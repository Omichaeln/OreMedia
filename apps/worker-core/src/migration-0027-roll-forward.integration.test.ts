import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { creativeDocuments, renderedExports } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { creativeService } from '@oremedia/module-creative';
import {
  LATER_TABLE_NAMES,
  seedTwoTenants,
  snapshotColumns,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0027 (STU-2b video projects): on a database populated at the previous head the migration
 * adds creative_documents.kind (NOT NULL, default graphic) and the nullable rendered_exports.dedupe_key with its
 * index; every existing row is unchanged, every existing document reads as graphic, and the seeded graphic document
 * still reads with its snapshot through the new code. The columns are in LATER_COLUMNS (seed.ts).
 */
const PREVIOUS_HEAD = '0026_video_media';
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLE_NAMES.includes(getTableName(t)));

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
    await expect(tdb.db.select().from(creativeDocuments)).rejects.toThrow(); // kind not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds kind (graphic on every existing document) and dedupe_key (null), leaving every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const docs = await tdb.db.select().from(creativeDocuments);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.kind === 'graphic')).toBe(true);
    expect((await tdb.db.select().from(renderedExports)).every((e) => e.dedupeKey === null)).toBe(true);
    await expect(
      tdb.db.execute(sql`update ${creativeDocuments} set kind = 'audio' where id = ${docs[0]!.id}`),
    ).rejects.toMatchObject({ cause: { code: 'WARN_DATA_TRUNCATED' } });
  });

  it('the seeded graphic document reads through the new code as graphic with its snapshot', async () => {
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
    const [row] = await tdb.db.select().from(creativeDocuments).where(eq(creativeDocuments.id, documentId));
    expect(row?.kind).toBe('graphic');
  });
});
