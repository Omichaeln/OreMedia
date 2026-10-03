import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type Tx } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import {
  brandDestinations,
  destinationReportRows,
  pendingDestinationGrants,
  seoAuditPages,
  seoAuditRuns,
  sourceUsePolicies,
  seoFindingWork,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { destinationService, sourceUsePolicyService } from '@oremedia/module-destinations';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0015 (R2-0 brand destinations and source-use policies): on a database populated at the
 * previous head (0014) the migration only adds `brand_destinations` and `source_use_policies`; every existing row
 * is unchanged, the new tables are empty, and on the migrated data a person registers a destination, records a
 * source-use policy for it and the policy answers a check.
 */
const PREVIOUS_HEAD = '0014_plan_items';
const NEW_TABLES: MySqlTable[] = [brandDestinations, sourceUsePolicies];
/** Added by later migrations (0016, 0017). */
const LATER_TABLES: MySqlTable[] = [
  pendingDestinationGrants,
  destinationReportRows,
  seoAuditRuns,
  seoAuditPages,
  seoFindingWork,
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0015 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(brandDestinations)).rejects.toThrow(); // not there at 0014
    await expect(tdb.db.select().from(sourceUsePolicies)).rejects.toThrow();
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the tables, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(brandDestinations)).toEqual([]);
    expect(await tdb.db.select().from(sourceUsePolicies)).toEqual([]);
  });

  it('a person registers a destination, records its source-use policy and the policy answers a check', async () => {
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
    const brandId = tenantA.brandIds[0];
    const run = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant(
        {
          tenantId: tenantA.tenantId,
          actor: { kind: 'user', id: owner.id },
          brandIds: 'all',
          correlationId: 'corr_roll_forward_0015',
        },
        () => withTransaction(fn),
      );
    const registered = await run((tx) =>
      destinationService.register(
        owner,
        {
          brandId,
          kind: 'search_console_site',
          externalId: 'sc-domain:acme.example',
          displayName: 'Acme site',
        },
        tx,
      ),
    );
    expect(registered).toMatchObject({ ownerUserId: owner.id, status: 'active', health: 'unknown' });
    const set = await run((tx) =>
      sourceUsePolicyService.set(
        owner,
        {
          brandId,
          destinationKind: 'search_console_site',
          dataType: 'search_console.queries',
          allowedUses: ['read', 'retain'],
          retentionDays: 400,
          reviewDueAt: new Date(Date.now() + 180 * 86_400_000).toISOString(),
        },
        tx,
      ),
    );
    expect(set.version).toBe(1);
    const check = await run((tx) =>
      sourceUsePolicyService.check(
        owner,
        {
          brandId,
          destinationKind: 'search_console_site',
          dataType: 'search_console.queries',
          use: 'retain',
        },
        tx,
      ),
    );
    expect(check).toMatchObject({ allowed: true, reason: 'allowed', policy: { retentionDays: 400 } });
    const rows = await tdb.db
      .select()
      .from(brandDestinations)
      .where(eq(brandDestinations.tenantId, tenantA.tenantId));
    expect(rows.map((r) => r.kind)).toEqual(['search_console_site']);
  });
});
