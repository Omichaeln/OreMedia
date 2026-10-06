import { and, desc, eq, lte, type SQL } from 'drizzle-orm';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, type Tx } from '@oremedia/db';
import { reportPreferences, reports } from '@oremedia/db/schema/reports';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

export class ReportRepository extends BrandScopedRepository<typeof reports> {
  constructor() {
    super(reports);
  }
  async create(values: Omit<typeof reports.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof reports.$inferInsert>, tx: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** The brand's reports newest first (the "Recent" list). */
  async list(brandId: string, page: PageRequest, tx?: Tx): Promise<Page<typeof reports.$inferSelect>> {
    const clauses: SQL[] = [];
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(reports.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(reports)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(reports.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** The brand's report for one calendar month (at most one: uq_report_month). */
  async findForMonth(brandId: string, periodMonth: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(reports)
      .where(this.brandScope(brandId, eq(reports.periodMonth, periodMonth)))
      .limit(1);
    return rows[0] ?? null;
  }
}

export class ReportPreferenceRepository extends BrandScopedRepository<typeof reportPreferences> {
  constructor() {
    super(reportPreferences);
  }
  async create(values: Omit<typeof reportPreferences.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof reportPreferences.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async findForBrand(brandId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(reportPreferences)
      .where(this.brandScope(brandId))
      .limit(1);
    return rows[0] ?? null;
  }
}
