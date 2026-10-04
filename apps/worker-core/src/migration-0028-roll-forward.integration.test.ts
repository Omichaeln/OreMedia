import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { studioVideoJobs } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { creativeService } from '@oremedia/module-creative';
import {
  LATER_TABLE_NAMES,
  seedTwoTenants,
  snapshotColumns,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0028 (STU-3 studio video AI): on a database populated at the previous head the migration
 * creates studio_video_jobs (empty); every existing row is unchanged and the seeded document still reads through the
 * new code. The table is in LATER_TABLE_NAMES (seed.ts). creative_revisions.generation_inputs is STU-1b's (0025).
 */
const PREVIOUS_HEAD = '0027_video_projects';
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLE_NAMES.includes(getTableName(t)));

describe('migration 0028 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(studioVideoJobs)).rejects.toThrow(); // not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('creates studio_video_jobs, leaving every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(studioVideoJobs)).toEqual([]);
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
      correlationId: 'corr_roll_forward_0028',
    };
    const documentId = tenantA.ids['creativeDocumentId'] as string;
    const got = await runInTenant(ctx, () => creativeService.documents.get(owner, { documentId }));
    expect(got).toMatchObject({ kind: 'graphic', revision: { kind: 'graphic' } });
  });
});
