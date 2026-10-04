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
 * Ledger 1.g4 for migration 0031 (PR-03, conditional CMS writes): on a database populated at the previous head the
 * migration adds brand_destinations.write_safety (not null, default `unknown`) and the nullable
 * write_safety_checked_at; every existing row is unchanged, every existing destination reads `unknown` (not yet
 * asked) through the new code until its next verification, and a verification's result is stored. The columns are in
 * LATER_COLUMNS (seed.ts).
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
    await expect(tdb.db.select().from(brandDestinations)).rejects.toThrow(); // write_safety not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds write_safety (`unknown` on every existing destination) and the nullable checked instant, leaving every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const destinations = await tdb.db.select().from(brandDestinations);
    expect(destinations.length).toBeGreaterThan(0);
    expect(destinations.every((d) => d.writeSafety === 'unknown' && d.writeSafetyCheckedAt === null)).toBe(
      true,
    );
    const columns = await tdb.db.execute(
      sql`select column_name as c, is_nullable as n, column_default as d from information_schema.columns where table_schema = database() and table_name = 'brand_destinations' and column_name in ('write_safety', 'write_safety_checked_at')`,
    );
    const cols = (columns as unknown as [Array<{ c: string; n: string; d: string | null }>])[0];
    expect(cols.map((r) => `${r.c}:${r.n}:${r.d ?? ''}`).sort()).toEqual([
      'write_safety:NO:unknown',
      'write_safety_checked_at:YES:',
    ]);
  });

  it('an existing destination reads `unknown` through the new code, and a recorded verification result is kept', async () => {
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
    const got = await runInTenant(ctx, () =>
      destinationService.get(owner, { brandId: row!.brandId, destinationId }),
    );
    expect(got).toMatchObject({ writeSafety: 'unknown', writeSafetyCheckedAt: null });
    const at = new Date('2026-10-04T12:00:00.000Z');
    await tdb.db
      .update(brandDestinations)
      .set({ writeSafety: 'limited', writeSafetyCheckedAt: at })
      .where(eq(brandDestinations.id, destinationId));
    expect(
      await runInTenant(ctx, () => destinationService.get(owner, { brandId: row!.brandId, destinationId })),
    ).toMatchObject({ writeSafety: 'limited', writeSafetyCheckedAt: at.toISOString() });
  });
});
