import { and, asc, desc, eq, inArray, isNotNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import type { ResponseDraftState } from '@oremedia/contracts/community';
import { BrandScopedRepository, type Tx } from '@oremedia/db';
import { conversations, messages, responseDrafts } from '@oremedia/db/schema/community';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/**
 * The comment inbox's view of the community tables (spec 4.2: this module owns community.ts; comment ingestion in
 * the measurement module still writes conversations and inbound messages until it calls this module instead).
 */
export class InboxConversationRepository extends BrandScopedRepository<typeof conversations> {
  constructor() {
    super(conversations);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof conversations.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /**
   * Conversations with at least one message, newest activity first. Cursor = base64 of (lastMessageAt, id), the
   * sort key and the tie-breaker (spec 7.4).
   */
  async listForBrand(
    brandId: string,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof conversations.$inferSelect>> {
    const clauses: SQL[] = [isNotNull(conversations.lastMessageAt) as SQL];
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor && typeof cursor.sort === 'string') {
      const at = new Date(cursor.sort);
      clauses.push(
        or(
          lt(conversations.lastMessageAt, at),
          and(eq(conversations.lastMessageAt, at), lte(conversations.id, cursor.id)),
        ) as SQL,
      );
    }
    const rows = await this.conn(tx)
      .select()
      .from(conversations)
      .where(this.brandScope(brandId, and(...clauses) as SQL))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const next = rows.length > page.limit ? rows[page.limit] : undefined;
    return {
      items,
      nextCursor: next?.lastMessageAt
        ? encodeCursor({ id: next.id, sort: next.lastMessageAt.toISOString() })
        : null,
    };
  }
}

/** Customer voice messages: insert-only (no update method); outbound rows are the brand's own replies. */
export class InboxMessageRepository extends BrandScopedRepository<typeof messages> {
  constructor() {
    super(messages);
  }
  async create(values: Omit<typeof messages.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async findRemote(conversationId: string, remoteMessageId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(messages)
      .where(
        this.scope(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.remoteMessageId, remoteMessageId),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  /**
   * The one correction a message row takes: a reply the brand posted that was stored as a customer comment (a
   * platform that does not name the author) becomes outbound. No other column ever changes.
   */
  async markOutbound(id: string, tx: Tx) {
    await this.conn(tx)
      .update(messages)
      .set({ direction: 'outbound' })
      .where(this.scope(and(eq(messages.id, id), eq(messages.direction, 'inbound')) as SQL));
  }
  /** One conversation's messages, oldest first (a thread is read top-down); bounded. */
  async listForConversation(brandId: string, conversationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(messages)
      .where(this.brandScope(brandId, eq(messages.conversationId, conversationId)))
      .orderBy(asc(messages.remoteCreatedAt), asc(messages.id))
      .limit(2000);
  }
  /** Inbound (customer) comment count per conversation. */
  async countInbound(brandId: string, conversationIds: string[], tx?: Tx): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (conversationIds.length === 0) return counts;
    const rows = await this.conn(tx)
      .select({ conversationId: messages.conversationId, c: sql<number>`count(*)` })
      .from(messages)
      .where(
        this.brandScope(
          brandId,
          and(inArray(messages.conversationId, conversationIds), eq(messages.direction, 'inbound')) as SQL,
        ),
      )
      .groupBy(messages.conversationId);
    for (const r of rows) counts.set(r.conversationId, Number(r.c));
    return counts;
  }
  /** The newest inbound comment of a conversation (the inbox list shows it). */
  async latestInbound(brandId: string, conversationId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(messages)
      .where(
        this.brandScope(
          brandId,
          and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound')) as SQL,
        ),
      )
      .orderBy(desc(messages.remoteCreatedAt), desc(messages.id))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** The replies still on their way or that did not make it; a sent reply is shown as its outbound message. */
const OPEN_REPLY_STATES: readonly ResponseDraftState[] = ['queued', 'sending', 'failed', 'outcome_unknown'];

export class ResponseDraftRepository extends BrandScopedRepository<typeof responseDrafts> {
  constructor() {
    super(responseDrafts);
  }
  async create(values: Omit<typeof responseDrafts.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof responseDrafts.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** SELECT ... FOR UPDATE: the send boundary and the outcome move the state under the row lock. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(responseDrafts)
      .where(this.scope(eq(responseDrafts.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('ResponseDraft', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  /** Replies to one comment that may have been posted but are not confirmed (sending, outcome_unknown). */
  async listUnconfirmedReplies(brandId: string, conversationId: string, replyToMessageId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(responseDrafts)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(responseDrafts.conversationId, conversationId),
            eq(responseDrafts.replyToMessageId, replyToMessageId),
            inArray(responseDrafts.state, ['sending', 'outcome_unknown']),
          ) as SQL,
        ),
      )
      .orderBy(asc(responseDrafts.id))
      .limit(50);
  }
  async listOpenReplies(brandId: string, conversationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(responseDrafts)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(responseDrafts.conversationId, conversationId),
            inArray(responseDrafts.state, [...OPEN_REPLY_STATES]),
            isNotNull(responseDrafts.replyToMessageId),
          ) as SQL,
        ),
      )
      .orderBy(asc(responseDrafts.id))
      .limit(500);
  }
}
