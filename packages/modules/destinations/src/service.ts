import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  CMS_SCOPE_PUBLISH,
  CMS_SCOPE_WRITE,
  DESTINATION_KIND_CAPABILITIES,
  DestinationConnectCancel,
  DestinationConnectComplete,
  DestinationConnectSelect,
  DestinationConnectStart,
  DestinationConnectWithSecret,
  DestinationDisconnect,
  DestinationGet,
  DestinationList,
  DestinationRegister,
  DestinationSetHealth,
  SourceUse,
  SourceUseCheck,
  SourceUsePolicyList,
  SourceUsePolicySet,
  sourceUseIssues,
  type DestinationConnectChoice,
  type DestinationKind,
  type DestinationSourceV1,
  type DestinationV1,
  type SourceUseCheckResult,
  type SourceUsePolicyV1,
} from '@oremedia/contracts/destinations';
import {
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { audit, outbox } from '@oremedia/module-operations';
import {
  CONNECT_STATE_TTL_MS,
  MemoryConnectStateStore,
  connectCallbackUriInUse,
  credentialBroker,
  providerClientFor,
  type ConnectStateStore,
  type EnvelopeRow,
} from '@oremedia/module-publishing';
import { logger } from '@oremedia/observability';
import { assertSafeUrl, missingScopes, type CmsAdapter, type SourceAdapter } from '@oremedia/providers';
import { cmsAdapterFor, cmsRegistryInUse } from './cms';
import { sourceAvailable } from './hooks';
import {
  BrandDestinationRepository,
  PendingDestinationGrantRepository,
  SourceUsePolicyRepository,
} from './repositories';
import { registry, sourceAdapterFor, sourceIO } from './sources';

const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();
const pendingRepo = new PendingDestinationGrantRepository();

/**
 * The connect flow's server-side state (R2-1), the same shape and lifetime as a channel connect's
 * (packages/modules/publishing/src/channels.ts): PKCE verifier, redirect, actor, short TTL, consumed once. Its own
 * store, so a state started for a channel can never complete a destination flow or the other way round;
 * configureDestinationConnectStateStore swaps in a shared store for a multi-instance deployment.
 */
let stateStore: ConnectStateStore = new MemoryConnectStateStore();
export const configureDestinationConnectStateStore = (store: ConnectStateStore): void => {
  stateStore = store;
};

type DestinationRow = Awaited<ReturnType<BrandDestinationRepository['getById']>>;
type PolicyRow = Awaited<ReturnType<SourceUsePolicyRepository['getById']>>;

export const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const destinationResource = (d: DestinationRow) => ({
  type: 'brand_destination',
  tenantId: d.tenantId,
  brandId: d.brandId,
  id: d.id,
});
const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });

/**
 * Kinds with a registered adapter, whether it is certified and enabled here (the settings screen's buttons): the
 * read-only sources (R2-1) and the CMS kinds connected with a secret (R2-3), each with the platform it names.
 */
const listSources = (): DestinationSourceV1[] => [
  ...registry()
    .list()
    .filter((s): s is typeof s & { key: DestinationKind } => s.key in DESTINATION_KIND_CAPABILITIES)
    .map((s) => ({
      kind: s.key,
      label: DESTINATION_KIND_CAPABILITIES[s.key].label,
      vendor: s.capability.vendor,
      certified: s.certified,
      enabled: sourceAvailable(s.key),
      connect: 'oauth' as const,
    })),
  ...cmsRegistryInUse()
    .list()
    .filter((c): c is typeof c & { key: DestinationKind } => c.key in DESTINATION_KIND_CAPABILITIES)
    .map((c) => ({
      kind: c.key,
      label: DESTINATION_KIND_CAPABILITIES[c.key].label,
      vendor: c.capability.vendor,
      certified: c.certified,
      enabled: sourceAvailable(c.key),
      connect: 'secret' as const,
      credential: c.capability.credential,
    })),
];

/** A certified source adapter the deployment has enabled; the other refusals read as a channel's (spec 14.6). */
function enabledSourceAdapter(kind: DestinationKind): SourceAdapter {
  const adapter = sourceAdapterFor(kind); // CAPABILITY_UNSUPPORTED unless registered and certified
  if (!sourceAvailable(kind))
    throw new CapabilityUnsupportedError([{ path: 'kind', issue: `source_not_enabled:${kind}` }]);
  return adapter;
}

/** A certified CMS adapter the deployment has enabled (R2-3), with the same refusals. */
export function enabledCmsAdapter(kind: DestinationKind): CmsAdapter {
  const adapter = cmsAdapterFor(kind); // CAPABILITY_UNSUPPORTED unless registered and certified
  if (!sourceAvailable(kind))
    throw new CapabilityUnsupportedError([{ path: 'kind', issue: `source_not_enabled:${kind}` }]);
  return adapter;
}

/** Whether a CMS kind can be written to here: registered, certified and enabled (the gate reads false, never throws). */
export function cmsWritable(kind: string): boolean {
  try {
    enabledCmsAdapter(StoredKind.parse(kind));
    return true;
  } catch (err) {
    if (err instanceof CapabilityUnsupportedError || err instanceof z.ZodError) return false;
    throw err;
  }
}

/**
 * Expired flows are deleted, sealed grants with them, whenever a connect flow runs in the tenant. It commits on its
 * own so a refused (rolled back) flow still leaves nothing expired behind; a failure here is logged and never fails
 * the request (as channels do).
 */
async function destroyExpiredFlows(): Promise<void> {
  try {
    await withTransaction((tx) => pendingRepo.deleteExpired(new Date(), tx));
  } catch (err) {
    logger()
      .child('destinations')
      .warn(
        { errorName: (err as Error)?.name, errorCode: (err as { code?: string })?.code },
        'expired destination connect flows not purged; the next flow will try again',
      );
  }
}

const flowExpired = () =>
  new ValidationFailedError(
    [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
    'The connect flow has expired; start again',
  );

/** The live flow this actor completed, locked; anything else is the same refusal (nothing is revealed). */
async function takeFlow(actor: ResolvedActor, pendingId: string, tx: Tx) {
  await destroyExpiredFlows();
  const row = await pendingRepo.lockPending(pendingId, tx);
  if (!row || row.actorKind !== actor.kind || row.actorId !== actor.id || row.expiresAt <= new Date())
    throw flowExpired();
  await policy.assert(actor, 'destination.connect', brandResource(row.brandId), {}, tx);
  return row;
}

/**
 * What a destination registration needs beyond the identity: the sealed grant, or nothing (R2-0's register). A
 * grant that just listed its targets is known to work; a sealed secret (R2-3) is not until the worker verifies it,
 * which the registered event asks for (`verify`).
 */
interface Grant {
  credentialRefId: string;
  tokenExpiresAt: Date | null;
  verified: boolean;
}

/**
 * The one destination write (R2-0 register and R2-1 select): a remote identity this brand holds already is a
 * conflict; one another brand of the tenant holds is refused without naming it (uq_destination_remote, as channels
 * do for a remote account). One audit row per write, under the action of the command that made it (as
 * connectAccount records channel.connect or channel.reconnect), with the event.
 */
async function registerDestination(
  actor: ResolvedActor,
  action: 'destination.register' | 'destination.connect.select' | 'destination.connect.secret',
  values: {
    id: string;
    brandId: string;
    kind: DestinationKind;
    externalId: string;
    displayName: string;
    grantedScopes: string[];
    capabilityVersion: number;
  },
  grant: Grant | null,
  tx: Tx,
) {
  const existing = await destinationsRepo.findRemote(values.kind, values.externalId, tx);
  if (existing && existing.brandId !== values.brandId)
    throw new ValidationFailedError(
      [{ path: 'externalId', issue: 'remote_identity_registered_to_another_brand' }],
      'This remote identity is already registered to another brand',
    );
  if (existing) throw new ConflictError('Destination', existing.id, existing.version);
  await destinationsRepo.create(
    {
      ...values,
      ownerUserId: actor.id,
      credentialRefId: grant?.credentialRefId ?? null,
      tokenExpiresAt: grant?.tokenExpiresAt ?? null,
      // A grant that just listed its targets is known to work; a bare registration or a sealed secret has not
      // been checked (the worker verifies the secret and sets the health).
      health: grant?.verified ? 'healthy' : 'unknown',
      healthCheckedAt: grant?.verified ? new Date() : null,
      status: 'active',
    },
    tx,
  );
  const row = await destinationsRepo.getById(values.id, tx);
  await audit.record(actorRef(actor), action, { type: 'brand_destination', id: values.id }, 'allowed', tx, {
    brandId: values.brandId,
    kind: values.kind,
    toState: 'active',
  });
  await outbox.add(
    'destination.registered',
    { type: 'brand_destination', id: values.id, version: row.version },
    {
      destinationId: values.id,
      kind: values.kind,
      actorKind: actor.kind,
      actorId: actor.id,
      // Appended (additive): a sealed secret is verified by destinationVerifyWorkflowV1 (R2-3).
      verify: grant !== null && !grant.verified,
    },
    tx,
    { brandId: values.brandId },
  );
  return toDestinationDto(row);
}

/**
 * Defence in depth: source_use.manage is AGENT_NEVER (role-grants.ts), so an agent is denied by policy.assert
 * before this runs; should the action ever gain a propose_only grant, a proposal still never writes a policy.
 */
function assertMayDecide(decision: Decision): void {
  if (decision.obligations?.some((o) => o.type === 'propose_only'))
    throw new PolicyDeniedError('propose_only', 'Agents may only propose; an admin must decide');
}

/** Versioned JSON is validated on read (spec 6.1); a kind unknown to the capability table never reaches a DTO. */
export const StoredKind = z.enum(
  Object.keys(DESTINATION_KIND_CAPABILITIES) as [DestinationKind, ...DestinationKind[]],
);
const StoredUses = z.array(SourceUse);

/** Never the credential reference: identity, scopes, health and state only. */
const toDestinationDto = (d: DestinationRow): DestinationV1 => ({
  id: d.id,
  brandId: d.brandId,
  kind: StoredKind.parse(d.kind),
  externalId: d.externalId,
  displayName: d.displayName,
  ownerUserId: d.ownerUserId,
  grantedScopes: d.grantedScopes,
  health: d.health,
  healthCheckedAt: d.healthCheckedAt ? d.healthCheckedAt.toISOString() : null,
  capabilityVersion: d.capabilityVersion,
  status: d.status,
  reportingTimeZone: d.reportingTimeZone,
  currencyCode: d.currencyCode,
  version: d.version,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

/**
 * The one reading of a policy row for one use, shared by `sourceUsePolicyService.check` and the report sweep
 * (which runs as a platform job with no person to ask): refused without a row, once the review is overdue, or
 * when the use is not among the allowed ones.
 */
export function sourceUseDecision(row: PolicyRow | null, use: SourceUse, now: Date): SourceUseCheckResult {
  if (!row) return { allowed: false, reason: 'no_policy', policy: null };
  const dto = toPolicyDto(row);
  if (row.reviewDueAt.getTime() < now.getTime())
    return { allowed: false, reason: 'review_overdue', policy: dto };
  if (!dto.allowedUses.includes(use)) return { allowed: false, reason: 'not_allowed', policy: dto };
  return { allowed: true, reason: 'allowed', policy: dto };
}

const toPolicyDto = (p: PolicyRow): SourceUsePolicyV1 => ({
  id: p.id,
  brandId: p.brandId,
  destinationKind: StoredKind.parse(p.destinationKind),
  dataType: p.dataType,
  allowedUses: StoredUses.parse(p.allowedUses),
  retentionDays: p.retentionDays,
  version: p.version,
  reviewedAt: p.reviewedAt.toISOString(),
  reviewDueAt: p.reviewDueAt.toISOString(),
  reviewedById: p.reviewedById,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

/**
 * Any brand id from a client is read through the brand module first: a brand of another tenant, or one the actor
 * is not granted, is NOT_FOUND (never FORBIDDEN, spec 5.3), and brand.read is asserted on the way.
 */
export const visibleBrand = (actor: ResolvedActor, brandId: string, tx?: Tx) =>
  brandService.get(actor, brandId, tx);

/** A destination read by id under a brand: one that belongs to another brand of the tenant does not exist here. */
export async function destinationOf(brandId: string, destinationId: string, row: DestinationRow | null) {
  if (!row || row.brandId !== brandId) throw new NotFoundError('Destination', destinationId);
  return row;
}

export const destinationService = {
  /** A brand's destinations, by kind then name (brand.read). */
  async list(actor: ResolvedActor, input: z.input<typeof DestinationList>, tx?: Tx) {
    const parsed = DestinationList.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const rows = await destinationsRepo.listForBrand(parsed.brandId, parsed.kind, tx);
    return { items: rows.map(toDestinationDto) };
  },

  async get(actor: ResolvedActor, input: z.infer<typeof DestinationGet>, tx?: Tx) {
    const parsed = DestinationGet.parse(input);
    const row = await destinationOf(
      parsed.brandId,
      parsed.destinationId,
      await destinationsRepo.findById(parsed.destinationId, tx), // foreign → null → NOT_FOUND
    );
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    return toDestinationDto(row);
  },

  /**
   * Registers a remote identity for the brand (destination.connect, which agents never hold). The person who
   * registers it owns it. No credential is stored here: `connect` registers a destination with its grant.
   */
  async register(actor: ResolvedActor, input: z.input<typeof DestinationRegister>, tx: Tx) {
    const parsed = DestinationRegister.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    await policy.assert(actor, 'destination.connect', brandResource(parsed.brandId), {}, tx);
    return registerDestination(
      actor,
      'destination.register',
      {
        id: newId('destination'),
        brandId: parsed.brandId,
        kind: parsed.kind,
        externalId: parsed.externalId,
        displayName: parsed.displayName,
        grantedScopes: parsed.grantedScopes,
        capabilityVersion: parsed.capabilityVersion,
      },
      null,
      tx,
    );
  },

  /** The kinds a connect flow can start here: registered source adapters, certified or not, enabled or not. */
  sources: {
    async list(): Promise<{ items: DestinationSourceV1[] }> {
      return { items: listSources() };
    },
  },

  connect: {
    /**
     * R2-1 connect start (as spec 14.7 for channels): the source's authorisation URL with a server-side PKCE
     * verifier, for a kind whose source adapter is registered, certified and enabled on this deployment.
     */
    async start(actor: ResolvedActor, input: z.infer<typeof DestinationConnectStart>, tx: Tx) {
      const parsed = DestinationConnectStart.parse(input);
      await visibleBrand(actor, parsed.brandId, tx); // a foreign or invisible brand is NOT_FOUND
      await policy.assert(actor, 'destination.connect', brandResource(parsed.brandId), {}, tx);
      const adapter = enabledSourceAdapter(parsed.kind);
      const redirectUri = connectCallbackUriInUse() ?? parsed.redirectUri;
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
        'destination.connect.start',
        { type: 'brand', id: parsed.brandId },
        'allowed',
        tx,
        { brandId: parsed.brandId, kind: parsed.kind },
      );
      return { state, url, expiresAt: new Date(expiresAt).toISOString() };
    },

    /**
     * The code is exchanged, the grant sealed with a per-record data key bound to the tenant and the destination it
     * becomes (its id allocated now), and stored as one pending row with the targets the grant can read. Nothing
     * is registered yet: the person confirms a target with `select`, even when there is only one. Plaintext never
     * reaches the DB, logs or events; the API process seals without decrypting.
     */
    async complete(
      actor: ResolvedActor,
      input: z.infer<typeof DestinationConnectComplete>,
      tx: Tx,
    ): Promise<DestinationConnectChoice> {
      const parsed = DestinationConnectComplete.parse(input);
      const { tenantId } = requireTenant();
      const pending = await stateStore.take(parsed.state);
      if (!pending || pending.tenantId !== tenantId || pending.actorId !== actor.id)
        throw new ValidationFailedError(
          [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
          'The connect flow has expired; start again',
        );
      await policy.assert(actor, 'destination.connect', brandResource(pending.brandId), {}, tx);
      await destroyExpiredFlows();
      const kind = StoredKind.parse(pending.providerKey);
      const adapter = enabledSourceAdapter(kind);
      const client = providerClientFor(adapter.key);
      const io = sourceIO(adapter.key, tenantId);
      const grant = await adapter.exchangeCode(
        { code: parsed.code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, client },
        io,
      );
      const missing = missingScopes(adapter.capability.requiredScopes, grant.grantedScopes);
      if (missing.length)
        throw new ValidationFailedError(
          missing.map((scope) => ({ path: 'code', issue: `scope_missing:${scope}` })),
          'The grant does not cover the scopes this source needs; connect again and allow them',
        );
      const targets = await adapter.listTargets(grant.credentials, client, io);
      const destinationId = newId('destination');
      const envelope = await credentialBroker.seal(tenantId, destinationId, grant.credentials);
      const pendingId = newId('pendingDestinationGrant');
      const expiresAt = new Date(Date.now() + CONNECT_STATE_TTL_MS);
      await pendingRepo.create(
        {
          id: pendingId,
          brandId: pending.brandId,
          kind,
          actorKind: actor.kind,
          actorId: actor.id,
          destinationId,
          grantedScopes: grant.grantedScopes,
          tokenExpiresAt: grant.credentials.expiresAt ? new Date(grant.credentials.expiresAt) : null,
          targets,
          ...envelope,
          expiresAt,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'destination.connect.complete',
        { type: 'brand', id: pending.brandId },
        'allowed',
        tx,
        { brandId: pending.brandId, kind, count: targets.length },
      );
      return { pendingId, brandId: pending.brandId, kind, targets, expiresAt: expiresAt.toISOString() };
    },

    /**
     * Registers the target the person chose among those `complete` offered, with the sealed grant as its
     * credential (health healthy, the adapter's capability version), through the same write as R2-0's register and
     * with its refusals. Only the actor who completed the flow, in its tenant and brand, can choose, once, before
     * it expires; the pending row is deleted with its grant.
     */
    async select(actor: ResolvedActor, input: z.infer<typeof DestinationConnectSelect>, tx: Tx) {
      const parsed = DestinationConnectSelect.parse(input);
      const row = await takeFlow(actor, parsed.pendingId, tx);
      const target = row.targets.find((t) => t.externalId === parsed.externalId);
      if (!target)
        throw new ValidationFailedError(
          [{ path: 'externalId', issue: 'target_not_offered' }],
          'Choose one of the targets offered',
        );
      const kind = StoredKind.parse(row.kind);
      const adapter = sourceAdapterFor(kind);
      const { kmsKeyId, wrappedDataKey, ciphertext, iv, authTag, aad } = row;
      const envelope: EnvelopeRow = { kmsKeyId, wrappedDataKey, ciphertext, iv, authTag, aad };
      await pendingRepo.deletePending(row.id, tx);
      const credentialRefId = await credentialBroker.createCredentialRef(envelope, tx);
      return registerDestination(
        actor,
        'destination.connect.select',
        {
          id: row.destinationId,
          brandId: row.brandId,
          kind,
          externalId: target.externalId,
          displayName: target.displayName,
          grantedScopes: row.grantedScopes,
          capabilityVersion: adapter.capability.version,
        },
        { credentialRefId, tokenExpiresAt: row.tokenExpiresAt, verified: true },
        tx,
      );
    },

    /**
     * R2-3 (D-16): a website connected with its integration identity and secret (an application password). The
     * site must be https on a public host; the secret is sealed here under the destination's AAD and stored as
     * the destination's credential, never returned, logged or opened in this process (WrapOnlyKms). The destination
     * registers with health `unknown`; the worker verifies the secret (destinationVerifyWorkflowV1) and sets it.
     * Writes land as drafts by default; `allowPublish` grants the scope a live publish needs.
     */
    async withSecret(actor: ResolvedActor, input: z.input<typeof DestinationConnectWithSecret>, tx: Tx) {
      const parsed = DestinationConnectWithSecret.parse(input);
      await visibleBrand(actor, parsed.brandId, tx);
      await policy.assert(actor, 'destination.connect', brandResource(parsed.brandId), {}, tx);
      const adapter = enabledCmsAdapter(parsed.kind);
      let site: URL;
      try {
        site = assertSafeUrl(parsed.siteUrl);
      } catch {
        throw new ValidationFailedError(
          [{ path: 'siteUrl', issue: 'site_url_not_allowed' }],
          'The site address must be https on a public host',
        );
      }
      if (site.pathname !== '/' || site.search || site.hash)
        throw new ValidationFailedError(
          [{ path: 'siteUrl', issue: 'site_url_not_an_origin' }],
          'Give the site address as its origin, without a path',
        );
      const { tenantId } = requireTenant();
      const destinationId = newId('destination');
      const envelope = await credentialBroker.seal(tenantId, destinationId, {
        accessToken: parsed.secret,
        extra: { username: parsed.username, siteUrl: site.origin },
      });
      const credentialRefId = await credentialBroker.createCredentialRef(envelope, tx);
      return registerDestination(
        actor,
        'destination.connect.secret',
        {
          id: destinationId,
          brandId: parsed.brandId,
          kind: parsed.kind,
          externalId: site.origin,
          displayName: parsed.displayName ?? site.host,
          grantedScopes: parsed.allowPublish ? [CMS_SCOPE_WRITE, CMS_SCOPE_PUBLISH] : [CMS_SCOPE_WRITE],
          capabilityVersion: adapter.capability.version,
        },
        { credentialRefId, tokenExpiresAt: null, verified: false },
        tx,
      );
    },

    /** Discards a flow: the sealed grant it holds is deleted. Same actor, tenant and brand as `select`. */
    async cancel(actor: ResolvedActor, input: z.infer<typeof DestinationConnectCancel>, tx: Tx) {
      const parsed = DestinationConnectCancel.parse(input);
      const row = await takeFlow(actor, parsed.pendingId, tx);
      const count = await pendingRepo.deletePending(row.id, tx);
      await audit.record(
        actorRef(actor),
        'destination.connect.cancel',
        { type: 'brand', id: row.brandId },
        'allowed',
        tx,
        { brandId: row.brandId, kind: row.kind, count },
      );
      return { pendingId: parsed.pendingId, cancelled: true as const };
    },
  },

  /**
   * R2-3: a description for the content module's destination resolver (spec 4.2: never the row); null for a
   * foreign or unknown id. `writable` says whether the kind can be published to on this deployment.
   */
  async describe(destinationId: string, tx?: Tx) {
    const row = await destinationsRepo.findById(destinationId, tx);
    if (!row || row.status !== 'active') return null;
    return {
      brandId: row.brandId,
      kind: row.kind,
      capabilityVersion: row.capabilityVersion,
      writable:
        DESTINATION_KIND_CAPABILITIES[StoredKind.parse(row.kind)].uses.includes('write') &&
        cmsWritable(row.kind),
    };
  },

  /** Records what a health check found (destination.manage); the time of the check is now. Not once disconnected. */
  async setHealth(actor: ResolvedActor, input: z.infer<typeof DestinationSetHealth>, tx: Tx) {
    const parsed = DestinationSetHealth.parse(input);
    const row = await destinationOf(
      parsed.brandId,
      parsed.destinationId,
      await destinationsRepo.lock(parsed.destinationId, tx),
    );
    await policy.assert(actor, 'destination.manage', destinationResource(row), {}, tx);
    if (row.status === 'disconnected')
      throw new ValidationFailedError(
        [{ path: 'destinationId', issue: 'disconnected' }],
        'A disconnected destination is not health-checked',
      );
    if (row.version !== parsed.expectedVersion)
      throw new ConflictError('Destination', row.id, parsed.expectedVersion);
    await destinationsRepo.update(
      row.id,
      row.version,
      { health: parsed.health, healthCheckedAt: new Date() },
      tx,
    );
    await audit.record(
      actorRef(actor),
      'destination.health',
      { type: 'brand_destination', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, fromState: row.health, toState: parsed.health },
    );
    return toDestinationDto(await destinationsRepo.getById(row.id, tx));
  },

  /** active → disconnected (destination.manage), its credential destroyed; one disconnected already is refused. */
  async disconnect(actor: ResolvedActor, input: z.infer<typeof DestinationDisconnect>, tx: Tx) {
    const parsed = DestinationDisconnect.parse(input);
    const row = await destinationOf(
      parsed.brandId,
      parsed.destinationId,
      await destinationsRepo.lock(parsed.destinationId, tx),
    );
    await policy.assert(actor, 'destination.manage', destinationResource(row), {}, tx);
    if (row.status === 'disconnected')
      throw new ValidationFailedError(
        [{ path: 'destinationId', issue: 'already_disconnected' }],
        'This destination is already disconnected',
      );
    if (row.version !== parsed.expectedVersion)
      throw new ConflictError('Destination', row.id, parsed.expectedVersion);
    await destinationsRepo.update(row.id, row.version, { status: 'disconnected', tokenExpiresAt: null }, tx);
    // As channels on disconnect: the credential row is destroyed (data key discarded) with the destination.
    if (row.credentialRefId)
      await credentialBroker.destroyCredentialRef(row.credentialRefId, 'disconnected', tx);
    await audit.record(
      actorRef(actor),
      'destination.disconnect',
      { type: 'brand_destination', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, fromState: row.status, toState: 'disconnected' },
    );
    await outbox.add(
      'destination.disconnected',
      { type: 'brand_destination', id: row.id, version: row.version + 1 },
      { destinationId: row.id, kind: row.kind, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: row.brandId },
    );
    return toDestinationDto(await destinationsRepo.getById(row.id, tx));
  },
};

export const sourceUsePolicyService = {
  /** A brand's source-use policies by kind then data type (brand.read). */
  async list(actor: ResolvedActor, input: z.infer<typeof SourceUsePolicyList>, tx?: Tx) {
    const parsed = SourceUsePolicyList.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const rows = await policiesRepo.listForBrand(parsed.brandId, parsed.destinationKind, tx);
    return { items: rows.map(toPolicyDto) };
  },

  /**
   * D-17: an admin records what the product may do with one data type of one destination kind (source_use.manage,
   * which agents never hold). The uses are limited to the kind's capabilities; `retain` needs a retention period;
   * the review date is ahead. The first record is version 1; a later one names the version it replaces and moves
   * it on, with who reviewed it and when.
   */
  async set(actor: ResolvedActor, input: z.input<typeof SourceUsePolicySet>, tx: Tx) {
    const parsed = SourceUsePolicySet.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const decision = await policy.assert(actor, 'source_use.manage', brandResource(parsed.brandId), {}, tx);
    assertMayDecide(decision);
    const allowedUses = [...new Set(parsed.allowedUses)];
    const issues = sourceUseIssues(parsed.destinationKind, allowedUses, parsed.retentionDays);
    if (issues.length)
      throw new ValidationFailedError(
        issues,
        `A ${DESTINATION_KIND_CAPABILITIES[parsed.destinationKind].label} supports ${DESTINATION_KIND_CAPABILITIES[parsed.destinationKind].uses.join(', ')} only, and retained data needs a retention period`,
      );
    const retains = allowedUses.includes('retain');
    const now = new Date();
    const reviewDueAt = new Date(parsed.reviewDueAt);
    if (reviewDueAt.getTime() <= now.getTime())
      throw new ValidationFailedError(
        [{ path: 'reviewDueAt', issue: 'not_in_future' }],
        'The next review must be ahead of today',
      );
    const values = {
      allowedUses,
      retentionDays: retains ? (parsed.retentionDays ?? null) : null, // a period without `retain` means nothing
      reviewedAt: now,
      reviewDueAt,
      reviewedById: actor.id,
    };
    const existing = await policiesRepo.lockByKey(
      parsed.brandId,
      parsed.destinationKind,
      parsed.dataType,
      tx,
    );
    let id: string;
    if (existing) {
      if (parsed.expectedVersion !== existing.version)
        throw new ConflictError('SourceUsePolicy', existing.id, parsed.expectedVersion ?? existing.version);
      await policiesRepo.update(existing.id, existing.version, values, tx);
      id = existing.id;
    } else {
      id = newId('sourceUsePolicy');
      await policiesRepo.create(
        {
          id,
          brandId: parsed.brandId,
          destinationKind: parsed.destinationKind,
          dataType: parsed.dataType,
          version: 1, // the first record is version 1; the column's default (0) is never written
          ...values,
        },
        tx,
      );
    }
    const row = await policiesRepo.getById(id, tx);
    await audit.record(actorRef(actor), 'source_use.set', { type: 'source_use_policy', id }, 'allowed', tx, {
      brandId: parsed.brandId,
      destinationKind: parsed.destinationKind,
      dataType: parsed.dataType,
      fromVersion: existing?.version ?? null,
      toVersion: row.version,
    });
    return toPolicyDto(row);
  },

  /**
   * Whether one use of one data type is allowed now (brand.read): refused without a policy, once the review is
   * overdue, or when the use is not among the allowed ones. Callers that ingest or write ask this first.
   */
  async check(
    actor: ResolvedActor,
    input: z.infer<typeof SourceUseCheck>,
    tx?: Tx,
  ): Promise<SourceUseCheckResult> {
    const parsed = SourceUseCheck.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const row = await policiesRepo.findByKey(parsed.brandId, parsed.destinationKind, parsed.dataType, tx);
    return sourceUseDecision(row, parsed.use, new Date());
  },
};
