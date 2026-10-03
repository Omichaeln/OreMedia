import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { creativeRevisions } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { creativeService } from '@oremedia/module-creative';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0027 (the stand-in for STU-1b's generation_inputs column until #59 lands): on a populated
 * database it adds the nullable creative_revisions.generation_inputs; every existing row is unchanged and every
 * existing revision has none. The column is in LATER_COLUMNS (seed.ts).
 */
const PREVIOUS_HEAD = '0026_studio_video_jobs';
const TABLES = (Object.values(schema) as unknown[]).filter((v): v is MySqlTable => v instanceof MySqlTable);

describe('migration 0027 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(creativeRevisions)).rejects.toThrow(); // generation_inputs not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds generation_inputs (null on every existing revision), leaving every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const revisions = await tdb.db.select().from(creativeRevisions);
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.every((r) => r.generationInputs === null)).toBe(true);
  });

  it('the seeded document reads through the new code', async () => {
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
      correlationId: 'corr_roll_forward_0027',
    };
    const documentId = tenantA.ids['creativeDocumentId'] as string;
    const got = await runInTenant(ctx, () => creativeService.documents.get(owner, { documentId }));
    expect(got).toMatchObject({ kind: 'graphic', revision: { kind: 'graphic' } });
  });
});
