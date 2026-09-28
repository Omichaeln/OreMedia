import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { ConflictError, NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AccountGrant, ChannelVariantInput, ValidationResult } from '@oremedia/contracts/providers';
import {
  ChannelConnectCancel,
  ChannelConnectStart,
  ChannelConnectComplete,
  ChannelConnectSelect,
  ChannelDisconnect,
  ChannelList,
  type ChannelConnectChoice,
} from '@oremedia/contracts/publishing';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { audit, outbox } from '@oremedia/module-operations';
import { logger } from '@oremedia/observability';
import { missingScopes, type ProviderAdapter, type ProviderIO } from '@oremedia/providers';
import { credentialBroker } from './broker';
import { actorRef, connectionUsable, toConnectionDto, transition, type ConnectionRow } from './common';
import type { EnvelopeRow } from './envelope';
import { assertBrandExists, providerClientFor, publishMedia, variants } from './hooks';
import { adapterFor, providerIO } from './providers';
import {
  ChannelConnectionRepository,
  CredentialRefRepository,
  PendingChannelGrantRepository,
  PublicationRepository,
} from './repositories';

const connectionsRepo = new ChannelConnectionRepository();
const credentialsRepo = new CredentialRefRepository();
const publicationsRepo = new PublicationRepository();
const pendingRepo = new PendingChannelGrantRepository();

/**
 * PKCE state for an OAuth connect flow, stored server-side with a short TTL and consumed once. The memory store
 * serves a single API process; configureConnectStateStore swaps in a shared (Redis) store for a multi-instance
 * deployment. Nothing here is a durable record (spec 3.1).
 */
export interface ConnectState {
  tenantId: string;
  brandId: string;
  providerKey: string;
  redirectUri: string;
  codeVerifier: string;
  actorId: string;
  expiresAt: number;
}
export interface ConnectStateStore {
  put(state: string, value: ConnectState): Promise<void>;
  /** Removes and returns the value (one-shot); null when unknown or expired. */
  take(state: string): Promise<ConnectState | null>;
}
export class MemoryConnectStateStore implements ConnectStateStore {
  private readonly entries = new Map<string, ConnectState>();
  async put(state: string, value: ConnectState) {
    this.entries.set(state, value);
  }
  async take(state: string) {
    const v = this.entries.get(state);
    this.entries.delete(state);
    return v && v.expiresAt > Date.now() ? v : null;
  }
}
let stateStore: ConnectStateStore = new MemoryConnectStateStore();
export const configureConnectStateStore = (store: ConnectStateStore): void => {
  stateStore = store;
};
/** Short TTL: a person completes the provider's consent screen in minutes, not hours. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

/** The web app's path providers return to; registered once per platform app (spec 14.7, exact redirect matching). */
const CONNECT_CALLBACK_PATH = '/connect/callback';
let connectCallbackUri: string | null = null;
/**
 * The deployment's public web origin (WEB_ORIGIN). Set, every connect flow uses the one callback the platforms have
 * registered and the client's redirectUri is ignored, so a caller cannot send a provider's code anywhere else.
 * Unset (development, tests), the client's redirectUri is used as given.
 */
export const configureConnectCallback = (webOrigin: string | null | undefined): void => {
  connectCallbackUri = webOrigin ? new URL(CONNECT_CALLBACK_PATH, webOrigin).toString() : null;
};

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const connectionResource = (c: ConnectionRow) => ({
  type: 'channel_connection',
  tenantId: c.tenantId,
  brandId: c.brandId,
  id: c.id,
  channelId: c.id,
});

/** `connect.complete` and `connect.select`: the connection, marked connected, or the accounts to choose from. */
export type ChannelConnectResult =
  ({ outcome: 'connected' } & ReturnType<typeof toConnectionDto>) | ChannelConnectChoice;

const anotherBrand = (path: string) =>
  new ValidationFailedError(
    [{ path, issue: 'remote_account_connected_to_another_brand' }],
    'This account is already connected to another brand',
  );

/** Where an account would land in this brand: the known connection to rotate, else a new id; null in another brand. */
interface ConnectionTarget {
  channelConnectionId: string;
  existing: ConnectionRow | null;
}
async function connectionTarget(
  providerKey: string,
  brandId: string,
  remoteAccountId: string,
  tx: Tx,
): Promise<ConnectionTarget | null> {
  const existing = await connectionsRepo.findByRemoteAccount(providerKey, remoteAccountId, tx);
  if (existing && existing.brandId !== brandId) return null;
  return { channelConnectionId: existing?.id ?? newId('channelConnection'), existing };
}

/** An account's grant sealed for the connection it becomes; what a connection write needs, never plaintext. */
interface SealedAccount {
  remoteAccountId: string;
  displayName: string;
  grantedScopes: string[];
  tokenExpiresAt: Date | null;
  channelConnectionId: string;
  envelope: EnvelopeRow;
}
async function sealAccount(
  tenantId: string,
  grant: AccountGrant,
  target: ConnectionTarget,
): Promise<SealedAccount> {
  return {
    remoteAccountId: grant.remoteAccountId,
    displayName: grant.displayName,
    grantedScopes: grant.grantedScopes,
    tokenExpiresAt: grant.tokenExpiresAt ? new Date(grant.tokenExpiresAt) : null,
    channelConnectionId: target.channelConnectionId,
    envelope: await credentialBroker.seal(tenantId, target.channelConnectionId, grant.credentials),
  };
}

/**
 * The one connection write (spec 14.7): stores the sealed grant as a new credential_refs row, creates the
 * connection or, for a known remote account, rotates its credential and reactivates it; audited, with the event.
 */
async function connectAccount(
  actor: ResolvedActor,
  brandId: string,
  adapter: ProviderAdapter,
  account: SealedAccount,
  existing: ConnectionRow | null,
  tx: Tx,
) {
  const connectionId = account.channelConnectionId;
  const credentialRefId = newId('credentialRef');
  await credentialsRepo.create({ id: credentialRefId, ...account.envelope }, tx);
  const values = {
    displayName: account.displayName,
    credentialRefId,
    grantedScopes: account.grantedScopes,
    missingScopes: missingScopes(adapter.capability.requiredScopes, account.grantedScopes),
    status: 'active' as const,
    tokenExpiresAt: account.tokenExpiresAt,
    capabilityVersion: adapter.capability.version,
  };
  let fromState: string | null = null;
  if (existing) {
    const locked = await connectionsRepo.lock(existing.id, tx);
    fromState = locked.status;
    await connectionsRepo.update(locked.id, locked.version, values, tx);
    const old = await credentialsRepo.getById(locked.credentialRefId, tx);
    if (!old.destroyedAt) await credentialsRepo.destroy(old.id, old.version, 'rotated', tx);
  } else {
    await connectionsRepo.create(
      {
        id: connectionId,
        brandId,
        providerKey: adapter.key,
        remoteAccountId: account.remoteAccountId,
        ...values,
      },
      tx,
    );
  }
  const row = await connectionsRepo.getById(connectionId, tx);
  await audit.record(
    actorRef(actor),
    existing ? 'channel.reconnect' : 'channel.connect',
    { type: 'channel_connection', id: connectionId },
    'allowed',
    tx,
    { brandId, channelConnectionId: connectionId, fromState, toState: 'active' },
  );
  await outbox.add(
    'channel.connected',
    { type: 'channel_connection', id: connectionId, version: row.version },
    {
      channelConnectionId: connectionId,
      providerKey: adapter.key,
      actorKind: actor.kind,
      actorId: actor.id,
      reconnect: existing !== null,
    },
    tx,
    { brandId },
  );
  return toConnectionDto(row);
}

/**
 * Expired choices are deleted, sealed grants with them, whenever a connect flow runs in the tenant (the periodic
 * purge, connectChoicePurgeWorkflowV1, catches tenants that never connect again). It commits on its own so a refused
 * (rolled back) choice still leaves nothing expired behind; a failure here is logged and never fails the request.
 */
async function destroyExpiredChoices(): Promise<void> {
  try {
    await withTransaction((tx) => pendingRepo.deleteExpired(new Date(), tx));
  } catch (err) {
    logger()
      .child('publishing')
      .warn(
        { errorName: (err as Error)?.name, errorCode: (err as { code?: string })?.code },
        'expired connect choices not purged; the periodic purge will remove them',
      );
  }
}

/**
 * The grants a choice seals: the exchanged account's, then every other account's from one listing (accountGrants),
 * else one selectAccount each. An account the provider no longer returns, or fails for, is left out and counted:
 * one Page failing (gone, timed out, rate limited) never loses the others or the consumed connect state.
 */
async function grantsForChoice(
  adapter: ProviderAdapter,
  grant: AccountGrant,
  io: ProviderIO,
): Promise<{ grants: AccountGrant[]; unavailable: number }> {
  const wanted = [...new Set((grant.alternatives ?? []).map((a) => a.remoteAccountId))].filter(
    (id) => id !== grant.remoteAccountId,
  );
  const grants: AccountGrant[] = [grant];
  const leftOut = (err: unknown) =>
    logger()
      .child('publishing')
      .warn(
        {
          providerKey: adapter.key,
          errorName: (err as Error)?.name,
          errorCode: (err as { code?: string })?.code,
        },
        'an account of the connect choice is unavailable; left out',
      );
  if (adapter.accountGrants) {
    let listed: AccountGrant[] = [];
    try {
      listed = await adapter.accountGrants(grant.credentials, io, grant.grantedScopes);
    } catch (err) {
      leftOut(err);
    }
    for (const id of wanted) {
      const found = listed.find((g) => g.remoteAccountId === id);
      if (found) grants.push(found);
    }
  } else if (adapter.selectAccount) {
    for (const id of wanted) {
      try {
        grants.push(await adapter.selectAccount(grant.credentials, id, io, grant.grantedScopes));
      } catch (err) {
        leftOut(err);
      }
    }
  }
  return { grants, unavailable: wanted.length + 1 - grants.length };
}

/** The rows of a live choice made by this actor, locked; anything else is the same refusal (nothing is revealed). */
async function takeChoice(actor: ResolvedActor, pendingId: string, tx: Tx) {
  await destroyExpiredChoices();
  const rows = await pendingRepo.lockPending(pendingId, tx);
  const first = rows[0];
  if (!first || first.actorKind !== actor.kind || first.actorId !== actor.id || first.expiresAt <= new Date())
    throw new ValidationFailedError(
      [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      'The connect flow has expired; start again',
    );
  await policy.assert(actor, 'channel.connect', brandResource(first.brandId), {}, tx);
  return { brandId: first.brandId, rows };
}

export const channelService = {
  connect: {
    /** Spec 14.7: the authorization URL with a server-side PKCE verifier; uncertified providers are refused. */
    async start(actor: ResolvedActor, input: z.infer<typeof ChannelConnectStart>, tx: Tx) {
      const parsed = ChannelConnectStart.parse(input);
      await assertBrandExists(parsed.brandId, tx); // a foreign or invisible brand is NOT_FOUND
      await policy.assert(actor, 'channel.connect', brandResource(parsed.brandId), {}, tx);
      const adapter = adapterFor(parsed.providerKey); // CAPABILITY_UNSUPPORTED unless certified (spec 14.6)
      const redirectUri = connectCallbackUri ?? parsed.redirectUri;
      if (!redirectUri)
        throw new ValidationFailedError(
          [{ path: 'redirectUri', issue: 'required_without_web_origin' }],
          'No callback is configured for this deployment; send redirectUri',
        );
      const { tenantId } = requireTenant();
      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(48).toString('base64url');
      const expiresAt = Date.now() + CONNECT_STATE_TTL_MS;
      const { url } = await adapter.authorizationUrl({
        state,
        codeVerifier,
        redirectUri,
        client: providerClientFor(adapter.key),
      });
      await stateStore.put(state, {
        tenantId,
        brandId: parsed.brandId,
        providerKey: adapter.key,
        redirectUri,
        codeVerifier,
        actorId: actor.id,
        expiresAt,
      });
      await audit.record(
        actorRef(actor),
        'channel.connect.start',
        { type: 'brand', id: parsed.brandId },
        'allowed',
        tx,
        { brandId: parsed.brandId },
      );
      return { state, url, expiresAt: new Date(expiresAt).toISOString() };
    },

    /**
     * Spec 14.7 on connect: the code is exchanged, the grant sealed with a per-record data key (AAD binds it to
     * tenant and connection) and stored as a new credential_refs row; a reconnect of a known remote account rotates
     * the credential and reactivates the connection. Plaintext never reaches the DB, logs or events.
     *
     * A grant that can address several accounts (the adapter lists `alternatives` and can select among them)
     * connects nothing yet: each account this brand may connect is resolved and sealed for the connection it would
     * become, and the person chooses with `select` (outcome 'choose'), even when only one of them remains. A grant
     * for one account connects as before.
     */
    async complete(
      actor: ResolvedActor,
      input: z.infer<typeof ChannelConnectComplete>,
      tx: Tx,
    ): Promise<ChannelConnectResult> {
      const parsed = ChannelConnectComplete.parse(input);
      const { tenantId } = requireTenant();
      const pending = await stateStore.take(parsed.state);
      if (!pending || pending.tenantId !== tenantId || pending.actorId !== actor.id)
        throw new ValidationFailedError(
          [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
          'The connect flow has expired; start again',
        );
      await policy.assert(actor, 'channel.connect', brandResource(pending.brandId), {}, tx);
      await destroyExpiredChoices();
      const adapter = adapterFor(pending.providerKey);
      const io = providerIO(adapter.key, tenantId);
      const grant = await adapter.exchangeCode(
        {
          code: parsed.code,
          codeVerifier: pending.codeVerifier,
          redirectUri: pending.redirectUri,
          client: providerClientFor(adapter.key),
        },
        io,
      );
      const canChoose = Boolean(adapter.accountGrants ?? adapter.selectAccount);
      if (!canChoose || !grant.alternatives?.length) {
        const target = await connectionTarget(adapter.key, pending.brandId, grant.remoteAccountId, tx);
        if (!target) throw anotherBrand('providerKey');
        const account = await sealAccount(tenantId, grant, target);
        const connected = await connectAccount(actor, pending.brandId, adapter, account, target.existing, tx);
        return { outcome: 'connected', ...connected };
      }

      // Several accounts: always an explicit choice, even when only one of them can be connected to this brand.
      const { grants, unavailable } = await grantsForChoice(adapter, grant, io);
      const pendingId = newId('pendingChannelGrant');
      const expiresAt = new Date(Date.now() + CONNECT_STATE_TTL_MS);
      const rows = [];
      let excluded = 0;
      for (const account of grants) {
        const target = await connectionTarget(adapter.key, pending.brandId, account.remoteAccountId, tx);
        if (!target) {
          excluded += 1; // connected to another brand: not offered here
          continue;
        }
        const sealed = await sealAccount(tenantId, account, target);
        rows.push({
          id: newId('pendingChannelGrant'),
          brandId: pending.brandId,
          pendingId,
          providerKey: adapter.key,
          actorKind: actor.kind,
          actorId: actor.id,
          position: rows.length,
          remoteAccountId: sealed.remoteAccountId,
          displayName: sealed.displayName,
          channelConnectionId: sealed.channelConnectionId,
          grantedScopes: sealed.grantedScopes,
          tokenExpiresAt: sealed.tokenExpiresAt,
          ...sealed.envelope,
          expiresAt,
        });
      }
      if (rows.length === 0) throw anotherBrand('providerKey');
      await pendingRepo.createMany(rows, tx);
      await audit.record(
        actorRef(actor),
        'channel.connect.choose',
        { type: 'brand', id: pending.brandId },
        'allowed',
        tx,
        {
          brandId: pending.brandId,
          count: rows.length,
          evidence: `offered=${rows.length},unavailable=${unavailable},other_brand=${excluded}`,
        },
      );
      return {
        outcome: 'choose',
        pendingId,
        brandId: pending.brandId,
        providerKey: adapter.key,
        options: rows.map((r) => ({ remoteAccountId: r.remoteAccountId, displayName: r.displayName })),
        unavailable,
        expiresAt: expiresAt.toISOString(),
      };
    },

    /**
     * Spec 14.7 account choice: connects the account the person chose among those `complete` offered, through the
     * same write as a single-account connect. Only the actor who completed the flow, in its tenant and brand, can
     * choose, once, before it expires; every sealed grant of the choice is deleted with it.
     */
    async select(actor: ResolvedActor, input: z.infer<typeof ChannelConnectSelect>, tx: Tx) {
      const parsed = ChannelConnectSelect.parse(input);
      const { rows } = await takeChoice(actor, parsed.pendingId, tx);
      const chosen = rows.find((r) => r.remoteAccountId === parsed.remoteAccountId);
      if (!chosen)
        throw new ValidationFailedError(
          [{ path: 'remoteAccountId', issue: 'account_not_offered' }],
          'Choose one of the accounts offered',
        );
      const adapter = adapterFor(chosen.providerKey);
      const target = await connectionTarget(adapter.key, chosen.brandId, chosen.remoteAccountId, tx);
      if (!target) throw anotherBrand('remoteAccountId');
      // The grant is sealed for the connection it was offered as; one connected or removed since cannot take it.
      if (target.channelConnectionId !== chosen.channelConnectionId && target.existing)
        throw new ValidationFailedError(
          [{ path: 'pendingId', issue: 'connect_choice_stale' }],
          'The accounts changed while you were choosing; start again',
        );
      await pendingRepo.deletePending(parsed.pendingId, tx);
      const { kmsKeyId, wrappedDataKey, ciphertext, iv, authTag, aad } = chosen;
      const connected = await connectAccount(
        actor,
        chosen.brandId,
        adapter,
        {
          remoteAccountId: chosen.remoteAccountId,
          displayName: chosen.displayName,
          grantedScopes: chosen.grantedScopes,
          tokenExpiresAt: chosen.tokenExpiresAt,
          channelConnectionId: chosen.channelConnectionId,
          envelope: { kmsKeyId, wrappedDataKey, ciphertext, iv, authTag, aad },
        },
        target.existing,
        tx,
      );
      return { outcome: 'connected' as const, ...connected };
    },

    /** Discards a choice: every sealed grant it holds is deleted. Same actor, tenant and brand as `select`. */
    async cancel(actor: ResolvedActor, input: z.infer<typeof ChannelConnectCancel>, tx: Tx) {
      const parsed = ChannelConnectCancel.parse(input);
      const { brandId } = await takeChoice(actor, parsed.pendingId, tx);
      const count = await pendingRepo.deletePending(parsed.pendingId, tx);
      await audit.record(
        actorRef(actor),
        'channel.connect.cancel',
        { type: 'brand', id: brandId },
        'allowed',
        tx,
        { brandId, count },
      );
      return { pendingId: parsed.pendingId, cancelled: true as const };
    },
  },

  async list(actor: ResolvedActor, input: z.infer<typeof ChannelList>, tx?: Tx) {
    const parsed = ChannelList.parse(input);
    await assertBrandExists(parsed.brandId, tx);
    await policy.assert(actor, 'brand.read', brandResource(parsed.brandId), {}, tx);
    const rows = await connectionsRepo.listForBrand(parsed.brandId, tx);
    return rows.map(toConnectionDto);
  },

  async get(actor: ResolvedActor, channelConnectionId: string, tx?: Tx) {
    const row = await connectionsRepo.getById(channelConnectionId, tx);
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    return toConnectionDto(row);
  },

  /**
   * Spec 14.7 / 17.5 revoke: the credential row is destroyed (data key discarded), the connection disabled and
   * every scheduled publication on it held with reason channel_active, through the publication machine.
   */
  async disconnect(actor: ResolvedActor, input: z.infer<typeof ChannelDisconnect>, tx: Tx) {
    const parsed = ChannelDisconnect.parse(input);
    const row = await connectionsRepo.lock(parsed.channelConnectionId, tx);
    await policy.assert(actor, 'channel.manage', connectionResource(row), {}, tx);
    if (row.version !== parsed.expectedVersion)
      throw new ConflictError('ChannelConnection', row.id, parsed.expectedVersion);
    await connectionsRepo.update(row.id, row.version, { status: 'disabled', tokenExpiresAt: null }, tx);
    const credential = await credentialsRepo.getById(row.credentialRefId, tx);
    if (!credential.destroyedAt)
      await credentialsRepo.destroy(credential.id, credential.version, 'disconnected', tx);
    const held: string[] = [];
    for (const pub of await publicationsRepo.listScheduledForChannel(row.id, tx)) {
      const toState = transition(pub.state, 'dependency_revoked', 'publicationId');
      await publicationsRepo.update(
        pub.id,
        pub.version,
        { state: toState, stateReason: 'channel_disconnected', holdReasons: ['channel_active'] },
        tx,
      );
      await outbox.add(
        'publication.state_changed',
        { type: 'publication', id: pub.id, version: pub.version + 1 },
        { publicationId: pub.id, fromState: pub.state, toState, reason: 'channel_disconnected' },
        tx,
        { brandId: pub.brandId },
      );
      held.push(pub.id);
    }
    await audit.record(
      actorRef(actor),
      'channel.disconnect',
      { type: 'channel_connection', id: row.id },
      'allowed',
      tx,
      {
        brandId: row.brandId,
        channelConnectionId: row.id,
        fromState: row.status,
        toState: 'disabled',
        count: held.length,
      },
    );
    await outbox.add(
      'channel.disconnected',
      { type: 'channel_connection', id: row.id, version: row.version + 1 },
      { channelConnectionId: row.id, providerKey: row.providerKey, heldPublications: held.length },
      tx,
      { brandId: row.brandId },
    );
    const updated = await connectionsRepo.getById(row.id, tx);
    return { ...toConnectionDto(updated), heldPublicationIds: held };
  },

  /** Spec 13.4 `publishing.channelUsable`: false for a foreign or unknown id (never an error). */
  async channelUsable(channelConnectionId: string, tx?: Tx): Promise<boolean> {
    try {
      return connectionUsable(await connectionsRepo.getById(channelConnectionId, tx));
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  },

  /** Spec 13.4 `providers.validateVariant`: pure, capability-driven, against the variant's connection. */
  async validateVariantDetailed(variantId: string, tx?: Tx): Promise<ValidationResult> {
    const variant = await variants.get(variantId, tx);
    const connection = await connectionsRepo.getById(variant.channelConnectionId, tx);
    const adapter = adapterFor(connection.providerKey);
    const media = await publishMedia.describeForVariant(variant, tx); // dimensions only: nothing is minted
    const input: ChannelVariantInput = {
      text: variant.text,
      altTexts: variant.altTexts,
      media: media.map((m) => ({ mime: m.mime, width: m.width, height: m.height, bytes: m.bytes })),
      settings: variant.settings,
    };
    return adapter.validateVariant(input);
  },
  async validateVariant(variantId: string, tx?: Tx): Promise<boolean> {
    return (await channelService.validateVariantDetailed(variantId, tx)).ok;
  },

  /** Content module channel resolver (spec 4.2): a description, never the row; null for a foreign or unknown id. */
  async describe(channelConnectionId: string, tx?: Tx) {
    const row = await connectionsRepo.findById(channelConnectionId, tx);
    return row
      ? { brandId: row.brandId, providerKey: row.providerKey, capabilityVersion: row.capabilityVersion }
      : null;
  },

  /** Usage counter for the `channels` entitlement (composition registers it with the billing module). */
  countActive: (tx?: Tx) => connectionsRepo.countActive(tx),
};
