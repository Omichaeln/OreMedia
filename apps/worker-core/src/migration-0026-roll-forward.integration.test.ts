import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type Tx } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { brandAssistJobs, brandSources, brandSuggestions } from '@oremedia/db/schema/brand';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { brandAssistService } from '@oremedia/module-brand';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0026 (BSC-4 sources and AI assist): on a database populated at the previous head (0023)
 * the migration only creates brand_sources, brand_assist_jobs and brand_suggestions; every existing column of every
 * row is unchanged and the new tables start empty. On the migrated data a person adds a source and lists it, and the
 * history lists what was applied before the migration. Additive and roll-forward safe: the previous release never
 * reads the new tables.
 */
const PREVIOUS_HEAD = '0023_facts_workspace';
const NEW_TABLES: MySqlTable[] = [brandSources, brandAssistJobs, brandSuggestions];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t));

describe('migration 0026 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(brandSources)).rejects.toThrow(); // not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('creates the three tables empty and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    for (const t of NEW_TABLES) expect(await tdb.db.select().from(t)).toEqual([]);
  });

  it('on the migrated data a source is added and listed; the history lists the brand system as it was', async () => {
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
      correlationId: 'corr_roll_forward_0026',
    };
    const brandId = tenantA.brandIds[0]!;
    const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx, () => withTransaction(fn));
    const added = await run((tx) =>
      brandAssistService.sources.add(
        owner,
        { kind: 'text', brandId, title: 'Notes', text: 'We write plainly.' },
        tx,
      ),
    );
    const listed = await runInTenant(ctx, () =>
      brandAssistService.sources.list(owner, { brandId, page: { limit: 10 } }),
    );
    expect(listed.items.map((s) => [s.id, s.status])).toEqual([[added.sourceId, 'captured']]);
    const history = await runInTenant(ctx, () =>
      brandAssistService.history.list(owner, { brandId, page: { limit: 10 } }),
    );
    expect(history.items.every((h) => h.appliedAt !== null)).toBe(true);
  });
});
