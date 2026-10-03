import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { creativeRevisions, studioGenerationJobs } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { seedTwoTenants, snapshotColumns } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0025 (STU-1b studio generation): on a database populated at the previous head (0024)
 * the migration adds the nullable creative_revisions.generation_inputs (null on every existing revision) and the
 * empty studio_generation_jobs table; every existing column of every row is unchanged. Additive and roll-forward
 * safe: a revision written by the previous release has no generation inputs, which reads as a person's or an agent
 * run's revision.
 */
const PREVIOUS_HEAD = '0024_brand_assist';
const LATER_TABLES: MySqlTable[] = [studioGenerationJobs];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLES.includes(t));

describe('migration 0025 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
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
    await seedTwoTenants(tdb.db);
    await expect(tdb.db.select().from(studioGenerationJobs)).rejects.toThrow(); // not there at 0024
    await expect(tdb.db.select().from(creativeRevisions)).rejects.toThrow(); // generation_inputs not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the nullable column (null on every existing revision) and the empty table; every existing row is unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(studioGenerationJobs)).toEqual([]);
    const revisions = await tdb.db.select().from(creativeRevisions);
    expect(revisions.every((r) => r.generationInputs === null)).toBe(true);
  });
});
