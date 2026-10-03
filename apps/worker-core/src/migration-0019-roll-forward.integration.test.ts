import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { brandAssistJobs, brandSources, brandSuggestions } from '@oremedia/db/schema/brand';
import {
  brandDestinations,
  seoAuditPages,
  seoAuditRuns,
  seoFindingWork,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Ledger 1.g4 for migration 0019 (R2-4 technical SEO audit): on a database populated at the previous head (0018)
 * the migration only adds `seo_audit_runs` and `seo_audit_pages`; every existing row is unchanged and both tables
 * are empty. On the migrated data a run is recorded for a destination registered before the migration, a page of
 * it is stored once per URL (uq_seo_audit_page; the title and description as hashes, never text), a page of a run
 * that does not exist is refused (fk_seo_audit_page_run)
 * and the run's foreign key keeps it under its destination's brand.
 */
const PREVIOUS_HEAD = '0018_cms_articles';
const NEW_TABLES: MySqlTable[] = [seoAuditRuns, seoAuditPages];
/** Added by migration 0021 (RA-11); absent at both heads this suite compares. */
const LATER_TABLES: MySqlTable[] = [
  // BSC-4 (0024)
  brandSources,
  brandAssistJobs,
  brandSuggestions,
  seoFindingWork,
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0019 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      out[getTableName(table)] = await tdb.db.select(snapshotColumns(table)).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(seoAuditRuns)).rejects.toThrow(); // not there at 0018
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the two tables, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(seoAuditRuns)).toEqual([]);
    expect(await tdb.db.select().from(seoAuditPages)).toEqual([]);
  });

  it('records a run for a destination registered before the migration, one page per URL, under the brand', async () => {
    const destinationId = tenantA.ids['destinationId'] as string;
    const destination = (
      await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, destinationId))
    )[0]!;
    const brandId = destination.brandId;
    const runId = newId('sar');
    const at = new Date('2026-10-05T05:00:00.000Z');
    await tdb.db.insert(seoAuditRuns).values({
      id: runId,
      tenantId: tenantA.tenantId,
      brandId,
      destinationId,
      origin: 'https://site.example',
      trigger: 'scheduled',
      requestedById: null,
      startedAt: at,
      outcome: 'running',
    });
    const stored = (await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.id, runId)))[0]!;
    expect(stored).toMatchObject({ outcome: 'running', pagesCrawled: 0, limitsHit: [], robotsDisallow: [] });
    expect(stored.summary).toEqual({ critical: 0, major: 0, minor: 0, byCheck: {} });
    const url = 'https://site.example/';
    const page = {
      tenantId: tenantA.tenantId,
      brandId,
      runId,
      url,
      urlHash: sha256Hex(url),
      depth: 0,
      status: 200,
      bytes: 1200,
      severity: 'minor' as const,
      checks: [{ key: 'title', ok: false, severity: 'minor', detail: 'length=64' }],
      titleHash: sha256Hex('a title'),
      metaDescriptionHash: null,
      links: ['https://site.example/a'],
      fetchedAt: at,
    };
    await tdb.db.insert(seoAuditPages).values({ id: newId('sap'), ...page });
    await expect(tdb.db.insert(seoAuditPages).values({ id: newId('sap'), ...page })).rejects.toMatchObject({
      cause: { code: 'ER_DUP_ENTRY' },
    }); // uq_seo_audit_page
    await expect(
      tdb.db.insert(seoAuditPages).values({ id: newId('sap'), ...page, runId: newId('sar') }),
    ).rejects.toMatchObject({ cause: { code: 'ER_NO_REFERENCED_ROW_2' } }); // fk_seo_audit_page_run
    // A run names a destination of its own brand only (fk_seo_audit_run_destination).
    await expect(
      tdb.db.insert(seoAuditRuns).values({
        id: newId('sar'),
        tenantId: tenantA.tenantId,
        brandId: tenantA.brandIds.find((b) => b !== brandId) ?? brandId,
        destinationId,
        origin: 'https://site.example',
        trigger: 'on_demand',
        requestedById: tenantA.ownerUserId,
        startedAt: at,
        outcome: 'running',
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_NO_REFERENCED_ROW_2' } });
    const pages = await tdb.db.select().from(seoAuditPages).where(eq(seoAuditPages.runId, runId));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.checks).toEqual(page.checks);
  });
});
