import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { generatedUploads, uploadIntents } from '@oremedia/db/schema/assets';
import { brandGuidelineAuthors } from '@oremedia/db/schema/brand';
import { providerReviewStatuses } from '@oremedia/db/schema/platform';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { MemoryStorageProvider, assetService, configureStorage } from '@oremedia/module-assets';
import { seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0004 (ADR-11 generated uploads): on a database populated at the previous head (0003)
 * the migration only adds `generated_uploads`; every existing row is unchanged, the new table is empty, and a
 * generated image enters ingest against the migrated data with its provenance recorded beside the intent.
 */
const PREVIOUS_HEAD = '0003_external_identities_auth_events';
const NEW_TABLES: MySqlTable[] = [generatedUploads];
/** Added by later migrations (0005 provider review statuses; 0006: migration-0006-roll-forward.integration.test.ts). */
const LATER_TABLES: MySqlTable[] = [providerReviewStatuses, brandGuidelineAuthors];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0004 rolls forward on a populated database (ledger 1.g4)', () => {
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
    configureStorage(new MemoryStorageProvider());
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(generatedUploads)).rejects.toThrow(); // not there at 0003
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the table, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(generatedUploads)).toEqual([]);
  });

  it('a generated image enters ingest on the migrated data with its provenance beside the intent', async () => {
    const owner: ResolvedActor = {
      kind: 'user',
      id: tenantA.ownerUserId,
      tenantId: tenantA.tenantId,
      membershipId: 'mem_roll_forward_0004',
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const provenance = {
      kind: 'generated' as const,
      model: 'openrouter:vendor/image-model',
      promptHash: 'a'.repeat(64),
      inputs: [],
      agentRunId: 'run_roll_forward_0004',
    };
    // Ingest is not run here: the bytes only need to be stored under the intent's quarantine key.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { intentId } = await runInTenant(
      {
        tenantId: tenantA.tenantId,
        actor: { kind: 'user', id: owner.id },
        brandIds: 'all',
        correlationId: 'corr_roll_forward_0004',
      },
      () =>
        withTransaction((tx) =>
          assetService.uploadGenerated(
            owner,
            {
              brandId: tenantA.brandIds[0],
              kind: 'illustration',
              mime: 'image/png',
              bytes,
              originalFilename: 'generated.png',
              provenance,
            },
            tx,
          ),
        ),
    );
    expect(
      (await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, intentId)))[0],
    ).toMatchObject({
      state: 'uploaded',
    });
    expect(
      await tdb.db.select().from(generatedUploads).where(eq(generatedUploads.id, intentId)),
    ).toMatchObject([{ tenantId: tenantA.tenantId, brandId: tenantA.brandIds[0], provenance }]);
  });
});
