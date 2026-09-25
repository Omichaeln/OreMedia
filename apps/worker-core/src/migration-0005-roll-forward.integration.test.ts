import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { brandGuidelineAuthors } from '@oremedia/db/schema/brand';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { brandService } from '@oremedia/module-brand';
import { seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0005 (brand skill import): on a database populated at the previous head (0004) the
 * migration only adds `brand_guideline_authors`; every existing row is unchanged, the new table is empty, and a
 * brand skill imports on the migrated data with its importer recorded as the guidelines' author.
 */
const PREVIOUS_HEAD = '0004_generated_uploads';
const NEW_TABLES: MySqlTable[] = [brandGuidelineAuthors];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t));

describe('migration 0005 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      out[getTableName(table)] = await tdb.db.select().from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(brandGuidelineAuthors)).rejects.toThrow(); // not there at 0004
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the table, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(brandGuidelineAuthors)).toEqual([]);
  });

  it('a brand skill imports on the migrated data and records its importer', async () => {
    const owner: ResolvedActor = {
      kind: 'user',
      id: tenantA.ownerUserId,
      tenantId: tenantA.tenantId,
      membershipId: 'mem_roll_forward_0005',
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const { versionId } = await runInTenant(
      {
        tenantId: tenantA.tenantId,
        actor: { kind: 'user', id: owner.id },
        brandIds: 'all',
        correlationId: 'corr_roll_forward_0005',
      },
      () =>
        withTransaction((tx) =>
          brandService.guidelines.import(
            owner,
            {
              brandId: tenantA.brandIds[0],
              files: [
                { path: 'SKILL.md', content: '---\nname: roll-forward-brand\ndescription: x\n---\n# Brand' },
              ],
            },
            tx,
          ),
        ),
    );
    expect(
      await tdb.db.select().from(brandGuidelineAuthors).where(eq(brandGuidelineAuthors.id, versionId)),
    ).toMatchObject([{ tenantId: tenantA.tenantId, authorKind: 'user', authorId: owner.id }]);
  });
});
