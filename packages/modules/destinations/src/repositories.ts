import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { SourceReportMetricV1, WebMetricSums } from '@oremedia/contracts/destinations';
import {
  BrandScopedRepository,
  PlatformRepository,
  affectedRows,
  requireTenant,
  type Tx,
} from '@oremedia/db';
import {
  brandDestinations,
  destinationReportRows,
  pendingDestinationGrants,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** A brand has a handful of destinations and policy rows; a list is bounded, never paged. */
const LIST_MAX = 200;

export class BrandDestinationRepository extends BrandScopedRepository<typeof brandDestinations> {
  constructor() {
    super(brandDestinations);
  }
  async create(values: Omit<typeof brandDestinations.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof brandDestinations.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** SELECT ... FOR UPDATE: health and status move under the row lock. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(brandDestinations)
      .where(this.scope(eq(brandDestinations.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('Destination', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  /** The tenant's row for a remote identity, whichever brand holds it (uq_destination_remote). */
  async findRemote(kind: string, externalId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brandDestinations)
      .where(
        this.scope(
          and(eq(brandDestinations.kind, kind), eq(brandDestinations.externalId, externalId)) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async listForBrand(brandId: string, kind: string | undefined, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(brandDestinations)
      .where(this.brandScope(brandId, kind ? eq(brandDestinations.kind, kind) : undefined))
      .orderBy(asc(brandDestinations.kind), asc(brandDestinations.displayName), asc(brandDestinations.id))
      .limit(LIST_MAX);
  }
}

/** Rows the daily refresh visits per run (spec 17.4 bounded work); the rest wait for the next day. */
export const REFRESH_BATCH = 1000;

/**
 * The daily token refresh (destinationTokenRefreshWorkflowV1) spans tenants like the retention sweep and runs as a
 * declared platform job (spec 5.3); it returns references only (tenant and destination ids), never a row.
 */
export class DestinationRefreshDueRepository extends PlatformRepository {
  /** Active destinations with a credential whose token expires at or before `before`, soonest first. */
  async listDue(before: Date, tx?: Tx, limit = REFRESH_BATCH) {
    return this.conn(tx)
      .select({ tenantId: brandDestinations.tenantId, destinationId: brandDestinations.id })
      .from(brandDestinations)
      .where(
        and(
          eq(brandDestinations.status, 'active'),
          isNotNull(brandDestinations.credentialRefId),
          lte(brandDestinations.tokenExpiresAt, before),
        ),
      )
      .orderBy(asc(brandDestinations.tokenExpiresAt), asc(brandDestinations.id))
      .limit(limit);
  }
}

/** What a pending grant row holds once shredded: no wrapped data key, no ciphertext (as pending_channel_grants). */
const SHREDDED = { wrappedDataKey: '', ciphertext: '' };

/**
 * R2-1 connect flow: the sealed grant offered to the person who completed it, one row per flow. Nothing updates a
 * row: selecting or cancelling deletes it (one-shot), and expired rows are deleted with the next flow in the tenant.
 */
export class PendingDestinationGrantRepository extends BrandScopedRepository<
  typeof pendingDestinationGrants
> {
  constructor() {
    super(pendingDestinationGrants);
  }
  async create(values: Omit<typeof pendingDestinationGrants.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /** The row of one pending id, locked until the transaction ends (one chooser wins); null when unknown here. */
  async lockPending(pendingId: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(pendingDestinationGrants)
      .where(this.scope(eq(pendingDestinationGrants.id, pendingId)))
      .for('update');
    const row = rows[0];
    if (!row) return null;
    const ctx = requireTenant();
    // A brand the actor cannot see behaves like a choice that does not exist.
    return ctx.brandIds === 'all' || ctx.brandIds.has(row.brandId) ? row : null;
  }
  /** Crypto-shred then delete: the wrapped key and ciphertext go first. */
  async deletePending(pendingId: string, tx: Tx): Promise<number> {
    const where = this.scope(eq(pendingDestinationGrants.id, pendingId));
    await tx.update(pendingDestinationGrants).set(SHREDDED).where(where);
    return affectedRows(await tx.delete(pendingDestinationGrants).where(where));
  }
  /** Shreds and deletes the tenant's expired flows; returns how many rows went. */
  async deleteExpired(now: Date, tx: Tx): Promise<number> {
    const where = this.scope(lt(pendingDestinationGrants.expiresAt, now));
    await tx.update(pendingDestinationGrants).set(SHREDDED).where(where);
    return affectedRows(await tx.delete(pendingDestinationGrants).where(where));
  }
}

export class SourceUsePolicyRepository extends BrandScopedRepository<typeof sourceUsePolicies> {
  constructor() {
    super(sourceUsePolicies);
  }
  async create(values: Omit<typeof sourceUsePolicies.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof sourceUsePolicies.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  private byKey(brandId: string, destinationKind: string, dataType: string): SQL {
    return this.brandScope(
      brandId,
      and(
        eq(sourceUsePolicies.destinationKind, destinationKind),
        eq(sourceUsePolicies.dataType, dataType),
      ) as SQL,
    );
  }
  /** The one row per (brand, kind, data type), or null. */
  async findByKey(brandId: string, destinationKind: string, dataType: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(sourceUsePolicies)
      .where(this.byKey(brandId, destinationKind, dataType))
      .limit(1);
    return rows[0] ?? null;
  }
  /** SELECT ... FOR UPDATE: a policy's version moves under the row lock (null when there is no row yet). */
  async lockByKey(brandId: string, destinationKind: string, dataType: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(sourceUsePolicies)
      .where(this.byKey(brandId, destinationKind, dataType))
      .for('update');
    return rows[0] ?? null;
  }
  async listForBrand(brandId: string, destinationKind: string | undefined, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(sourceUsePolicies)
      .where(
        this.brandScope(
          brandId,
          destinationKind ? eq(sourceUsePolicies.destinationKind, destinationKind) : undefined,
        ),
      )
      .orderBy(asc(sourceUsePolicies.destinationKind), asc(sourceUsePolicies.dataType))
      .limit(LIST_MAX);
  }
}

/** Rows the daily report sweep visits per run (spec 17.4 bounded work); the rest wait for the next day. */
export const REPORT_SWEEP_BATCH = 1000;

/**
 * The daily report sweep (destinationReportSweepWorkflowV1) spans tenants like the token refresh and runs as a
 * declared platform job (spec 5.3); it returns references only (tenant and destination ids), never a row.
 */
export class DestinationReportTargetRepository extends PlatformRepository {
  /** Active destinations of the kinds with reports that hold a credential, oldest first. */
  async listTargets(kinds: readonly string[], tx?: Tx, limit = REPORT_SWEEP_BATCH) {
    if (kinds.length === 0) return [];
    return this.conn(tx)
      .select({ tenantId: brandDestinations.tenantId, destinationId: brandDestinations.id })
      .from(brandDestinations)
      .where(
        and(
          eq(brandDestinations.status, 'active'),
          isNotNull(brandDestinations.credentialRefId),
          inArray(brandDestinations.kind, [...kinds]),
        ),
      )
      .orderBy(asc(brandDestinations.createdAt), asc(brandDestinations.id))
      .limit(limit);
  }
}

/** Rows inserted per statement when a window is replaced. */
const INSERT_CHUNK = 500;
type ReportRowInsert = Omit<typeof destinationReportRows.$inferInsert, 'tenantId'>;

/** A metric's SQL sum over the JSON column: Σ value for a flow or ratio operand, Σ value × weight for a gauge. */
const metricPath = (name: string): string => `$.${name}`;
const metricSum = (name: string): SQL<number | null> =>
  sql<number | null>`sum(json_extract(${destinationReportRows.metrics}, ${metricPath(name)}))`;
const metricWeightedSum = (name: string, weight: string | undefined): SQL<number | null> =>
  weight
    ? sql<
        number | null
      >`sum(json_extract(${destinationReportRows.metrics}, ${metricPath(name)}) * json_extract(${destinationReportRows.metrics}, ${metricPath(weight)}))`
    : metricSum(name);
const weightSum = (name: string, weight: string | undefined): SQL<number | null> =>
  weight
    ? sql<
        number | null
      >`sum(case when json_extract(${destinationReportRows.metrics}, ${metricPath(name)}) is null then null else json_extract(${destinationReportRows.metrics}, ${metricPath(weight)}) end)`
    : sql<number | null>`count(json_extract(${destinationReportRows.metrics}, ${metricPath(name)}))`;

/** The select list of one aggregate: `s_<metric>` sums (a gauge's weight sum) and `w_<metric>` weighted sums. */
function sumColumns(metrics: readonly SourceReportMetricV1[]) {
  const columns: Record<string, SQL<number | null>> = {};
  for (const { name, kind, weight } of metrics) {
    if (kind === 'gauge') {
      columns[`s_${name}`] = weightSum(name, weight);
      columns[`w_${name}`] = metricWeightedSum(name, weight);
    } else columns[`s_${name}`] = metricSum(name);
  }
  return columns;
}
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
function toSums(
  metrics: readonly SourceReportMetricV1[],
  raw: Record<string, unknown>,
  rows: number,
): WebMetricSums {
  const out: WebMetricSums = { rows, sums: {}, weighted: {} };
  for (const { name } of metrics) {
    const s = num(raw[`s_${name}`]);
    if (s !== undefined) out.sums[name] = s;
    const w = num(raw[`w_${name}`]);
    if (w !== undefined) out.weighted[name] = w;
  }
  return out;
}

export interface ReportDimensionAggregate {
  dimensionKey: string;
  dimensions: Record<string, string>;
  days: number;
  sums: WebMetricSums;
}

/**
 * R2-1 part B: the rows of a destination's reports. The sweep replaces a window (delete range + insert) and prunes
 * by age; the read model asks for sums (D-15 aggregates are formed from them, never from per-row rates) in SQL so
 * a quarter of Search Console rows never crosses into memory.
 */
export class DestinationReportRowRepository extends BrandScopedRepository<typeof destinationReportRows> {
  constructor() {
    super(destinationReportRows);
  }
  private reportScope(brandId: string, destinationId: string, reportKey: string, extra?: SQL): SQL {
    return this.brandScope(
      brandId,
      and(
        eq(destinationReportRows.destinationId, destinationId),
        eq(destinationReportRows.reportKey, reportKey),
        extra,
      ) as SQL,
    );
  }
  private windowScope(
    brandId: string,
    destinationId: string,
    reportKey: string,
    start: string,
    end: string,
  ): SQL {
    return this.reportScope(
      brandId,
      destinationId,
      reportKey,
      and(gte(destinationReportRows.date, start), lte(destinationReportRows.date, end)) as SQL,
    );
  }

  /** The latest day stored for a report, or null before the first fetch. */
  async latestDate(
    brandId: string,
    destinationId: string,
    reportKey: string,
    tx?: Tx,
  ): Promise<string | null> {
    const rows = await this.conn(tx)
      .select({ latest: sql<string | null>`max(${destinationReportRows.date})` })
      .from(destinationReportRows)
      .where(this.reportScope(brandId, destinationId, reportKey));
    return rows[0]?.latest ?? null;
  }

  /** Replaces every row of the window in the caller's transaction: the delete and the inserts commit together. */
  async replaceWindow(
    brandId: string,
    destinationId: string,
    reportKey: string,
    start: string,
    end: string,
    rows: ReportRowInsert[],
    tx: Tx,
  ): Promise<void> {
    const { tenantId } = requireTenant();
    await tx
      .delete(destinationReportRows)
      .where(this.windowScope(brandId, destinationId, reportKey, start, end)); // brand access asserted here
    for (let i = 0; i < rows.length; i += INSERT_CHUNK)
      await tx
        .insert(destinationReportRows)
        .values(rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, tenantId })));
  }

  /** Deletes the destination's rows of days before the cut-off (every report); returns how many went. */
  async deleteBefore(brandId: string, destinationId: string, cutoffDate: string, tx: Tx): Promise<number> {
    return affectedRows(
      await tx
        .delete(destinationReportRows)
        .where(
          this.brandScope(
            brandId,
            and(
              eq(destinationReportRows.destinationId, destinationId),
              lt(destinationReportRows.date, cutoffDate),
            ) as SQL,
          ),
        ),
    );
  }

  /** Days with rows, rows, the latest day and when it was fetched, inside the window. */
  async coverage(
    brandId: string,
    destinationId: string,
    reportKey: string,
    start: string,
    end: string,
    tx?: Tx,
  ) {
    const rows = await this.conn(tx)
      .select({
        days: sql<number>`count(distinct ${destinationReportRows.date})`,
        rows: sql<number>`count(*)`,
        latestDate: sql<string | null>`max(${destinationReportRows.date})`,
        fetchedAt: sql<Date | null>`max(${destinationReportRows.fetchedAt})`,
      })
      .from(destinationReportRows)
      .where(this.windowScope(brandId, destinationId, reportKey, start, end));
    const r = rows[0];
    return {
      days: Number(r?.days ?? 0),
      rows: Number(r?.rows ?? 0),
      latestDate: r?.latestDate ?? null,
      fetchedAt: r?.fetchedAt ? new Date(r.fetchedAt) : null,
    };
  }

  /** The window's sums over every row (the summary's totals). */
  async totals(
    brandId: string,
    destinationId: string,
    reportKey: string,
    metrics: readonly SourceReportMetricV1[],
    start: string,
    end: string,
    tx?: Tx,
  ): Promise<WebMetricSums> {
    const rows = await this.conn(tx)
      .select({ rows: sql<number>`count(*)`, ...sumColumns(metrics) })
      .from(destinationReportRows)
      .where(this.windowScope(brandId, destinationId, reportKey, start, end));
    const r = (rows[0] ?? {}) as Record<string, unknown>;
    return toSums(metrics, r, Number(r['rows'] ?? 0));
  }

  /**
   * The window's sums per dimension value, sorted by the primary metric's sum (descending, ties by key) with a
   * cursor over that order; `limit + 1` rows are read to know whether a next page exists.
   */
  async aggregateByDimension(
    brandId: string,
    destinationId: string,
    reportKey: string,
    metrics: readonly SourceReportMetricV1[],
    primary: string,
    start: string,
    end: string,
    page: { limit: number; cursor?: string | undefined },
    tx?: Tx,
  ): Promise<{ items: ReportDimensionAggregate[]; nextCursor: string | null }> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const primarySum = sql<number | null>`coalesce(${metricSum(primary)}, 0)`;
    const after =
      cursor && typeof cursor.sort === 'number'
        ? (or(
            lt(primarySum, cursor.sort),
            and(eq(primarySum, cursor.sort), gt(destinationReportRows.dimensionKey, cursor.id)),
          ) as SQL)
        : undefined;
    const query = this.conn(tx)
      .select({
        dimensionKey: destinationReportRows.dimensionKey,
        dimensions: sql<string>`min(${destinationReportRows.dimensions})`,
        days: sql<number>`count(distinct ${destinationReportRows.date})`,
        rows: sql<number>`count(*)`,
        primary: primarySum,
        ...sumColumns(metrics),
      })
      .from(destinationReportRows)
      .where(this.windowScope(brandId, destinationId, reportKey, start, end))
      .groupBy(destinationReportRows.dimensionKey)
      .orderBy(desc(primarySum), asc(destinationReportRows.dimensionKey))
      .limit(page.limit + 1);
    const rows = (await (after ? query.having(after) : query)) as Array<Record<string, unknown>>;
    const items = rows.slice(0, page.limit).map((r) => ({
      dimensionKey: String(r['dimensionKey']),
      dimensions: parseDimensions(r['dimensions']),
      days: Number(r['days'] ?? 0),
      sums: toSums(metrics, r, Number(r['rows'] ?? 0)),
    }));
    const next = rows.length > page.limit ? rows[page.limit - 1] : undefined;
    return {
      items,
      nextCursor: next
        ? encodeCursor({ id: String(next['dimensionKey']), sort: Number(next['primary'] ?? 0) })
        : null,
    };
  }
}

/** `min()` over a JSON column comes back as text on MySQL. */
function parseDimensions(value: unknown): Record<string, string> {
  if (value && typeof value === 'object') return value as Record<string, string>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}
