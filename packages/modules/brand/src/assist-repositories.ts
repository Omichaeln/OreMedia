import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AssistSection, SuggestionStatus } from '@oremedia/contracts/brand-assist';
import { ASSIST_TERMINAL_STATES } from '@oremedia/contracts/brand-assist';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, type Tx } from '@oremedia/db';
import { brandAssistJobs, brandSources, brandSuggestions, brandVersions } from '@oremedia/db/schema/brand';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

const { text: _text, ...sourceColumns } = getTableColumns(brandSources);
/** A source row without its text: what lists and labels read. */
const WITHOUT_TEXT = sourceColumns;

/** BSC-4 sources of a brand. A removed source keeps its row (suggestions still name it); lists leave it out. */
export class BrandSourceRepository extends BrandScopedRepository<typeof brandSources> {
  constructor() {
    super(brandSources);
  }
  async create(values: Omit<typeof brandSources.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof brandSources.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Live sources newest first, without their text (lists never carry it). */
  async list(brandId: string, page: PageRequest, tx?: Tx) {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select(WITHOUT_TEXT)
      .from(brandSources)
      .where(
        this.brandScope(
          brandId,
          and(isNull(brandSources.removedAt), cursor ? lte(brandSources.id, cursor.id) : undefined) as SQL,
        ),
      )
      .orderBy(desc(brandSources.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  async countLive(brandId: string, tx?: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ n: sql<number>`count(*)` })
      .from(brandSources)
      .where(this.brandScope(brandId, isNull(brandSources.removedAt)));
    return Number(rows[0]?.n ?? 0);
  }
  /** These sources of the brand (with their text), removed ones included; foreign ids are absent. */
  async listByIds(brandId: string, ids: readonly string[], tx?: Tx) {
    if (ids.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(brandSources)
      .where(this.brandScope(brandId, inArray(brandSources.id, [...ids])));
  }
  /** Titles and addresses of these sources (no text), for evidence labels. */
  async labelsOf(brandId: string, ids: readonly string[], tx?: Tx) {
    if (ids.length === 0) return [];
    return this.conn(tx)
      .select({
        id: brandSources.id,
        title: brandSources.title,
        url: brandSources.url,
        kind: brandSources.kind,
      })
      .from(brandSources)
      .where(this.brandScope(brandId, inArray(brandSources.id, [...ids])));
  }
  /** A live source of the brand with this URL, or (captured) with this content hash. */
  async findLiveByUrl(brandId: string, url: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ id: brandSources.id, version: brandSources.version })
      .from(brandSources)
      .where(this.brandScope(brandId, and(isNull(brandSources.removedAt), eq(brandSources.url, url)) as SQL))
      .orderBy(asc(brandSources.id))
      .limit(1);
    return rows[0] ?? null;
  }
  async findLiveByHash(brandId: string, contentHash: string, exceptId: string | null, tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ id: brandSources.id, version: brandSources.version })
      .from(brandSources)
      .where(
        this.brandScope(
          brandId,
          and(
            isNull(brandSources.removedAt),
            eq(brandSources.contentHash, contentHash),
            isNull(brandSources.duplicateOfSourceId),
            exceptId ? ne(brandSources.id, exceptId) : undefined,
          ) as SQL,
        ),
      )
      .orderBy(asc(brandSources.id))
      .limit(1);
    return rows[0] ?? null;
  }
  async findLiveByAssetVersion(brandId: string, assetVersionId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ id: brandSources.id, version: brandSources.version })
      .from(brandSources)
      .where(
        this.brandScope(
          brandId,
          and(isNull(brandSources.removedAt), eq(brandSources.assetVersionId, assetVersionId)) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

const TERMINAL = [...ASSIST_TERMINAL_STATES];

export class BrandAssistJobRepository extends BrandScopedRepository<typeof brandAssistJobs> {
  constructor() {
    super(brandAssistJobs);
  }
  async create(values: Omit<typeof brandAssistJobs.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof brandAssistJobs.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** SELECT ... FOR UPDATE: the workflow's activities and the API serialise their writes on the job row. */
  async lock(brandId: string, id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brandAssistJobs)
      .where(this.brandScope(brandId, eq(brandAssistJobs.id, id)))
      .for('update');
    return rows[0] ?? null;
  }
  /** A job of the brand with this request key that has not finished: an identical request joins it. */
  async findRunningByKey(brandId: string, requestKey: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brandAssistJobs)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(brandAssistJobs.requestKey, requestKey),
            sql`${brandAssistJobs.state} not in (${sql.join(
              TERMINAL.map((s) => sql`${s}`),
              sql`, `,
            )})`,
          ) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async list(brandId: string, page: PageRequest, tx?: Tx) {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(brandAssistJobs)
      .where(this.brandScope(brandId, cursor ? lte(brandAssistJobs.id, cursor.id) : undefined))
      .orderBy(desc(brandAssistJobs.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}

export interface SuggestionFilters {
  jobId?: string;
  section?: AssistSection;
  status?: SuggestionStatus;
}

export class BrandSuggestionRepository extends BrandScopedRepository<typeof brandSuggestions> {
  constructor() {
    super(brandSuggestions);
  }
  async create(values: Omit<typeof brandSuggestions.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof brandSuggestions.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Oldest first within a job and section (the order the model gave), newest jobs first. */
  async list(brandId: string, filters: SuggestionFilters, page: PageRequest, tx?: Tx) {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const clauses: SQL[] = [];
    if (filters.jobId) clauses.push(eq(brandSuggestions.jobId, filters.jobId));
    if (filters.section) clauses.push(eq(brandSuggestions.section, filters.section));
    if (filters.status) clauses.push(eq(brandSuggestions.status, filters.status));
    if (cursor) clauses.push(gt(brandSuggestions.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(brandSuggestions)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(asc(brandSuggestions.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > page.limit && last ? encodeCursor({ id: last.id }) : null };
  }
  async listByIds(brandId: string, ids: readonly string[], tx?: Tx) {
    if (ids.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(brandSuggestions)
      .where(this.brandScope(brandId, inArray(brandSuggestions.id, [...ids])))
      .orderBy(asc(brandSuggestions.id));
  }
  async listForJob(brandId: string, jobId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(brandSuggestions)
      .where(this.brandScope(brandId, eq(brandSuggestions.jobId, jobId)))
      .orderBy(asc(brandSuggestions.id));
  }
  /** The fingerprints of the brand's suggestions in these states (a rejected or applied one is never made again). */
  async fingerprintsIn(brandId: string, statuses: SuggestionStatus[], tx?: Tx): Promise<Set<string>> {
    const rows = await this.conn(tx)
      .select({ fingerprint: brandSuggestions.fingerprint })
      .from(brandSuggestions)
      .where(this.brandScope(brandId, inArray(brandSuggestions.status, statuses)));
    return new Set(rows.map((r) => r.fingerprint));
  }
  /** Pending suggestions of the brand for these paths (an older one is superseded by a newer job's). */
  async pendingForPaths(brandId: string, paths: readonly string[], tx?: Tx) {
    if (paths.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(brandSuggestions)
      .where(
        this.brandScope(
          brandId,
          and(eq(brandSuggestions.status, 'pending'), inArray(brandSuggestions.path, [...paths])) as SQL,
        ),
      );
  }
  async countsForJob(brandId: string, jobId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ status: brandSuggestions.status, n: sql<number>`count(*)` })
      .from(brandSuggestions)
      .where(this.brandScope(brandId, eq(brandSuggestions.jobId, jobId)))
      .groupBy(brandSuggestions.status);
    return new Map(rows.map((r) => [r.status, Number(r.n)]));
  }
  /** The newest decided batch of the brand that is still applied (its suggestions accepted or edited). */
  async latestBatch(brandId: string, tx?: Tx): Promise<string | null> {
    const rows = await this.conn(tx)
      .select({ batchId: brandSuggestions.batchId })
      .from(brandSuggestions)
      .where(
        this.brandScope(
          brandId,
          and(
            isNotNull(brandSuggestions.batchId),
            or(eq(brandSuggestions.status, 'accepted'), eq(brandSuggestions.status, 'edited')),
          ) as SQL,
        ),
      )
      .orderBy(desc(brandSuggestions.batchId))
      .limit(1);
    return rows[0]?.batchId ?? null;
  }
  async listBatch(brandId: string, batchId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(brandSuggestions)
      .where(this.brandScope(brandId, eq(brandSuggestions.batchId, batchId)))
      .orderBy(desc(brandSuggestions.decidedAt), desc(brandSuggestions.id));
  }
}

/** BSC-5 history and the pending proposal: reads over brand_versions that the versions repository does not offer. */
export class BrandHistoryRepository extends BrandScopedRepository<typeof brandVersions> {
  constructor() {
    super(brandVersions);
  }
  /** Versions that were applied (published now or before), newest first; proposals never applied are left out. */
  async listApplied(brandId: string, page: PageRequest, tx?: Tx) {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(brandVersions)
      .where(
        this.brandScope(
          brandId,
          and(
            isNotNull(brandVersions.publishedAt),
            cursor ? lte(brandVersions.id, cursor.id) : undefined,
          ) as SQL,
        ),
      )
      .orderBy(desc(brandVersions.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** The applied version before this one (by number), or null for the first. */
  async appliedBefore(brandId: string, number: number, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brandVersions)
      .where(
        this.brandScope(
          brandId,
          and(isNotNull(brandVersions.publishedAt), sql`${brandVersions.number} < ${number}`) as SQL,
        ),
      )
      .orderBy(desc(brandVersions.number))
      .limit(1);
    return rows[0] ?? null;
  }
  /** D-22: the newest open proposal (draft or in review) newer than the applied version; any open one before that. */
  async pendingProposal(brandId: string, appliedNumber: number | null, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brandVersions)
      .where(
        this.brandScope(
          brandId,
          and(
            inArray(brandVersions.state, ['draft', 'in_review']),
            appliedNumber === null ? undefined : sql`${brandVersions.number} > ${appliedNumber}`,
          ) as SQL,
        ),
      )
      .orderBy(desc(brandVersions.number))
      .limit(1);
    return rows[0] ?? null;
  }
}
