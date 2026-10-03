import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { approvedFacts } from '@oremedia/db/schema/brand';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { brandService } from '@oremedia/module-brand';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0023 (BSC-3 facts workspace): on a database populated at the previous head (0022) the
 * migration adds the workspace columns to approved_facts and the `superseded` state, and backfills category from
 * kind, origin from proposed_by_kind (user → user, agent → suggested) and sources from evidence; every existing
 * column of every row is unchanged. On the migrated data the facts seeded before the migration list with their
 * category, origin and sources, a person's fact is approved and corrected, and the correction's approval
 * supersedes it. Additive and roll-forward safe: the new columns are in LATER_COLUMNS (seed.ts).
 */
const PREVIOUS_HEAD = '0022_channel_health';
const TABLES = (Object.values(schema) as unknown[]).filter((v): v is MySqlTable => v instanceof MySqlTable);

describe('migration 0023 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';
  const agentFactId = 'fact_01ROLLFORWARD0023AGENT0';

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
    const at = new Date();
    // An agent's proposal as the previous release wrote it (no workspace columns).
    await tdb.db.execute(
      sql`insert into ${approvedFacts} (id, tenant_id, brand_id, kind, statement, evidence, state, proposed_by_kind, proposed_by_id, created_at, updated_at, version) values (${agentFactId}, ${tenantA.tenantId}, ${tenantA.brandIds[0]}, 'offer', 'Agent offer', ${JSON.stringify([{ kind: 'url', ref: 'https://example.test' }])}, 'proposed', 'agent', 'sp_seeded', ${at}, ${at}, 0)`,
    );
    await expect(tdb.db.select().from(approvedFacts)).rejects.toThrow(); // the workspace columns are not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the columns, backfills category, origin and sources, and leaves every existing column unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const rows = await tdb.db.select().from(approvedFacts);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((r) => r.category === r.kind)).toBe(true);
    expect(rows.every((r) => JSON.stringify(r.sources) === JSON.stringify(r.evidence))).toBe(true);
    expect(rows.every((r) => r.origin === (r.proposedByKind === 'agent' ? 'suggested' : 'user'))).toBe(true);
    const agentRow = rows.find((r) => r.id === agentFactId)!;
    expect(agentRow).toMatchObject({
      origin: 'suggested',
      category: 'offer',
      dedupeKey: null,
      conflicts: null,
    });
    expect(rows.every((r) => r.reviewDueAt === null && r.supersededByFactId === null)).toBe(true);
    await expect(
      tdb.db.execute(sql`update ${approvedFacts} set state = 'archived' where id = ${agentFactId}`),
    ).rejects.toMatchObject({ cause: { code: 'WARN_DATA_TRUNCATED' } });
  });

  it('the facts seeded before the migration list in the workspace; approving and correcting them supersedes the original', async () => {
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
      correlationId: 'corr_roll_forward_0023',
    };
    const brandId = tenantA.brandIds[0]!;
    const factId = tenantA.ids['factId'] as string;
    const listed = await runInTenant(ctx, () =>
      brandService.facts.list(owner, { brandId, category: 'claim', origin: 'user', page: { limit: 50 } }),
    );
    expect(listed.items.find((f) => f.id === factId)).toMatchObject({
      category: 'claim',
      origin: 'user',
      sources: [{ kind: 'other', ref: 'seed' }],
      state: 'proposed',
    });
    const run = <T>(fn: Parameters<typeof withTransaction<T>>[0]) =>
      runInTenant(ctx, () => withTransaction(fn));
    await run((tx) => brandService.facts.approve(owner, { brandId, factId, expectedVersion: 0 }, tx));
    const correction = await run((tx) =>
      brandService.facts.correct(
        owner,
        { brandId, factId, expectedVersion: 1, statement: 'Seeded claim, corrected' },
        tx,
      ),
    );
    await run((tx) =>
      brandService.facts.approve(owner, { brandId, factId: correction.factId, expectedVersion: 0 }, tx),
    );
    const original = (await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.id, factId)))[0]!;
    expect(original).toMatchObject({ state: 'superseded', supersededByFactId: correction.factId });
  });
});
