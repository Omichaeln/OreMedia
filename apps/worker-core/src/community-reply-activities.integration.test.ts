import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { DecryptedCredentials, PublishOutcome } from '@oremedia/contracts/providers';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { requireTenant, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { conversations, messages, responseDrafts } from '@oremedia/db/schema/community';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  createCommunityReplyControlActivities,
  createCommunityReplyProviderActivities,
} from '@oremedia/activities';
import { communityService, createCommunityReplyRuntime } from '@oremedia/module-community';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureChannelActivation,
  configureCredentialBroker,
  configurePublishingProviders,
  connectedChannel,
  fixtureCapability,
  registerProviderClients,
  registerPublishingBrandChecker,
} from '@oremedia/module-publishing';
import { ProviderRegistry, type CommentRequest, type ProviderIO } from '@oremedia/providers';

/**
 * Ledger G21: communityReplyWorkflowV1's activity hosts (the provider half on `publish-<providerKey>`, the control
 * half on `core`) built from the production factories over the real community reply runtime, against MySQL and the
 * fixture provider with a comment surface. The host establishes the draft's tenant with the sender's grants
 * re-loaded now; a foreign tenant, a foreign draft or a non-member actor is refused non-retryably before any
 * credential is opened or row written; the reply is posted once (a replayed send never reaches the platform again)
 * and the outbound message is recorded once.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/** A loopback endpoint standing in for the platform's comment call (the reply itself is recorded in memory). */
let platform = '';
const platformServer = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

/** The fixture platform with a comment surface: records each reply; the send goes through ProviderIO. */
class ReplyingFixture extends FixtureProviderAdapter {
  readonly replies: CommentRequest[] = [];
  async comment(req: CommentRequest, _creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    await io.request(`${platform}/comments`, { method: 'POST', body: req.text }, { mutation: true });
    this.replies.push(req);
    return {
      outcome: 'accepted',
      remotePostId: `reply_${this.replies.length}`,
      remoteUrl: `https://fixture.example/c/${this.replies.length}`,
    };
  }
}

const refusal = async (p: Promise<unknown>) => {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { name?: string; type?: string; nonRetryable?: boolean } | null;
  expect(err?.name).toBe('ApplicationFailure');
  return { type: err?.type, nonRetryable: err?.nonRetryable };
};

describe('community reply activity hosts against MySQL and the fixture provider (ledger G21)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const brandA = newId('brd');
  const brandB = newId('brd');
  const userA = newId('usr');
  const userB = newId('usr');
  const membershipA = newId('mem');
  const membershipB = newId('mem');
  const registry = new ProviderRegistry();
  const fixture = new ReplyingFixture(fixtureCapability({ comments: { read: true, reply: true } }));
  registry.register(fixture);
  const runtime = createCommunityReplyRuntime();
  const providerActs = createCommunityReplyProviderActivities(runtime);
  const controlActs = createCommunityReplyControlActivities(runtime);
  let convA = '';
  let parentA = '';
  let parentB = '';

  const member = (tenantId: string, userId: string, role: MembershipRole): ResolvedActor => ({
    kind: 'user',
    id: userId,
    tenantId,
    membershipId: tenantId === tenantA ? membershipA : membershipB,
    membershipStatus: 'active',
    role,
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  });
  const ctx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    brandIds: 'all',
    correlationId: 'corr_reply_acts',
  });
  const run = <T>(tenantId: string, userId: string, fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantId, userId), () => withTransaction(fn));
  const wf = (responseDraftId: string, tenantId = tenantA, userId = userA) => ({
    tenantId,
    actor: { kind: 'user' as const, id: userId },
    correlationId: 'corr_reply_acts',
    responseDraftId,
  });
  const draftRow = async (id: string) =>
    (await tdb.db.select().from(responseDrafts).where(eq(responseDrafts.id, id)))[0]!;
  const outboundOf = (conversationId: string) =>
    tdb.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));
  const reply = (tenantId: string, userId: string, messageId: string, text: string) =>
    run(tenantId, userId, (tx) =>
      communityService.reply(member(tenantId, userId, 'owner'), { messageId, text }, tx),
    );

  const connect = async (tenantId: string, userId: string, brandId: string, remoteAccountId: string) => {
    fixture.grant.remoteAccountId = remoteAccountId;
    const actor = member(tenantId, userId, 'owner');
    const started = await run(tenantId, userId, (tx) =>
      channelService.connect.start(
        actor,
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return run(tenantId, userId, (tx) =>
      channelService.connect
        .complete(actor, { state: started.state, code: 'good' }, tx)
        .then(connectedChannel),
    );
  };
  const thread = async (tenantId: string, brandId: string, channelConnectionId: string, remote: string) => {
    const conversationId = newId('cnv');
    await tdb.db.insert(conversations).values({
      id: conversationId,
      tenantId,
      brandId,
      channelConnectionId,
      publicationId: null,
      remoteThreadId: `post_${remote}`,
      state: 'open',
      lastMessageAt: new Date(),
    });
    const messageId = newId('msg');
    await tdb.db.insert(messages).values({
      id: messageId,
      tenantId,
      brandId,
      conversationId,
      remoteMessageId: remote,
      parentRemoteMessageId: null,
      direction: 'inbound',
      authorHash: 'a'.repeat(64),
      authorHandle: `@${remote}`,
      text: `comment ${remote}`,
      remoteCreatedAt: new Date(),
    });
    return { conversationId, messageId };
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => platformServer.listen(0, '127.0.0.1', resolve));
    platform = `http://127.0.0.1:${(platformServer.address() as AddressInfo).port}`;
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'reply-acts-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'reply-acts-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values([
      { id: userA, email: `reply-acts-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A' },
      { id: userB, email: `reply-acts-${userB.slice(-6).toLowerCase()}@example.test`, name: 'B' },
    ]);
    await tdb.db.insert(memberships).values([
      { id: membershipA, tenantId: tenantA, userId: userA, role: 'owner', status: 'active', allBrands: true },
      { id: membershipB, tenantId: tenantB, userId: userB, role: 'owner', status: 'active', allBrands: true },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configurePublishingProviders({ registry, insecureAllowLoopback: true });
    configureCredentialBroker({ kms: new LocalKms('reply-acts-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureChannelActivation(null);
    registerPublishingBrandChecker({
      assertExist: async (brandIds: string[]) => {
        const known = requireTenant().tenantId === tenantA ? brandA : brandB;
        for (const id of brandIds) if (id !== known) throw new NotFoundError('Brand', id);
      },
    });
    const connA = (await connect(tenantA, userA, brandA, 'acct_A')).id;
    const connB = (await connect(tenantB, userB, brandB, 'acct_B')).id;
    ({ conversationId: convA, messageId: parentA } = await thread(tenantA, brandA, connA, 'ca1'));
    ({ messageId: parentB } = await thread(tenantB, brandB, connB, 'cb1'));
  });
  afterAll(async () => {
    platformServer.close();
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.replies.length = 0;
  });

  describe('createCommunityReplyProviderActivities (sendReplyOnce)', () => {
    it('posts the reply once in the draft tenant with the draft id as idempotency key; a replay never reaches the platform again', async () => {
      const queued = await reply(tenantA, userA, parentA, 'Thank you!');
      const input = wf(queued.responseDraftId);
      expect(await providerActs.sendReplyOnce(input)).toEqual({
        outcome: 'accepted',
        remoteMessageId: 'reply_1',
        remoteUrl: 'https://fixture.example/c/1',
      });
      expect(fixture.replies).toEqual([
        {
          remotePostId: 'post_ca1',
          replyToRemoteId: 'ca1',
          text: 'Thank you!',
          idempotencyKey: queued.responseDraftId,
        },
      ]);
      // The send boundary committed in tenant A, audited as the sender (the context the host established).
      expect(await draftRow(queued.responseDraftId)).toMatchObject({ tenantId: tenantA, state: 'sending' });
      const boundary = await tdb.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'community.reply_sending'),
            eq(auditEvents.resourceId, queued.responseDraftId),
          ),
        );
      expect(boundary).toHaveLength(1);
      expect(boundary[0]).toMatchObject({ tenantId: tenantA, actorKind: 'user', actorId: userA });
      // Temporal retries the activity (or a lost worker resumes): the reply is never posted twice.
      expect(await providerActs.sendReplyOnce(input)).toMatchObject({
        outcome: 'unknown',
        code: 'resumed_after_send',
      });
      expect(fixture.replies).toHaveLength(1);
    });

    it('the sender is re-resolved at the send boundary: a membership without inbox.respond fails the draft, nothing is posted', async () => {
      const queued = await reply(tenantA, userA, parentA, 'Not any more');
      await tdb.db.update(memberships).set({ role: 'analyst' }).where(eq(memberships.id, membershipA));
      try {
        expect(await providerActs.sendReplyOnce(wf(queued.responseDraftId))).toMatchObject({
          outcome: 'rejected',
          code: 'sender_not_authorised',
        });
      } finally {
        await tdb.db.update(memberships).set({ role: 'owner' }).where(eq(memberships.id, membershipA));
      }
      expect(fixture.replies).toEqual([]);
      expect(await draftRow(queued.responseDraftId)).toMatchObject({
        state: 'failed',
        failureCode: 'sender_not_authorised',
      });
    });

    it('a foreign tenant, a foreign draft or a non-member actor is refused before any credential is opened', async () => {
      const queuedA = await reply(tenantA, userA, parentA, 'Mine');
      const queuedB = await reply(tenantB, userB, parentB, 'Theirs');
      const beforeA = await draftRow(queuedA.responseDraftId);
      const beforeB = await draftRow(queuedB.responseDraftId);
      for (const bad of [
        wf(queuedA.responseDraftId, tenantB, userB),
        wf(queuedB.responseDraftId),
        wf(queuedA.responseDraftId, tenantB, userA),
      ])
        expect(await refusal(providerActs.sendReplyOnce(bad))).toEqual({
          type: 'PolicyDenied',
          nonRetryable: true,
        });
      expect(fixture.replies).toEqual([]);
      expect(await draftRow(queuedA.responseDraftId)).toEqual(beforeA);
      expect(await draftRow(queuedB.responseDraftId)).toEqual(beforeB);
    });
  });

  describe('createCommunityReplyControlActivities (readReplyRoute, recordReplyOutcome)', () => {
    it('routes to the provider queue and records the outbound message once; a replayed record changes nothing', async () => {
      const queued = await reply(tenantA, userA, parentA, 'Recorded once');
      const input = wf(queued.responseDraftId);
      expect(await controlActs.readReplyRoute(input)).toEqual({ providerKey: FIXTURE_PROVIDER_KEY });
      const result = await providerActs.sendReplyOnce(input);
      const outboundBefore = (await outboundOf(convA)).length;
      const recorded = await controlActs.recordReplyOutcome({ ...input, result });
      expect(recorded).toMatchObject({ state: 'sent', changed: true });
      const [out] = await tdb.db.select().from(messages).where(eq(messages.id, recorded.messageId!));
      expect(out).toMatchObject({
        tenantId: tenantA,
        direction: 'outbound',
        remoteMessageId: 'reply_1',
        parentRemoteMessageId: 'ca1',
        text: 'Recorded once',
      });
      expect(await draftRow(queued.responseDraftId)).toMatchObject({
        state: 'sent',
        outboundMessageId: out!.id,
      });
      // The workflow retries the record (idempotent, maximumAttempts 5): no second message, no state change.
      const version = (await draftRow(queued.responseDraftId)).version;
      expect(await controlActs.recordReplyOutcome({ ...input, result })).toMatchObject({
        state: 'sent',
        changed: false,
      });
      expect(await outboundOf(convA)).toHaveLength(outboundBefore + 1);
      expect((await draftRow(queued.responseDraftId)).version).toBe(version);
    });

    it('a foreign tenant, a foreign draft or a non-member actor is refused; nothing is recorded', async () => {
      const queuedA = await reply(tenantA, userA, parentA, 'Not yours to record');
      const queuedB = await reply(tenantB, userB, parentB, 'Nor this');
      const result = {
        outcome: 'accepted' as const,
        remoteMessageId: 'forged-remote-comment',
        remoteUrl: null,
      };
      const outboundBefore = await tdb.db.select().from(messages).where(eq(messages.direction, 'outbound'));
      for (const bad of [
        wf(queuedA.responseDraftId, tenantB, userB),
        wf(queuedB.responseDraftId),
        wf(queuedA.responseDraftId, tenantB, userA),
      ]) {
        expect(await refusal(controlActs.readReplyRoute(bad))).toEqual({
          type: 'PolicyDenied',
          nonRetryable: true,
        });
        expect(await refusal(controlActs.recordReplyOutcome({ ...bad, result }))).toEqual({
          type: 'PolicyDenied',
          nonRetryable: true,
        });
      }
      expect(await tdb.db.select().from(messages).where(eq(messages.direction, 'outbound'))).toEqual(
        outboundBefore,
      );
      expect((await draftRow(queuedA.responseDraftId)).state).toBe('queued');
      expect((await draftRow(queuedB.responseDraftId)).state).toBe('queued');
    });
  });
});
