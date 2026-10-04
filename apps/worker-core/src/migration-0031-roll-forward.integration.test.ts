import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { brandDestinations } from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { destinationService } from '@oremedia/module-destinations';
import {
  LATER_TABLE_NAMES,
  seedTwoTenants,
  snapshotColumns,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0031 (PR-04, rendered-article verification): on a database populated at the previous
 * head the migration adds the nullable brand_destinations.article_selector; every existing row is unchanged, every
 * existing destination reads no selector (the theme defaults) through the new code, and a selector is stored. The
 * column is in LATER_COLUMNS (seed.ts).
 */
const PREVIOUS_HEAD = '0030_tenant_kind';
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLE_NAMES.includes(getTableName(t)));

describe('migration 0031 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(brandDestinations)).rejects.toThrow(); // article_selector not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds article_selector (null on every existing destination), leaving every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const destinations = await tdb.db.select().from(brandDestinations);
    expect(destinations.length).toBeGreaterThan(0);
    expect(destinations.every((d) => d.articleSelector === null)).toBe(true);
    const columns = await tdb.db.execute(
      sql`select column_name as c, is_nullable as n from information_schema.columns where table_schema = database() and table_name = 'brand_destinations' and column_name = 'article_selector'`,
    );
    const cols = (columns as unknown as [Array<{ c: string; n: string }>])[0];
    expect(cols.map((r) => `${r.c}:${r.n}`)).toEqual(['article_selector:YES']);
  });

  it('an existing destination reads no selector through the new code, and a stored selector is read back', async () => {
    const owner: ResolvedActor = {
      kind: 'user',
      id: tenantA.ownerUserId,
      tenantId: tenantA.tenantId,
      membershipId: tenantA.ownerMembershipId,
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const ctx = {
      tenantId: tenantA.tenantId,
      actor: { kind: 'user' as const, id: tenantA.ownerUserId },
      brandIds: 'all' as const,
      correlationId: 'corr_roll_forward_0031',
    };
    const destinationId = tenantA.ids['destinationId'] as string;
    const [row] = await tdb.db
      .select()
      .from(brandDestinations)
      .where(eq(brandDestinations.id, destinationId));
    expect(
      await runInTenant(ctx, () => destinationService.get(owner, { brandId: row!.brandId, destinationId })),
    ).toMatchObject({ articleSelector: null });
    await tdb.db
      .update(brandDestinations)
      .set({ articleSelector: 'div.post-body' })
      .where(eq(brandDestinations.id, destinationId));
    expect(
      await runInTenant(ctx, () => destinationService.get(owner, { brandId: row!.brandId, destinationId })),
    ).toMatchObject({ articleSelector: 'div.post-body' });
  });
});
