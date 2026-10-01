import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, inArray } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import { defaultPolicyDocument } from '@oremedia/contracts/brand';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type Tx } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { passwordSetupTokens } from '@oremedia/db/schema/access';
import { brands, policyVersions } from '@oremedia/db/schema/brand';
import { pendingChannelGrants, publicationRemoteChanges } from '@oremedia/db/schema/publishing';
import { planItems } from '@oremedia/db/schema/content';
import {
  brandDestinations,
  pendingDestinationGrants,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { brandService } from '@oremedia/module-brand';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0009 (D-11 brand classification): on a database populated at the previous head (0008)
 * the migration only adds brands.classification. Every brand that existed becomes internal, so separation of duties
 * stays as it was for them; every other column and row is unchanged; and the migrated brands work with the new
 * rules (no distinct approver needed until a person reclassifies the brand as client).
 */
const PREVIOUS_HEAD = '0008_usage_audio_generation';
/** Added by later migrations (0010 to 0013: their migration-*-roll-forward tests). */
const LATER_TABLES: MySqlTable[] = [
  pendingChannelGrants,
  publicationRemoteChanges,
  passwordSetupTokens,
  planItems,
  brandDestinations,
  sourceUsePolicies,
  pendingDestinationGrants,
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLES.includes(t));

describe('migration 0009 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let before = '';

  /** Every table's rows over the columns that exist at 0008 (brands.classification left out). */
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
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select({ c: brands.classification }).from(brands)).rejects.toThrow(); // not there at 0008
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the column, makes every existing brand internal and leaves every other value unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const seeded = [...tenantA.brandIds, ...tenantB.brandIds];
    const rows = await tdb.db
      .select({ id: brands.id, classification: brands.classification })
      .from(brands)
      .where(inArray(brands.id, seeded));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.classification === 'internal')).toBe(true);
  });

  it('a migrated brand needs no distinct approver until a person makes it a client brand', async () => {
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
    // The seed activates a release policy on each tenant's first brand (it decides there); the second has none.
    const brandId = tenantA.brandIds[1];
    const inTenant = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant(
        {
          tenantId: tenantA.tenantId,
          actor: { kind: 'user', id: owner.id },
          brandIds: 'all',
          correlationId: 'corr_roll_forward_0009',
        },
        () => withTransaction(fn),
      );
    await expect(inTenant((tx) => brandService.distinctApproverRequired(brandId, tx))).resolves.toBe(false);
    // A policy version written without the rule follows the brand's classification.
    const { requireDistinctApprover: _rule, ...withoutRule } = defaultPolicyDocument();
    const draft = await inTenant((tx) =>
      brandService.policy.createVersion(owner, { brandId, document: withoutRule }, tx),
    );
    const [stored] = await tdb.db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.id, draft.policyVersionId));
    expect(stored?.document).toMatchObject({ requireDistinctApprover: false });

    const [row] = await tdb.db.select().from(brands).where(eq(brands.id, brandId));
    await inTenant((tx) =>
      brandService.classify(owner, { brandId, classification: 'client', expectedVersion: row!.version }, tx),
    );
    await expect(inTenant((tx) => brandService.distinctApproverRequired(brandId, tx))).resolves.toBe(true);
  });
});
