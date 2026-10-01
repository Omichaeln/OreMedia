import { and, asc, desc, eq, gte, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import type { PublicationState } from '@oremedia/contracts/publishing';
import {
  BrandScopedRepository,
  PlatformRepository,
  TenantScopedRepository,
  affectedRows,
  requireTenant,
  type Tx,
} from '@oremedia/db';
import {
  channelConnections,
  credentialRefs,
  pendingChannelGrants,
  publicationAttempts,
  publicationRemoteChanges,
  publications,
  remoteEvidence,
} from '@oremedia/db/schema/publishing';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

/**
 * Credential envelopes (spec 14.7). Rows are never updated in place except to retire them: rotation writes a new
 * row and destroys the old one (destroyedAt + ciphertext and wrapped key overwritten, so the data key is gone).
 */
export class CredentialRefRepository extends TenantScopedRepository<typeof credentialRefs> {
  constructor() {
    super(credentialRefs);
  }
  async create(values: Omit<typeof credentialRefs.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  /** Crypto-shred: the wrapped data key and ciphertext are overwritten, the row stays as evidence of the rotation. */
  async destroy(id: string, expectedVersion: number, reason: 'rotated' | 'disconnected', tx: Tx) {
    const now = new Date();
    await this.updateScoped(
      id,
      expectedVersion,
      {
        destroyedAt: now,
        ...(reason === 'rotated' ? { rotatedAt: now } : {}),
        wrappedDataKey: '',
        ciphertext: '',
      },
      tx,
    );
  }
}

/**
 * Spec 14.7 account choice: the sealed grants offered to the person who completed a connect flow, one row per
 * account. Nothing updates a row: choosing or cancelling deletes the pending id's rows (one-shot), and expired rows
 * are deleted with them (the data key goes with the row).
 */
export class PendingChannelGrantRepository extends BrandScopedRepository<typeof pendingChannelGrants> {
  constructor() {
    super(pendingChannelGrants);
  }
  async createMany(rows: Array<Omit<typeof pendingChannelGrants.$inferInsert, 'tenantId'>>, tx: Tx) {
    for (const row of rows) await this.insertBrandScoped(row, tx);
  }
  /** The options of one pending id, in the order offered, locked until the transaction ends (one chooser wins). */
  async lockPending(pendingId: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(pendingChannelGrants)
      .where(this.scope(eq(pendingChannelGrants.pendingId, pendingId)))
      .orderBy(asc(pendingChannelGrants.position))
      .for('update');
    const ctx = requireTenant();
    // A brand the actor cannot see behaves like a choice that does not exist.
    return rows.filter((r) => ctx.brandIds === 'all' || ctx.brandIds.has(r.brandId));
  }
  /** Crypto-shred then delete (as CredentialRefRepository.destroy): the wrapped key and ciphertext go first. */
  async deletePending(pendingId: string, tx: Tx): Promise<number> {
    const where = this.scope(eq(pendingChannelGrants.pendingId, pendingId));
    await tx.update(pendingChannelGrants).set(SHREDDED).where(where);
    return affectedRows(await tx.delete(pendingChannelGrants).where(where));
  }
  /** Shreds and deletes the tenant's expired choices; returns how many rows went. */
  async deleteExpired(now: Date, tx: Tx): Promise<number> {
    const where = this.scope(lt(pendingChannelGrants.expiresAt, now));
    await tx.update(pendingChannelGrants).set(SHREDDED).where(where);
    return affectedRows(await tx.delete(pendingChannelGrants).where(where));
  }
}

/** Rows per purge transaction. */
export const PURGE_BATCH = 1000;

/** What a pending grant row holds once shredded: no wrapped data key, no ciphertext. */
const SHREDDED = { wrappedDataKey: '', ciphertext: '' };

/**
 * The periodic purge of expired choices (connectChoicePurgeWorkflowV1) spans tenants like the publication sweeper
 * and runs as a declared platform job (spec 5.3); it reads and returns no tenant content, only a row count.
 */
export class PendingChannelGrantPurgeRepository extends PlatformRepository {
  /** Shreds and deletes up to `limit` expired rows, oldest expiry first, in the caller's transaction. */
  async purgeExpired(now: Date, tx: Tx, limit = PURGE_BATCH): Promise<number> {
    const ids = (
      await this.conn(tx)
        .select({ id: pendingChannelGrants.id })
        .from(pendingChannelGrants)
        .where(lt(pendingChannelGrants.expiresAt, now))
        .orderBy(asc(pendingChannelGrants.expiresAt))
        .limit(limit)
        .for('update')
    ).map((r) => r.id);
    if (ids.length === 0) return 0;
    const where = inArray(pendingChannelGrants.id, ids);
    await this.conn(tx).update(pendingChannelGrants).set(SHREDDED).where(where);
    return affectedRows(await this.conn(tx).delete(pendingChannelGrants).where(where));
  }
}

export class ChannelConnectionRepository extends BrandScopedRepository<typeof channelConnections> {
  constructor() {
    super(channelConnections);
  }
  /** SELECT ... FOR UPDATE: credential rotation and disconnect serialise on the connection row. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(channelConnections)
      .where(this.scope(eq(channelConnections.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('ChannelConnection', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  async findByRemoteAccount(providerKey: string, remoteAccountId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(channelConnections)
      .where(
        this.scope(
          and(
            eq(channelConnections.providerKey, providerKey),
            eq(channelConnections.remoteAccountId, remoteAccountId),
          ) as SQL,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)) return null;
    return row;
  }
  async create(values: Omit<typeof channelConnections.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof channelConnections.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForBrand(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(channelConnections)
      .where(this.brandScope(brandId))
      .orderBy(asc(channelConnections.id));
  }
  /** Usage counter for the `channels` entitlement (spec 5.5 step 6). */
  async countActive(tx?: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ c: sql<number>`count(*)` })
      .from(channelConnections)
      .where(this.scope(eq(channelConnections.status, 'active')));
    return Number(rows[0]?.c ?? 0);
  }
}

const NEEDS_PERSON: readonly PublicationState[] = ['failed', 'outcome_unknown', 'held'];
/** Went out under its approval: a post deleted afterwards through the product still spent it (spec 13.1). */
const RELEASED: readonly PublicationState[] = ['published', 'removed'];

export class PublicationRepository extends BrandScopedRepository<typeof publications> {
  constructor() {
    super(publications);
  }
  /** SELECT ... FOR UPDATE: state moves under the row lock so a command and an activity cannot interleave. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(publications)
      .where(this.scope(eq(publications.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('Publication', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  async findByOccurrenceKey(occurrenceKey: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(publications)
      .where(this.scope(eq(publications.occurrenceKey, occurrenceKey)))
      .limit(1);
    return rows[0] ?? null;
  }
  async create(values: Omit<typeof publications.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof publications.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForBrand(
    brandId: string,
    state: PublicationState | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof publications.$inferSelect>> {
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(publications.state, state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(publications.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(publications)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(publications.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /**
   * Portfolio summary, per brand of `brandIds`: publications that need a person (failed, outcome unknown or held)
   * and publications scheduled in [now, until). The tenant scope still applies.
   */
  async countAttentionByBrand(brandIds: 'all' | readonly string[], now: Date, until: Date, tx?: Tx) {
    if (brandIds !== 'all' && brandIds.length === 0) return [];
    const needsPerson = inArray(publications.state, [...NEEDS_PERSON]);
    const upcoming = and(
      eq(publications.state, 'scheduled'),
      gte(publications.scheduledFor, now),
      lt(publications.scheduledFor, until),
    ) as SQL;
    const either = or(needsPerson, upcoming) as SQL;
    const rows = await this.conn(tx)
      .select({
        brandId: publications.brandId,
        needsPerson: sql`sum(case when ${needsPerson} then 1 else 0 end)`,
        upcoming: sql`sum(case when ${upcoming} then 1 else 0 end)`,
      })
      .from(publications)
      .where(
        this.scope(
          brandIds === 'all' ? either : (and(inArray(publications.brandId, [...brandIds]), either) as SQL),
        ),
      )
      .groupBy(publications.brandId);
    return rows.map((r) => ({
      brandId: r.brandId,
      needsPerson: Number(r.needsPerson ?? 0),
      upcoming: Number(r.upcoming ?? 0),
    }));
  }
  /** Spec 13.4 mandate_daily_quota: publications a mandate scheduled on the UTC day of `at` (all states but cancelled). */
  async countForMandateOnDay(mandateId: string, at: Date, tx?: Tx): Promise<number> {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const rows = await this.conn(tx)
      .select({ c: sql`count(*)` })
      .from(publications)
      .where(
        this.scope(
          and(
            eq(publications.mandateId, mandateId),
            gte(publications.scheduledFor, start),
            lt(publications.scheduledFor, end),
            ne(publications.state, 'cancelled'),
          ) as SQL,
        ),
      );
    return Number(rows[0]?.c ?? 0);
  }
  /** The brand's publications scheduled inside [from, to], newest first, bounded (the calendar and the rollups). */
  async listScheduledBetween(brandId: string, from: Date, to: Date, limit: number, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(publications)
      .where(
        this.brandScope(
          brandId,
          and(gte(publications.scheduledFor, from), lte(publications.scheduledFor, to)) as SQL,
        ),
      )
      .orderBy(desc(publications.scheduledFor), desc(publications.id))
      .limit(limit);
  }
  /** The scheduled publications of one brand, read only (UX-20: the preview of a brand change). */
  async listScheduledForBrandRead(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(publications)
      .where(this.brandScope(brandId, eq(publications.state, 'scheduled')))
      .orderBy(asc(publications.id))
      .limit(200);
  }
  /** The scheduled publications of one brand, locked (a brand change re-evaluates them, spec 8.2). */
  async listScheduledForBrand(brandId: string, tx: Tx) {
    return tx
      .select()
      .from(publications)
      .where(this.brandScope(brandId, eq(publications.state, 'scheduled')))
      .orderBy(asc(publications.id))
      .limit(200)
      .for('update');
  }
  /** Channels already published under one approval (spec 13.1: the approval is spent once every target is out). */
  /** The targets (channel connection ids, destination ids) published under the approval so far. */
  async listPublishedChannelsForApproval(approvalId: string, tx?: Tx): Promise<string[]> {
    const rows = await this.conn(tx)
      .selectDistinct({
        channelConnectionId: publications.channelConnectionId,
        destinationId: publications.destinationId,
      })
      .from(publications)
      .where(
        this.scope(
          and(eq(publications.approvalId, approvalId), inArray(publications.state, [...RELEASED])) as SQL,
        ),
      );
    return rows.map((r) => r.destinationId ?? r.channelConnectionId ?? '').filter(Boolean);
  }
  /** Whether another publication already published on this target under this approval (single use per target). */
  async publishedElsewhereForApprovalChannel(
    approvalId: string,
    targetId: string,
    exceptPublicationId: string,
    tx?: Tx,
  ): Promise<boolean> {
    const rows = await this.conn(tx)
      .select({ id: publications.id })
      .from(publications)
      .where(
        this.scope(
          and(
            eq(publications.approvalId, approvalId),
            or(
              eq(publications.channelConnectionId, targetId),
              eq(publications.destinationId, targetId),
            ) as SQL,
            inArray(publications.state, [...RELEASED]),
            ne(publications.id, exceptPublicationId),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  /**
   * Spec 17.6 restore rule: the in-flight rows (scheduled, dispatching, processing) of the tenant, or of one brand,
   * locked, oldest first, at most `limit` (bounded like listScheduledForBrand; the command asks for one more to know
   * whether another batch is needed). A brand-restricted context sees only its brands.
   */
  async lockInFlightForRestore(brandId: string | null, limit: number, tx: Tx) {
    const inFlight = inArray(publications.state, ['scheduled', 'dispatching', 'processing']);
    const { brandIds } = requireTenant();
    const where = brandId
      ? this.brandScope(brandId, inFlight)
      : this.scope(
          brandIds === 'all'
            ? inFlight
            : (and(inFlight, inArray(publications.brandId, [...brandIds])) as SQL),
        );
    return tx
      .select()
      .from(publications)
      .where(where)
      .orderBy(asc(publications.id))
      .limit(limit)
      .for('update');
  }
  /** The scheduled publications of one channel (disconnect holds them, spec 14.7). */
  async listScheduledForChannel(channelConnectionId: string, tx: Tx) {
    return tx
      .select()
      .from(publications)
      .where(
        this.scope(
          and(
            eq(publications.channelConnectionId, channelConnectionId),
            eq(publications.state, 'scheduled'),
          ) as SQL,
        ),
      )
      .for('update');
  }
}

/**
 * Append-plus-outcome (spec 6.1): a row is inserted by openAttempt and its outcome columns are written once by the
 * attempt owner (fencing token checked). Nothing is ever deleted.
 */
export class PublicationAttemptRepository extends TenantScopedRepository<typeof publicationAttempts> {
  constructor() {
    super(publicationAttempts);
  }
  async create(values: Omit<typeof publicationAttempts.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  async findByFence(publicationId: string, fencingToken: number, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(publicationAttempts)
      .where(
        this.scope(
          and(
            eq(publicationAttempts.publicationId, publicationId),
            eq(publicationAttempts.fencingToken, fencingToken),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  /**
   * The attempt of one claim, locked: a locking read sees the latest committed row, not the transaction's snapshot,
   * so a caller that waited on the publication row lock (taken first, the pre-send fence's order) sees a sentAt the
   * fence committed meanwhile.
   */
  async lockByFence(publicationId: string, fencingToken: number, tx: Tx) {
    const rows = await tx
      .select()
      .from(publicationAttempts)
      .where(
        this.scope(
          and(
            eq(publicationAttempts.publicationId, publicationId),
            eq(publicationAttempts.fencingToken, fencingToken),
          ) as SQL,
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }
  async listForPublication(publicationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(publicationAttempts)
      .where(this.scope(eq(publicationAttempts.publicationId, publicationId)))
      .orderBy(asc(publicationAttempts.attemptNumber));
  }
  async countForPublication(publicationId: string, tx: Tx): Promise<number> {
    const rows = await tx
      .select({ c: sql<number>`count(*)` })
      .from(publicationAttempts)
      .where(this.scope(eq(publicationAttempts.publicationId, publicationId)));
    return Number(rows[0]?.c ?? 0);
  }
  /** sentAt is written once, immediately before the outbound mutation; a repeat is a no-op (idempotent). */
  async markSent(id: string, at: Date, tx: Tx): Promise<boolean> {
    const res = await tx
      .update(publicationAttempts)
      .set({ sentAt: at })
      .where(
        this.scope(and(eq(publicationAttempts.id, id), sql`${publicationAttempts.sentAt} is null`) as SQL),
      );
    return affectedRows(res) === 1;
  }
  /** The outcome is written once (finishedAt null → set); a repeat never overwrites the recorded outcome. */
  async recordOutcome(
    id: string,
    values: Pick<
      typeof publicationAttempts.$inferInsert,
      'outcome' | 'errorCode' | 'errorDetail' | 'remoteJobId' | 'remotePostId' | 'pendingState'
    >,
    at: Date,
    tx: Tx,
  ): Promise<boolean> {
    const res = await tx
      .update(publicationAttempts)
      .set({ ...values, finishedAt: at })
      .where(
        this.scope(
          and(eq(publicationAttempts.id, id), sql`${publicationAttempts.finishedAt} is null`) as SQL,
        ),
      );
    return affectedRows(res) === 1;
  }
  /** Reconciliation attaches the remote id it found to the attempt it reconciled (finishedAt already set). */
  async attachRemotePost(id: string, remotePostId: string, tx: Tx): Promise<void> {
    await tx
      .update(publicationAttempts)
      .set({ remotePostId })
      .where(
        this.scope(
          and(eq(publicationAttempts.id, id), sql`${publicationAttempts.remotePostId} is null`) as SQL,
        ),
      );
  }
}

/**
 * Append-plus-outcome, like the attempt ledger: a change is inserted `requested` and its outcome is written once
 * (requested → succeeded | failed); the request columns (kind, text, reason, requester) never change.
 */
export class PublicationRemoteChangeRepository extends BrandScopedRepository<
  typeof publicationRemoteChanges
> {
  constructor() {
    super(publicationRemoteChanges);
  }
  async create(values: Omit<typeof publicationRemoteChanges.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /** Newest first (ids are time-ordered); bounded, a publication collects few changes. */
  async listForPublication(publicationId: string, tx?: Tx, limit = 20) {
    return this.conn(tx)
      .select()
      .from(publicationRemoteChanges)
      .where(this.scope(eq(publicationRemoteChanges.publicationId, publicationId)))
      .orderBy(desc(publicationRemoteChanges.id))
      .limit(limit);
  }
  /**
   * The live text: the edit the platform confirmed last (by when it was confirmed, so a late confirmation of an
   * older request that landed after a newer one is what the post shows).
   */
  async latestSucceededEdit(publicationId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(publicationRemoteChanges)
      .where(
        this.scope(
          and(
            eq(publicationRemoteChanges.publicationId, publicationId),
            eq(publicationRemoteChanges.kind, 'edit'),
            eq(publicationRemoteChanges.state, 'succeeded'),
          ) as SQL,
        ),
      )
      .orderBy(desc(publicationRemoteChanges.finishedAt), desc(publicationRemoteChanges.id))
      .limit(1);
    return rows[0] ?? null;
  }
  /** The change still waiting on the platform, if any (at most one per publication, checked under the row lock). */
  async findOpenForPublication(publicationId: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(publicationRemoteChanges)
      .where(
        this.scope(
          and(
            eq(publicationRemoteChanges.publicationId, publicationId),
            eq(publicationRemoteChanges.state, 'requested'),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  /**
   * The one correction of a written outcome: a change closed as stale (no outcome in time) whose workflow later
   * got the platform's confirmation. The post did change, so the record follows the platform; the stale closure
   * stays in the audit log.
   */
  async recordLateSuccess(id: string, staleCodes: readonly string[], at: Date, tx: Tx): Promise<boolean> {
    const res = await tx
      .update(publicationRemoteChanges)
      .set({
        state: 'succeeded',
        errorCode: 'confirmed_after_stale',
        errorDetail: null,
        finishedAt: at,
        version: sql`${publicationRemoteChanges.version} + 1`,
      })
      .where(
        this.scope(
          and(
            eq(publicationRemoteChanges.id, id),
            eq(publicationRemoteChanges.state, 'failed'),
            inArray(publicationRemoteChanges.errorCode, [...staleCodes]),
          ) as SQL,
        ),
      );
    return affectedRows(res) === 1;
  }
  /** The outcome is written once; a repeat (activity retry) changes nothing and reports false. */
  async recordOutcome(
    id: string,
    values: Pick<typeof publicationRemoteChanges.$inferInsert, 'state' | 'errorCode' | 'errorDetail'>,
    at: Date,
    tx: Tx,
  ): Promise<boolean> {
    const res = await tx
      .update(publicationRemoteChanges)
      .set({ ...values, finishedAt: at, version: sql`${publicationRemoteChanges.version} + 1` })
      .where(
        this.scope(
          and(eq(publicationRemoteChanges.id, id), eq(publicationRemoteChanges.state, 'requested')) as SQL,
        ),
      );
    return affectedRows(res) === 1;
  }
}

/** Insert-only (spec 6.1). */
export class RemoteEvidenceRepository extends TenantScopedRepository<typeof remoteEvidence> {
  constructor() {
    super(remoteEvidence);
  }
  async create(values: Omit<typeof remoteEvidence.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  /** The latest evidence row of one kind (R2-3: the last read-back, validation or revert of an article). */
  async latestOfKind(publicationId: string, kind: (typeof remoteEvidence.$inferSelect)['kind'], tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(remoteEvidence)
      .where(
        this.scope(
          and(eq(remoteEvidence.publicationId, publicationId), eq(remoteEvidence.kind, kind)) as SQL,
        ),
      )
      .orderBy(desc(remoteEvidence.capturedAt), desc(remoteEvidence.id))
      .limit(1);
    return rows[0] ?? null;
  }
  async listForPublication(publicationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(remoteEvidence)
      .where(this.scope(eq(remoteEvidence.publicationId, publicationId)))
      .orderBy(asc(remoteEvidence.capturedAt), asc(remoteEvidence.id));
  }
  /** Idempotency of markPublished: one evidence row per (publication, attempt, kind). */
  async exists(
    publicationId: string,
    attemptId: string | null,
    kind: (typeof remoteEvidence.$inferSelect)['kind'],
    tx: Tx,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: remoteEvidence.id })
      .from(remoteEvidence)
      .where(
        this.scope(
          and(
            eq(remoteEvidence.publicationId, publicationId),
            attemptId === null
              ? sql`${remoteEvidence.attemptId} is null`
              : eq(remoteEvidence.attemptId, attemptId),
            eq(remoteEvidence.kind, kind),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows.length === 1;
  }
}

/** A remote change with no outcome past the stale threshold, as the remote change sweeper sees it: references only. */
export interface StaleRemoteChangeRef {
  tenantId: string;
  brandId: string;
  publicationId: string;
  changeId: string;
}

/** Platform-level like PublicationSweepRepository: finds references across tenants, writes nothing. */
export class RemoteChangeSweepRepository extends PlatformRepository {
  async findStale(requestedBefore: Date, limit = 200): Promise<StaleRemoteChangeRef[]> {
    return this.conn()
      .select({
        tenantId: publicationRemoteChanges.tenantId,
        brandId: publicationRemoteChanges.brandId,
        publicationId: publicationRemoteChanges.publicationId,
        changeId: publicationRemoteChanges.id,
      })
      .from(publicationRemoteChanges)
      .where(
        and(
          eq(publicationRemoteChanges.state, 'requested'),
          lt(publicationRemoteChanges.requestedAt, requestedBefore),
        ),
      )
      .orderBy(asc(publicationRemoteChanges.requestedAt))
      .limit(limit);
  }
}

/** A stuck publication as the sweeper sees it: references only, never tenant content. */
export interface StuckPublicationRef {
  tenantId: string;
  publicationId: string;
  state: 'scheduled' | 'dispatching';
  claimant: string | null;
  version: number;
}

/**
 * The sweeper legitimately spans tenants (like the outbox dispatcher, spec 14.2) and runs as a declared platform
 * job. It reads references only; every write happens afterwards inside the row's own tenant context.
 */
export class PublicationSweepRepository extends PlatformRepository {
  async findStuck(
    now: Date,
    graceSeconds: number,
    claimLeaseSeconds: number,
    limit = 200,
  ): Promise<StuckPublicationRef[]> {
    const dueBefore = new Date(now.getTime() - graceSeconds * 1000);
    const claimedBefore = new Date(now.getTime() - claimLeaseSeconds * 1000);
    const rows = await this.conn()
      .select({
        tenantId: publications.tenantId,
        publicationId: publications.id,
        state: publications.state,
        claimant: publications.claimant,
        version: publications.version,
      })
      .from(publications)
      .where(
        and(
          inArray(publications.state, ['scheduled', 'dispatching']),
          sql`case when ${publications.state} = 'scheduled' then ${publications.scheduledFor} < ${dueBefore} else coalesce(${publications.claimedAt}, ${publications.updatedAt}) < ${claimedBefore} end`,
        ),
      )
      .orderBy(asc(publications.scheduledFor))
      .limit(limit);
    return rows.map((r) => ({
      tenantId: r.tenantId,
      publicationId: r.publicationId,
      state: r.state as 'scheduled' | 'dispatching',
      claimant: r.claimant,
      version: r.version,
    }));
  }
}
