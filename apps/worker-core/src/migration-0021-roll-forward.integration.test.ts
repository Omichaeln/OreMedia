import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { brandAssistJobs, brandSources, brandSuggestions } from '@oremedia/db/schema/brand';
import {
  brandDestinations,
  destinationReportRows,
  seoAuditRuns,
  seoFindingWork,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/**
 * Ledger 1.g4 for migration 0021 (RA-10 report quality, RA-11 findings as tracked work): on a database populated
 * at the previous head (0020) the migration adds `reporting_time_zone`, `currency_code` and `reporting_zone_checked_at` to brand_destinations
 * and `time_zone` and `quality` to destination_report_rows, null on every existing row (a row stored before the
 * zone was known stays a UTC day and reads without flags), and adds `seo_finding_work`, empty. Every existing row
 * is unchanged. On the migrated data a destination remembers its zone, a report row carries its zone and flags
 * beside the untouched rows, and a finding's work is recorded once per (destination, run, check) under its
 * destination's brand and run.
 */
const PREVIOUS_HEAD = '0020_article_remote_status';
const NEW_TABLES: MySqlTable[] = [seoFindingWork];
/** Tables later migrations add (BSC-4, 0024): absent at both heads this suite compares. */
const LATER_TABLES: MySqlTable[] = [brandSources, brandAssistJobs, brandSuggestions];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0021 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      // reporting_time_zone, currency_code, reporting_zone_checked_at, time_zone and quality are in LATER_COLUMNS.
      out[getTableName(table)] = await tdb.db.select(snapshotColumns(table)).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(seoFindingWork)).rejects.toThrow(); // not there at 0020
    await expect(tdb.db.select().from(destinationReportRows)).rejects.toThrow(); // time_zone not there at 0020
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the nullable columns (null on every existing row) and the empty table; every existing row is unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(seoFindingWork)).toEqual([]);
    const destinations = await tdb.db.select().from(brandDestinations);
    expect(destinations.length).toBeGreaterThan(0);
    expect(
      destinations.every(
        (d) => d.reportingTimeZone === null && d.currencyCode === null && d.reportingZoneCheckedAt === null,
      ),
    ).toBe(true);
    const rows = await tdb.db.select().from(destinationReportRows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.timeZone === null && r.quality === null)).toBe(true);
    const nullable = await tdb.db.execute(
      sql`select table_name as t, column_name as c, is_nullable as n from information_schema.columns where table_schema = database() and ((table_name = 'brand_destinations' and column_name in ('reporting_time_zone', 'currency_code', 'reporting_zone_checked_at')) or (table_name = 'destination_report_rows' and column_name in ('time_zone', 'quality')))`,
    );
    const cols = (nullable as unknown as [Array<{ t: string; c: string; n: string }>])[0];
    expect(cols.map((r) => `${r.t}.${r.c}:${r.n}`).sort()).toEqual([
      'brand_destinations.currency_code:YES',
      'brand_destinations.reporting_time_zone:YES',
      'brand_destinations.reporting_zone_checked_at:YES',
      'destination_report_rows.quality:YES',
      'destination_report_rows.time_zone:YES',
    ]);
  });

  it('a destination remembers its zone and a new row carries its zone and flags beside the rows stored as UTC days', async () => {
    const destinationId = tenantA.ids['destinationId'] as string;
    const destination = (
      await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, destinationId))
    )[0]!;
    await tdb.db
      .update(brandDestinations)
      .set({ reportingTimeZone: 'Africa/Johannesburg', currencyCode: 'ZAR' })
      .where(eq(brandDestinations.id, destinationId));
    expect(
      (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, destinationId)))[0],
    ).toMatchObject({ reportingTimeZone: 'Africa/Johannesburg', currencyCode: 'ZAR' });
    const rowId = newId('drr');
    await tdb.db.insert(destinationReportRows).values({
      id: rowId,
      tenantId: tenantA.tenantId,
      brandId: destination.brandId,
      destinationId,
      reportKey: 'ga4.acquisition',
      date: '2026-09-29',
      dimensions: { sessionDefaultChannelGroup: 'Direct' },
      dimensionKey: 'direct',
      metrics: { sessions: 5 },
      fetchedAt: new Date('2026-09-30T05:00:00.000Z'),
      source: 'provider',
      timeZone: 'Africa/Johannesburg',
      quality: ['sampled', 'partial_day'],
    });
    const stored = await tdb.db
      .select()
      .from(destinationReportRows)
      .where(eq(destinationReportRows.destinationId, destinationId))
      .orderBy(asc(destinationReportRows.date));
    expect(stored.map((r) => [r.date, r.timeZone, r.quality])).toEqual([
      ['2026-09-27', null, null],
      ['2026-09-28', null, null],
      ['2026-09-29', 'Africa/Johannesburg', ['sampled', 'partial_day']],
    ]);
  });

  it('records a finding’s work once per (destination, run, check) under its brand and run; a run that is not there is refused', async () => {
    const destinationId = tenantA.ids['destinationId'] as string;
    const runId = tenantA.ids['seoAuditRunId'] as string;
    const run = (await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.id, runId)))[0]!;
    expect(run.destinationId).toBe(destinationId);
    const id = newId('sfw');
    const values = {
      id,
      tenantId: tenantA.tenantId,
      brandId: run.brandId,
      destinationId,
      runId,
      check: 'title',
      severity: 'minor' as const,
      pageCount: 2,
      examples: ['https://site.example/', 'https://site.example/about'],
      workType: 'recommendation',
      workId: newId('rec'),
      createdById: tenantA.ownerUserId,
    };
    await tdb.db.insert(seoFindingWork).values(values);
    const stored = (await tdb.db.select().from(seoFindingWork).where(eq(seoFindingWork.id, id)))[0]!;
    expect(stored).toMatchObject({ ...values, resolvedAt: null, resolvedRunId: null, version: 0 });
    await expect(
      tdb.db.insert(seoFindingWork).values({ ...values, id: newId('sfw'), workId: newId('rec') }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } }); // uq_seo_finding_work_finding
    await expect(
      tdb.db.insert(seoFindingWork).values({ ...values, id: newId('sfw'), check: 'h1', runId: newId('sar') }),
    ).rejects.toMatchObject({ cause: { code: 'ER_NO_REFERENCED_ROW_2' } }); // fk_seo_finding_work_run
    await tdb.db
      .update(seoFindingWork)
      .set({ resolvedAt: new Date('2026-10-06T05:00:00.000Z'), resolvedRunId: runId })
      .where(eq(seoFindingWork.id, id));
    expect(
      (await tdb.db.select().from(seoFindingWork).where(eq(seoFindingWork.id, id)))[0]?.resolvedRunId,
    ).toBe(runId);
  });
});
