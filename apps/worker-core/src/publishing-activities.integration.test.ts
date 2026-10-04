import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { RenderedValidationV1 } from '@oremedia/contracts/article';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ChannelVariantForPublishing, PublicationWorkflowInputV1 } from '@oremedia/contracts/publishing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { brandDestinations } from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import {
  channelConnections,
  credentialRefs,
  publicationRemoteChanges,
  publications,
  remoteEvidence,
} from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  CHANNEL_REVOKE_ACTOR,
  createChannelRevokeActivities,
  createPublishControlActivities,
  createPublishProviderActivities,
  createRemoteChangeControlActivities,
  createRemoteChangeProviderActivities,
  createRemoteChangeSweepActivities,
  createRenderedValidationActivities,
} from '@oremedia/activities';
import { registerBrandChecker } from '@oremedia/module-access';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureChannelActivation,
  configureCredentialBroker,
  configurePublishingProviders,
  connectedChannel,
  createPublishingRuntime,
  publicationService,
  registerApprovalConsumer,
  registerDestinationPublisher,
  registerProviderClients,
  registerPublishMediaSource,
  registerPublishingBrandChecker,
  registerReleaseEvaluator,
  registerVariantSource,
  registerWorkflowProbe,
  resetDestinationPublisher,
  type DestinationPublisher,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';

/**
 * Ledger G21: the publishing activity hosts that had no integration test (channel revoke RA-01, remote edit and
 * delete with their control and stale sweep, rendered validation RA-04), each built from the production factory
 * over the real publishing runtime, against MySQL and the fixture provider. For every host: the tenant context it
 * establishes (the input's tenant, the actor re-resolved now, or the platform job it declares), a foreign tenant
 * or a foreign id refused non-retryably before anything changes, the outcome written to the database, and a
 * replayed call (the same ids, as Temporal retries it or a duplicate delivery repeats it) that causes no second
 * effect.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/** The Temporal failure an activity host raised (checked by name: this app does not depend on @temporalio/common). */
const refusal = async (p: Promise<unknown>) => {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { name?: string; type?: string; nonRetryable?: boolean } | null;
  expect(err?.name).toBe('ApplicationFailure');
  return { type: err?.type, nonRetryable: err?.nonRetryable };
};

describe('publishing activity hosts against MySQL and the fixture provider (ledger G21)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const brandA = newId('brd');
  const brandB = newId('brd');
  const userA = newId('usr');
  const userB = newId('usr');
  const destinationId = newId('dst');
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  registry.register(fixture);
  const variantsById = new Map<string, ChannelVariantForPublishing>();
  const runtime = createPublishingRuntime();
  const control = createPublishControlActivities(runtime.control);
  const provider = createPublishProviderActivities(runtime.provider);
  let connA = '';
  let connB = '';

  const membershipOf: Record<string, string> = {};
  const owner = (tenantId: string, userId: string): ResolvedActor => ({
    kind: 'user',
    id: userId,
    tenantId,
    membershipId: (membershipOf[userId] ??= newId('mem')),
    membershipStatus: 'active',
    role: 'owner',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  });
  const A = owner(tenantA, userA);
  const B = owner(tenantB, userB);
  const ctx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    brandIds: 'all',
    correlationId: 'corr_pub_acts',
  });
  const asA = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(tenantA, userA), () => withTransaction(fn));
  const asB = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(tenantB, userB), () => withTransaction(fn));
  const wfInput = (
    publicationId: string,
    tenantId = tenantA,
    userId = userA,
  ): PublicationWorkflowInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    correlationId: 'corr_pub_acts',
    publicationId,
  });
  const auditsOf = (tenantId: string, action: string, resourceId: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.action, action),
          eq(auditEvents.resourceId, resourceId),
        ),
      );
  const publicationRow = async (id: string) =>
    (await tdb.db.select().from(publications).where(eq(publications.id, id)))[0]!;
  const connectionRow = async (id: string) =>
    (await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, id)))[0]!;
  const credentialRow = async (id: string) =>
    (await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, id)))[0]!;
  const changeRow = async (id: string) =>
    (await tdb.db.select().from(publicationRemoteChanges).where(eq(publicationRemoteChanges.id, id)))[0]!;
  const evidenceOf = (publicationId: string) =>
    tdb.db.select().from(remoteEvidence).where(eq(remoteEvidence.publicationId, publicationId));

  const connect = async (actor: ResolvedActor, brandId: string, remoteAccountId: string) => {
    fixture.grant.remoteAccountId = remoteAccountId;
    const as = actor.tenantId === tenantA ? asA : asB;
    const started = await as((tx) =>
      channelService.connect.start(
        actor,
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return as((tx) =>
      channelService.connect
        .complete(actor, { state: started.state, code: 'good' }, tx)
        .then(connectedChannel),
    );
  };
  const disconnect = async (actor: ResolvedActor, channelConnectionId: string) => {
    const as = actor.tenantId === tenantA ? asA : asB;
    const row = await connectionRow(channelConnectionId);
    return as((tx) =>
      channelService.disconnect(actor, { channelConnectionId, expectedVersion: row.version }, tx),
    );
  };
  const newVariant = (
    tenantId: string,
    brandId: string,
    over: Partial<ChannelVariantForPublishing>,
  ): ChannelVariantForPublishing => {
    const v: ChannelVariantForPublishing = {
      id: newId('cv'),
      tenantId,
      brandId,
      contentPackageId: newId('pkg'),
      contentRevisionId: newId('pr'),
      channelConnectionId: null,
      destinationId: null,
      text: 'Hello from the activity hosts',
      altTexts: [],
      settings: {},
      exportIds: [],
      exportHashes: [],
      article: null,
      version: 0,
      ...over,
    };
    variantsById.set(v.id, v);
    return v;
  };
  /** A variant scheduled, dispatched and published through the real control and provider activity hosts. */
  const publish = async (actor: ResolvedActor, variant: ChannelVariantForPublishing) => {
    const as = actor.tenantId === tenantA ? asA : asB;
    const pub = await as((tx) =>
      publicationService.schedule(
        actor,
        {
          channelVariantId: variant.id,
          scheduledFor: new Date(Date.now() - 1000).toISOString(),
          authority: 'approval',
          approvalId: newId('apr'),
        },
        tx,
      ),
    );
    const input = wfInput(pub.id, actor.tenantId, actor.id);
    const claim = await control.claimForDispatch({ ...input, claimant: `pub:${pub.id}` });
    if (!claim.ok) throw new Error(`claim failed: ${claim.state}`);
    await control.evaluateRelease({ ...input, fencingToken: claim.fencingToken });
    const attemptId = await control.openAttempt({ ...input, fencingToken: claim.fencingToken });
    const attempt = await provider.publishOnce({ ...input, attemptId, fencingToken: claim.fencingToken });
    await control.markPublished({ ...input, attempt });
    expect((await publicationRow(pub.id)).state).toBe('published');
    return pub.id;
  };

  /** RA-04: the destinations module's answer, stubbed here (the publishing runtime records what it says). */
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
  let validateResult = validationOf(true);
  const validateCalls: string[] = [];
  const destinationStub: DestinationPublisher = {
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
      return {
        outcome: 'accepted',
        remotePostId: '42',
        remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
        readback: {
          remoteId: '42',
          remoteUrl: 'https://blog.acme.example/why-ore-and-tar-last/',
          title: article.title,
          slug: article.slug,
          status: 'publish',
          modifiedAt: '2026-10-02T10:00:00.000Z',
          contentHash: 'a'.repeat(64),
        },
        readbackVerification: {
          outcome: 'verified',
          matched: ['content', 'title', 'slug', 'status', 'modifiedAt'],
          mismatched: [],
          reason: null,
          sentHash: 'b'.repeat(64),
        },
        validation: validationOf(true),
      };
    },
    edit: async () => ({ outcome: 'rejected', code: 'unused', message: 'unused' }),
    unpublish: async () => ({ outcome: 'rejected', code: 'unused', message: 'unused' }),
    delete: async () => ({ outcome: 'done' }),
    validateRendered: async (input) => {
      validateCalls.push(`${input.tenantId}:${input.destinationId}:${input.url}`);
      return validateResult;
    },
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'pub-acts-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'pub-acts-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values([
      { id: userA, email: `pub-acts-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A owner' },
      { id: userB, email: `pub-acts-${userB.slice(-6).toLowerCase()}@example.test`, name: 'B owner' },
    ]);
    await tdb.db.insert(memberships).values([
      {
        id: membershipOf[userA]!,
        tenantId: tenantA,
        userId: userA,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
      {
        id: membershipOf[userB]!,
        tenantId: tenantB,
        userId: userB,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    await tdb.db.insert(brandDestinations).values({
      id: destinationId,
      tenantId: tenantA,
      brandId: brandA,
      kind: 'cms_site',
      externalId: 'https://blog.acme.example',
      displayName: 'blog.acme.example',
      ownerUserId: userA,
      grantedScopes: ['articles:write', 'articles:publish'],
      health: 'healthy',
      capabilityVersion: 1,
    });
    registerBrandChecker({
      assertExist: async () => undefined,
      assertValidGrantBrands: async () => undefined,
    });
    registerPublishingBrandChecker({
      assertExist: async (ids) => {
        for (const id of ids) if (id !== brandA && id !== brandB) throw new NotFoundError('Brand', id);
      },
    });
    configurePublishingProviders({ registry, insecureAllowLoopback: true }); // the fixture's send is a loopback call
    configureCredentialBroker({ kms: new LocalKms('pub-acts-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'c', clientSecret: 's' }));
    configureChannelActivation(null);
    registerVariantSource(async (id) => {
      const v = variantsById.get(id);
      if (!v) throw new NotFoundError('ChannelVariant', id);
      return v;
    });
    registerReleaseEvaluator(async () => ({ allow: true }));
    registerApprovalConsumer(async () => undefined);
    registerPublishMediaSource({ describe: async () => [], release: async () => [] });
    registerWorkflowProbe(null);
    registerDestinationPublisher(destinationStub);
    connA = (await connect(A, brandA, 'acct_A')).id;
    connB = (await connect(B, brandB, 'acct_B')).id;
  });
  afterAll(async () => {
    resetDestinationPublisher();
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.behaviour = { kind: 'accept' };
    fixture.revokeBehaviour = { outcome: 'revoked' };
    fixture.remoteMutations = [];
    validateResult = validationOf(true);
  });

  describe('createChannelRevokeActivities (channelRevokeWorkflowV1, RA-01)', () => {
    const acts = createChannelRevokeActivities(runtime.channelRevoke);
    const input = (tenantId: string, channelConnectionId: string) => ({
      tenantId,
      // The disconnecting person: the host replaces it with the platform job, whose grants are never loaded.
      actor: { kind: 'user' as const, id: userA },
      correlationId: 'corr_channel_revoke',
      channelConnectionId,
    });

    it('a foreign tenant or a foreign connection is refused before any credential is opened; nothing changes', async () => {
      const conn = await connect(A, brandA, 'acct_A_revoke_foreign');
      await disconnect(A, conn.id);
      const before = await connectionRow(conn.id);
      const calls = fixture.calls.length;
      // tenant B naming tenant A's connection, and tenant A naming tenant B's
      expect(await refusal(acts.revokeChannelAccess(input(tenantB, conn.id)))).toEqual({
        type: 'PolicyDenied',
        nonRetryable: true,
      });
      expect(await refusal(acts.revokeChannelAccess(input(tenantA, connB)))).toEqual({
        type: 'PolicyDenied',
        nonRetryable: true,
      });
      expect(fixture.calls.length).toBe(calls);
      expect(await connectionRow(conn.id)).toEqual(before);
      expect((await credentialRow(before.credentialRefId)).destroyedAt).toBeNull();
      expect((await credentialRow((await connectionRow(connB)).credentialRefId)).destroyedAt).toBeNull();
    });

    it('revokes at the platform as the platform job in the connection tenant, destroys the credential and audits; a replay revokes nothing again', async () => {
      const conn = await connect(A, brandA, 'acct_A_revoke');
      await disconnect(A, conn.id);
      const before = await connectionRow(conn.id);
      expect(await acts.revokeChannelAccess(input(tenantA, conn.id))).toEqual({ outcome: 'revoked' });
      expect(fixture.calls.filter((c) => c.startsWith('revokeAccess:'))).toHaveLength(1);
      const cred = await credentialRow(before.credentialRefId);
      expect(cred.destroyedAt).not.toBeNull();
      expect(cred.ciphertext).toBe('');
      expect((await connectionRow(conn.id)).health).toBe('revoked');
      const audits = await auditsOf(tenantA, 'channel.remote_revoke', conn.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorKind: CHANNEL_REVOKE_ACTOR.kind,
        actorId: CHANNEL_REVOKE_ACTOR.id,
        decision: 'allowed',
        metadata: { remoteRevoke: 'revoked', channelConnectionId: conn.id },
      });
      // The activity retried or the event replayed: nothing left to do, nothing opened, nothing recorded.
      const calls = fixture.calls.length;
      const version = (await connectionRow(conn.id)).version;
      expect(await acts.revokeChannelAccess(input(tenantA, conn.id))).toEqual({
        outcome: 'already_destroyed',
      });
      expect(fixture.calls.length).toBe(calls);
      expect((await connectionRow(conn.id)).version).toBe(version);
      expect(await auditsOf(tenantA, 'channel.remote_revoke', conn.id)).toHaveLength(1);
    });

    it('a removed membership of the disconnecting person never leaves a live token (no actor grants are loaded)', async () => {
      const conn = await connect(A, brandA, 'acct_A_revoke_departed');
      await disconnect(A, conn.id);
      const before = await connectionRow(conn.id);
      const departed = newId('usr'); // no user row, no membership: resolving it would refuse
      expect(
        await acts.revokeChannelAccess({ ...input(tenantA, conn.id), actor: { kind: 'user', id: departed } }),
      ).toEqual({ outcome: 'revoked' });
      expect((await credentialRow(before.credentialRefId)).destroyedAt).not.toBeNull();
      expect((await auditsOf(tenantA, 'channel.remote_revoke', conn.id))[0]?.actorId).toBe(
        CHANNEL_REVOKE_ACTOR.id,
      );
    });
  });

  describe('createRemoteChangeProviderActivities and createRemoteChangeControlActivities (publicationRemoteEdit/DeleteWorkflowV1)', () => {
    const providerActs = createRemoteChangeProviderActivities(runtime.remoteChangeProvider);
    const controlActs = createRemoteChangeControlActivities(runtime.remoteChangeControl);
    const changeInput = (publicationId: string, changeId: string, tenantId = tenantA, userId = userA) => ({
      ...wfInput(publicationId, tenantId, userId),
      changeId,
      providerKey: FIXTURE_PROVIDER_KEY,
    });
    const published = async (text: string) => {
      const pubId = await publish(A, newVariant(tenantA, brandA, { channelConnectionId: connA, text }));
      return { pubId, remotePostId: (await publicationRow(pubId)).remotePostId! };
    };

    it('an edit is applied once on the platform; a replay converges on the same text with the same idempotency key; recorded once', async () => {
      const { pubId, remotePostId } = await published('Launch price 50 EUR');
      const edit = await asA((tx) =>
        publicationService.editRemote(A, { publicationId: pubId, text: 'Launch price 40 EUR' }, tx),
      );
      const input = changeInput(pubId, edit.changeId);
      expect(await providerActs.editRemotePost(input)).toEqual({ outcome: 'done' });
      // Temporal retries the provider activity before the outcome is recorded: the platform sets the same text.
      expect(await providerActs.editRemotePost(input)).toEqual({ outcome: 'done' });
      const post = fixture.posts.find((p) => p.id === remotePostId)!;
      expect(post.text).toBe('Launch price 40 EUR');
      expect(fixture.posts.filter((p) => p.text === 'Launch price 40 EUR')).toHaveLength(1);
      expect(await controlActs.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } })).toEqual({
        state: 'succeeded',
        publicationState: 'published',
        changed: true,
      });
      expect(await changeRow(edit.changeId)).toMatchObject({
        tenantId: tenantA,
        kind: 'edit',
        state: 'succeeded',
      });
      const edits = (await evidenceOf(pubId)).filter((e) => e.kind === 'remote_edit');
      expect(edits).toHaveLength(1);
      expect(await auditsOf(tenantA, 'publication.edit_remote_applied', pubId)).toHaveLength(1);
      // The record replayed: unchanged, no second evidence row or audit. The provider replayed: skipped, no call.
      expect(await controlActs.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } })).toEqual({
        state: 'succeeded',
        publicationState: 'published',
        changed: false,
      });
      const calls = fixture.calls.length;
      expect(await providerActs.editRemotePost(input)).toEqual({
        outcome: 'skipped',
        reason: 'change_succeeded',
      });
      expect(fixture.calls.length).toBe(calls);
      expect((await evidenceOf(pubId)).filter((e) => e.kind === 'remote_edit')).toHaveLength(1);
      expect(await auditsOf(tenantA, 'publication.edit_remote_applied', pubId)).toHaveLength(1);
    });

    it('a delete is carried out once (a replay finds the post gone); the publication becomes removed once', async () => {
      const { pubId, remotePostId } = await published('Delete me');
      const del = await asA((tx) =>
        publicationService.deleteRemote(A, { publicationId: pubId, reason: 'wrong price' }, tx),
      );
      const input = changeInput(pubId, del.changeId);
      expect(await providerActs.deleteRemotePost(input)).toEqual({ outcome: 'done' });
      expect(await providerActs.deleteRemotePost(input)).toEqual({ outcome: 'already_absent' });
      expect(fixture.posts.find((p) => p.id === remotePostId)?.deleted).toBe(true);
      expect(
        await controlActs.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } }),
      ).toMatchObject({
        state: 'succeeded',
        publicationState: 'removed',
        changed: true,
      });
      expect(
        await controlActs.recordRemoteChangeOutcome({ ...input, result: { outcome: 'done' } }),
      ).toMatchObject({
        changed: false,
      });
      expect(await publicationRow(pubId)).toMatchObject({ state: 'removed', stateReason: 'remote_deleted' });
      expect((await evidenceOf(pubId)).filter((e) => e.kind === 'remote_deletion')).toHaveLength(1);
    });

    it('the requester is re-resolved now: a membership that lost the permission is rejected without a platform call', async () => {
      const { pubId } = await published('Permission is checked at the point of effect');
      const edit = await asA((tx) =>
        publicationService.editRemote(A, { publicationId: pubId, text: 'Edited by a departed owner' }, tx),
      );
      const membershipId = membershipOf[userA]!;
      await tdb.db.update(memberships).set({ role: 'analyst' }).where(eq(memberships.id, membershipId));
      try {
        const calls = fixture.calls.length;
        const result = await providerActs.editRemotePost(changeInput(pubId, edit.changeId));
        expect(result).toMatchObject({ outcome: 'rejected', code: expect.stringMatching(/^policy_denied:/) });
        expect(fixture.calls.length).toBe(calls);
      } finally {
        await tdb.db.update(memberships).set({ role: 'owner' }).where(eq(memberships.id, membershipId));
      }
    });

    it('a foreign tenant, a foreign publication or a non-member actor is refused non-retryably before any call or write', async () => {
      const { pubId } = await published('Isolated');
      const edit = await asA((tx) =>
        publicationService.editRemote(A, { publicationId: pubId, text: 'Isolated, edited' }, tx),
      );
      const pubB = await publish(B, newVariant(tenantB, brandB, { channelConnectionId: connB }));
      const calls = fixture.calls.length;
      const changeBefore = await changeRow(edit.changeId);
      const bBefore = await publicationRow(pubB);
      for (const bad of [
        changeInput(pubId, edit.changeId, tenantB, userB), // tenant B's owner naming tenant A's publication
        changeInput(pubB, edit.changeId), // tenant A naming tenant B's publication
        changeInput(pubId, edit.changeId, tenantB, userA), // tenant A's owner is no member of tenant B
      ]) {
        expect(await refusal(providerActs.editRemotePost(bad))).toEqual({
          type: 'PolicyDenied',
          nonRetryable: true,
        });
        expect(
          await refusal(controlActs.recordRemoteChangeOutcome({ ...bad, result: { outcome: 'done' } })),
        ).toEqual({ type: 'PolicyDenied', nonRetryable: true });
      }
      expect(fixture.calls.length).toBe(calls);
      expect(await changeRow(edit.changeId)).toEqual(changeBefore);
      expect(await publicationRow(pubB)).toEqual(bBefore);
    });
  });

  describe('createRemoteChangeSweepActivities (remoteChangeSweepWorkflowV1)', () => {
    const sweepActs = createRemoteChangeSweepActivities(runtime.remoteChangeSweep);

    it('closes a stale change in its own tenant as the sweeper, leaves a fresh one (and the other tenant) alone; a replay closes nothing', async () => {
      const staleA = await publish(
        A,
        newVariant(tenantA, brandA, { channelConnectionId: connA, text: 'Stale A' }),
      );
      const freshB = await publish(
        B,
        newVariant(tenantB, brandB, { channelConnectionId: connB, text: 'Fresh B' }),
      );
      const stale = await asA((tx) =>
        publicationService.deleteRemote(A, { publicationId: staleA, reason: 'lost workflow' }, tx),
      );
      const fresh = await asB((tx) =>
        publicationService.deleteRemote(B, { publicationId: freshB, reason: 'in flight' }, tx),
      );
      await tdb.db
        .update(publicationRemoteChanges)
        .set({ requestedAt: new Date(Date.now() - 7 * 3600_000) })
        .where(eq(publicationRemoteChanges.id, stale.changeId));
      const freshBefore = await changeRow(fresh.changeId);
      const result = await sweepActs.sweepStaleRemoteChanges({
        correlationId: 'corr_remote_sweep',
        now: new Date().toISOString(),
      });
      expect(result.closed).toBeGreaterThanOrEqual(1);
      expect(await changeRow(stale.changeId)).toMatchObject({
        tenantId: tenantA,
        state: 'failed',
        errorCode: 'stale_no_outcome',
      });
      expect((await publicationRow(staleA)).state).toBe('published');
      const audits = await auditsOf(tenantA, 'publication.delete_remote_failed', staleA);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorKind: 'service_principal', actorId: 'remote-change-sweeper' });
      expect(await changeRow(fresh.changeId)).toEqual(freshBefore);
      expect(await auditsOf(tenantB, 'publication.delete_remote_failed', freshB)).toEqual([]);
      // The schedule fires again (or the activity is retried): nothing left to close.
      expect(
        await sweepActs.sweepStaleRemoteChanges({
          correlationId: 'corr_remote_sweep',
          now: new Date().toISOString(),
        }),
      ).toEqual({ closed: 0 });
      expect(await auditsOf(tenantA, 'publication.delete_remote_failed', staleA)).toHaveLength(1);
    });
  });

  describe('createRenderedValidationActivities (renderedValidationWorkflowV1, RA-04)', () => {
    const acts = createRenderedValidationActivities(runtime.renderedValidation);
    const liveArticle = async () => {
      const pubId = await publish(
        A,
        newVariant(tenantA, brandA, { destinationId, article, text: article.title }),
      );
      expect(await publicationRow(pubId)).toMatchObject({
        remoteStatus: 'live',
        remoteVerification: 'verified',
      });
      return pubId;
    };

    it('validates the live page in the publication tenant as the publishing actor and records the result; a replay converges', async () => {
      const pubId = await liveArticle();
      const input = { ...wfInput(pubId), publishedAt: new Date().toISOString() };
      validateCalls.length = 0;
      validateResult = validationOf(false);
      expect(await acts.validateRenderedPublication(input)).toEqual({
        outcome: 'validated',
        ok: false,
        verification: 'failed',
      });
      expect(validateCalls).toEqual([
        `${tenantA}:${destinationId}:https://blog.acme.example/why-ore-and-tar-last/`,
      ]);
      expect(await publicationRow(pubId)).toMatchObject({
        remoteVerification: 'failed',
        remoteVerifiedAt: null,
      });
      const audits = await auditsOf(tenantA, 'publication.validate_rendered', pubId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorKind: 'user', actorId: userA, decision: 'denied' });
      const evidence = (await evidenceOf(pubId)).filter((e) => e.kind === 'rendered_validation');
      // The activity retried with the same input: a read-only fetch again, and the same verification. The log of
      // what the page showed is insert-only by design (each look is evidence), so the state converges.
      expect(await acts.validateRenderedPublication(input)).toEqual({
        outcome: 'validated',
        ok: false,
        verification: 'failed',
      });
      expect(await publicationRow(pubId)).toMatchObject({
        remoteVerification: 'failed',
        remoteVerifiedAt: null,
      });
      expect((await evidenceOf(pubId)).filter((e) => e.kind === 'rendered_validation')).toHaveLength(
        evidence.length + 1,
      );
      validateResult = validationOf(true);
      expect(await acts.validateRenderedPublication(input)).toMatchObject({ verification: 'verified' });
      expect((await publicationRow(pubId)).remoteVerification).toBe('verified');
    });

    it('a publication that is not a live article is skipped without a fetch or a write', async () => {
      const social = await publish(
        A,
        newVariant(tenantA, brandA, { channelConnectionId: connA, text: 'Social' }),
      );
      const before = await publicationRow(social);
      validateCalls.length = 0;
      expect(
        await acts.validateRenderedPublication({ ...wfInput(social), publishedAt: new Date().toISOString() }),
      ).toEqual({ outcome: 'skipped', reason: 'not_a_published_article:published' });
      expect(validateCalls).toEqual([]);
      expect(await publicationRow(social)).toEqual(before);
    });

    it('a foreign tenant, a foreign publication or a non-member actor is refused before any page is fetched', async () => {
      const pubId = await liveArticle();
      const pubB = await publish(
        B,
        newVariant(tenantB, brandB, { channelConnectionId: connB, text: 'B social' }),
      );
      const before = await publicationRow(pubId);
      validateCalls.length = 0;
      const publishedAt = new Date().toISOString();
      for (const bad of [
        { ...wfInput(pubId, tenantB, userB), publishedAt },
        { ...wfInput(pubB), publishedAt },
        { ...wfInput(pubId, tenantB, userA), publishedAt },
      ])
        expect(await refusal(acts.validateRenderedPublication(bad))).toEqual({
          type: 'PolicyDenied',
          nonRetryable: true,
        });
      expect(validateCalls).toEqual([]);
      expect(await publicationRow(pubId)).toEqual(before);
    });
  });
});
