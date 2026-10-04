import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  ApprovalInvalidError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
  CapabilityUnsupportedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { ChannelVariantForPublishing } from '@oremedia/contracts/publishing';
import type { ReleaseDecision } from '@oremedia/contracts/review';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { requireTenant, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import {
  channelConnections,
  credentialRefs,
  pendingChannelGrants,
  publicationAttempts,
  publicationRemoteChanges,
  publications,
  remoteEvidence,
} from '@oremedia/db/schema/publishing';
import { brandDestinations } from '@oremedia/db/schema/destinations';
import { RENDERED_VALIDATION_DELAYS_MS } from '@oremedia/contracts/publishing';
import type { ArticleReadbackV1, ArticleReadbackVerificationV1 } from '@oremedia/contracts/destinations';
import type { RenderedValidationV1 } from '@oremedia/contracts/article';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { idempotent } from '@oremedia/module-operations';
import { createLogger } from '@oremedia/observability';
import { ProviderRegistry, ProviderTransportError } from '@oremedia/providers';
import { configureCredentialBroker, credentialBroker } from './broker';
import { channelService, configureConnectCallback, type ChannelConnectResult } from './channels';
import { channelHealth } from './health';
import { publicationWorkflowId } from './common';
import {
  configureChannelActivation,
  registerBrandChecker,
  registerApprovalConsumer,
  registerDestinationPublisher,
  registerProviderClients,
  registerPublishMediaSource,
  registerReleaseEvaluator,
  registerRevisionVariantSource,
  registerVariantSource,
  registerWorkflowProbe,
  resetApprovalConsumer,
  resetDestinationPublisher,
  resetReleaseEvaluator,
  resetRevisionVariantSource,
  resetVariantSource,
  type DestinationEditInput,
  type DestinationMutationResult,
  type DestinationPublishResult,
  type DestinationPublisher,
  type DestinationValidateInput,
  type ReleaseEvaluator,
  type RevisionWithVariants,
} from './hooks';
import { LocalKms, WrapOnlyKms } from './kms';
import { configurePublishingProviders } from './providers';
import { publicationService } from './publications';
import {
  PendingChannelGrantRepository,
  PublicationAttemptRepository,
  PublicationRepository,
} from './repositories';
import { createPublishingRuntime } from './runtime';
import { publishingToolSource } from './tools';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  connectedChannel,
  fixtureCapability,
} from './testing/fixture-provider';

/**
 * The publishing module against MySQL 8 (spec 14.1, 14.3 control/provider runtime, 14.7, 13.5): channel connect
 * with envelope encryption and the broker's process boundary, the scheduling command (idempotent occurrence,
 * fail-fast release check), the control activities driven in the workflow's order and each called twice (idempotent),
 * the attempt ledger (sentAt before the call, never a second send), crash-after-send reconciliation with exactly one
 * remote post, the cancel race, holds, re-release, disconnect, token refresh and the sweeper.
 */
const USER = 'usr_publishing_test';
const ctx = (tenantId: string, brandIds: ReadonlySet<string> | 'all' = 'all'): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds,
  correlationId: 'corr_publishing',
});
const manager = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_publishing_test',
  membershipStatus: 'active',
  role: 'owner',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);

const requireTenantId = () => requireTenant().tenantId;

const kms = new LocalKms('publishing-test-master-secret-0123456789');

describe('publishing module (spec 14) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  const B = manager(tenantB);
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  const uncertified = new FixtureProviderAdapter(
    fixtureCapability({ key: 'uncertified_fixture', certifiedAt: null }),
  );
  Object.defineProperty(uncertified, 'key', { value: 'uncertified_fixture' });
  registry.register(fixture).register(uncertified);
  const variantsById = new Map<string, ChannelVariantForPublishing>();
  let releaseDecision: ReleaseDecision = { allow: true };
  const releaseCalls: Array<{ id: string; state: string }> = [];
  /** Approvals the review module would have moved valid → consumed (the consumer hook, spec 13.1). */
  let consumedApprovals: Array<{ approvalId: string; publicationId: string }> = [];
  const recordingConsumer = async (approvalId: string, publicationId: string) => {
    consumedApprovals.push({ approvalId, publicationId });
  };
  let mediaFailure: Error | null = null;
  let runningWorkflows = new Set<string>();
  let connA = '';
  let connB = '';
  const runtime = createPublishingRuntime();
  const recordingEvaluator: ReleaseEvaluator = async (pub) => {
    releaseCalls.push({ id: pub.id, state: pub.state });
    // as reviewService.evaluateRelease: a consumed approval fails approval_valid
    if (consumedApprovals.some((c) => c.approvalId === pub.approvalId))
      return { allow: false, hold: true, reasons: ['approval_valid'] };
    return releaseDecision;
  };

  const wfInput = (publicationId: string, tenantId = tenantA) => ({
    tenantId,
    actor: { kind: 'user' as const, id: USER },
    correlationId: 'corr_publishing',
    publicationId,
  });
  const newVariant = (
    tenantId: string,
    brandId: string,
    channelConnectionId: string,
    text = 'Hello from the fixture',
  ): ChannelVariantForPublishing => {
    const v: ChannelVariantForPublishing = {
      id: newId('channelVariant'),
      tenantId,
      brandId,
      contentPackageId: newId('contentPackage'),
      contentRevisionId: newId('contentRevision'),
      channelConnectionId,
      destinationId: null,
      text,
      altTexts: [],
      settings: {},
      exportIds: [],
      exportHashes: [],
      article: null,
      version: 0,
    };
    variantsById.set(v.id, v);
    return v;
  };
  const schedule = (
    tenantId: string,
    variantId: string,
    at = new Date(Date.now() - 1000),
    occurrence?: string,
    approvalId: string = newId('releaseApproval'),
  ) =>
    run(tenantId, (tx) =>
      publicationService.schedule(
        manager(tenantId),
        {
          channelVariantId: variantId,
          scheduledFor: at.toISOString(),
          authority: 'approval',
          approvalId,
          ...(occurrence ? { occurrence } : {}),
        },
        tx,
      ),
    );
  const row = async (id: string) =>
    (await tdb.db.select().from(publications).where(eq(publications.id, id)))[0]!;
  const attemptsOf = (id: string) =>
    tdb.db.select().from(publicationAttempts).where(eq(publicationAttempts.publicationId, id));
  const evidenceOf = (id: string) =>
    tdb.db.select().from(remoteEvidence).where(eq(remoteEvidence.publicationId, id));
  const eventsOf = (tenantId: string, type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantId), eq(outboxEvents.eventType, type)));
  const connectionRow = async (id: string) =>
    (await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, id)))[0]!;
  const credentialRow = async (id: string) =>
    (await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, id)))[0]!;
  /** The dispatch prefix of spec 14.3 up to the open attempt. */
  const dispatch = async (publicationId: string, claimant = 'pub:wf:run-1') =>
    inTenant(tenantA, async () => {
      const claim = await runtime.control.claimForDispatch({ ...wfInput(publicationId), claimant });
      if (!claim.ok) throw new Error(`claim failed: ${claim.state}`);
      const release = await runtime.control.evaluateRelease({
        ...wfInput(publicationId),
        fencingToken: claim.fencingToken,
      });
      if (!release.allow) throw new Error(`release failed: ${release.reasons.join(',')}`);
      const attemptId = await runtime.control.openAttempt({
        ...wfInput(publicationId),
        fencingToken: claim.fencingToken,
      });
      return { claim, attemptId };
    });
  const connect = async (tenantId: string, brandId: string) => {
    const started = await run(tenantId, (tx) =>
      channelService.connect.start(
        manager(tenantId),
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return connectedChannel(
      await run(tenantId, (tx) =>
        channelService.connect.complete(manager(tenantId), { state: started.state, code: 'good' }, tx),
      ),
    );
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'publishing-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'publishing-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configurePublishingProviders({ registry, insecureAllowLoopback: true }); // the fixture's send is a loopback call
    configureCredentialBroker({ kms });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    registerBrandChecker({
      assertExist: async (ids) => {
        const known = new Set([brandA, brandB]);
        for (const id of ids) if (!known.has(id)) throw new NotFoundError('Brand', id);
      },
    });
    registerVariantSource(async (id) => {
      const v = variantsById.get(id);
      if (!v) throw new NotFoundError('ChannelVariant', id);
      return v;
    });
    registerReleaseEvaluator(recordingEvaluator);
    registerApprovalConsumer(recordingConsumer);
    registerPublishMediaSource({
      describe: async () => [],
      release: async () => {
        if (mediaFailure) throw mediaFailure;
        return [];
      },
    });
    registerWorkflowProbe({ isRunning: async (id) => runningWorkflows.has(id) });
    fixture.grant.remoteAccountId = 'acct_A';
    connA = (await connect(tenantA, brandA)).id;
    fixture.grant.remoteAccountId = 'acct_B';
    connB = (await connect(tenantB, brandB)).id;
    fixture.grant.remoteAccountId = 'acct_A';
  });
  afterAll(async () => {
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.behaviour = { kind: 'accept' };
    fixture.reconcileBehaviour = 'scan';
    releaseDecision = { allow: true };
    mediaFailure = null;
    runningWorkflows = new Set();
    consumedApprovals = [];
  });

  describe('hooks', () => {
    it('fail loudly when the variant source or release evaluator is not registered', async () => {
      resetVariantSource();
      const v = newVariant(tenantA, brandA, connA);
      await expect(schedule(tenantA, v.id)).rejects.toThrow(/variant source not registered/);
      registerVariantSource(async (id) => variantsById.get(id)!);
      resetReleaseEvaluator();
      await expect(schedule(tenantA, v.id)).rejects.toThrow(/release evaluator not registered/);
      registerReleaseEvaluator(recordingEvaluator);
    });
  });

  describe('channel connections and the credential broker (spec 14.7)', () => {
    it('connect sealed the grant: no plaintext in credential_refs, AAD binds tenant and connection, event emitted', async () => {
      const conn = await connectionRow(connA);
      expect(conn.status).toBe('active');
      expect(conn.grantedScopes).toEqual(['w_post']);
      const cred = await credentialRow(conn.credentialRefId);
      expect(cred.aad).toBe(`${tenantA}:${connA}`);
      for (const col of [cred.ciphertext, cred.wrappedDataKey])
        expect(Buffer.from(col, 'base64').toString('utf8')).not.toContain('at_fixture_secret');
      expect(cred.iv).toHaveLength(12);
      expect(JSON.stringify(await eventsOf(tenantA, 'channel.connected'))).not.toContain('at_fixture_secret');
      expect(
        (await eventsOf(tenantA, 'channel.connected')).map((e) => e.payload['channelConnectionId']),
      ).toContain(connA);
      const dto = (await inTenant(tenantA, () => channelService.list(A, { brandId: brandA })))[0]!;
      expect(dto.usable).toBe(true);
      expect(Object.keys(dto)).not.toContain('credentialRefId');
    });

    it('the platform limits list certified providers only, from the capability register (BSC-1)', async () => {
      const { items } = await inTenant(tenantA, () => channelService.limits(A, { brandId: brandA }));
      expect(items.map((i) => i.providerKey)).toEqual([fixture.key]);
      expect(items[0]).toMatchObject({
        capabilityVersion: fixture.capability.version,
        text: fixture.capability.text,
        altText: fixture.capability.media.altText,
      });
    });

    it('an uncertified provider cannot be connected (registry gate, spec 14.6)', async () => {
      await expect(
        run(tenantA, (tx) =>
          channelService.connect.start(
            A,
            { brandId: brandA, providerKey: 'uncertified_fixture', redirectUri: 'https://app.example/cb' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    });

    it('with a web origin configured the provider always returns to its one callback, whatever the client sends', async () => {
      const start = (redirectUri?: string) =>
        run(tenantA, (tx) =>
          channelService.connect.start(
            A,
            { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, ...(redirectUri ? { redirectUri } : {}) },
            tx,
          ),
        );
      configureConnectCallback('https://app.oreandtar.test');
      try {
        const redirected = new URL((await start('https://attacker.example/steal')).url);
        expect(redirected.searchParams.get('redirect_uri')).toBe(
          'https://app.oreandtar.test/connect/callback',
        );
        const omitted = new URL((await start()).url);
        expect(omitted.searchParams.get('redirect_uri')).toBe('https://app.oreandtar.test/connect/callback');
      } finally {
        configureConnectCallback(null);
      }
      // Without an origin (development), the client's redirect is used; with neither there is nowhere to return to.
      expect(new URL((await start('https://app.example/cb')).url).searchParams.get('redirect_uri')).toBe(
        'https://app.example/cb',
      );
      await expect(start()).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('a used or foreign-tenant connect state is refused', async () => {
      const started = await run(tenantA, (tx) =>
        channelService.connect.start(
          A,
          { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
          tx,
        ),
      );
      await expect(
        run(tenantB, (tx) => channelService.connect.complete(B, { state: started.state, code: 'good' }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      // consumed by the foreign attempt: the owner cannot use it either (one-shot)
      await expect(
        run(tenantA, (tx) => channelService.connect.complete(A, { state: started.state, code: 'good' }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('withCredentials decrypts in a worker, scrubs afterwards, and is NOT_FOUND across tenants', async () => {
      let seen: { accessToken: string } | null = null;
      const out = await inTenant(tenantA, () =>
        credentialBroker.withCredentials(tenantA, connA, async (creds, ref) => {
          seen = creds;
          expect(ref.providerKey).toBe(FIXTURE_PROVIDER_KEY);
          return creds.accessToken;
        }),
      );
      expect(out).toBe('at_fixture_secret');
      expect(seen!.accessToken).toBe(''); // scrubbed after use
      await expect(
        inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, connB, async () => 'x')),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inTenant(tenantA, () => credentialBroker.withCredentials(tenantB, connB, async () => 'x')),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('the API process (WrapOnlyKms) can seal but never decrypt: credential_decrypt_not_permitted', async () => {
      configureCredentialBroker({ kms: new WrapOnlyKms(kms) });
      try {
        expect(credentialBroker.canDecrypt()).toBe(false);
        await expect(
          inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, connA, async () => 'x')),
        ).rejects.toMatchObject({ reason: 'credential_decrypt_not_permitted' });
        const sealed = await credentialBroker.seal(tenantA, connA, { accessToken: 'x' });
        expect(sealed.aad).toBe(`${tenantA}:${connA}`);
      } finally {
        configureCredentialBroker({ kms });
      }
    });

    it('channelUsable: active with the required scopes; false for a foreign id; false when scopes are missing', async () => {
      expect(await inTenant(tenantA, () => channelService.channelUsable(connA))).toBe(true);
      expect(await inTenant(tenantA, () => channelService.channelUsable(connB))).toBe(false);
      await tdb.db
        .update(channelConnections)
        .set({ grantedScopes: [] })
        .where(eq(channelConnections.id, connA));
      expect(await inTenant(tenantA, () => channelService.channelUsable(connA))).toBe(false);
      await tdb.db
        .update(channelConnections)
        .set({ grantedScopes: ['w_post'] })
        .where(eq(channelConnections.id, connA));
    });

    it('validateVariant runs the adapter against the capability register', async () => {
      const ok = newVariant(tenantA, brandA, connA);
      const long = newVariant(tenantA, brandA, connA, 'x'.repeat(300));
      expect(await inTenant(tenantA, () => channelService.validateVariant(ok.id))).toBe(true);
      expect(await inTenant(tenantA, () => channelService.validateVariantDetailed(long.id))).toMatchObject({
        ok: false,
      });
    });
  });

  describe('choosing the account when the grant addresses several (spec 14.7)', () => {
    const OTHER_USER = 'usr_publishing_other';
    let seq = 0;
    /** Starts and completes a flow whose login manages `primary` plus the given alternatives. */
    const completeWith = async (
      primary: string,
      alternatives: string[],
      actor: ResolvedActor = A,
    ): Promise<ChannelConnectResult> => {
      const saved = fixture.grant;
      fixture.grant = {
        ...saved,
        remoteAccountId: primary,
        displayName: `Page ${primary}`,
        alternatives: alternatives.map((id) => ({ remoteAccountId: id, displayName: `Page ${id}` })),
      };
      try {
        const started = await run(tenantA, (tx) =>
          channelService.connect.start(
            actor,
            { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
            tx,
          ),
        );
        return await run(tenantA, (tx) =>
          channelService.connect.complete(actor, { state: started.state, code: 'good' }, tx),
        );
      } finally {
        fixture.grant = saved;
      }
    };
    /** A choice among three fresh accounts; the fixture must still list them when `select` runs. */
    const choose = async () => {
      seq += 1;
      const ids = [`acct_choice_${seq}_1`, `acct_choice_${seq}_2`, `acct_choice_${seq}_3`];
      const result = await completeWith(ids[0]!, ids.slice(1));
      if (result.outcome !== 'choose') throw new Error('expected a choice');
      return { ...result, ids };
    };
    const pendingRows = (pendingId: string) =>
      tdb.db.select().from(pendingChannelGrants).where(eq(pendingChannelGrants.pendingId, pendingId));
    const connectionsFor = (remoteAccountId: string) =>
      tdb.db
        .select()
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.tenantId, tenantA),
            eq(channelConnections.remoteAccountId, remoteAccountId),
          ),
        );
    const select = (
      pendingId: string,
      remoteAccountId: string,
      actor: ResolvedActor = A,
      tenantId = tenantA,
    ) => run(tenantId, (tx) => channelService.connect.select(actor, { pendingId, remoteAccountId }, tx));

    it('one account: connects as before, outcome connected, nothing pending', async () => {
      const result = await completeWith('acct_single_only', []);
      expect(result).toMatchObject({
        outcome: 'connected',
        remoteAccountId: 'acct_single_only',
        status: 'active',
      });
      expect(await tdb.db.select().from(pendingChannelGrants)).toEqual([]);
    });

    it('several: nothing is connected; each account is offered and sealed for its own connection', async () => {
      const choice = await choose();
      expect(choice.options).toEqual(
        choice.ids.map((id) => ({ remoteAccountId: id, displayName: `Page ${id}` })),
      );
      expect(choice).toMatchObject({ brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, unavailable: 0 });
      expect(Date.parse(choice.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
      for (const id of choice.ids) expect(await connectionsFor(id)).toEqual([]);
      const rows = await pendingRows(choice.pendingId);
      expect(rows.map((r) => r.remoteAccountId)).toEqual(choice.ids);
      for (const r of rows) {
        expect(r).toMatchObject({ tenantId: tenantA, brandId: brandA, actorKind: 'user', actorId: USER });
        expect(r.aad).toBe(`${tenantA}:${r.channelConnectionId}`);
        for (const col of [r.ciphertext, r.wrappedDataKey])
          expect(Buffer.from(col, 'base64').toString('utf8')).not.toMatch(/at_fixture_secret|at_page_/);
      }
      // The answer carries names only: no token, no credential reference, no connection id.
      expect(JSON.stringify(choice)).not.toMatch(/at_fixture_secret|at_page_|cc_|cr_/);
    });

    it('select connects the chosen account with its own token, in the API process (no decrypt), once', async () => {
      const choice = await choose();
      const chosen = choice.ids[1]!;
      configureCredentialBroker({ kms: new WrapOnlyKms(kms) });
      let connected;
      try {
        connected = await select(choice.pendingId, chosen);
      } finally {
        configureCredentialBroker({ kms });
      }
      expect(connected).toMatchObject({
        outcome: 'connected',
        remoteAccountId: chosen,
        displayName: `Page ${chosen}`,
      });
      expect(connected.missingScopes).toEqual([]);
      for (const other of [choice.ids[0]!, choice.ids[2]!]) expect(await connectionsFor(other)).toEqual([]);
      const token = await inTenant(tenantA, () =>
        credentialBroker.withCredentials(tenantA, connected.id, async (creds) => creds.accessToken),
      );
      expect(token).toBe(`at_page_${chosen}`);
      expect(await pendingRows(choice.pendingId)).toEqual([]); // every sealed grant of the choice is gone
      expect(
        (await eventsOf(tenantA, 'channel.connected')).map((e) => e.payload['channelConnectionId']),
      ).toContain(connected.id);
      // One-shot: the same choice cannot connect again, not even another of its accounts.
      await expect(select(choice.pendingId, choice.ids[2]!)).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
    });

    it('choosing an account already connected to the brand rotates that connection', async () => {
      const first = await completeWith('acct_rotate_me', []);
      if (first.outcome !== 'connected') throw new Error('expected a connection');
      const before = await connectionRow(first.id);
      const result = await completeWith('acct_rotate_other', ['acct_rotate_me']);
      if (result.outcome !== 'choose') throw new Error('expected a choice');
      const rows = await pendingRows(result.pendingId);
      expect(rows.find((r) => r.remoteAccountId === 'acct_rotate_me')?.channelConnectionId).toBe(first.id);
      const rotated = await select(result.pendingId, 'acct_rotate_me');
      expect(rotated.id).toBe(first.id);
      const after = await connectionRow(first.id);
      expect(after.credentialRefId).not.toBe(before.credentialRefId);
      expect((await credentialRow(before.credentialRefId)).destroyedAt).not.toBeNull();
    });

    it('an account the choice did not offer is refused and the choice stays open', async () => {
      const choice = await choose();
      await expect(select(choice.pendingId, 'acct_not_offered')).rejects.toMatchObject({
        details: [{ path: 'remoteAccountId', issue: 'account_not_offered' }],
      });
      expect(await pendingRows(choice.pendingId)).toHaveLength(3);
      await expect(select(choice.pendingId, choice.ids[0]!)).resolves.toMatchObject({ outcome: 'connected' });
    });

    it('another actor, another tenant or a brand out of scope cannot choose (the choice is not revealed)', async () => {
      const choice = await choose();
      const other: ResolvedActor = { ...A, id: OTHER_USER };
      await expect(select(choice.pendingId, choice.ids[0]!, other)).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
      await expect(select(choice.pendingId, choice.ids[0]!, B, tenantB)).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
      await expect(
        runInTenant(ctx(tenantA, new Set([newId('brand')])), () =>
          withTransaction((tx) =>
            channelService.connect.select(
              A,
              { pendingId: choice.pendingId, remoteAccountId: choice.ids[0]! },
              tx,
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        run(tenantB, (tx) => channelService.connect.cancel(B, { pendingId: choice.pendingId }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(await pendingRows(choice.pendingId)).toHaveLength(3); // refused attempts consume nothing
      for (const id of choice.ids) expect(await connectionsFor(id)).toEqual([]);
    });

    it('an expired choice is refused and its sealed grants are destroyed', async () => {
      const choice = await choose();
      await tdb.db
        .update(pendingChannelGrants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(pendingChannelGrants.pendingId, choice.pendingId));
      await expect(select(choice.pendingId, choice.ids[0]!)).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
      expect(await pendingRows(choice.pendingId)).toEqual([]);
      expect(await connectionsFor(choice.ids[0]!)).toEqual([]);
    });

    it('any connect flow in the tenant destroys expired choices', async () => {
      const choice = await choose();
      await tdb.db
        .update(pendingChannelGrants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(pendingChannelGrants.pendingId, choice.pendingId));
      await completeWith('acct_sweeps_expired', []);
      expect(await pendingRows(choice.pendingId)).toEqual([]);
    });

    it('cancel destroys the choice; it cannot be chosen afterwards; cancel is audited', async () => {
      const choice = await choose();
      await expect(
        run(tenantA, (tx) => channelService.connect.cancel(A, { pendingId: choice.pendingId }, tx)),
      ).resolves.toEqual({ pendingId: choice.pendingId, cancelled: true });
      expect(await pendingRows(choice.pendingId)).toEqual([]);
      await expect(select(choice.pendingId, choice.ids[0]!)).rejects.toBeInstanceOf(ValidationFailedError);
      const audited = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.connect.cancel')));
      expect(audited.length).toBeGreaterThan(0);
    });

    it('a stale choice (the account was connected by another flow meanwhile) is refused', async () => {
      const choice = await choose();
      const [first, second] = [choice.ids[0]!, choice.ids[1]!];
      await completeWith(first, []); // connected directly, as a new connection with another id
      await expect(select(choice.pendingId, first)).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_stale' }],
      });
      await expect(select(choice.pendingId, second)).resolves.toMatchObject({ remoteAccountId: second });
    });

    it('an account the provider no longer returns is left out and counted; the others are still offered', async () => {
      seq += 1;
      const ids = [`acct_gone_${seq}_1`, `acct_gone_${seq}_2`, `acct_gone_${seq}_3`];
      fixture.unavailableAccounts.add(ids[1]!);
      try {
        const listed = await completeWith(ids[0]!, ids.slice(1));
        expect(listed).toMatchObject({ outcome: 'choose', unavailable: 1 });
        if (listed.outcome !== 'choose') throw new Error('expected a choice');
        expect(listed.options.map((o) => o.remoteAccountId)).toEqual([ids[0], ids[2]]);
        // Without a one-listing method the flow asks per account: one failure is left out the same way.
        Object.defineProperty(fixture, 'accountGrants', { value: undefined, configurable: true });
        const perAccount = await completeWith(ids[0]!, ids.slice(1));
        expect(perAccount).toMatchObject({ outcome: 'choose', unavailable: 1 });
        if (perAccount.outcome !== 'choose') throw new Error('expected a choice');
        expect(perAccount.options.map((o) => o.remoteAccountId)).toEqual([ids[0], ids[2]]);
        const audited = await tdb.db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.connect.choose')));
        expect(JSON.stringify(audited.map((a) => a.metadata))).toContain('unavailable=1');
      } finally {
        delete (fixture as { accountGrants?: unknown }).accountGrants;
        fixture.unavailableAccounts.clear();
      }
    });

    it('the primary account connected to another brand: the person still chooses, even with one account left', async () => {
      seq += 1;
      const [elsewhere, here] = [`acct_other_brand_${seq}`, `acct_left_${seq}`];
      const brandA2 = newId('brand');
      await tdb.db.insert(brands).values({
        id: brandA2,
        tenantId: tenantA,
        name: 'A2',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
      });
      await tdb.db.insert(channelConnections).values({
        id: newId('channelConnection'),
        tenantId: tenantA,
        brandId: brandA2,
        providerKey: FIXTURE_PROVIDER_KEY,
        remoteAccountId: elsewhere,
        displayName: 'Elsewhere',
        credentialRefId: (await connectionRow(connA)).credentialRefId,
        grantedScopes: ['w_post'],
        status: 'active',
        capabilityVersion: 1,
      });
      const result = await completeWith(elsewhere, [here]);
      expect(result).toMatchObject({ outcome: 'choose', unavailable: 0 });
      if (result.outcome !== 'choose') throw new Error('expected a choice');
      expect(result.options).toEqual([{ remoteAccountId: here, displayName: `Page ${here}` }]);
      expect(await connectionsFor(here)).toEqual([]); // nothing connected silently
      // Only accounts of other brands: refused as before.
      await expect(completeWith(elsewhere, [])).rejects.toMatchObject({
        details: [{ path: 'providerKey', issue: 'remote_account_connected_to_another_brand' }],
      });
    });

    it('select replays with the same idempotency key: one connection, the stored answer', async () => {
      const choice = await choose();
      const input = { pendingId: choice.pendingId, remoteAccountId: choice.ids[0]! };
      const call = () =>
        inTenant(tenantA, () =>
          idempotent(
            {
              idempotency: {
                key: `idem_select_${choice.pendingId}`,
                path: 'publishing.channels.connect.select',
                requestHash: hashCanonical(input),
              },
              actor: { kind: 'user', id: USER },
            },
            (tx) => channelService.connect.select(A, input, tx),
          ),
        );
      const first = await call();
      const again = await call();
      expect(again).toEqual(first);
      expect(await connectionsFor(choice.ids[0]!)).toHaveLength(1);
    });

    it('concurrent selects of one choice: exactly one connects', async () => {
      const choice = await choose();
      const results = await Promise.allSettled([
        select(choice.pendingId, choice.ids[0]!),
        select(choice.pendingId, choice.ids[1]!),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(ValidationFailedError);
      const connected = [
        ...(await connectionsFor(choice.ids[0]!)),
        ...(await connectionsFor(choice.ids[1]!)),
      ];
      expect(connected).toHaveLength(1);
      expect(await pendingRows(choice.pendingId)).toEqual([]);
    });

    it('a failing purge of expired choices never fails the connect flow', async () => {
      const spy = vi
        .spyOn(PendingChannelGrantRepository.prototype, 'deleteExpired')
        .mockRejectedValue(Object.assign(new Error('lock wait'), { code: 'ER_LOCK_WAIT_TIMEOUT' }));
      try {
        const choice = await choose();
        await expect(select(choice.pendingId, choice.ids[0]!)).resolves.toMatchObject({
          outcome: 'connected',
        });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('the periodic purge shreds and deletes expired choices in every tenant, and keeps live ones', async () => {
      const live = await choose();
      const expired = await choose();
      const foreignId = newId('pendingChannelGrant');
      await tdb.db.insert(pendingChannelGrants).values({
        id: newId('pendingChannelGrant'),
        tenantId: tenantB,
        brandId: brandB,
        pendingId: foreignId,
        providerKey: FIXTURE_PROVIDER_KEY,
        actorKind: 'user',
        actorId: USER,
        position: 0,
        remoteAccountId: 'acct_b_expired',
        displayName: 'B',
        channelConnectionId: newId('channelConnection'),
        grantedScopes: [],
        kmsKeyId: 'k',
        wrappedDataKey: 'd3JhcHBlZA==',
        ciphertext: 'Y2lwaGVy',
        iv: 'iv',
        authTag: 't',
        aad: 'x',
        expiresAt: new Date(Date.now() - 60_000),
      });
      await tdb.db
        .update(pendingChannelGrants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(pendingChannelGrants.pendingId, expired.pendingId));
      const result = await runtime.connectChoicePurge.purgeExpiredConnectChoices({
        correlationId: 'corr_purge',
        now: new Date().toISOString(),
      });
      expect(result.rows).toBeGreaterThanOrEqual(4); // three of tenant A, one of tenant B
      expect(await pendingRows(expired.pendingId)).toEqual([]);
      expect(await pendingRows(foreignId)).toEqual([]);
      expect(await pendingRows(live.pendingId)).toHaveLength(3);
    });
  });

  describe('scheduling command (spec 14.1)', () => {
    it('an approved variant schedules: row scheduled, outbox event with the stable workflow id, audit, release pre-check recorded', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const at = new Date(Date.now() + 3600_000);
      const pub = await schedule(tenantA, v.id, at);
      expect(pub.state).toBe('scheduled');
      expect(pub.occurrenceKey).toBe(`${v.contentRevisionId}:${connA}:once`);
      expect(releaseCalls.at(-1)).toEqual({ id: 'preview', state: 'scheduled' });
      const evt = (await eventsOf(tenantA, 'publication.scheduled')).find(
        (e) => e.payload['publicationId'] === pub.id,
      )!;
      expect(evt.payload).toMatchObject({
        workflowId: publicationWorkflowId(pub.id, 0),
        rerelease: false,
        scheduledFor: at.toISOString(),
      });
      expect((await row(pub.id)).claimant).toBe(`pub:${pub.id}`);
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, pub.id)));
      expect(audits.map((a) => a.action)).toContain('publication.schedule');
    });

    it('a repeat with the same occurrence key is CONFLICT and never a second row; a new occurrence is distinct', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const first = await schedule(tenantA, v.id);
      await expect(schedule(tenantA, v.id)).rejects.toBeInstanceOf(ConflictError);
      const again = await schedule(tenantA, v.id, new Date(), 'week-2');
      expect(again.id).not.toBe(first.id);
      const rows = await tdb.db.select().from(publications).where(eq(publications.channelVariantId, v.id));
      expect(rows).toHaveLength(2);
    });

    it('a failed release pre-check is APPROVAL_INVALID with the reasons and writes no row', async () => {
      const v = newVariant(tenantA, brandA, connA);
      releaseDecision = { allow: false, hold: true, reasons: ['approval_matches'] };
      await expect(schedule(tenantA, v.id)).rejects.toMatchObject({ reasons: ['approval_matches'] });
      await expect(schedule(tenantA, v.id)).rejects.toBeInstanceOf(ApprovalInvalidError);
      expect(
        await tdb.db.select().from(publications).where(eq(publications.channelVariantId, v.id)),
      ).toHaveLength(0);
    });

    it("a foreign tenant's variant or channel is NOT_FOUND with no writes", async () => {
      const vB = newVariant(tenantB, brandB, connB);
      const before = (await tdb.db.select().from(publications).where(eq(publications.tenantId, tenantB)))
        .length;
      await expect(schedule(tenantA, vB.id)).rejects.toBeInstanceOf(NotFoundError);
      const crossChannel = newVariant(tenantA, brandA, connB);
      await expect(schedule(tenantA, crossChannel.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await tdb.db.select().from(publications).where(eq(publications.tenantId, tenantB))).length,
      ).toBe(before);
      await expect(
        inTenant(tenantA, () => publicationService.get(A, { publicationId: newId('publication') })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('an approval authority without an approval id is a validation failure', async () => {
      const v = newVariant(tenantA, brandA, connA);
      await expect(
        run(tenantA, (tx) =>
          publicationService.schedule(
            A,
            { channelVariantId: v.id, scheduledFor: new Date().toISOString(), authority: 'approval' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });

  describe('proposeSchedule (spec 12.4 publications.proposeSchedule): checks a slot, writes nothing', () => {
    const revisionsById = new Map<string, RevisionWithVariants>();
    const agent = (tenantId: string): ResolvedActorServicePrincipal => ({
      kind: 'service_principal',
      id: 'sp_publishing_tools',
      tenantId,
      status: 'active',
      maxAutonomy: 'prepare_release',
      grants: [{ action: 'publication.schedule', brandIds: 'all', channelConnectionIds: 'all' }],
    });
    const revision = (tenantId: string, brandId: string, state: string, channelIds: string[]) => {
      const r: RevisionWithVariants = {
        id: newId('contentRevision'),
        brandId,
        state,
        variants: channelIds.map((c) => ({
          id: newId('channelVariant'),
          channelConnectionId: c,
          destinationId: null,
        })),
      };
      revisionsById.set(`${tenantId}:${r.id}`, r);
      return r;
    };
    const propose = (
      contentRevisionId: string,
      over: Partial<{ channelConnectionIds: string[]; proposedAt: string; autonomyMode: AutonomyMode }> = {},
    ) =>
      runInTenant({ ...ctx(tenantA), actor: { kind: 'service_principal', id: 'sp_publishing_tools' } }, () =>
        withTransaction((tx) =>
          publishingToolSource.proposeSchedule(
            agent(tenantA),
            {
              brandId: brandA,
              runId: 'run_publishing_tools',
              autonomyMode: over.autonomyMode ?? 'prepare_release',
              contentRevisionId,
              channelConnectionIds: over.channelConnectionIds ?? [connA],
              proposedAt: over.proposedAt ?? new Date(Date.now() + 86_400_000).toISOString(),
            },
            tx,
          ),
        ),
      );
    const writes = async () =>
      JSON.stringify({
        publications: await tdb.db.select().from(publications),
        outbox: (await tdb.db.select().from(outboxEvents)).length,
      });
    beforeAll(() => {
      registerRevisionVariantSource(async (id) => {
        const r = revisionsById.get(`${requireTenantId()}:${id}`);
        if (!r) throw new NotFoundError('ContentRevision', id);
        return r;
      });
    });
    afterAll(() => resetRevisionVariantSource());

    it('returns one publications.schedule command per channel for an approved revision, and writes nothing', async () => {
      const r = revision(tenantA, brandA, 'approved', [connA]);
      const before = await writes();
      const at = new Date(Date.now() + 86_400_000).toISOString();
      const out = await propose(r.id, { proposedAt: at, channelConnectionIds: [connA, connA] });
      expect(out).toEqual({
        entries: [{ channelConnectionId: connA, channelVariantId: r.variants[0]!.id, scheduledFor: at }],
      });
      expect(await writes()).toBe(before);
    });

    it('refuses an unapproved revision, a past slot, a channel without a variant and a lower autonomy mode', async () => {
      const draft = revision(tenantA, brandA, 'in_review', [connA]);
      await expect(propose(draft.id)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'contentRevisionId', issue: 'revision is in_review, not approved' }],
      });
      const approved = revision(tenantA, brandA, 'approved', []);
      await expect(
        propose(approved.id, { proposedAt: new Date(Date.now() - 60_000).toISOString() }),
      ).rejects.toMatchObject({
        details: [
          { path: 'proposedAt', issue: 'must be in the future' },
          { path: 'channelConnectionIds.0', issue: 'no_channel_variant' },
        ],
      });
      const ok = revision(tenantA, brandA, 'approved', [connA]);
      await expect(propose(ok.id, { autonomyMode: 'create' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        reason: 'autonomy_insufficient',
      });
    });

    it("a foreign tenant's revision or channel, or another brand's revision, is NOT_FOUND with no writes", async () => {
      const before = await writes();
      const foreign = revision(tenantB, brandB, 'approved', [connB]);
      await expect(propose(foreign.id)).rejects.toBeInstanceOf(NotFoundError);
      const ok = revision(tenantA, brandA, 'approved', [connA]);
      await expect(propose(ok.id, { channelConnectionIds: [connB] })).rejects.toBeInstanceOf(NotFoundError);
      const otherBrand = revision(tenantA, newId('brand'), 'approved', [connA]);
      await expect(propose(otherBrand.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await writes()).toBe(before);
    });

    it('fails loudly when the revision variant source is not registered', async () => {
      resetRevisionVariantSource();
      try {
        await expect(propose('cr_any')).rejects.toThrow(/revision variant source not registered/);
      } finally {
        registerRevisionVariantSource(async (id) => {
          const r = revisionsById.get(`${requireTenantId()}:${id}`);
          if (!r) throw new NotFoundError('ContentRevision', id);
          return r;
        });
      }
    });
  });

  describe('dispatch runtime (spec 14.3), every control activity idempotent', () => {
    it('scheduled → dispatching → published with an attempt row, sentAt, remote evidence and the release check recorded', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      expect(await inTenant(tenantA, () => runtime.control.readSchedule(wfInput(pub.id)))).toMatchObject({
        state: 'scheduled',
      });
      const claim = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-1' }),
      );
      const claimAgain = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-1' }),
      );
      expect(claim).toEqual({
        ok: true,
        fencingToken: 1,
        providerKey: FIXTURE_PROVIDER_KEY,
        channelConnectionId: connA,
      });
      expect(claimAgain).toEqual(claim); // idempotent per claimant
      expect(
        await inTenant(tenantA, () =>
          runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-2' }),
        ),
      ).toEqual({ ok: false, state: 'dispatching' });
      const release = await inTenant(tenantA, () =>
        runtime.control.evaluateRelease({ ...wfInput(pub.id), fencingToken: 1 }),
      );
      expect(release).toEqual({ allow: true });
      expect(releaseCalls.at(-1)).toEqual({ id: pub.id, state: 'dispatching' });
      const attemptId = await inTenant(tenantA, () =>
        runtime.control.openAttempt({ ...wfInput(pub.id), fencingToken: 1 }),
      );
      expect(
        await inTenant(tenantA, () => runtime.control.openAttempt({ ...wfInput(pub.id), fencingToken: 1 })),
      ).toBe(attemptId);
      const opened = (await attemptsOf(pub.id))[0]!;
      expect(opened).toMatchObject({
        attemptNumber: 1,
        fencingToken: 1,
        sentAt: null,
        finishedAt: null,
        providerIdempotencyKey: attemptId,
      });
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(result).toMatchObject({ outcome: 'accepted', remotePostId: 'post_1' });
      const sent = (await attemptsOf(pub.id))[0]!;
      expect(sent.sentAt).not.toBeNull();
      expect(sent.finishedAt).not.toBeNull();
      expect(sent.outcome).toBe('accepted');
      const published = await inTenant(tenantA, () =>
        runtime.control.markPublished({ ...wfInput(pub.id), attempt: result }),
      );
      expect(published).toMatchObject({ state: 'published', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(pub.id), attempt: result })),
      ).toMatchObject({ state: 'published', changed: false });
      expect(await row(pub.id)).toMatchObject({
        state: 'published',
        remotePostId: 'post_1',
        remoteUrl: 'https://fixture.example/p/post_1',
      });
      const evidence = await evidenceOf(pub.id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ kind: 'accepted_response', remotePostId: 'post_1', attemptId });
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, pub.id)));
      expect(audits.find((a) => a.action === 'publication.release_check')?.decision).toBe('allowed');
      // a repeat publishOnce after the outcome is recorded never re-sends
      const publishCalls = fixture.calls.filter((c) => c === `publish:${attemptId}`).length;
      expect(
        await inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
        ),
      ).toMatchObject({ outcome: 'accepted' });
      expect(fixture.calls.filter((c) => c === `publish:${attemptId}`).length).toBe(publishCalls);
    });

    it('crash after send → outcome_unknown → reconciliation finds the post → published with NO second remote post', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Crash after send caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'crash_after_send' };
      const postsBefore = fixture.posts.length;
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(result.outcome).toBe('unknown');
      expect(fixture.posts.length).toBe(postsBefore + 1); // the platform has the post
      const attempt = (await attemptsOf(pub.id))[0]!;
      expect(attempt.sentAt).not.toBeNull();
      expect(attempt.outcome).toBe('unknown');
      expect(
        await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId })),
      ).toMatchObject({ state: 'outcome_unknown', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId })),
      ).toMatchObject({ changed: false });
      // a resumed activity after sentAt never re-sends
      fixture.behaviour = { kind: 'accept' };
      expect(
        await inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
        ),
      ).toMatchObject({ outcome: 'unknown' });
      const found = await inTenant(tenantA, () =>
        runtime.provider.findRemotePost({ ...wfInput(pub.id), attemptId }),
      );
      expect(found).toMatchObject({ status: 'found', matchedBy: 'fingerprint' });
      if (found.status !== 'found') throw new Error('unreachable');
      await inTenant(tenantA, () =>
        runtime.control.markPublished({ ...wfInput(pub.id), evidence: { ...found, attemptId } }),
      );
      expect(await row(pub.id)).toMatchObject({ state: 'published', remotePostId: found.remotePostId });
      expect((await evidenceOf(pub.id))[0]).toMatchObject({ kind: 'reconciliation' });
      expect(fixture.posts.length).toBe(postsBefore + 1); // exactly one post, never a duplicate
      expect((await attemptsOf(pub.id))[0]!.remotePostId).toBe(found.remotePostId);
    });

    it('reconciliation that proves absence → retry_eligible; exhausted → held for a human', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Absent caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'after_send_failure' };
      fixture.posts.length = 0;
      expect(
        (
          await inTenant(tenantA, () =>
            runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
          )
        ).outcome,
      ).toBe('unknown');
      fixture.posts.length = 0; // the platform lost it
      await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId }));
      expect(
        await inTenant(tenantA, () => runtime.provider.findRemotePost({ ...wfInput(pub.id), attemptId })),
      ).toEqual({ status: 'definitely_absent' });
      expect(await inTenant(tenantA, () => runtime.control.markRetryEligible(wfInput(pub.id)))).toMatchObject(
        { state: 'retry_eligible', changed: true },
      );
      expect(await inTenant(tenantA, () => runtime.control.markRetryEligible(wfInput(pub.id)))).toMatchObject(
        { changed: false },
      );
      // a human re-schedules the same occurrence: a new generation, a new attempt later
      const current = await row(pub.id);
      const released = await run(tenantA, (tx) =>
        publicationService.reschedule(
          A,
          { publicationId: pub.id, expectedVersion: current.version, scheduledFor: new Date().toISOString() },
          tx,
        ),
      );
      expect(released.state).toBe('scheduled');
      const evt = (await eventsOf(tenantA, 'publication.scheduled'))
        .filter((e) => e.payload['publicationId'] === pub.id)
        .at(-1)!;
      expect(evt.payload).toMatchObject({
        rerelease: true,
        workflowId: publicationWorkflowId(pub.id, current.version + 1),
      });
      expect((await row(pub.id)).claimant).toBe(publicationWorkflowId(pub.id, current.version + 1));

      const v2 = newVariant(tenantA, brandA, connA, 'Exhausted caption');
      const pub2 = await schedule(tenantA, v2.id);
      const d2 = await dispatch(pub2.id);
      fixture.reconcileBehaviour = 'cannot_determine';
      await inTenant(tenantA, () =>
        runtime.control.markOutcomeUnknown({ ...wfInput(pub2.id), attemptId: d2.attemptId }),
      );
      expect(
        await inTenant(tenantA, () =>
          runtime.provider.findRemotePost({ ...wfInput(pub2.id), attemptId: d2.attemptId }),
        ),
      ).toMatchObject({ status: 'cannot_determine' });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.holdForHuman({ ...wfInput(pub2.id), reason: 'outcome_unknown_unresolved' }),
        ),
      ).toMatchObject({ state: 'held', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.holdForHuman({ ...wfInput(pub2.id), reason: 'outcome_unknown_unresolved' }),
        ),
      ).toMatchObject({ changed: false });
      expect((await row(pub2.id)).holdReasons).toEqual(['outcome_unknown_unresolved']);
    });

    it('a retryable error proven pre-send (no sentAt) goes back to scheduled with a later time; with sentAt it is unknown', async () => {
      const v = newVariant(tenantA, brandA, connA);
      v.exportIds = ['exp_1'];
      v.exportHashes = ['a'.repeat(64)];
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      mediaFailure = new ProviderTransportError(
        Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        'before_send',
      );
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(result.outcome).toBe('retryable_error');
      expect((await attemptsOf(pub.id))[0]!.sentAt).toBeNull();
      const before = await row(pub.id);
      const retry = await inTenant(tenantA, () =>
        runtime.control.retryAfterProvenNoEffect({ ...wfInput(pub.id), attempt: result }),
      );
      expect(retry).toMatchObject({ retried: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.retryAfterProvenNoEffect({ ...wfInput(pub.id), attempt: result }),
        ),
      ).toEqual(retry); // idempotent
      const after = await row(pub.id);
      expect(after.state).toBe('scheduled');
      expect(after.scheduledFor.getTime()).toBeGreaterThan(before.scheduledFor.getTime());
      // the next claim issues a new fencing token and a second attempt
      mediaFailure = null;
      const second = await dispatch(pub.id, 'pub:wf:run-1');
      expect(second.claim.fencingToken).toBe(2);
      expect((await attemptsOf(pub.id)).map((a) => a.attemptNumber)).toEqual([1, 2]);
      const ok = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId: second.attemptId, fencingToken: 2 }),
      );
      expect(ok.outcome).toBe('accepted');
      // an attempt that was sent cannot be retried
      const sentRetry = await inTenant(tenantA, () =>
        runtime.control.retryAfterProvenNoEffect({
          ...wfInput(pub.id),
          attempt: { ...ok, outcome: 'retryable_error' },
        }),
      );
      expect(sentRetry).toEqual({ retried: false, reason: 'sent' });
      // a stale fencing token is refused
      await expect(
        inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('an adapter retryable_error before the first mutation leaves no sentAt → retried with backoff and a new attempt; after send → unknown', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Pre-send adapter failure caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'before_send_failure' };
      const postsBefore = fixture.posts.length;
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(result.outcome).toBe('retryable_error');
      expect((await attemptsOf(pub.id))[0]!.sentAt).toBeNull(); // nothing mutating left the process
      const before = await row(pub.id);
      const retry = await inTenant(tenantA, () =>
        runtime.control.retryAfterProvenNoEffect({ ...wfInput(pub.id), attempt: result }),
      );
      expect(retry).toMatchObject({ retried: true });
      const after = await row(pub.id);
      expect(after.state).toBe('scheduled');
      expect(after.scheduledFor.getTime()).toBeGreaterThan(before.scheduledFor.getTime());
      expect(fixture.posts.length).toBe(postsBefore);
      // the next dispatch opens a second attempt; this time the post-creating call fails after it left
      fixture.behaviour = { kind: 'after_send_failure' };
      const second = await dispatch(pub.id);
      expect(second.claim.fencingToken).toBe(2);
      expect((await attemptsOf(pub.id)).map((a) => a.attemptNumber).sort()).toEqual([1, 2]);
      const unknown = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId: second.attemptId, fencingToken: 2 }),
      );
      expect(unknown.outcome).toBe('unknown');
      const sentAttempt = (await attemptsOf(pub.id)).find((a) => a.id === second.attemptId)!;
      expect(sentAttempt.sentAt).not.toBeNull();
      expect(
        await inTenant(tenantA, () =>
          runtime.control.retryAfterProvenNoEffect({
            ...wfInput(pub.id),
            attempt: { ...unknown, outcome: 'retryable_error' },
          }),
        ),
      ).toEqual({ retried: false, reason: 'sent' });
    });

    it('publishing spends the release approval in the same transaction: another occurrence under it is refused at dispatch with approval_valid', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Single-use approval caption');
      const approvalId = newId('releaseApproval');
      const first = await schedule(tenantA, v.id, undefined, 'first', approvalId);
      const second = await schedule(tenantA, v.id, undefined, 'second', approvalId); // inside the timing tolerance
      const { attemptId } = await dispatch(first.id);
      const accepted = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(first.id), attemptId, fencingToken: 1 }),
      );
      // the consumer failing rolls the whole publish back: never published with a still-valid approval
      registerApprovalConsumer(async () => {
        throw new Error('review unavailable');
      });
      await expect(
        inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(first.id), attempt: accepted })),
      ).rejects.toThrow(/review unavailable/);
      expect((await row(first.id)).state).toBe('dispatching');
      expect(await evidenceOf(first.id)).toHaveLength(0);
      registerApprovalConsumer(recordingConsumer);
      await inTenant(tenantA, () =>
        runtime.control.markPublished({ ...wfInput(first.id), attempt: accepted }),
      );
      await inTenant(tenantA, () =>
        runtime.control.markPublished({ ...wfInput(first.id), attempt: accepted }),
      );
      expect(consumedApprovals).toEqual([{ approvalId, publicationId: first.id }]); // once, with the publication
      const claim = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({ ...wfInput(second.id), claimant: 'pub:wf:run-1' }),
      );
      if (!claim.ok) throw new Error('claim failed');
      expect(
        await inTenant(tenantA, () =>
          runtime.control.evaluateRelease({ ...wfInput(second.id), fencingToken: claim.fencingToken }),
        ),
      ).toEqual({ allow: false, reasons: ['approval_valid'] });
      // the loud default: an unwired composition root cannot publish silently with a reusable approval
      resetApprovalConsumer();
      try {
        const v3 = newVariant(tenantA, brandA, connA, 'Unwired consumer caption');
        const third = await schedule(tenantA, v3.id);
        const d3 = await dispatch(third.id);
        const ok = await inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(third.id), attemptId: d3.attemptId, fencingToken: 1 }),
        );
        await expect(
          inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(third.id), attempt: ok })),
        ).rejects.toThrow(/approval consumer not registered/);
      } finally {
        registerApprovalConsumer(recordingConsumer);
      }
    });

    it('JSON columns are validated on read: a malformed pending state or hold-reason list is refused, never spread raw', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Malformed JSON caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'pending' };
      await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      await tdb.db
        .update(publicationAttempts)
        .set({ pendingState: { remoteJobId: 42, data: 'not-an-object' } })
        .where(eq(publicationAttempts.id, attemptId));
      const call = { ...wfInput(pub.id), attemptId, fencingToken: 1 };
      const checksBefore = fixture.calls.filter((c) => c === 'checkStatus').length;
      await expect(inTenant(tenantA, () => runtime.provider.checkStatus(call))).rejects.toThrow();
      await expect(inTenant(tenantA, () => runtime.provider.finalize(call))).rejects.toThrow();
      expect(fixture.calls.filter((c) => c === 'checkStatus').length).toBe(checksBefore); // the adapter never saw it
      await tdb.db
        .update(publications)
        .set({ holdReasons: 'channel_active' as unknown as string[] })
        .where(eq(publications.id, pub.id));
      await expect(
        inTenant(tenantA, () => publicationService.get(A, { publicationId: pub.id })),
      ).rejects.toThrow();
      await tdb.db
        .update(publications)
        .set({ holdReasons: ['channel_active'] })
        .where(eq(publications.id, pub.id));
      expect(
        await inTenant(tenantA, () => publicationService.get(A, { publicationId: pub.id })),
      ).toMatchObject({
        holdReasons: ['channel_active'],
      });
    });

    it('rejected → failed; pending → processing → poll (finalize) → published', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'reject', code: 'content_policy' };
      const rejected = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      expect(rejected).toMatchObject({ outcome: 'rejected', errorCode: 'content_policy' });
      expect(
        await inTenant(tenantA, () => runtime.control.markFailed({ ...wfInput(pub.id), attempt: rejected })),
      ).toMatchObject({ state: 'failed', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.markFailed({ ...wfInput(pub.id), attempt: rejected })),
      ).toMatchObject({ changed: false });
      expect((await row(pub.id)).stateReason).toBe('content_policy');

      const v2 = newVariant(tenantA, brandA, connA, 'Pending caption');
      const pub2 = await schedule(tenantA, v2.id);
      const d2 = await dispatch(pub2.id);
      fixture.behaviour = { kind: 'pending' };
      fixture.pendingChecks = ['processing', 'ready'];
      const pending = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub2.id), attemptId: d2.attemptId, fencingToken: 1 }),
      );
      expect(pending.outcome).toBe('pending');
      expect(
        await inTenant(tenantA, () =>
          runtime.control.markProcessing({ ...wfInput(pub2.id), attempt: pending }),
        ),
      ).toMatchObject({ state: 'processing', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.markProcessing({ ...wfInput(pub2.id), attempt: pending }),
        ),
      ).toMatchObject({ changed: false });
      const call = { ...wfInput(pub2.id), attemptId: d2.attemptId, fencingToken: 1 };
      expect((await inTenant(tenantA, () => runtime.provider.checkStatus(call))).status).toBe('processing');
      expect((await inTenant(tenantA, () => runtime.provider.checkStatus(call))).status).toBe('ready');
      const done = await inTenant(tenantA, () => runtime.provider.finalize(call));
      expect(done.status).toBe('completed');
      expect((await inTenant(tenantA, () => runtime.provider.checkStatus(call))).status).toBe('completed'); // finalize-already-completed
      if (done.status !== 'completed') throw new Error('unreachable');
      await inTenant(tenantA, () =>
        runtime.control.markPublished({
          ...wfInput(pub2.id),
          attempt: { ...pending, remotePostId: done.remotePostId, remoteUrl: done.remoteUrl },
        }),
      );
      expect(await row(pub2.id)).toMatchObject({ state: 'published', remotePostId: done.remotePostId });
      expect((await evidenceOf(pub2.id))[0]).toMatchObject({ kind: 'status_poll' });
    });

    it('a failed release check at dispatch holds with reasons (dispatching → held), recorded as a denied check', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      releaseDecision = { allow: false, hold: true, reasons: ['approver_still_authorised'] };
      const claim = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'pub:wf:run-1' }),
      );
      if (!claim.ok) throw new Error('claim');
      const release = await inTenant(tenantA, () =>
        runtime.control.evaluateRelease({ ...wfInput(pub.id), fencingToken: claim.fencingToken }),
      );
      expect(release).toEqual({ allow: false, reasons: ['approver_still_authorised'] });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.hold({ ...wfInput(pub.id), reasons: ['approver_still_authorised'] }),
        ),
      ).toMatchObject({ state: 'held', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.hold({ ...wfInput(pub.id), reasons: ['approver_still_authorised'] }),
        ),
      ).toMatchObject({ changed: false });
      expect((await row(pub.id)).holdReasons).toEqual(['approver_still_authorised']);
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, pub.id)));
      expect(audits.find((a) => a.action === 'publication.release_check')).toMatchObject({
        decision: 'denied',
      });
      expect(await attemptsOf(pub.id)).toHaveLength(0);
      // a human re-releases: held → scheduled, new generation
      releaseDecision = { allow: true };
      const current = await row(pub.id);
      expect(
        (
          await run(tenantA, (tx) =>
            publicationService.reschedule(
              A,
              {
                publicationId: pub.id,
                expectedVersion: current.version,
                scheduledFor: new Date().toISOString(),
              },
              tx,
            ),
          )
        ).state,
      ).toBe('scheduled');
    });

    it('cross-tenant activity inputs: a foreign publication id, or a tenantId that does not own the row, is NOT_FOUND with no writes (ledger 5.33)', async () => {
      const vB = newVariant(tenantB, brandB, connB);
      const pubB = await schedule(tenantB, vB.id);
      const before = await row(pubB.id);
      await expect(
        inTenant(tenantA, () => runtime.control.claimForDispatch({ ...wfInput(pubB.id), claimant: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inTenant(tenantA, () => runtime.control.readSchedule(wfInput(pubB.id))),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inTenant(tenantA, () =>
          runtime.provider.publishOnce({ ...wfInput(pubB.id), attemptId: 'att_x', fencingToken: 1 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await row(pubB.id)).toEqual(before);
    });
  });

  describe('cancellation (spec 13.5) and rescheduling', () => {
    it('cancel before the claim: scheduled → cancelled with the expected version; a stale version is CONFLICT', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id, new Date(Date.now() + 3600_000));
      await expect(
        run(tenantA, (tx) => publicationService.cancel(A, { publicationId: pub.id, expectedVersion: 7 }, tx)),
      ).rejects.toBeInstanceOf(ConflictError);
      const res = await run(tenantA, (tx) =>
        publicationService.cancel(A, { publicationId: pub.id, expectedVersion: pub.version }, tx),
      );
      expect(res).toEqual({ prevented: true, state: 'cancelled', version: pub.version + 1 });
      expect(await inTenant(tenantA, () => runtime.control.readSchedule(wfInput(pub.id)))).toMatchObject({
        state: 'cancelled',
      }); // the workflow exits
      expect(
        await inTenant(tenantA, () =>
          runtime.control.claimForDispatch({ ...wfInput(pub.id), claimant: 'x' }),
        ),
      ).toEqual({ ok: false, state: 'cancelled' });
    });

    it('cancel during dispatch: { prevented: false } and a cancel_requested event that names the workflow; the signal cancels before the attempt opens', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const claim = await inTenant(tenantA, () =>
        runtime.control.claimForDispatch({
          ...wfInput(pub.id),
          claimant: `pub:${pub.id}:11111111-2222-3333-4444-555555555555`,
        }),
      );
      if (!claim.ok) throw new Error('claim');
      const res = await run(tenantA, (tx) =>
        publicationService.cancel(A, { publicationId: pub.id, expectedVersion: 0 }, tx),
      );
      expect(res).toEqual({
        prevented: false,
        state: 'dispatching',
        message: 'Dispatch in progress; outcome will be reconciled',
      });
      const evt = (await eventsOf(tenantA, 'publication.cancel_requested')).find(
        (e) => e.payload['publicationId'] === pub.id,
      )!;
      expect(evt.payload['workflowId']).toBe(`pub:${pub.id}`);
      expect((await row(pub.id)).state).toBe('dispatching');
      const cancelled = await inTenant(tenantA, () =>
        runtime.control.releaseClaimAndCancel({ ...wfInput(pub.id), fencingToken: claim.fencingToken }),
      );
      expect(cancelled).toMatchObject({ state: 'cancelled', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.releaseClaimAndCancel({ ...wfInput(pub.id), fencingToken: claim.fencingToken }),
        ),
      ).toMatchObject({ changed: false });
      expect(await attemptsOf(pub.id)).toHaveLength(0);
    });

    it('cancelIfNotStarted (the wait-loop cancel) is a no-op once dispatch started, and idempotent otherwise', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      expect(
        await inTenant(tenantA, () => runtime.control.cancelIfNotStarted(wfInput(pub.id))),
      ).toMatchObject({ state: 'cancelled', changed: true });
      expect(
        await inTenant(tenantA, () => runtime.control.cancelIfNotStarted(wfInput(pub.id))),
      ).toMatchObject({ changed: false });
      const v2 = newVariant(tenantA, brandA, connA);
      const pub2 = await schedule(tenantA, v2.id);
      await dispatch(pub2.id);
      expect(
        await inTenant(tenantA, () => runtime.control.cancelIfNotStarted(wfInput(pub2.id))),
      ).toMatchObject({ state: 'dispatching', changed: false });
    });

    it('a published publication cannot be cancelled (policy resource state) and deleteRemote is a separate, recorded action', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      await inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(pub.id), attempt: result }));
      await expect(
        run(tenantA, (tx) => publicationService.cancel(A, { publicationId: pub.id, expectedVersion: 2 }, tx)),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const del = await run(tenantA, (tx) =>
        publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'wrong price' }, tx),
      );
      expect(del).toMatchObject({
        accepted: true,
        remotePostId: result.remotePostId,
        changeId: expect.stringMatching(/^prc_/),
      });
      expect(
        (await eventsOf(tenantA, 'publication.delete_remote_requested')).some(
          (e) => e.payload['publicationId'] === pub.id,
        ),
      ).toBe(true);
      expect((await row(pub.id)).state).toBe('published'); // never an automatic rollback
    });

    it('reschedule updates the row and emits the reschedule signal for the waiting workflow; it never terminates it', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id, new Date(Date.now() + 3600_000));
      const earlier = new Date(Date.now() + 60_000);
      const res = await run(tenantA, (tx) =>
        publicationService.reschedule(
          A,
          { publicationId: pub.id, expectedVersion: pub.version, scheduledFor: earlier.toISOString() },
          tx,
        ),
      );
      expect(res.scheduledFor).toBe(earlier.toISOString());
      const evt = (await eventsOf(tenantA, 'publication.rescheduled')).find(
        (e) => e.payload['publicationId'] === pub.id,
      )!;
      expect(evt.payload).toMatchObject({ workflowId: `pub:${pub.id}`, scheduledFor: earlier.toISOString() });
      expect((await row(pub.id)).claimant).toBe(`pub:${pub.id}`);
    });

    it('human reconciliation: confirm_published records human evidence; confirm_absent → retry_eligible', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId }));
      const done = await run(tenantA, (tx) =>
        publicationService.reconcile(
          A,
          {
            publicationId: pub.id,
            resolution: 'confirm_published',
            remotePostId: 'post_manual',
            remoteUrl: 'https://fixture.example/p/post_manual',
          },
          tx,
        ),
      );
      expect(done).toMatchObject({ state: 'published', remotePostId: 'post_manual' });
      expect((await evidenceOf(pub.id))[0]).toMatchObject({ kind: 'human_confirmation', attemptId });
      expect(consumedApprovals).toEqual([{ approvalId: done.approvalId, publicationId: pub.id }]);
      const v2 = newVariant(tenantA, brandA, connA);
      const pub2 = await schedule(tenantA, v2.id);
      const d2 = await dispatch(pub2.id);
      await inTenant(tenantA, () =>
        runtime.control.markOutcomeUnknown({ ...wfInput(pub2.id), attemptId: d2.attemptId }),
      );
      expect(
        (
          await run(tenantA, (tx) =>
            publicationService.reconcile(A, { publicationId: pub2.id, resolution: 'confirm_absent' }, tx),
          )
        ).state,
      ).toBe('retry_eligible');
    });

    it('confirm_published is refused on a held row (it would stay held); cancel still resolves it', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Held then confirmed caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId }));
      await inTenant(tenantA, () =>
        runtime.control.holdForHuman({ ...wfInput(pub.id), reason: 'outcome_unknown_unresolved' }),
      );
      const held = await row(pub.id);
      expect(held.state).toBe('held');
      const err = await run(tenantA, (tx) =>
        publicationService.reconcile(
          A,
          { publicationId: pub.id, resolution: 'confirm_published', remotePostId: 'post_manual_held' },
          tx,
        ),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationFailedError);
      expect((err as ValidationFailedError).message).toMatch(/outcome_unknown/);
      expect((err as ValidationFailedError).details).toEqual([
        { path: 'resolution', issue: 'confirm_published_not_allowed_in_state:held' },
      ]);
      expect(await row(pub.id)).toMatchObject({ state: 'held', version: held.version, remotePostId: null });
      expect(await evidenceOf(pub.id)).toHaveLength(0);
      expect(consumedApprovals).toEqual([]);
      expect(
        (
          await run(tenantA, (tx) =>
            publicationService.reconcile(A, { publicationId: pub.id, resolution: 'cancel' }, tx),
          )
        ).state,
      ).toBe('cancelled');
    });

    it('reconcile is a person-only resolution: an API-key principal is refused with agent_never and nothing is written', async () => {
      const v = newVariant(tenantA, brandA, connA, 'Key reconcile caption');
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      await inTenant(tenantA, () => runtime.control.markOutcomeUnknown({ ...wfInput(pub.id), attemptId }));
      const before = await row(pub.id);
      // An API client: its service principal, with the key's per-request ceiling, holding publication.schedule.
      const apiKey: ResolvedActorServicePrincipal = {
        kind: 'service_principal',
        id: 'sp_publishing_key',
        tenantId: tenantA,
        status: 'active',
        maxAutonomy: 'managed_autopublish',
        requestAutonomy: 'managed_autopublish',
        grants: [{ action: 'publication.schedule', brandIds: 'all', channelConnectionIds: 'all' }],
      };
      for (const resolution of [
        { resolution: 'confirm_published' as const, remotePostId: 'post_by_key' },
        { resolution: 'confirm_absent' as const },
        { resolution: 'cancel' as const },
      ])
        await expect(
          run(tenantA, (tx) =>
            publicationService.reconcile(apiKey, { publicationId: pub.id, ...resolution }, tx),
          ),
          resolution.resolution,
        ).rejects.toMatchObject({ reason: 'agent_never' });
      expect(await row(pub.id)).toMatchObject({
        state: 'outcome_unknown',
        version: before.version,
        remotePostId: null,
      });
      expect(await evidenceOf(pub.id)).toHaveLength(0);
      expect(consumedApprovals).toEqual([]);
    });
  });

  describe('remote edit and delete of a published post (publication.edit_remote / delete_remote)', () => {
    /** A publication taken through dispatch to published, on the fixture platform. */
    const published = async (text = 'Hello from the fixture') => {
      const v = newVariant(tenantA, brandA, connA, text);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      const result = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      await inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(pub.id), attempt: result }));
      return { pub, variant: v, remotePostId: result.remotePostId! };
    };
    const changeInput = (publicationId: string, changeId: string) => ({
      ...wfInput(publicationId),
      changeId,
      providerKey: FIXTURE_PROVIDER_KEY,
    });
    const changesOf = (publicationId: string) =>
      tdb.db
        .select()
        .from(publicationRemoteChanges)
        .where(eq(publicationRemoteChanges.publicationId, publicationId));
    const issueOf = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationFailedError);
      return (err as ValidationFailedError).details?.[0]?.issue;
    };

    it('delete: recorded, emitted with the change, carried out once; the publication becomes removed with evidence', async () => {
      const { pub, remotePostId } = await published();
      const del = await run(tenantA, (tx) =>
        publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'wrong price' }, tx),
      );
      const [change] = await changesOf(pub.id);
      expect(change).toMatchObject({
        id: del.changeId,
        kind: 'delete',
        state: 'requested',
        reason: 'wrong price',
      });
      const evt = (await eventsOf(tenantA, 'publication.delete_remote_requested')).find(
        (e) => e.payload['changeId'] === del.changeId,
      );
      expect(evt?.payload).toMatchObject({
        publicationId: pub.id,
        remotePostId,
        requestedByKind: 'user',
        requestedById: USER,
        changeId: del.changeId,
        providerKey: FIXTURE_PROVIDER_KEY,
        workflowId: `pub:${pub.id}:remote:${del.changeId}`,
      });
      // One change at a time: a second delete, or an edit racing the delete, is refused while it is open.
      expect(
        await issueOf(
          run(tenantA, (tx) =>
            publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'again' }, tx),
          ),
        ),
      ).toBe('remote_change_in_progress');
      expect(
        await issueOf(
          run(tenantA, (tx) =>
            publicationService.editRemote(A, { publicationId: pub.id, text: 'Edited' }, tx),
          ),
        ),
      ).toBe('remote_change_in_progress');

      const input = changeInput(pub.id, del.changeId);
      expect(await inTenant(tenantA, () => runtime.remoteChangeProvider.deleteRemotePost(input, A))).toEqual({
        outcome: 'done',
      });
      expect(fixture.posts.find((p) => p.id === remotePostId)?.deleted).toBe(true);
      const recorded = await inTenant(tenantA, () =>
        runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } }),
      );
      expect(recorded).toEqual({ state: 'succeeded', publicationState: 'removed', changed: true });
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } }),
        ),
      ).toEqual({ state: 'succeeded', publicationState: 'removed', changed: false });
      // A repeated provider activity after the outcome sends nothing.
      const callsBefore = fixture.calls.length;
      expect(await inTenant(tenantA, () => runtime.remoteChangeProvider.deleteRemotePost(input, A))).toEqual({
        outcome: 'skipped',
        reason: 'change_succeeded',
      });
      expect(fixture.calls.length).toBe(callsBefore);

      expect((await row(pub.id)).state).toBe('removed');
      expect((await row(pub.id)).stateReason).toBe('remote_deleted');
      const evidence = await evidenceOf(pub.id);
      expect(evidence.map((e) => e.kind).sort()).toEqual(['accepted_response', 'remote_deletion']);
      expect(evidence.find((e) => e.kind === 'remote_deletion')?.payload).toMatchObject({
        changeId: del.changeId,
        remotePostId,
        outcome: 'done',
      });
      expect(
        (await eventsOf(tenantA, 'publication.state_changed')).some(
          (e) => e.payload['publicationId'] === pub.id && e.payload['toState'] === 'removed',
        ),
      ).toBe(true);
      // Removed is terminal for remote changes; the approval it went out under stays spent.
      expect(
        await issueOf(
          run(tenantA, (tx) =>
            publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'x' }, tx),
          ),
        ),
      ).toBe('not_published');
      expect(
        await inTenant(tenantA, () =>
          publicationService.publishedElsewhereForApprovalChannel(pub.approvalId!, connA, 'pub_other'),
        ),
      ).toBe(true);
      const dto = await inTenant(tenantA, () => publicationService.get(A, { publicationId: pub.id }));
      expect(dto.remote.changes[0]).toMatchObject({ id: del.changeId, kind: 'delete', state: 'succeeded' });
    });

    it('a post already gone on the platform counts as deleted', async () => {
      const { pub, remotePostId } = await published();
      fixture.posts.find((p) => p.id === remotePostId)!.deleted = true;
      const del = await run(tenantA, (tx) =>
        publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'cleanup' }, tx),
      );
      const input = changeInput(pub.id, del.changeId);
      const result = await inTenant(tenantA, () => runtime.remoteChangeProvider.deleteRemotePost(input, A));
      expect(result).toEqual({ outcome: 'already_absent' });
      await inTenant(tenantA, () =>
        runtime.remoteChangeControl.recordRemoteChangeOutcome({
          ...input,
          result: { outcome: 'already_absent' },
        }),
      );
      expect(await row(pub.id)).toMatchObject({ state: 'removed', stateReason: 'remote_already_absent' });
    });

    it('edit: checked like a variant, stored on the change, carried out; evidence is added, never rewritten', async () => {
      const { pub, remotePostId } = await published('Launch price 50 EUR');
      const before = await evidenceOf(pub.id);
      expect(
        await issueOf(
          run(tenantA, (tx) =>
            publicationService.editRemote(A, { publicationId: pub.id, text: 'x'.repeat(281) }, tx),
          ),
        ),
      ).toBe('text_too_long:281>280');
      expect(
        await issueOf(
          run(tenantA, (tx) =>
            publicationService.editRemote(A, { publicationId: pub.id, text: 'Launch price 50 EUR  ' }, tx),
          ),
        ),
      ).toBe('text_unchanged');
      const edit = await run(tenantA, (tx) =>
        publicationService.editRemote(
          A,
          { publicationId: pub.id, text: 'Launch price 40 EUR', reason: 'typo in the price' },
          tx,
        ),
      );
      const [change] = await changesOf(pub.id);
      expect(change).toMatchObject({
        id: edit.changeId,
        kind: 'edit',
        state: 'requested',
        text: 'Launch price 40 EUR',
        reason: 'typo in the price',
      });
      const evt = (await eventsOf(tenantA, 'publication.edit_remote_requested')).find(
        (e) => e.payload['changeId'] === edit.changeId,
      );
      expect(evt?.payload).toMatchObject({
        publicationId: pub.id,
        providerKey: FIXTURE_PROVIDER_KEY,
        textHash: change!.textHash,
        workflowId: `pub:${pub.id}:remote:${edit.changeId}`,
      });
      expect(JSON.stringify(evt?.payload)).not.toContain('40 EUR'); // references only in events

      const input = changeInput(pub.id, edit.changeId);
      expect(await inTenant(tenantA, () => runtime.remoteChangeProvider.editRemotePost(input, A))).toEqual({
        outcome: 'done',
      });
      expect(fixture.posts.find((p) => p.id === remotePostId)?.text).toBe('Launch price 40 EUR');
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } }),
        ),
      ).toEqual({ state: 'succeeded', publicationState: 'published', changed: true });

      const after = await evidenceOf(pub.id);
      expect(after.filter((e) => before.some((b) => b.id === e.id))).toEqual(before); // untouched
      expect(after.find((e) => e.kind === 'remote_edit')?.payload).toMatchObject({
        changeId: edit.changeId,
        textHash: change!.textHash,
      });
      const dto = await inTenant(tenantA, () => publicationService.get(A, { publicationId: pub.id }));
      expect(dto.state).toBe('published');
      expect(dto.remote).toMatchObject({
        edit: true,
        delete: true,
        textMaxLength: 280,
        currentText: 'Launch price 40 EUR',
      });
      // The edited text is now the live text: the same text again is unchanged, the old text is a real change.
      expect(
        await issueOf(
          run(tenantA, (tx) =>
            publicationService.editRemote(A, { publicationId: pub.id, text: 'Launch price 40 EUR' }, tx),
          ),
        ),
      ).toBe('text_unchanged');
    });

    it('a failure leaves the post published with the reason on the change; a new request may follow', async () => {
      const { pub } = await published();
      const edit = await run(tenantA, (tx) =>
        publicationService.editRemote(A, { publicationId: pub.id, text: 'Something else' }, tx),
      );
      fixture.remoteMutations = [{ kind: 'reject', code: 'content_policy' }];
      const input = changeInput(pub.id, edit.changeId);
      const result = await inTenant(tenantA, () => runtime.remoteChangeProvider.editRemotePost(input, A));
      expect(result).toMatchObject({ outcome: 'rejected', code: 'content_policy' });
      if (result.outcome !== 'rejected') throw new Error('expected a rejection');
      await inTenant(tenantA, () =>
        runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...input, result }),
      );
      expect((await changesOf(pub.id))[0]).toMatchObject({
        state: 'failed',
        errorCode: 'content_policy',
        errorDetail: 'rejected by fixture',
      });
      expect((await row(pub.id)).state).toBe('published');
      expect((await evidenceOf(pub.id)).map((e) => e.kind)).toEqual(['accepted_response']);
      const again = await run(tenantA, (tx) =>
        publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'give up' }, tx),
      );
      expect(again.changeId).not.toBe(edit.changeId);
    });

    it('a confirmation that arrives after the change was closed as stale is still recorded: the post is removed', async () => {
      const { pub, remotePostId } = await published();
      const del = await run(tenantA, (tx) =>
        publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'lost workflow' }, tx),
      );
      const input = changeInput(pub.id, del.changeId);
      expect(await inTenant(tenantA, () => runtime.remoteChangeProvider.deleteRemotePost(input, A))).toEqual({
        outcome: 'done',
      });
      // The workflow is lost before it records; the sweeper closes the change once it is stale.
      await tdb.db
        .update(publicationRemoteChanges)
        .set({ requestedAt: new Date(Date.now() - 7 * 3600_000) })
        .where(eq(publicationRemoteChanges.id, del.changeId));
      const listed = await inTenant(tenantA, () => publicationService.get(A, { publicationId: pub.id }));
      expect(listed.remote.changes[0]).toMatchObject({ id: del.changeId, state: 'requested', stale: true });
      const swept = await runtime.remoteChangeSweep.sweepStaleRemoteChanges({
        correlationId: 'corr_sweep',
        now: new Date().toISOString(),
      });
      expect(swept.closed).toBeGreaterThanOrEqual(1);
      expect((await changesOf(pub.id))[0]).toMatchObject({ state: 'failed', errorCode: 'stale_no_outcome' });
      expect((await row(pub.id)).state).toBe('published');
      // The workflow comes back and records the confirmation: the record follows the platform.
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } }),
        ),
      ).toEqual({ state: 'succeeded', publicationState: 'removed', changed: true });
      expect((await changesOf(pub.id))[0]).toMatchObject({
        state: 'succeeded',
        errorCode: 'confirmed_after_stale',
      });
      expect((await evidenceOf(pub.id)).find((e) => e.kind === 'remote_deletion')?.payload).toMatchObject({
        changeId: del.changeId,
        remotePostId,
        confirmedAfterStale: true,
      });
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, pub.id)));
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'publication.delete_remote_failed',
          'publication.delete_remote_confirmed_late',
        ]),
      );
      // A failure that arrives late changes nothing.
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeControl.recordRemoteChangeOutcome({
            ...input,
            result: { outcome: 'rejected', code: 'x', message: 'x' },
          }),
        ),
      ).toMatchObject({ changed: false });
    });

    it('the requester must still hold the permission when the change is carried out', async () => {
      const { pub } = await published();
      const edit = await run(tenantA, (tx) =>
        publicationService.editRemote(A, { publicationId: pub.id, text: 'Revised text' }, tx),
      );
      const creator: ResolvedActor = { ...A, role: 'creator' } as ResolvedActor;
      const callsBefore = fixture.calls.length;
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeProvider.editRemotePost(changeInput(pub.id, edit.changeId), creator),
        ),
      ).toMatchObject({ outcome: 'rejected', code: 'policy_denied:role_missing' });
      expect(fixture.calls.length).toBe(callsBefore); // nothing was sent
    });

    it('a request with no recorded outcome for hours is closed as stale when the next one comes; its activity then sends nothing', async () => {
      const { pub } = await published();
      const stale = await run(tenantA, (tx) =>
        publicationService.editRemote(A, { publicationId: pub.id, text: 'Never carried out' }, tx),
      );
      await tdb.db
        .update(publicationRemoteChanges)
        .set({ requestedAt: new Date(Date.now() - 7 * 3600_000) })
        .where(eq(publicationRemoteChanges.id, stale.changeId));
      await run(tenantA, (tx) =>
        publicationService.deleteRemote(A, { publicationId: pub.id, reason: 'x' }, tx),
      );
      expect((await changesOf(pub.id)).find((c) => c.id === stale.changeId)).toMatchObject({
        state: 'failed',
        errorCode: 'superseded_stale',
      });
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeProvider.editRemotePost(changeInput(pub.id, stale.changeId), A),
        ),
      ).toEqual({ outcome: 'skipped', reason: 'change_failed' });
    });

    it('refused: channels without the capability, unpublished rows, agents, and other tenants', async () => {
      const { pub } = await published();
      const cap = fixture.capability as { edit: boolean };
      cap.edit = false;
      try {
        await expect(
          run(tenantA, (tx) => publicationService.editRemote(A, { publicationId: pub.id, text: 'New' }, tx)),
        ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
      } finally {
        cap.edit = true;
      }
      const v = newVariant(tenantA, brandA, connA);
      const scheduled = await schedule(tenantA, v.id, new Date(Date.now() + 3600_000));
      expect(
        await issueOf(
          run(tenantA, (tx) =>
            publicationService.editRemote(A, { publicationId: scheduled.id, text: 'New' }, tx),
          ),
        ),
      ).toBe('not_published');
      const agent: ResolvedActorServicePrincipal = {
        kind: 'service_principal',
        id: 'sp_publishing_tools',
        tenantId: tenantA,
        status: 'active',
        maxAutonomy: 'managed_autopublish',
        grants: [
          { action: 'publication.edit_remote', brandIds: 'all', channelConnectionIds: 'all' },
          { action: 'publication.delete_remote', brandIds: 'all', channelConnectionIds: 'all' },
        ],
      };
      await expect(
        run(tenantA, (tx) =>
          publicationService.editRemote(agent, { publicationId: pub.id, text: 'New' }, tx),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run(tenantA, (tx) =>
          publicationService.deleteRemote(agent, { publicationId: pub.id, reason: 'x' }, tx),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      // Another tenant cannot see the publication, let alone change it or run its change activities.
      await expect(
        run(tenantB, (tx) => publicationService.editRemote(B, { publicationId: pub.id, text: 'New' }, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      const own = await run(tenantA, (tx) =>
        publicationService.editRemote(A, { publicationId: pub.id, text: 'Tenant A text' }, tx),
      );
      await expect(
        inTenant(tenantB, () =>
          runtime.remoteChangeProvider.editRemotePost(
            {
              ...changeInput(pub.id, own.changeId),
              tenantId: tenantB,
            },
            A,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await changesOf(pub.id)).every((c) => c.tenantId === tenantA)).toBe(true);
    });
  });

  describe('website articles (RA-02, RA-04, RA-12): what the runtime records behind a destination publication', () => {
    const destinationId = newId('destination');
    const article: NonNullable<ChannelVariantForPublishing['article']> = {
      kind: 'article',
      title: 'Why ore and tar last',
      slug: 'why-ore-and-tar-last',
      excerpt: 'A short answer.',
      blocks: [
        { type: 'paragraph', text: 'Ore is heavy.' },
        { type: 'faq', question: 'Is it safe?', answer: 'Yes, mostly.' },
      ],
      categories: [],
      tags: [],
    };
    const readbackOf = (
      status: 'draft' | 'publish',
      over: Partial<ArticleReadbackV1> = {},
    ): ArticleReadbackV1 => ({
      remoteId: '42',
      remoteUrl:
        status === 'publish'
          ? 'https://blog.acme.example/why-ore-and-tar-last/'
          : 'https://blog.acme.example/?p=42',
      title: article.title,
      slug: article.slug,
      status,
      modifiedAt: '2026-10-02T10:00:00.000Z',
      contentHash: 'a'.repeat(64),
      ...over,
    });
    const verified: ArticleReadbackVerificationV1 = {
      outcome: 'verified',
      matched: ['content', 'title', 'slug', 'status', 'modifiedAt'],
      mismatched: [],
      reason: null,
      sentHash: 'b'.repeat(64),
    };
    const validationOf = (ok: boolean): RenderedValidationV1 => ({
      url: 'https://blog.acme.example/why-ore-and-tar-last/',
      fetchedAt: '2026-10-02T10:00:01.000Z',
      status: 200,
      bytes: 1024,
      truncated: false,
      ok,
      checks: [
        { key: 'status_ok', ok: true },
        { key: 'title_present', ok: true },
        { key: 'canonical_present', ok: true },
        { key: 'indexable', ok },
        { key: 'body_present', ok: true },
        { key: 'canonical_matches', ok: true },
        { key: 'last_paragraph_present', ok },
      ],
      error: null,
    });
    /** What the (stubbed) destinations module answers next; the runtime under test records it. */
    let publishResult: DestinationPublishResult = { outcome: 'rejected', code: 'unset', message: 'unset' };
    let editResult: DestinationMutationResult = { outcome: 'rejected', code: 'unset', message: 'unset' };
    let unpublishResult: DestinationMutationResult = { outcome: 'rejected', code: 'unset', message: 'unset' };
    let validateResult: RenderedValidationV1 = validationOf(true);
    const editInputs: DestinationEditInput[] = [];
    const validateInputs: DestinationValidateInput[] = [];
    const stub: DestinationPublisher = {
      describe: async (id) =>
        id === destinationId
          ? {
              id,
              brandId: brandA,
              kind: 'cms_site',
              displayName: 'blog.acme.example',
              capabilityVersion: 1,
              usable: true,
              actions: { edit: true, delete: true, unpublish: true },
            }
          : null,
      validateVariant: async () => ({ ok: true, issues: [] }),
      useAllowed: async () => true,
      publish: async (_input, _hooks, beforeSend) => {
        await beforeSend?.();
        return publishResult;
      },
      edit: async (input) => {
        editInputs.push(input);
        return editResult;
      },
      unpublish: async () => unpublishResult,
      delete: async () => ({ outcome: 'done' }),
      validateRendered: async (input) => {
        validateInputs.push(input);
        return validateResult;
      },
    };
    const newArticleVariant = (settings: Record<string, unknown> = { publishMode: 'draft' }) => {
      const v: ChannelVariantForPublishing = {
        ...newVariant(tenantA, brandA, connA),
        channelConnectionId: null,
        destinationId,
        text: 'Why ore and tar last',
        settings,
        article,
      };
      variantsById.set(v.id, v);
      return v;
    };
    /** A destination publication taken through dispatch and publishOnce; markPublished when asked. */
    const publishArticle = async (result: DestinationPublishResult, settings?: Record<string, unknown>) => {
      publishResult = result;
      const v = newArticleVariant(settings);
      const pub = await schedule(tenantA, v.id);
      const { attemptId } = await dispatch(pub.id);
      const attempt = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: 1 }),
      );
      await inTenant(tenantA, () => runtime.control.markPublished({ ...wfInput(pub.id), attempt }));
      return { pub, attemptId, attempt };
    };
    const changesOf = (publicationId: string) =>
      tdb.db
        .select()
        .from(publicationRemoteChanges)
        .where(eq(publicationRemoteChanges.publicationId, publicationId));
    const changeInput = (publicationId: string, changeId: string) => ({
      ...wfInput(publicationId),
      changeId,
      providerKey: 'cms_site',
    });

    beforeAll(async () => {
      await tdb.db.insert(brandDestinations).values({
        id: destinationId,
        tenantId: tenantA,
        brandId: brandA,
        kind: 'cms_site',
        externalId: 'https://blog.acme.example',
        displayName: 'blog.acme.example',
        ownerUserId: USER,
        grantedScopes: ['articles:write', 'articles:publish'],
        health: 'healthy',
        capabilityVersion: 1,
      });
      registerDestinationPublisher(stub);
    });
    afterAll(() => {
      resetDestinationPublisher();
    });
    beforeEach(() => {
      editInputs.length = 0;
      validateInputs.length = 0;
      validateResult = validationOf(true);
    });

    it('a draft write: the read-back and what it proved are evidence, the status is draft (never live), the page is not re-validated and the article cannot be reverted', async () => {
      const { pub, attemptId } = await publishArticle({
        outcome: 'accepted',
        remotePostId: '42',
        remoteUrl: 'https://blog.acme.example/?p=42',
        readback: readbackOf('draft'),
        readbackVerification: verified,
        validation: validationOf(true),
      });
      const stored = await row(pub.id);
      expect(stored).toMatchObject({
        state: 'published',
        remotePostId: '42',
        remoteStatus: 'draft',
        remoteVerification: 'verified',
      });
      expect(stored.remoteVerifiedAt).not.toBeNull();
      const evidence = await evidenceOf(pub.id);
      expect(evidence.map((e) => e.kind).sort()).toEqual([
        'accepted_response',
        'remote_readback',
        'rendered_validation',
      ]);
      expect(evidence.find((e) => e.kind === 'remote_readback')?.payload).toMatchObject({
        ...readbackOf('draft'),
        attemptId,
        verification: verified,
      });
      expect(await eventsOf(tenantA, 'publication.rendered_validation_due')).toEqual([]);
      const dto = await inTenant(tenantA, () => publicationService.get(A, { publicationId: pub.id }));
      expect(dto).toMatchObject({ remoteStatus: 'draft', remoteVerification: 'verified' });
      expect(dto.remoteVerifiedAt).toBe(stored.remoteVerifiedAt?.toISOString());
      const calendar = await inTenant(tenantA, () =>
        publicationService.calendarRange(
          brandA,
          new Date(Date.now() - 86_400_000),
          new Date(Date.now() + 86_400_000),
        ),
      );
      expect(calendar.find((c) => c.publicationId === pub.id)).toMatchObject({
        destinationId,
        state: 'published',
        remoteStatus: 'draft',
        remoteVerification: 'verified',
      });
      await expect(
        run(tenantA, (tx) =>
          publicationService.unpublishRemote(A, { publicationId: pub.id, reason: 'x' }, tx),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'publicationId', issue: 'not_live:draft' }] });
      expect(
        await inTenant(tenantA, () =>
          runtime.renderedValidation.validateRenderedPublication({
            ...wfInput(pub.id),
            publishedAt: new Date().toISOString(),
          }),
        ),
      ).toEqual({ outcome: 'skipped', reason: 'remote_draft' });
    });

    it('a publish mode whose read-back is not live is a draft; a read-back that could not be compared leaves the write unverified; a mismatch fails it', async () => {
      const draftDespiteMode = await publishArticle(
        {
          outcome: 'accepted',
          remotePostId: '42',
          remoteUrl: 'https://blog.acme.example/?p=42',
          readback: readbackOf('draft'),
          readbackVerification: verified,
          validation: validationOf(true),
        },
        { publishMode: 'publish' },
      );
      expect(await row(draftDespiteMode.pub.id)).toMatchObject({
        remoteStatus: 'draft',
        remoteVerification: 'verified',
      });
      const unverified = await publishArticle({
        outcome: 'accepted',
        remotePostId: '42',
        remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
        readback: readbackOf('publish'),
        readbackVerification: {
          outcome: 'unverified',
          matched: [],
          mismatched: [],
          reason: 'read_not_allowed',
          sentHash: 'b'.repeat(64),
        },
        validation: validationOf(true),
      });
      expect(await row(unverified.pub.id)).toMatchObject({
        remoteStatus: 'live',
        remoteVerification: 'unverified',
        remoteVerifiedAt: null,
      });
      expect(
        (await evidenceOf(unverified.pub.id)).find((e) => e.kind === 'remote_readback')?.payload,
      ).toMatchObject({
        verification: { outcome: 'unverified', reason: 'read_not_allowed' },
      });
      const mismatch = await publishArticle({
        outcome: 'accepted',
        remotePostId: '42',
        remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
        readback: readbackOf('publish', { title: 'Why ore and tar last (filtered)' }),
        readbackVerification: {
          ...verified,
          outcome: 'mismatch',
          matched: ['content', 'slug', 'status', 'modifiedAt'],
          mismatched: ['title'],
        },
        validation: validationOf(true),
      });
      expect(await row(mismatch.pub.id)).toMatchObject({
        remoteStatus: 'live',
        remoteVerification: 'failed',
        remoteVerifiedAt: null,
      });
    });

    it('a live write: verified when the page passes, the delayed re-validation is queued with availableAt and re-runs set the verification from each result', async () => {
      const before = Date.now();
      const { pub } = await publishArticle(
        {
          outcome: 'accepted',
          remotePostId: '42',
          remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
          readback: readbackOf('publish'),
          readbackVerification: verified,
          validation: validationOf(true),
        },
        { publishMode: 'publish' },
      );
      expect(await row(pub.id)).toMatchObject({ remoteStatus: 'live', remoteVerification: 'verified' });
      const [due] = (await eventsOf(tenantA, 'publication.rendered_validation_due')).filter(
        (e) => e.payload['publicationId'] === pub.id,
      );
      expect(due?.payload).toMatchObject({
        publicationId: pub.id,
        actorKind: 'user',
        actorId: USER,
        workflowId: `pub:${pub.id}:rendered-validation:${(await row(pub.id)).version}`,
      });
      expect(typeof due?.payload['publishedAt']).toBe('string');
      expect(due!.availableAt.getTime()).toBeGreaterThanOrEqual(before + RENDERED_VALIDATION_DELAYS_MS[0]);
      expect(due!.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + RENDERED_VALIDATION_DELAYS_MS[0]);
      // The re-validation: a page that changed after its first paragraph fails and the verification says so.
      validateResult = validationOf(false);
      const input = { ...wfInput(pub.id), publishedAt: String(due!.payload['publishedAt']) };
      expect(
        await inTenant(tenantA, () => runtime.renderedValidation.validateRenderedPublication(input)),
      ).toEqual({
        outcome: 'validated',
        ok: false,
        verification: 'failed',
      });
      expect(validateInputs.at(-1)).toMatchObject({
        destinationId,
        url: 'https://blog.acme.example/why-ore-and-tar-last/',
        title: article.title,
        slug: article.slug,
        firstParagraph: 'Ore is heavy.',
        lastParagraph: 'Yes, mostly.',
        draft: false, // a live article must be indexable
      });
      expect(await row(pub.id)).toMatchObject({ remoteVerification: 'failed', remoteVerifiedAt: null });
      validateResult = validationOf(true);
      expect(
        await inTenant(tenantA, () => runtime.renderedValidation.validateRenderedPublication(input)),
      ).toEqual({
        outcome: 'validated',
        ok: true,
        verification: 'verified',
      });
      expect((await row(pub.id)).remoteVerification).toBe('verified');
      expect((await evidenceOf(pub.id)).filter((e) => e.kind === 'rendered_validation')).toHaveLength(3);
      // The on-demand validation records the same way.
      validateResult = validationOf(false);
      await run(tenantA, (tx) => publicationService.validateRendered(A, { publicationId: pub.id }, tx));
      expect((await row(pub.id)).remoteVerification).toBe('failed');
      // A foreign tenant's publication is NOT_FOUND before any page is fetched.
      const fetches = validateInputs.length;
      await expect(
        inTenant(tenantB, () =>
          runtime.renderedValidation.validateRenderedPublication({ ...input, tenantId: tenantB }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(validateInputs.length).toBe(fetches);
    });

    it('revert: the website confirms the draft, a fresh read-back is recorded, the status is reverted and a second revert is refused', async () => {
      const { pub } = await publishArticle(
        {
          outcome: 'accepted',
          remotePostId: '42',
          remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
          readback: readbackOf('publish'),
          readbackVerification: verified,
          validation: validationOf(true),
        },
        { publishMode: 'publish' },
      );
      const revert = await run(tenantA, (tx) =>
        publicationService.unpublishRemote(A, { publicationId: pub.id, reason: 'wrong launch date' }, tx),
      );
      unpublishResult = {
        outcome: 'done',
        readback: readbackOf('draft', { modifiedAt: '2026-10-02T11:00:00.000Z' }),
      };
      const input = changeInput(pub.id, revert.changeId);
      const result = await inTenant(tenantA, () => runtime.remoteChangeProvider.deleteRemotePost(input, A));
      expect(result).toMatchObject({ outcome: 'done', readback: { status: 'draft' } });
      if (result.outcome !== 'done') throw new Error('expected done');
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...input, result }),
        ),
      ).toEqual({ state: 'succeeded', publicationState: 'published', changed: true });
      expect(await row(pub.id)).toMatchObject({ state: 'published', remoteStatus: 'reverted' });
      const readbacks = (await evidenceOf(pub.id)).filter((e) => e.kind === 'remote_readback');
      expect(readbacks).toHaveLength(2);
      expect(readbacks.at(-1)?.payload).toMatchObject({
        status: 'draft',
        changeId: revert.changeId,
        modifiedAt: '2026-10-02T11:00:00.000Z',
      });
      expect((await evidenceOf(pub.id)).find((e) => e.kind === 'remote_unpublish')?.payload).toMatchObject({
        changeId: revert.changeId,
        readback: { status: 'draft' },
      });
      await expect(
        run(tenantA, (tx) =>
          publicationService.unpublishRemote(A, { publicationId: pub.id, reason: 'again' }, tx),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'publicationId', issue: 'not_live:reverted' }] });
      expect(
        await inTenant(tenantA, () =>
          runtime.renderedValidation.validateRenderedPublication({
            ...wfInput(pub.id),
            publishedAt: new Date().toISOString(),
          }),
        ),
      ).toEqual({ outcome: 'skipped', reason: 'remote_reverted' });
      const calendar = await inTenant(tenantA, () =>
        publicationService.calendarRange(
          brandA,
          new Date(Date.now() - 86_400_000),
          new Date(Date.now() + 86_400_000),
        ),
      );
      expect(calendar.find((c) => c.publicationId === pub.id)?.remoteStatus).toBe('reverted');
    });

    it('revert (RA-02): when the site confirms the write but the article still reads back live, the status stays live and the mismatch is recorded', async () => {
      const { pub } = await publishArticle(
        {
          outcome: 'accepted',
          remotePostId: '42',
          remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
          readback: readbackOf('publish'),
          readbackVerification: verified,
          validation: validationOf(true),
        },
        { publishMode: 'publish' },
      );
      const revert = await run(tenantA, (tx) =>
        publicationService.unpublishRemote(A, { publicationId: pub.id, reason: 'still live?' }, tx),
      );
      unpublishResult = {
        outcome: 'done',
        readback: readbackOf('publish', { modifiedAt: '2026-10-02T11:30:00.000Z' }),
        readbackVerification: {
          outcome: 'mismatch',
          matched: ['modifiedAt'],
          mismatched: ['status'],
          reason: null,
          sentHash: 'b'.repeat(64),
        },
      };
      const input = changeInput(pub.id, revert.changeId);
      const result = await inTenant(tenantA, () => runtime.remoteChangeProvider.deleteRemotePost(input, A));
      if (result.outcome !== 'done') throw new Error('expected done');
      await inTenant(tenantA, () =>
        runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...input, result }),
      );
      expect(await row(pub.id)).toMatchObject({
        remoteStatus: 'live',
        remoteVerification: 'failed',
        remoteVerifiedAt: null,
      });
      const latest = (await evidenceOf(pub.id)).filter((e) => e.kind === 'remote_readback').at(-1);
      expect(latest?.payload).toMatchObject({
        status: 'publish',
        changeId: revert.changeId,
        verification: { outcome: 'mismatch', mismatched: ['status'] },
      });
      expect((await changesOf(pub.id)).find((c) => c.id === revert.changeId)?.state).toBe('succeeded');
      // Still live: another revert may be asked for.
      await expect(
        run(tenantA, (tx) =>
          publicationService.unpublishRemote(A, { publicationId: pub.id, reason: 'again' }, tx),
        ),
      ).resolves.toMatchObject({ accepted: true });
    });

    it('edit (RA-12): the stored hash and modified instant are the precondition; a conflict refreshes the read-back; a write that replaced a site change is succeeded as conflict_overwritten with the lost revision as evidence', async () => {
      const { pub } = await publishArticle(
        {
          outcome: 'accepted',
          remotePostId: '42',
          remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
          readback: readbackOf('publish'),
          readbackVerification: verified,
          validation: validationOf(true),
        },
        { publishMode: 'publish' },
      );
      // 1. A conflict: nothing written; the current remote travels back and becomes the stored read-back.
      const first = await run(tenantA, (tx) =>
        publicationService.editRemote(
          A,
          { publicationId: pub.id, text: '<p>Ore is heavy and tar is sticky.</p>' },
          tx,
        ),
      );
      const current = readbackOf('publish', {
        contentHash: 'c'.repeat(64),
        modifiedAt: '2026-10-02T12:00:00.000Z',
      });
      editResult = {
        outcome: 'rejected',
        code: 'conflict',
        message: 'the article changed on the site',
        readback: current,
      };
      const conflictInput = changeInput(pub.id, first.changeId);
      const conflict = await inTenant(tenantA, () =>
        runtime.remoteChangeProvider.editRemotePost(conflictInput, A),
      );
      expect(conflict).toMatchObject({ outcome: 'rejected', code: 'conflict' });
      expect(editInputs.at(-1)).toMatchObject({
        destinationId,
        remoteId: '42',
        expectedHash: 'a'.repeat(64),
        expectedModifiedAt: '2026-10-02T10:00:00.000Z',
        html: '<p>Ore is heavy and tar is sticky.</p>',
      });
      if (conflict.outcome === 'skipped') throw new Error('unexpected skip');
      await inTenant(tenantA, () =>
        runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...conflictInput, result: conflict }),
      );
      expect((await changesOf(pub.id)).find((c) => c.id === first.changeId)).toMatchObject({
        state: 'failed',
        errorCode: 'conflict',
      });
      const refreshed = (await evidenceOf(pub.id)).filter((e) => e.kind === 'remote_readback').at(-1);
      expect(refreshed?.payload).toMatchObject({
        ...current,
        changeId: first.changeId,
        refreshedAfter: 'conflict',
      });
      // 2. The next edit compares against what the site holds now, not the stale hash.
      const second = await run(tenantA, (tx) =>
        publicationService.editRemote(
          A,
          { publicationId: pub.id, text: '<p>Written over the window.</p>' },
          tx,
        ),
      );
      const previous = current;
      const replaced = readbackOf('publish', {
        contentHash: 'd'.repeat(64),
        modifiedAt: '2026-10-02T12:30:00.000Z',
      });
      const after = readbackOf('publish', {
        contentHash: 'e'.repeat(64),
        modifiedAt: '2026-10-02T13:00:00.000Z',
      });
      editResult = {
        outcome: 'done',
        readback: after,
        readbackVerification: { ...verified, matched: ['content', 'modifiedAt'] },
        overwritten: { previous, replaced },
      };
      const writeInput = changeInput(pub.id, second.changeId);
      const written = await inTenant(tenantA, () =>
        runtime.remoteChangeProvider.editRemotePost(writeInput, A),
      );
      expect(editInputs.at(-1)).toMatchObject({
        expectedHash: 'c'.repeat(64),
        expectedModifiedAt: '2026-10-02T12:00:00.000Z',
      });
      if (written.outcome === 'skipped') throw new Error('unexpected skip');
      expect(
        await inTenant(tenantA, () =>
          runtime.remoteChangeControl.recordRemoteChangeOutcome({ ...writeInput, result: written }),
        ),
      ).toEqual({ state: 'succeeded', publicationState: 'published', changed: true });
      const change = (await changesOf(pub.id)).find((c) => c.id === second.changeId);
      expect(change).toMatchObject({ state: 'succeeded', errorCode: 'conflict_overwritten' });
      expect(change?.errorDetail).toContain('replaced a change made on the site');
      expect((await evidenceOf(pub.id)).find((e) => e.kind === 'remote_edit')?.payload).toMatchObject({
        changeId: second.changeId,
        readback: after,
        overwritten: { previous, replaced },
      });
      expect(
        (await evidenceOf(pub.id)).filter((e) => e.kind === 'remote_readback').at(-1)?.payload,
      ).toMatchObject({
        contentHash: 'e'.repeat(64),
        changeId: second.changeId,
      });
      // RA-04: the read-back proved the article, not the page: unverified until the queued page check runs.
      const edited = await row(pub.id);
      expect(edited).toMatchObject({
        remoteStatus: 'live',
        remoteVerification: 'unverified',
        remoteVerifiedAt: null,
      });
      const queued = (await eventsOf(tenantA, 'publication.rendered_validation_due')).filter(
        (e) => e.payload['publicationId'] === pub.id,
      );
      expect(queued).toHaveLength(2); // one at publish, one for the edit
      expect(queued.at(-1)?.payload['workflowId']).toBe(
        `pub:${pub.id}:rendered-validation:${edited.version}`,
      );
      expect(queued.at(-1)!.availableAt.getTime()).toBeGreaterThan(
        Date.now() + RENDERED_VALIDATION_DELAYS_MS[0] - 60_000,
      );
      const dto = await inTenant(tenantA, () => publicationService.get(A, { publicationId: pub.id }));
      expect(dto.remote.changes[0]).toMatchObject({
        id: second.changeId,
        state: 'succeeded',
        errorCode: 'conflict_overwritten',
      });
      expect(dto.remote.currentText).toBe('<p>Written over the window.</p>');
    });
  });

  describe('disconnect, token refresh and the sweeper (spec 14.7, 14.2)', () => {
    it('disconnect destroys the credential (data key gone), disables the connection and holds its scheduled publications', async () => {
      fixture.grant.remoteAccountId = 'acct_A_second';
      const conn2 = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      const v = newVariant(tenantA, brandA, conn2.id);
      const pub = await schedule(tenantA, v.id, new Date(Date.now() + 3600_000));
      const before = await connectionRow(conn2.id);
      const revokeAccess = fixture.revokeAccess;
      fixture.revokeAccess = undefined; // RA-01: an adapter without a remote revoke shreds the credential here
      const res = await run(tenantA, (tx) =>
        channelService.disconnect(A, { channelConnectionId: conn2.id, expectedVersion: before.version }, tx),
      );
      fixture.revokeAccess = revokeAccess;
      expect(res.status).toBe('disabled');
      expect(res.remoteRevoke).toBe('not_supported');
      expect(res.heldPublicationIds).toEqual([pub.id]);
      expect(await row(pub.id)).toMatchObject({ state: 'held', holdReasons: ['channel_active'] });
      const cred = await credentialRow(before.credentialRefId);
      expect(cred.destroyedAt).not.toBeNull();
      expect(cred.ciphertext).toBe('');
      expect(cred.wrappedDataKey).toBe('');
      // RA-01: a disconnected channel is refused before its (shredded) credential is even read.
      await expect(
        inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, conn2.id, async () => 'x')),
      ).rejects.toMatchObject({ reason: 'credential_owner_disconnected' });
      await expect(
        inTenant(tenantA, () =>
          credentialBroker.withCredentials(tenantA, conn2.id, async () => 'x', undefined, {
            purpose: 'revoke',
          }),
        ),
      ).rejects.toMatchObject({ reason: 'credential_destroyed' });
      expect(await inTenant(tenantA, () => channelService.channelUsable(conn2.id))).toBe(false);
      expect(
        (await eventsOf(tenantA, 'channel.disconnected')).some(
          (e) => e.payload['channelConnectionId'] === conn2.id,
        ),
      ).toBe(true);
      // reconnecting the same remote account rotates the credential and reactivates the connection
      fixture.grant.remoteAccountId = 'acct_A_second';
      const again = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      expect(again.id).toBe(conn2.id);
      expect(again.status).toBe('active');
      expect((await connectionRow(conn2.id)).credentialRefId).not.toBe(before.credentialRefId);
    });

    it('RA-01: a disconnect whose adapter can revoke remotely leaves the credential to the worker, which revokes it at the platform, records the outcome and destroys it', async () => {
      fixture.grant.remoteAccountId = 'acct_A_revoke';
      const conn = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      const before = await connectionRow(conn.id);
      const res = await run(tenantA, (tx) =>
        channelService.disconnect(A, { channelConnectionId: conn.id, expectedVersion: before.version }, tx),
      );
      expect(res).toMatchObject({ status: 'disabled', remoteRevoke: 'requested' });
      // The API cannot open the credential: it stays intact, disabled with the connection, for the worker.
      expect((await credentialRow(before.credentialRefId)).destroyedAt).toBeNull();
      const event = (await eventsOf(tenantA, 'channel.disconnected')).find(
        (e) => e.payload['channelConnectionId'] === conn.id,
      );
      expect(event?.payload).toMatchObject({ remoteRevoke: 'requested', actorKind: 'user', actorId: USER });
      const disconnectAudit = (
        await tdb.db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.disconnect')))
      ).find((e) => e.resourceId === conn.id);
      expect(disconnectAudit?.metadata).toMatchObject({ remoteRevoke: 'requested' });
      // channelRevokeWorkflowV1's activity: the platform revokes, the outcome is audited, the row is shredded.
      const input = {
        tenantId: tenantA,
        actor: { kind: 'user' as const, id: USER },
        correlationId: 'c',
        channelConnectionId: conn.id,
      };
      expect(await inTenant(tenantA, () => runtime.channelRevoke.revokeChannelAccess(input))).toEqual({
        outcome: 'revoked',
      });
      expect(fixture.calls.at(-1)).toBe('revokeAccess:rt_fixture_secret');
      const cred = await credentialRow(before.credentialRefId);
      expect(cred.destroyedAt).not.toBeNull();
      expect(cred.ciphertext).toBe('');
      expect((await connectionRow(conn.id)).health).toBe('revoked');
      const revokeAudit = (
        await tdb.db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.remote_revoke')))
      ).find((e) => e.resourceId === conn.id);
      expect(revokeAudit).toMatchObject({
        decision: 'allowed',
        metadata: { remoteRevoke: 'revoked', channelConnectionId: conn.id },
      });
      // A repeat (the activity retried, the event replayed) has nothing left to do and opens nothing.
      const calls = fixture.calls.length;
      expect(await inTenant(tenantA, () => runtime.channelRevoke.revokeChannelAccess(input))).toEqual({
        outcome: 'already_destroyed',
      });
      expect(fixture.calls.length).toBe(calls);
      // A refused remote revoke never keeps the token: the credential is destroyed and the refusal audited.
      fixture.grant.remoteAccountId = 'acct_A_revoke_fails';
      const failing = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      const failingBefore = await connectionRow(failing.id);
      await run(tenantA, (tx) =>
        channelService.disconnect(
          A,
          { channelConnectionId: failing.id, expectedVersion: failingBefore.version },
          tx,
        ),
      );
      fixture.revokeBehaviour = { outcome: 'failed', reason: 'http_500:platform down' };
      expect(
        await inTenant(tenantA, () =>
          runtime.channelRevoke.revokeChannelAccess({ ...input, channelConnectionId: failing.id }),
        ),
      ).toEqual({ outcome: 'failed', reason: 'http_500:platform down' });
      fixture.revokeBehaviour = { outcome: 'revoked' };
      expect((await credentialRow(failingBefore.credentialRefId)).destroyedAt).not.toBeNull();
      const failedAudit = (
        await tdb.db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.remote_revoke')))
      ).find((e) => e.resourceId === failing.id);
      // The activity result carries the adapter's reason; the audit trail only a code (`http_<status>`, a
      // transport phase), never a platform's text.
      expect(failedAudit).toMatchObject({
        decision: 'denied',
        metadata: { remoteRevoke: 'failed', reason: 'provider_error' },
      });
      await expect(
        inTenant(tenantA, () =>
          credentialBroker.withCredentials(tenantA, failing.id, async () => 'x', undefined, {
            purpose: 'revoke',
          }),
        ),
      ).rejects.toMatchObject({ reason: 'credential_destroyed' });
      fixture.revokedTokens.clear(); // the fixture's grant is shared by every connection of these tests
    });

    it('RA-01: a disconnected channel’s credential is unusable at once (only the revoke may open it) and the sweeper shreds it an hour later if the remote revoke never ran', async () => {
      fixture.grant.remoteAccountId = 'acct_A_floor';
      const conn = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      const before = await connectionRow(conn.id);
      await run(tenantA, (tx) =>
        channelService.disconnect(A, { channelConnectionId: conn.id, expectedVersion: before.version }, tx),
      );
      expect((await credentialRow(before.credentialRefId)).destroyedAt).toBeNull();
      // Every ordinary opener is refused from the disconnect on; the revoke says what it is for.
      await expect(
        inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, conn.id, async () => 'x')),
      ).rejects.toMatchObject({ reason: 'credential_owner_disconnected' });
      expect(
        await inTenant(tenantA, () =>
          credentialBroker.withCredentials(tenantA, conn.id, async () => 'opened', undefined, {
            purpose: 'revoke',
          }),
        ),
      ).toBe('opened');
      const sweepInput = {
        correlationId: 'sweep',
        now: new Date().toISOString(),
        claimLeaseSeconds: 20 * 60,
        graceSeconds: 60,
      };
      // Within the hour the sweeper leaves it to the workflow.
      expect((await runtime.sweep.sweepPublications(sweepInput)).credentialsShredded).toBe(0);
      await tdb.db
        .update(channelConnections)
        .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60_000) })
        .where(eq(channelConnections.id, conn.id));
      expect((await runtime.sweep.sweepPublications(sweepInput)).credentialsShredded).toBe(1);
      const cred = await credentialRow(before.credentialRefId);
      expect(cred.destroyedAt).not.toBeNull();
      expect(cred.ciphertext).toBe('');
      const shredAudit = (
        await tdb.db
          .select()
          .from(auditEvents)
          .where(
            and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.credential_shredded')),
          )
      ).find((e) => e.resourceId === conn.id);
      expect(shredAudit?.metadata).toMatchObject({
        reason: 'disconnect_shred_floor',
        channelConnectionId: conn.id,
      });
      // Nothing left for the revoke, and a second sweep finds nothing.
      const input = {
        tenantId: tenantA,
        actor: { kind: 'user' as const, id: USER },
        correlationId: 'c',
        channelConnectionId: conn.id,
      };
      expect(await inTenant(tenantA, () => runtime.channelRevoke.revokeChannelAccess(input))).toEqual({
        outcome: 'already_destroyed',
      });
      expect((await runtime.sweep.sweepPublications(sweepInput)).credentialsShredded).toBe(0);
    });

    it('RA-01: a reconnect between the revoke’s read and its destroy keeps the new credential (status re-checked under the lock)', async () => {
      fixture.grant.remoteAccountId = 'acct_A_race';
      const conn = await connect(tenantA, brandA);
      const before = await connectionRow(conn.id);
      await run(tenantA, (tx) =>
        channelService.disconnect(A, { channelConnectionId: conn.id, expectedVersion: before.version }, tx),
      );
      const revokeAudits = (
        await tdb.db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.remote_revoke')))
      ).length;
      // The platform call takes long enough for a person to reconnect the same account: the row is active again
      // with a new credential (the old one rotated away) by the time the revoke's transaction opens.
      const revokeAccess = fixture.revokeAccess;
      fixture.revokeAccess = async (creds) => {
        await connect(tenantA, brandA);
        return revokeAccess!.call(fixture, creds);
      };
      try {
        expect(
          await inTenant(tenantA, () =>
            runtime.channelRevoke.revokeChannelAccess({
              tenantId: tenantA,
              actor: { kind: 'user' as const, id: USER },
              correlationId: 'c',
              channelConnectionId: conn.id,
            }),
          ),
        ).toEqual({ outcome: 'already_destroyed' });
      } finally {
        fixture.revokeAccess = revokeAccess;
        fixture.grant.remoteAccountId = 'acct_A';
        fixture.revokedTokens.clear();
      }
      const after = await connectionRow(conn.id);
      expect(after.status).toBe('active');
      expect(after.credentialRefId).not.toBe(before.credentialRefId);
      expect((await credentialRow(after.credentialRefId)).destroyedAt).toBeNull();
      expect((await credentialRow(before.credentialRefId)).rotatedAt).not.toBeNull(); // the reconnect rotated it
      expect(
        (
          await tdb.db
            .select()
            .from(auditEvents)
            .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'channel.remote_revoke')))
        ).length,
      ).toBe(revokeAudits); // nothing recorded for a row that is no longer disconnected
      expect(
        await inTenant(tenantA, () => credentialBroker.withCredentials(tenantA, conn.id, async () => 'x')),
      ).toBe('x');
    });

    it('RA-01: channel health is written only for an active or refresh_needed row, and never by a stamp older than the last check', async () => {
      fixture.grant.remoteAccountId = 'acct_A_health';
      const conn = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      const now = new Date();
      await inTenant(tenantA, () => channelHealth.record(conn.id, 'token_expired', now));
      expect((await connectionRow(conn.id)).health).toBe('token_expired');
      // A slow pull that started before the newer stamp cannot overwrite it with a stale ok.
      await inTenant(tenantA, () => channelHealth.record(conn.id, 'ok', new Date(now.getTime() - 60_000)));
      expect((await connectionRow(conn.id)).health).toBe('token_expired');
      await inTenant(tenantA, () => channelHealth.record(conn.id, 'ok', new Date(now.getTime() + 60_000)));
      expect((await connectionRow(conn.id)).health).toBe('ok');
      // The refresh workflow's revoked (reconnect_needed) stands until a person reconnects: a read cannot flip it.
      await tdb.db
        .update(channelConnections)
        .set({ status: 'reconnect_needed', health: 'revoked', healthCheckedAt: now })
        .where(eq(channelConnections.id, conn.id));
      await inTenant(tenantA, () => channelHealth.record(conn.id, 'ok', new Date(now.getTime() + 120_000)));
      expect(await connectionRow(conn.id)).toMatchObject({ status: 'reconnect_needed', health: 'revoked' });
      await tdb.db
        .update(channelConnections)
        .set({ status: 'refresh_needed' })
        .where(eq(channelConnections.id, conn.id));
      await inTenant(tenantA, () => channelHealth.record(conn.id, 'ok', new Date(now.getTime() + 180_000)));
      expect((await connectionRow(conn.id)).health).toBe('ok');
    });

    it('RA-01: connect.start refuses a certified provider this environment disabled, or whose app credentials are not set, with the reason the providers listing shows', async () => {
      const start = () =>
        run(tenantA, (tx) =>
          channelService.connect.start(
            A,
            { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
            tx,
          ),
        );
      configureChannelActivation(() => ({ disabled: true, credentialRefs: [] }));
      await expect(start()).rejects.toMatchObject({
        code: 'CAPABILITY_UNSUPPORTED',
        details: [{ path: 'providerKey', issue: `provider_disabled:${FIXTURE_PROVIDER_KEY}` }],
      });
      configureChannelActivation(() => ({
        disabled: false,
        credentialRefs: [
          { name: 'PROVIDER_FIXTURE_PROVIDER_CLIENT_ID_REF', present: true },
          { name: 'PROVIDER_FIXTURE_PROVIDER_SECRET_REF', present: false },
        ],
      }));
      await expect(start()).rejects.toMatchObject({
        details: [{ path: 'providerKey', issue: 'credentials_missing:PROVIDER_FIXTURE_PROVIDER_SECRET_REF' }],
      });
      configureChannelActivation(null);
      expect((await start()).url).toContain('https://fixture.example/oauth');
    });

    it('a transient refresh failure is logged by error name and code only: never a message that can carry a secret URL', async () => {
      fixture.grant.remoteAccountId = 'acct_A_refresh_log';
      const conn = await connect(tenantA, brandA);
      fixture.grant.remoteAccountId = 'acct_A';
      const chunks: string[] = [];
      createLogger({
        service: 'publishing-test',
        level: 'info',
        destination: new Writable({
          write(chunk, _enc, cb) {
            chunks.push(String(chunk));
            cb();
          },
        }),
      });
      const failing = Object.assign(
        new Error('POST https://oauth.fixture.example/token?client_id=cid&client_secret=SUPERSECRET failed'),
        { code: 'ETIMEDOUT' },
      );
      const refresh = vi.spyOn(fixture, 'refresh').mockRejectedValueOnce(failing);
      try {
        expect(
          await inTenant(tenantA, () =>
            createPublishingRuntime().tokenRefresh.refreshCredentials({
              tenantId: tenantA,
              actor: { kind: 'user' as const, id: USER },
              correlationId: 'c',
              channelConnectionId: conn.id,
            }),
          ),
        ).toEqual({ ok: false, reason: 'transient' });
      } finally {
        refresh.mockRestore();
        createLogger({ service: 'oremedia' });
      }
      const line = chunks.find((c) => c.includes('token refresh failed'));
      expect(line).toBeDefined();
      const logged = JSON.parse(line!) as Record<string, unknown>;
      expect(logged).toMatchObject({
        errorName: 'Error',
        errorCode: 'ETIMEDOUT',
        channelConnectionId: conn.id,
      });
      expect(logged).not.toHaveProperty('errorMessage');
      expect(line).not.toContain('SUPERSECRET');
      expect(line).not.toContain('client_secret');
    });

    it('refreshCredentials writes a new credential row version, destroys the old one, and flags failures', async () => {
      const before = await connectionRow(connA);
      const input = {
        tenantId: tenantA,
        actor: { kind: 'user' as const, id: USER },
        correlationId: 'c',
        channelConnectionId: connA,
      };
      expect(await inTenant(tenantA, () => runtime.tokenRefresh.readRefreshSchedule(input))).toMatchObject({
        status: 'active',
      });
      fixture.refreshBehaviour = {
        ok: true,
        credentials: { accessToken: 'at_refreshed', refreshToken: 'rt_2' },
        tokenExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      };
      const res = await inTenant(tenantA, () => runtime.tokenRefresh.refreshCredentials(input));
      expect(res).toMatchObject({ ok: true });
      const after = await connectionRow(connA);
      expect(after.credentialRefId).not.toBe(before.credentialRefId);
      expect(after.health).toBe('ok'); // RA-01: a refresh that went through is the health check
      expect(after.healthCheckedAt).not.toBeNull();
      expect((await credentialRow(before.credentialRefId)).rotatedAt).not.toBeNull();
      expect((await credentialRow(before.credentialRefId)).ciphertext).toBe('');
      expect(
        await inTenant(tenantA, () =>
          credentialBroker.withCredentials(tenantA, connA, async (c) => c.accessToken),
        ),
      ).toBe('at_refreshed');
      // the per-connection lock: a second refresh inside the lock window is refused
      expect(await inTenant(tenantA, () => runtime.tokenRefresh.refreshCredentials(input))).toEqual({
        ok: false,
        reason: 'locked',
      });
      // a reconnect_required refresh flags the connection and emits the notification event
      const runtime2 = createPublishingRuntime();
      fixture.refreshBehaviour = { ok: false, reason: 'reconnect_required' };
      expect(await inTenant(tenantA, () => runtime2.tokenRefresh.refreshCredentials(input))).toEqual({
        ok: false,
        reason: 'reconnect_required',
      });
      expect((await connectionRow(connA)).status).toBe('reconnect_needed');
      expect((await connectionRow(connA)).health).toBe('revoked'); // RA-01: a grant refused for good
      expect(
        (await eventsOf(tenantA, 'channel.reconnect_needed')).some(
          (e) => e.payload['channelConnectionId'] === connA,
        ),
      ).toBe(true);
      expect(await inTenant(tenantA, () => channelService.channelUsable(connA))).toBe(false);
      await tdb.db
        .update(channelConnections)
        .set({ status: 'active' })
        .where(eq(channelConnections.id, connA));
      fixture.refreshBehaviour = {
        ok: true,
        credentials: { accessToken: 'at_refreshed', refreshToken: 'rt_2' },
      };
    });

    it('the sweeper re-emits past-due starts without a running workflow and turns expired claims into outcome_unknown', async () => {
      const v = newVariant(tenantA, brandA, connA);
      const overdue = await schedule(tenantA, v.id, new Date(Date.now() - 10 * 60_000));
      const v2 = newVariant(tenantA, brandA, connA);
      const lost = await schedule(tenantA, v2.id);
      const { attemptId } = await dispatch(lost.id, `pub:${lost.id}:11111111-2222-3333-4444-555555555555`);
      await tdb.db
        .update(publications)
        .set({ claimedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(publications.id, lost.id));
      const v3 = newVariant(tenantA, brandA, connA);
      const running = await schedule(tenantA, v3.id, new Date(Date.now() - 10 * 60_000));
      runningWorkflows = new Set([`pub:${running.id}`]);
      const sweepInput = {
        correlationId: 'sweep',
        now: new Date().toISOString(),
        claimLeaseSeconds: 20 * 60,
        graceSeconds: 60,
      };
      const summary = await runtime.sweep.sweepPublications(sweepInput);
      expect(summary).toEqual({ scheduledReemitted: 1, dispatchingExpired: 1, credentialsShredded: 0 });
      expect(
        (await eventsOf(tenantA, 'publication.scheduled')).filter(
          (e) => e.payload['publicationId'] === overdue.id,
        ),
      ).toHaveLength(2);
      expect(
        (await eventsOf(tenantA, 'publication.scheduled')).filter(
          (e) => e.payload['publicationId'] === running.id,
        ),
      ).toHaveLength(1);
      expect(await row(lost.id)).toMatchObject({
        state: 'outcome_unknown',
        stateReason: 'claim_lease_expired',
      });
      expect((await attemptsOf(lost.id))[0]).toMatchObject({ id: attemptId, outcome: 'unknown' });
      const reconcile = (await eventsOf(tenantA, 'publication.reconcile_requested')).find(
        (e) => e.payload['publicationId'] === lost.id,
      )!;
      expect(reconcile.payload).toMatchObject({ attemptId, providerKey: FIXTURE_PROVIDER_KEY });
      // a second pass finds nothing new for the expired claim (outcome_unknown is not swept)
      expect((await runtime.sweep.sweepPublications(sweepInput)).dispatchingExpired).toBe(0);
    });
  });

  describe('restore rule (spec 17.6, runbook "restore a single tenant" step 5): holdRestored', () => {
    const STALE_FENCE = {
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ issue: expect.stringMatching(/^stale_fencing_token:/) })],
    };
    /** An illegal move from the row's state: the activity layer maps VALIDATION_FAILED to a non-retryable failure. */
    const ILLEGAL_FROM_HELD = {
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ issue: expect.stringMatching(/illegal transition from 'held'/) })],
    };
    const publicationsRepo = new PublicationRepository();
    const attemptsRepo = new PublicationAttemptRepository();
    const holdRestored = (
      actor: ResolvedActor,
      brandId: string | null,
      tenantId = tenantA,
      extra: { limit?: number } = {},
    ) => run(tenantId, (tx) => publicationService.holdRestored(actor, { brandId, ...extra }, tx));
    /** A pending publish left in `processing` (its attempt was sent), as a restore can bring back. */
    const processingRow = async (text: string) => {
      const v = newVariant(tenantA, brandA, connA, text);
      const pub = await schedule(tenantA, v.id);
      const { claim, attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'pending' };
      fixture.pendingChecks = ['ready'];
      const pending = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: claim.fencingToken }),
      );
      await inTenant(tenantA, () => runtime.control.markProcessing({ ...wfInput(pub.id), attempt: pending }));
      fixture.behaviour = { kind: 'accept' };
      return { id: pub.id, attemptId, fencingToken: claim.fencingToken };
    };
    /** Sent and live on the channel, the response lost; the restore point is before markOutcomeUnknown. */
    const sentDispatchingRow = async (text: string) => {
      const pub = await schedule(tenantA, newVariant(tenantA, brandA, connA, text).id);
      const { claim, attemptId } = await dispatch(pub.id);
      fixture.behaviour = { kind: 'crash_after_send' };
      await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(pub.id), attemptId, fencingToken: claim.fencingToken }),
      );
      fixture.behaviour = { kind: 'accept' };
      return { id: pub.id, attemptId, fencingToken: claim.fencingToken };
    };

    it('never-sent rows move to held; sent rows (processing, or dispatching with sentAt) to outcome_unknown with a reconcile request; the rest and the other tenant are untouched; audited, announced, idempotent', async () => {
      const scheduled = await schedule(tenantA, newVariant(tenantA, brandA, connA).id);
      const dispatching = await schedule(
        tenantA,
        newVariant(tenantA, brandA, connA, 'Restore dispatching').id,
      );
      await dispatch(dispatching.id);
      const sent = await sentDispatchingRow('Restore sent, live on the channel');
      const processing = await processingRow('Restore processing');
      const published = await schedule(tenantA, newVariant(tenantA, brandA, connA, 'Restore published').id);
      const d = await dispatch(published.id);
      const accepted = await inTenant(tenantA, () =>
        runtime.provider.publishOnce({ ...wfInput(published.id), attemptId: d.attemptId, fencingToken: 1 }),
      );
      await inTenant(tenantA, () =>
        runtime.control.markPublished({ ...wfInput(published.id), attempt: accepted }),
      );
      const foreign = await schedule(tenantB, newVariant(tenantB, brandB, connB).id);
      const allA = async () => tdb.db.select().from(publications).where(eq(publications.tenantId, tenantA));
      const before = await allA();
      const inFlight = before.filter((p) => ['scheduled', 'dispatching', 'processing'].includes(p.state));
      expect(inFlight.map((p) => p.id)).toEqual(
        expect.arrayContaining([scheduled.id, dispatching.id, sent.id, processing.id]),
      );
      const foreignBefore = await row(foreign.id);
      const postsBefore = fixture.posts.length;

      const result = await holdRestored(A, null);
      expect(result.hasMore).toBe(false);
      expect([...result.held, ...result.outcomeUnknown].sort()).toEqual(inFlight.map((p) => p.id).sort());
      expect(result.held).toEqual(expect.arrayContaining([scheduled.id, dispatching.id]));
      expect([...result.outcomeUnknown].sort()).toEqual(expect.arrayContaining([sent.id, processing.id]));
      expect(result.outcomeUnknown).not.toContain(dispatching.id); // attempt open, never sent
      const after = new Map((await allA()).map((p) => [p.id, p]));
      for (const p of before) {
        const now = after.get(p.id)!;
        if (!inFlight.includes(p)) {
          expect(now, `${p.id} (${p.state}) is untouched`).toEqual(p);
          continue;
        }
        const toState = result.held.includes(p.id) ? 'held' : 'outcome_unknown';
        expect(now).toMatchObject({
          state: toState,
          stateReason: 'restored_from_backup',
          version: p.version + 1,
        });
        if (toState === 'held') expect(now.holdReasons).toEqual(['restored_from_backup']);
        // A claimed row's fence moves on, so the workflow holding the old claim can do nothing more with it.
        expect(now.fencingToken).toBe(p.state === 'scheduled' ? p.fencingToken : p.fencingToken + 1);
      }
      expect(after.get(processing.id)!.state).toBe('outcome_unknown');
      expect(after.get(published.id)!.state).toBe('published');
      expect(await row(foreign.id)).toEqual(foreignBefore);
      expect(fixture.posts.length).toBe(postsBefore);
      // Audited and announced per row, like every other hold and outcome move; sent rows ask for reconciliation.
      const audits = await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantA));
      for (const [ids, action] of [
        [result.held, 'publication.hold'],
        [result.outcomeUnknown, 'publication.outcome_unknown'],
      ] as const)
        for (const id of ids) {
          const audit = audits.find(
            (a) =>
              a.resourceId === id && a.action === action && a.metadata?.['reason'] === 'restored_from_backup',
          );
          expect(audit, `${action} audit for ${id}`).toMatchObject({ decision: 'allowed', actorId: USER });
        }
      const changed = (await eventsOf(tenantA, 'publication.state_changed')).filter(
        (e) => e.payload['reason'] === 'restored_from_backup',
      );
      expect(changed.map((e) => e.payload['publicationId']).sort()).toEqual(
        [...result.held, ...result.outcomeUnknown].sort(),
      );
      const reconcile = (await eventsOf(tenantA, 'publication.reconcile_requested')).filter((e) =>
        result.outcomeUnknown.includes(String(e.payload['publicationId'])),
      );
      expect(reconcile.map((e) => e.payload['publicationId']).sort()).toEqual(
        [...result.outcomeUnknown].sort(),
      );
      expect(reconcile.find((e) => e.payload['publicationId'] === sent.id)!.payload).toMatchObject({
        attemptId: sent.attemptId,
        providerKey: FIXTURE_PROVIDER_KEY,
        workflowId: `pub:${sent.id}:reconcile:${after.get(sent.id)!.version}`,
      });
      // A second run finds nothing in flight and changes nothing.
      const snapshot = await allA();
      expect(await holdRestored(A, null)).toEqual({ held: [], outcomeUnknown: [], hasMore: false });
      expect(await allA()).toEqual(snapshot);

      // The exits. Never sent: a person releases it (a new generation).
      const heldRow = await row(scheduled.id);
      const released = await run(tenantA, (tx) =>
        publicationService.reschedule(
          A,
          {
            publicationId: scheduled.id,
            expectedVersion: heldRow.version,
            scheduledFor: new Date().toISOString(),
          },
          tx,
        ),
      );
      expect(released).toMatchObject({ state: 'scheduled', holdReasons: [] });
      // Sent and live: the reconciliation workflow's lookup finds it → published with evidence, no second post.
      const found = await inTenant(tenantA, () =>
        runtime.provider.findRemotePost({ ...wfInput(sent.id), attemptId: sent.attemptId }),
      );
      if (found.status !== 'found') throw new Error(`expected the live post, got ${found.status}`);
      await inTenant(tenantA, () =>
        runtime.control.markPublished({
          ...wfInput(sent.id),
          evidence: { ...found, attemptId: sent.attemptId },
        }),
      );
      expect(await row(sent.id)).toMatchObject({ state: 'published', remotePostId: found.remotePostId });
      expect(fixture.posts.length).toBe(postsBefore);
      // Sent and pending when restored: a person who finds it live confirms it (never a re-release).
      const confirmed = await run(tenantA, (tx) =>
        publicationService.reconcile(
          A,
          { publicationId: processing.id, resolution: 'confirm_published', remotePostId: 'remote_restored' },
          tx,
        ),
      );
      expect(confirmed).toMatchObject({ state: 'published', remotePostId: 'remote_restored' });
      expect((await evidenceOf(processing.id)).map((e) => e.kind)).toContain('human_confirmation');
    });

    it('a sentAt the pre-send fence commits while holdRestored waits for the row lock is seen (locking read under REPEATABLE READ)', async () => {
      const pub = await schedule(tenantA, newVariant(tenantA, brandA, connA, 'Fence interleaving').id);
      const { claim, attemptId } = await dispatch(pub.id);
      let fenceHolds!: () => void;
      const fenceHolding = new Promise<void>((r) => (fenceHolds = r));
      let commitFence!: () => void;
      const fenceMayCommit = new Promise<void>((r) => (commitFence = r));
      // Connection 1: the pre-send fence exactly as publishOnce runs it (row lock, fence check, sentAt), held open.
      const fence = run(tenantA, async (tx) => {
        const locked = await publicationsRepo.lock(pub.id, tx);
        expect(locked).toMatchObject({ state: 'dispatching', fencingToken: claim.fencingToken });
        expect(await attemptsRepo.markSent(attemptId, new Date(), tx)).toBe(true);
        fenceHolds();
        await fenceMayCommit;
      });
      await fenceHolding;
      // Connection 2: holdRestored's transaction. Its first consistent read (policy.assert's, here made explicit so
      // the read view is certainly taken now) fixes the snapshot before the fence commits; then it waits on the lock.
      let snapshotTaken!: () => void;
      const snapshot = new Promise<void>((r) => (snapshotTaken = r));
      const restore = run(tenantA, async (tx) => {
        const [seen] = await tx
          .select()
          .from(publicationAttempts)
          .where(eq(publicationAttempts.id, attemptId));
        expect(seen!.sentAt).toBeNull(); // uncommitted: not in this transaction's snapshot
        snapshotTaken();
        return publicationService.holdRestored(A, { brandId: null }, tx);
      });
      await snapshot;
      await new Promise((r) => setTimeout(r, 300)); // holdRestored is now blocked on the publication row lock
      commitFence();
      await fence;
      const result = await restore;
      // Sent before the hold: it may be live, so it goes to reconciliation, never to a hold a person might release.
      expect(result.outcomeUnknown).toContain(pub.id);
      expect(result.held).not.toContain(pub.id);
      expect(await row(pub.id)).toMatchObject({
        state: 'outcome_unknown',
        stateReason: 'restored_from_backup',
        fencingToken: claim.fencingToken + 1,
      });
      expect((await attemptsOf(pub.id))[0]).toMatchObject({
        id: attemptId,
        outcome: 'unknown',
        errorCode: 'restored_from_backup',
      });
      expect((await attemptsOf(pub.id))[0]!.sentAt).not.toBeNull();
    });

    it('the run that held the old claim cannot send, poll or finalise; its token-less calls on a held row fail as VALIDATION_FAILED (non-retryable) and change nothing', async () => {
      // (a) Claimed with an open attempt, held before publishOnce: the old fence is refused, nothing is sent.
      const a = await schedule(tenantA, newVariant(tenantA, brandA, connA, 'Fence a').id);
      const da = await dispatch(a.id);
      await holdRestored(A, null);
      const heldA = await row(a.id);
      expect(heldA).toMatchObject({ state: 'held', holdReasons: ['restored_from_backup'] });
      const postsBefore = fixture.posts.length;
      await expect(
        inTenant(tenantA, () =>
          runtime.provider.publishOnce({
            ...wfInput(a.id),
            attemptId: da.attemptId,
            fencingToken: da.claim.fencingToken,
          }),
        ),
      ).rejects.toMatchObject(STALE_FENCE);
      const oldClaim = { ...wfInput(a.id), fencingToken: da.claim.fencingToken };
      await expect(inTenant(tenantA, () => runtime.control.openAttempt(oldClaim))).rejects.toMatchObject(
        STALE_FENCE,
      );
      await expect(inTenant(tenantA, () => runtime.control.evaluateRelease(oldClaim))).rejects.toMatchObject(
        STALE_FENCE,
      );
      // The workflow maps the failed publishOnce to `unknown` and reconciles: markOutcomeUnknown has no token and
      // fails on the held row (no held → outcome_unknown move), rolling back its ledger write. markProcessing and
      // markPublished fail the same way; markFailed leaves a held row as it is.
      const attempt = { attemptId: da.attemptId, outcome: 'accepted' as const, remotePostId: 'never' };
      for (const call of [
        () => runtime.control.markOutcomeUnknown({ ...wfInput(a.id), attemptId: da.attemptId }),
        () => runtime.control.markProcessing({ ...wfInput(a.id), attempt }),
        () => runtime.control.markPublished({ ...wfInput(a.id), attempt }),
      ])
        await expect(inTenant(tenantA, call)).rejects.toMatchObject(ILLEGAL_FROM_HELD);
      expect(
        await inTenant(tenantA, () => runtime.control.markFailed({ ...wfInput(a.id), attempt })),
      ).toMatchObject({ state: 'held', changed: false });
      expect(await row(a.id)).toEqual(heldA);
      expect(fixture.posts.length).toBe(postsBefore);
      expect((await attemptsOf(a.id))[0]).toMatchObject({ sentAt: null, finishedAt: null });

      // (b) The race: publishOnce has loaded the row, the hold commits, then the adapter reaches its first mutation.
      // The pre-send fence refuses to commit sentAt, so the request never leaves; the workflow ends on the held row.
      const b = await schedule(tenantA, newVariant(tenantA, brandA, connA, 'Fence b').id);
      const db = await dispatch(b.id);
      const original = fixture.publish.bind(fixture);
      fixture.publish = async (req, creds, io) => {
        await holdRestored(A, null);
        return original(req, creds, io);
      };
      let raced;
      try {
        raced = await inTenant(tenantA, () =>
          runtime.provider.publishOnce({
            ...wfInput(b.id),
            attemptId: db.attemptId,
            fencingToken: db.claim.fencingToken,
          }),
        );
      } finally {
        fixture.publish = original;
      }
      expect(raced.outcome).toBe('retryable_error');
      expect(fixture.posts.length).toBe(postsBefore);
      const [attemptB] = await attemptsOf(b.id);
      expect(attemptB).toMatchObject({ sentAt: null, outcome: 'retryable_error' });
      expect(await row(b.id)).toMatchObject({ state: 'held', holdReasons: ['restored_from_backup'] });
      expect(
        await inTenant(tenantA, () =>
          runtime.control.retryAfterProvenNoEffect({ ...wfInput(b.id), attempt: raced }),
        ),
      ).toEqual({ retried: false, reason: 'state' });
      expect((await row(b.id)).state).toBe('held');

      // (c) Processing (sent, pending on the channel): reconciled, and the old claim can no longer poll or finalise.
      const c = await processingRow('Fence c');
      await holdRestored(A, null);
      const calls = fixture.calls.length;
      const call = { ...wfInput(c.id), attemptId: c.attemptId, fencingToken: c.fencingToken };
      await expect(inTenant(tenantA, () => runtime.provider.finalize(call))).rejects.toMatchObject(
        STALE_FENCE,
      );
      await expect(inTenant(tenantA, () => runtime.provider.checkStatus(call))).rejects.toMatchObject(
        STALE_FENCE,
      );
      expect(fixture.calls.slice(calls)).toEqual([]);
      expect(await row(c.id)).toMatchObject({
        state: 'outcome_unknown',
        stateReason: 'restored_from_backup',
      });

      // (d) The same pre-send fence covers a move that keeps the token: worker loss declared while the worker was
      // only slow (dispatching → outcome_unknown). The late send is refused, so reconciliation cannot race it.
      const d = await schedule(tenantA, newVariant(tenantA, brandA, connA, 'Fence d').id);
      const dd = await dispatch(d.id);
      const postsBeforeD = fixture.posts.length;
      fixture.publish = async (req, creds, io) => {
        await inTenant(tenantA, () =>
          runtime.control.markOutcomeUnknown({ ...wfInput(d.id), attemptId: null }),
        );
        return original(req, creds, io);
      };
      try {
        await inTenant(tenantA, () =>
          runtime.provider.publishOnce({
            ...wfInput(d.id),
            attemptId: dd.attemptId,
            fencingToken: dd.claim.fencingToken,
          }),
        );
      } finally {
        fixture.publish = original;
      }
      expect(fixture.posts.length).toBe(postsBeforeD);
      expect((await attemptsOf(d.id))[0]).toMatchObject({ sentAt: null });
      expect(await row(d.id)).toMatchObject({
        state: 'outcome_unknown',
        fencingToken: dd.claim.fencingToken,
      });

      // (e) Held, released by a person and claimed again by the new generation while the old run was still on its
      // way to the channel: the row is dispatching again, but under a newer token, so the old send is refused and
      // only the new claim can send (one post, never two).
      const e = await schedule(tenantA, newVariant(tenantA, brandA, connA, 'Fence e').id);
      const de = await dispatch(e.id, 'pub:old:run-1');
      let newClaim = 0;
      fixture.publish = async (req, creds, io) => {
        fixture.publish = original;
        await holdRestored(A, null);
        const heldE = await row(e.id);
        await run(tenantA, (tx) =>
          publicationService.reschedule(
            A,
            { publicationId: e.id, expectedVersion: heldE.version, scheduledFor: new Date().toISOString() },
            tx,
          ),
        );
        const claim = await inTenant(tenantA, () =>
          runtime.control.claimForDispatch({ ...wfInput(e.id), claimant: 'pub:new:run-2' }),
        );
        if (claim.ok) newClaim = claim.fencingToken;
        return original(req, creds, io);
      };
      const postsBeforeE = fixture.posts.length;
      try {
        await inTenant(tenantA, () =>
          runtime.provider.publishOnce({
            ...wfInput(e.id),
            attemptId: de.attemptId,
            fencingToken: de.claim.fencingToken,
          }),
        );
      } finally {
        fixture.publish = original;
      }
      expect(newClaim).toBeGreaterThan(de.claim.fencingToken);
      expect(fixture.posts.length).toBe(postsBeforeE);
      expect(await row(e.id)).toMatchObject({ state: 'dispatching', fencingToken: newClaim });
      const oldAttempt = (await attemptsOf(e.id)).find((a) => a.id === de.attemptId)!;
      expect(oldAttempt.sentAt).toBeNull();
    });

    it('bounded batches, each its own transaction: hasMore until every row moved; a failed batch leaves the committed ones and a re-run resumes; the input is parsed', async () => {
      const brandA3 = newId('brand');
      await tdb.db.insert(brands).values({
        id: brandA3,
        tenantId: tenantA,
        name: 'A3',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
      });
      let brandLookupFails = false;
      registerBrandChecker({
        assertExist: async (ids) => {
          if (brandLookupFails) throw new Error('lost connection');
          for (const id of ids) if (![brandA, brandA3].includes(id)) throw new NotFoundError('Brand', id);
        },
      });
      fixture.grant.remoteAccountId = 'acct_A3';
      const connA3 = (await connect(tenantA, brandA3)).id;
      fixture.grant.remoteAccountId = 'acct_A';
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push((await schedule(tenantA, newVariant(tenantA, brandA3, connA3, `Batch ${i}`).id)).id);
      const stateOf = async () => Promise.all(ids.map(async (id) => (await row(id)).state));

      const first = await holdRestored(A, brandA3, tenantA, { limit: 2 });
      expect(first).toMatchObject({ outcomeUnknown: [], hasMore: true });
      expect(first.held).toEqual(ids.slice(0, 2)); // oldest first
      // The next batch fails: its transaction rolls back alone; the first batch stays committed.
      brandLookupFails = true;
      await expect(holdRestored(A, brandA3, tenantA, { limit: 2 })).rejects.toThrow('lost connection');
      brandLookupFails = false;
      expect(await stateOf()).toEqual(['held', 'held', 'scheduled', 'scheduled', 'scheduled']);
      // Re-run: it resumes with what is still in flight; the counts add up to every row exactly once.
      const second = await holdRestored(A, brandA3, tenantA, { limit: 2 });
      const third = await holdRestored(A, brandA3, tenantA, { limit: 2 });
      expect(second).toMatchObject({ held: ids.slice(2, 4), hasMore: true });
      expect(third).toMatchObject({ held: ids.slice(4), hasMore: false });
      expect(await holdRestored(A, brandA3, tenantA, { limit: 2 })).toEqual({
        held: [],
        outcomeUnknown: [],
        hasMore: false,
      });
      expect(await stateOf()).toEqual(ids.map(() => 'held'));
      // The contract is parsed by the command, not only at the edge: brandId is required (null for the tenant).
      for (const bad of [{}, { brandId: brandA3, limit: 0 }, { brandId: brandA3, limit: 201 }])
        await expect(
          run(tenantA, (tx) => publicationService.holdRestored(A, bad as { brandId: string }, tx)),
        ).rejects.toMatchObject({ name: 'ZodError' });
      registerBrandChecker({
        assertExist: async (ids) => {
          const known = new Set([brandA, brandB]);
          for (const id of ids) if (!known.has(id)) throw new NotFoundError('Brand', id);
        },
      });
    });

    it('a tenant admin command, brand-scoped on request: another brand is untouched, a foreign brand is NOT_FOUND, a publisher or an agent is refused', async () => {
      const brandA2 = newId('brand');
      await tdb.db.insert(brands).values({
        id: brandA2,
        tenantId: tenantA,
        name: 'A2',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
      });
      registerBrandChecker({
        assertExist: async (ids) => {
          const known = new Set([brandA, brandA2, brandB]);
          for (const id of ids) {
            if (!known.has(id)) throw new NotFoundError('Brand', id);
            if (id === brandB && requireTenantId() !== tenantB) throw new NotFoundError('Brand', id);
          }
        },
      });
      fixture.grant.remoteAccountId = 'acct_A2';
      const connA2 = (await connect(tenantA, brandA2)).id;
      fixture.grant.remoteAccountId = 'acct_A';
      const one = await schedule(tenantA, newVariant(tenantA, brandA, connA, 'Brand one').id);
      const two = await schedule(tenantA, newVariant(tenantA, brandA2, connA2, 'Brand two').id);
      const result = await holdRestored(A, brandA);
      expect(result.held).toContain(one.id);
      expect(result.held).not.toContain(two.id);
      expect((await row(one.id)).state).toBe('held');
      expect((await row(two.id)).state).toBe('scheduled');
      // Another tenant's brand does not exist here; nothing moves.
      await expect(holdRestored(A, brandB)).rejects.toBeInstanceOf(NotFoundError);
      expect((await row(two.id)).state).toBe('scheduled');
      // Below admin, or an agent: refused by the policy engine, nothing moves.
      await expect(holdRestored({ ...A, role: 'publisher' } as ResolvedActor, null)).rejects.toBeInstanceOf(
        PolicyDeniedError,
      );
      const agent: ResolvedActorServicePrincipal = {
        kind: 'service_principal',
        id: 'sp_restore',
        tenantId: tenantA,
        status: 'active',
        maxAutonomy: 'managed_autopublish',
        grants: [{ action: 'billing.manage', brandIds: 'all' }],
      };
      await expect(holdRestored(agent, null)).rejects.toBeInstanceOf(PolicyDeniedError);
      expect((await row(two.id)).state).toBe('scheduled');
      // Tenant-wide from a brand-restricted context reaches only its own brands (none, or brand 1 here).
      const restricted = (brandIds: ReadonlySet<string>) =>
        runInTenant(ctx(tenantA, brandIds), () =>
          withTransaction((tx) => publicationService.holdRestored(A, { brandId: null }, tx)),
        );
      expect(await restricted(new Set())).toEqual({ held: [], outcomeUnknown: [], hasMore: false });
      expect((await restricted(new Set([brandA]))).held).not.toContain(two.id);
      expect((await row(two.id)).state).toBe('scheduled');
      // The admin, tenant-wide, reaches the other brand too.
      expect((await holdRestored(A, null)).held).toContain(two.id);
    });
  });

  describe('portfolio summary (attentionByBrand)', () => {
    it('counts, per visible brand, publications needing a person and those due in the next seven days', async () => {
      const now = new Date();
      const until = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      // The earlier tests leave nothing due this week: move one cancelled row into the window and one just past it.
      const cancelled = await tdb.db
        .select()
        .from(publications)
        .where(and(eq(publications.tenantId, tenantA), eq(publications.state, 'cancelled')));
      expect(cancelled.length).toBeGreaterThanOrEqual(2);
      const inWindow = new Date(now.getTime() + 24 * 3600 * 1000);
      const pastWindow = new Date(until.getTime() + 3600 * 1000);
      await tdb.db
        .update(publications)
        .set({ state: 'scheduled', scheduledFor: inWindow })
        .where(eq(publications.id, cancelled[0]!.id));
      await tdb.db
        .update(publications)
        .set({ state: 'scheduled', scheduledFor: pastWindow })
        .where(eq(publications.id, cancelled[1]!.id));
      const rows = await tdb.db.select().from(publications).where(eq(publications.tenantId, tenantA));
      const expected = new Map<string, { needsPerson: number; upcoming: number }>();
      for (const r of rows) {
        const needsPerson = ['failed', 'outcome_unknown', 'held'].includes(r.state);
        const upcoming = r.state === 'scheduled' && r.scheduledFor >= now && r.scheduledFor < until;
        if (!needsPerson && !upcoming) continue;
        const e = expected.get(r.brandId) ?? { needsPerson: 0, upcoming: 0 };
        expected.set(r.brandId, {
          needsPerson: e.needsPerson + (needsPerson ? 1 : 0),
          upcoming: e.upcoming + (upcoming ? 1 : 0),
        });
      }
      expect([...expected.values()].some((e) => e.needsPerson > 0)).toBe(true);
      expect([...expected.values()].some((e) => e.upcoming > 0)).toBe(true);
      const all = await runInTenant(ctx(tenantA), () => publicationService.attentionByBrand(A, now));
      expect(all.upcomingDays).toBe(7);
      expect(
        new Map(all.brands.map((b) => [b.brandId, { needsPerson: b.needsPerson, upcoming: b.upcoming }])),
      ).toEqual(expected);
      // A brand-restricted context counts only its brands; another tenant never sees these rows.
      const none = await runInTenant(ctx(tenantA, new Set()), () =>
        publicationService.attentionByBrand(A, now),
      );
      expect(none.brands).toEqual([]);
      const onlyA = await runInTenant(ctx(tenantA, new Set([brandA])), () =>
        publicationService.attentionByBrand(A, now),
      );
      expect(onlyA.brands.every((b) => b.brandId === brandA)).toBe(true);
      const other = await runInTenant(ctx(tenantB), () => publicationService.attentionByBrand(B, now));
      expect(other.brands.some((b) => expected.has(b.brandId))).toBe(false);
    });
  });
});
