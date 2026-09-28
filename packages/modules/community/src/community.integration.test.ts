import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { CommentRequest } from '@oremedia/providers';
import {
  CapabilityUnsupportedError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { DecryptedCredentials, PublishOutcome } from '@oremedia/contracts/providers';
import { requireTenant, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { conversations, messages, responseDrafts } from '@oremedia/db/schema/community';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { outboxRouteFor } from '@oremedia/module-operations';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  connectedChannel,
  configurePublishingProviders,
  fixtureCapability,
  registerProviderClients,
  registerPublishingBrandChecker,
} from '@oremedia/module-publishing';
import { ProviderRegistry, ProviderTransportError, type ProviderIO } from '@oremedia/providers';
import { registerCommunityOutboxRoutes } from './outbox-routes';
import { confirmIngestedOwnReply, createCommunityReplyRuntime } from './runtime';
import { communityService } from './service';

/**
 * The comment inbox against MySQL 8: conversations newest activity first with counts; a conversation threaded by
 * parent; handles shown only with inbox.respond; a reply checked against the channel's limit, queued with its outbox
 * event in the same transaction; the reply runtime sending once through the adapter with the parent comment and
 * the draft id as idempotency key, recording the outbound message and never sending twice. Cross-tenant: NOT_FOUND.
 */
const USER = 'usr_community_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_community',
});
const member = (tenantId: string, role: MembershipRole): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_community_test',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);

const T0 = new Date('2026-09-24T10:00:00.000Z');

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
  replyBehaviour: 'accept' | 'reject' | 'after_send_failure' | 'rate_limited' = 'accept';
  async comment(req: CommentRequest, _creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    // The mutation passes the send boundary (beforeSend) first; an abort there throws before anything is recorded.
    await io.request(`${platform}/comments`, { method: 'POST', body: req.text }, { mutation: true });
    this.replies.push(req);
    if (this.replyBehaviour === 'reject')
      return { outcome: 'rejected', code: 'comment_blocked', message: 'blocked by platform' };
    if (this.replyBehaviour === 'rate_limited')
      return { outcome: 'retryable_error', code: 'rate_limited', message: '429', retryAfterMs: 1000 };
    if (this.replyBehaviour === 'after_send_failure')
      throw new ProviderTransportError(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        'after_send',
      );
    return {
      outcome: 'accepted',
      remotePostId: `reply_${this.replies.length}`,
      remoteUrl: 'https://fixture.example/p/1',
    };
  }
}

describe('community module (comment inbox) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const registry = new ProviderRegistry();
  const fixture = new ReplyingFixture(
    fixtureCapability({
      comments: { read: true, reply: true },
      text: {
        maxLength: 20,
        weighted: false,
        supportsLinks: true,
        supportsMentions: true,
        supportsHashtags: true,
      },
    }),
  );
  registry.register(fixture);
  const runtime = createCommunityReplyRuntime({ now: () => new Date(T0.getTime() + 3_600_000) });
  let connA = '';
  let convA = '';
  let convA2 = '';
  const ids: Record<string, string> = {};

  const connect = async (tenantId: string, brandId: string) => {
    const owner = member(tenantId, 'owner');
    const started = await run(tenantId, (tx) =>
      channelService.connect.start(
        owner,
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return run(tenantId, (tx) =>
      channelService.connect
        .complete(owner, { state: started.state, code: 'good' }, tx)
        .then(connectedChannel),
    );
  };
  const conversation = async (
    tenantId: string,
    brandId: string,
    connection: string,
    remote: string,
    at: Date,
  ) => {
    const id = newId('conversation');
    await tdb.db.insert(conversations).values({
      id,
      tenantId,
      brandId,
      channelConnectionId: connection,
      publicationId: null,
      remoteThreadId: remote,
      state: 'open',
      lastMessageAt: at,
    });
    return id;
  };
  const comment = async (
    tenantId: string,
    brandId: string,
    conversationId: string,
    remote: string,
    at: Date,
    parent: string | null = null,
  ) => {
    const id = newId('message');
    await tdb.db.insert(messages).values({
      id,
      tenantId,
      brandId,
      conversationId,
      remoteMessageId: remote,
      parentRemoteMessageId: parent,
      direction: 'inbound',
      authorHash: 'a'.repeat(64),
      authorHandle: `@${remote}`,
      text: `comment ${remote}`,
      remoteCreatedAt: at,
    });
    ids[remote] = id;
    return id;
  };
  const wf = (responseDraftId: string) => ({
    tenantId: tenantA,
    actor: { kind: 'user' as const, id: USER },
    correlationId: 'corr_community',
    responseDraftId,
  });
  const draft = async (id: string) =>
    (await tdb.db.select().from(responseDrafts).where(eq(responseDrafts.id, id)))[0]!;
  const reply = (messageId: string, text: string, role: MembershipRole = 'community') =>
    run(tenantA, (tx) => communityService.reply(member(tenantA, role), { messageId, text }, tx));

  beforeAll(async () => {
    await new Promise<void>((resolve) => platformServer.listen(0, '127.0.0.1', resolve));
    platform = `http://127.0.0.1:${(platformServer.address() as AddressInfo).port}`;
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'community-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'community-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    // The sender, re-resolved at the send boundary: a community member of tenant A.
    await tdb.db.insert(users).values({ id: USER, email: 'community-test@example.test', name: 'Community' });
    await tdb.db.insert(memberships).values({
      id: 'mem_community_test',
      tenantId: tenantA,
      userId: USER,
      role: 'community',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configurePublishingProviders({ registry, insecureAllowLoopback: true });
    configureCredentialBroker({ kms: new LocalKms('community-test-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    registerPublishingBrandChecker({
      assertExist: async (brandIds: string[]) => {
        const known = requireTenant().tenantId === tenantA ? brandA : brandB;
        for (const id of brandIds) if (id !== known) throw new NotFoundError('Brand', id);
      },
    });
    fixture.grant.remoteAccountId = 'acct_A';
    connA = (await connect(tenantA, brandA)).id;
    fixture.grant.remoteAccountId = 'acct_B';
    const connB = (await connect(tenantB, brandB)).id;
    convA = await conversation(tenantA, brandA, connA, 'post_1', new Date(T0.getTime() + 60_000));
    convA2 = await conversation(tenantA, brandA, connA, 'post_2', new Date(T0.getTime() + 120_000));
    await comment(tenantA, brandA, convA, 'c1', T0);
    await comment(tenantA, brandA, convA, 'c2', new Date(T0.getTime() + 30_000), 'c1');
    await comment(tenantA, brandA, convA, 'c3', new Date(T0.getTime() + 60_000));
    await comment(tenantA, brandA, convA2, 'd1', new Date(T0.getTime() + 120_000));
    const convB = await conversation(tenantB, brandB, connB, 'post_b', T0);
    await comment(tenantB, brandB, convB, 'b1', T0);
    registerCommunityOutboxRoutes();
  });
  afterAll(async () => {
    platformServer.close();
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.replyBehaviour = 'accept';
  });

  it('lists conversations newest activity first with counts, paged; handles only with inbox.respond', async () => {
    const page1 = await inTenant(tenantA, () =>
      communityService.conversations.list(member(tenantA, 'community'), {
        brandId: brandA,
        page: { limit: 1 },
      }),
    );
    expect(page1.items.map((c) => c.id)).toEqual([convA2]);
    expect(page1.canRespond).toBe(true);
    expect(page1.items[0]).toMatchObject({
      commentCount: 1,
      latest: { authorHandle: '@d1', text: 'comment d1' },
      channel: { providerKey: FIXTURE_PROVIDER_KEY, replySupported: true, replyMaxLength: 20 },
    });
    const page2 = await inTenant(tenantA, () =>
      communityService.conversations.list(member(tenantA, 'community'), {
        brandId: brandA,
        page: { limit: 1, cursor: page1.nextCursor! },
      }),
    );
    expect(page2.items.map((c) => [c.id, c.commentCount])).toEqual([[convA, 3]]);
    expect(page2.nextCursor).toBeNull();

    const denials = () =>
      tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, 'inbox.respond'), eq(auditEvents.decision, 'denied')));
    const deniedBefore = (await denials()).length;
    const analyst = await inTenant(tenantA, () =>
      communityService.conversations.list(member(tenantA, 'analyst'), { brandId: brandA }),
    );
    // Hiding the handles is a display choice inside an audited brand.read: no denial row per inbox read.
    expect(await denials()).toHaveLength(deniedBefore);
    expect(analyst.canRespond).toBe(false);
    expect(analyst.items.every((c) => c.latest?.authorHandle === null)).toBe(true);
    await expect(
      inTenant(tenantA, () =>
        communityService.conversations.list(member(tenantA, 'community'), { brandId: brandB }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('threads a conversation by parent; a reader without inbox.respond sees no handles and cannot reply', async () => {
    const view = await inTenant(tenantA, () =>
      communityService.messages.list(member(tenantA, 'community'), { conversationId: convA }),
    );
    expect(view.canReply).toBe(true);
    expect(view.items.map((i) => [i.text, i.depth])).toEqual([
      ['comment c1', 0],
      ['comment c2', 1],
      ['comment c3', 0],
    ]);
    expect(view.items[1]!.parentId).toBe(ids['c1']);
    const reader = await inTenant(tenantA, () =>
      communityService.messages.list(member(tenantA, 'analyst'), { conversationId: convA }),
    );
    expect(reader.canReply).toBe(false);
    expect(reader.items.every((i) => i.authorHandle === null)).toBe(true);
    await expect(
      inTenant(tenantB, () =>
        communityService.messages.list(member(tenantB, 'owner'), { conversationId: convA }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reply needs inbox.respond, an inbound comment and text within the channel limit', async () => {
    await expect(reply(ids['c1']!, 'Thanks!', 'analyst')).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(reply(ids['c1']!, 'x'.repeat(21))).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(reply(ids['c1']!, '   ')).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      run(tenantB, (tx) =>
        communityService.reply(member(tenantB, 'owner'), { messageId: ids['c1']!, text: 'hi' }, tx),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await tdb.db.select().from(responseDrafts)).toHaveLength(0);
  });

  it('queues the reply with its outbox event; the runtime sends it once and records the outbound message', async () => {
    const queued = await reply(ids['c2']!, 'Thank you!');
    expect(queued.state).toBe('queued');
    const [evt] = await tdb.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventType, 'community.reply_requested'),
          eq(outboxEvents.aggregateId, queued.responseDraftId),
        ),
      );
    expect(evt?.payload).toMatchObject({ responseDraftId: queued.responseDraftId, brandId: brandA });
    const start = outboxRouteFor('community.reply_requested')!({
      ...evt!,
      payload: evt!.payload as Record<string, unknown>,
    });
    expect(start).toMatchObject({
      workflowType: 'communityReplyWorkflowV1',
      taskQueue: 'core',
      workflowId: `reply:${queued.responseDraftId}`,
    });

    const pending = await inTenant(tenantA, () =>
      communityService.messages.list(member(tenantA, 'community'), { conversationId: convA }),
    );
    expect(pending.items.find((i) => i.kind === 'reply')).toMatchObject({
      replyState: 'queued',
      parentId: ids['c2'],
      depth: 2,
    });

    const input = wf(queued.responseDraftId);
    expect(await inTenant(tenantA, () => runtime.readReplyRoute(input))).toEqual({
      providerKey: FIXTURE_PROVIDER_KEY,
    });
    const result = await inTenant(tenantA, () => runtime.sendReplyOnce(input));
    expect(result).toEqual({
      outcome: 'accepted',
      remoteMessageId: 'reply_1',
      remoteUrl: 'https://fixture.example/p/1',
    });
    expect(fixture.replies.at(-1)).toEqual({
      remotePostId: 'post_1',
      replyToRemoteId: 'c2',
      text: 'Thank you!',
      idempotencyKey: queued.responseDraftId,
    });
    expect((await draft(queued.responseDraftId)).state).toBe('sending');
    // A repeat after the boundary never reaches the platform again.
    expect(await inTenant(tenantA, () => runtime.sendReplyOnce(input))).toMatchObject({
      outcome: 'unknown',
      code: 'resumed_after_send',
    });
    expect(fixture.replies).toHaveLength(1);

    const recorded = await inTenant(tenantA, () => runtime.recordReplyOutcome({ ...input, result }));
    expect(recorded).toMatchObject({ state: 'sent', changed: true });
    expect(await inTenant(tenantA, () => runtime.recordReplyOutcome({ ...input, result }))).toMatchObject({
      state: 'sent',
      changed: false,
    });
    const [out] = await tdb.db.select().from(messages).where(eq(messages.id, recorded.messageId!));
    expect(out).toMatchObject({
      direction: 'outbound',
      remoteMessageId: 'reply_1',
      parentRemoteMessageId: 'c2',
      text: 'Thank you!',
    });
    const view = await inTenant(tenantA, () =>
      communityService.messages.list(member(tenantA, 'community'), { conversationId: convA }),
    );
    expect(view.items.map((i) => [i.text, i.depth, i.replyState])).toEqual([
      ['comment c1', 0, null],
      ['comment c2', 1, null],
      ['Thank you!', 2, 'sent'],
      ['comment c3', 0, null],
    ]);
  });

  it('a rejection fails the draft with the reason; an ambiguous send ends outcome_unknown', async () => {
    fixture.replyBehaviour = 'reject';
    const a = await reply(ids['c3']!, 'Sorry');
    const ra = await inTenant(tenantA, () => runtime.sendReplyOnce(wf(a.responseDraftId)));
    expect(ra).toMatchObject({ outcome: 'rejected', code: 'comment_blocked' });
    await inTenant(tenantA, () => runtime.recordReplyOutcome({ ...wf(a.responseDraftId), result: ra }));
    expect(await draft(a.responseDraftId)).toMatchObject({ state: 'failed', failureCode: 'comment_blocked' });

    fixture.replyBehaviour = 'after_send_failure';
    const b = await reply(ids['c3']!, 'Hello');
    const rb = await inTenant(tenantA, () => runtime.sendReplyOnce(wf(b.responseDraftId)));
    expect(rb.outcome).toBe('unknown');
    await inTenant(tenantA, () => runtime.recordReplyOutcome({ ...wf(b.responseDraftId), result: rb }));
    expect((await draft(b.responseDraftId)).state).toBe('outcome_unknown');

    // The platform refused it without effect after the boundary: failed (a person may send again), never re-sent.
    fixture.replyBehaviour = 'rate_limited';
    const c = await reply(ids['c3']!, 'Hi');
    expect(await inTenant(tenantA, () => runtime.sendReplyOnce(wf(c.responseDraftId)))).toMatchObject({
      outcome: 'rejected',
      code: 'rate_limited',
    });

    const view = await inTenant(tenantA, () =>
      communityService.messages.list(member(tenantA, 'community'), { conversationId: convA }),
    );
    expect(view.items.filter((i) => i.kind === 'reply').map((i) => i.replyState)).toEqual([
      'failed',
      'outcome_unknown',
      'sending',
    ]);
  });

  it("ingestion finding the brand's own reply confirms an unknown outcome; a reply stored inbound is corrected", async () => {
    fixture.replyBehaviour = 'after_send_failure';
    const d = await reply(ids['c1']!, 'We ship everywhere');
    const r = await inTenant(tenantA, () => runtime.sendReplyOnce(wf(d.responseDraftId)));
    await inTenant(tenantA, () => runtime.recordReplyOutcome({ ...wf(d.responseDraftId), result: r }));
    expect((await draft(d.responseDraftId)).state).toBe('outcome_unknown');
    // The pull stores the brand's reply outbound (as measurement's ingestion does) and confirms the draft.
    const own = newId('message');
    await tdb.db.insert(messages).values({
      id: own,
      tenantId: tenantA,
      brandId: brandA,
      conversationId: convA,
      remoteMessageId: 'reply_seen',
      parentRemoteMessageId: 'c1',
      direction: 'outbound',
      authorHash: 'b'.repeat(64),
      authorHandle: 'Fixture account',
      text: 'We ship everywhere',
      remoteCreatedAt: new Date(),
    });
    const confirmed = await run(tenantA, (tx) =>
      confirmIngestedOwnReply(
        { conversationId: convA, messageId: own, parentRemoteMessageId: 'c1', text: 'We ship everywhere ' },
        tx,
      ),
    );
    expect(confirmed).toBe(d.responseDraftId);
    expect(await draft(d.responseDraftId)).toMatchObject({
      state: 'sent',
      outboundMessageId: own,
      failureCode: null,
    });
    // Nothing else matches a second time.
    expect(
      await run(tenantA, (tx) =>
        confirmIngestedOwnReply(
          { conversationId: convA, messageId: own, parentRemoteMessageId: 'c1', text: 'We ship everywhere' },
          tx,
        ),
      ),
    ).toBeNull();

    // A platform that did not name the author: ingestion stored the reply as a comment before it was recorded.
    fixture.replyBehaviour = 'accept';
    const e = await reply(ids['c3']!, 'Glad you like it');
    const sent = await inTenant(tenantA, () => runtime.sendReplyOnce(wf(e.responseDraftId)));
    expect(sent.outcome).toBe('accepted');
    const remote = (sent as { remoteMessageId: string }).remoteMessageId;
    const copy = await comment(tenantA, brandA, convA, remote, new Date());
    const recorded = await inTenant(tenantA, () =>
      runtime.recordReplyOutcome({ ...wf(e.responseDraftId), result: sent }),
    );
    expect(recorded.messageId).toBe(copy);
    const rows = await tdb.db.select().from(messages).where(eq(messages.remoteMessageId, remote));
    expect(rows.map((m) => m.direction)).toEqual(['outbound']); // one row, never an inbound copy
  });

  it('a sender who lost inbox.respond before the send: the reply is failed at the boundary, nothing is posted', async () => {
    const d = await reply(ids['c1']!, 'Queued then revoked');
    await tdb.db.update(memberships).set({ role: 'analyst' }).where(eq(memberships.id, 'mem_community_test'));
    try {
      const before = fixture.replies.length;
      expect(await inTenant(tenantA, () => runtime.sendReplyOnce(wf(d.responseDraftId)))).toMatchObject({
        outcome: 'rejected',
        code: 'sender_not_authorised',
      });
      expect(fixture.replies).toHaveLength(before);
      expect(await draft(d.responseDraftId)).toMatchObject({
        state: 'failed',
        failureCode: 'sender_not_authorised',
        sentAt: null,
      });
    } finally {
      await tdb.db
        .update(memberships)
        .set({ role: 'community' })
        .where(eq(memberships.id, 'mem_community_test'));
    }
  });

  it('an outcome recorded before the send (a timed-out attempt) stops the send at the boundary', async () => {
    const d = await reply(ids['c1']!, 'Late');
    await inTenant(tenantA, () =>
      runtime.recordReplyOutcome({
        ...wf(d.responseDraftId),
        result: { outcome: 'unknown', code: 'activity_failed', message: 'timeout' },
      }),
    );
    expect(await draft(d.responseDraftId)).toMatchObject({ state: 'failed', failureCode: 'activity_failed' });
    const before = fixture.replies.length;
    expect(await inTenant(tenantA, () => runtime.sendReplyOnce(wf(d.responseDraftId)))).toMatchObject({
      outcome: 'rejected',
    });
    expect(fixture.replies).toHaveLength(before);
  });

  it('a channel that cannot reply refuses the command', async () => {
    const noReply = new ProviderRegistry();
    const readOnly = new ReplyingFixture(fixtureCapability({ comments: { read: true, reply: false } }));
    noReply.register(readOnly);
    configurePublishingProviders({ registry: noReply, insecureAllowLoopback: true });
    try {
      await expect(reply(ids['c1']!, 'Hi')).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    } finally {
      configurePublishingProviders({ registry, insecureAllowLoopback: true });
    }
  });
});
