import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { passwordSetupTokens } from '@oremedia/db/schema/access';
import { brandGuidelineAuthors } from '@oremedia/db/schema/brand';
import { pendingChannelGrants, publicationRemoteChanges } from '@oremedia/db/schema/publishing';
import { planItems } from '@oremedia/db/schema/content';
import {
  brandDestinations,
  destinationReportRows,
  pendingDestinationGrants,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { brandService } from '@oremedia/module-brand';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0006 (brand skill import): on a database populated at the previous head (0005) the
 * migration only adds `brand_guideline_authors`; every existing row is unchanged, the new table is empty, and a
 * brand skill imports on the migrated data with its importer recorded as the guidelines' author.
 */
const PREVIOUS_HEAD = '0005_lazy_redwing';
const NEW_TABLES: MySqlTable[] = [brandGuidelineAuthors];
/** Added by later migrations (0010 to 0013: their migration-*-roll-forward tests). */
const LATER_TABLES: MySqlTable[] = [
  pendingChannelGrants,
  publicationRemoteChanges,
  passwordSetupTokens,
  planItems,
  brandDestinations,
  sourceUsePolicies,
  pendingDestinationGrants,
  destinationReportRows,
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0006 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(brandGuidelineAuthors)).rejects.toThrow(); // not there at 0005
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
      membershipId: 'mem_roll_forward_0006',
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
        correlationId: 'corr_roll_forward_0006',
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
