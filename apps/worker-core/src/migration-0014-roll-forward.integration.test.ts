import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type Tx } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { studioGenerationJobs } from '@oremedia/db/schema/creative';
import { brandAssistJobs, brandSources, brandSuggestions } from '@oremedia/db/schema/brand';
import { contentPackages, planItems } from '@oremedia/db/schema/content';
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
import { contentService, registerChannelResolver, resetChannelResolver } from '@oremedia/module-content';
import {
  seedTwoTenants,
  snapshotColumns,
  type SeededTenant,
  LATER_TABLE_NAMES,
} from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0014 (UX-09 plan items): on a database populated at the previous head (0013) the
 * migration only adds `plan_items`; every existing row is unchanged, the new table is empty, and on the migrated
 * data a person plans against a seeded brief, drops an item and accepts the brief, which materialises the rest.
 */
const PREVIOUS_HEAD = '0013_password_setup_tokens';
const NEW_TABLES: MySqlTable[] = [planItems];
/** Added after 0014 (R2-0): absent at both heads this suite runs at, so never snapshotted. */
const LATER_TABLES: MySqlTable[] = [
  // BSC-4 (0024)
  brandSources,
  brandAssistJobs,
  brandSuggestions,

  brandDestinations,
  sourceUsePolicies,
  pendingDestinationGrants,
  destinationReportRows,
  seoAuditRuns,
  seoAuditPages,
  seoFindingWork,
  studioGenerationJobs, // 0025
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t))
  .filter((t) => !LATER_TABLE_NAMES.includes(getTableName(t)));

describe('migration 0014 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(planItems)).rejects.toThrow(); // not there at 0013
    before = await snapshot();
  });
  afterAll(async () => {
    resetChannelResolver();
    await tdb?.drop();
  });

  it('adds the table, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(planItems)).toEqual([]);
  });

  it('a person plans against a seeded brief, drops one item and accepts the brief; the rest become packages', async () => {
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
    const briefId = tenantA.ids['briefId']!;
    const channelId = tenantA.ids['channelConnectionId']!;
    registerChannelResolver(async (id) =>
      id === channelId ? { brandId, providerKey: 'fixture_provider', capabilityVersion: 1 } : null,
    );
    const run = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant(
        {
          tenantId: tenantA.tenantId,
          actor: { kind: 'user', id: owner.id },
          brandIds: 'all',
          correlationId: 'corr_roll_forward_0014',
        },
        () => withTransaction(fn),
      );
    const proposed = await run((tx) =>
      contentService.planItems.propose(
        owner,
        {
          briefId,
          items: [
            { date: '2026-11-02', channelKey: 'fixture_provider', theme: 'Launch', formatKey: 'post' },
            { date: '2026-11-05', channelKey: 'fixture_provider', theme: 'Reminder', formatKey: 'story' },
          ],
        },
        tx,
      ),
    );
    expect(proposed.planItemIds).toHaveLength(2);
    const [first, second] = proposed.planItemIds as [string, string];
    await run((tx) => contentService.planItems.drop(owner, { planItemId: second, expectedVersion: 0 }, tx));
    const accepted = await run((tx) =>
      contentService.briefs.accept(owner, { briefId, expectedVersion: 0 }, tx),
    );
    expect(accepted.materialised.map((m) => m.planItemId)).toEqual([first]);
    const rows = await tdb.db
      .select()
      .from(planItems)
      .where(and(eq(planItems.tenantId, tenantA.tenantId), eq(planItems.briefId, briefId)))
      .orderBy(asc(planItems.date));
    expect(rows.map((r) => r.state)).toEqual(['materialised', 'dropped']);
    const pkgs = await tdb.db
      .select()
      .from(contentPackages)
      .where(and(eq(contentPackages.tenantId, tenantA.tenantId), eq(contentPackages.briefId, briefId)));
    expect(pkgs.map((p) => p.title)).toEqual(['2026-11-02 · Launch']);
  });
});
