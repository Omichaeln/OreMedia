import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { creativeDocuments } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { creativeService } from '@oremedia/module-creative';
import {
  LATER_TABLE_NAMES,
  seedTwoTenants,
  snapshotColumns,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0029 (G12 document archive): on a database populated at the previous head the migration
 * adds the nullable creative_documents.archived_at; every existing row is unchanged, every existing document stays in
 * use (archived_at null), and the seeded document is still in the Studio's default index through the new code. The
 * column is in LATER_COLUMNS (seed.ts).
 */
const PREVIOUS_HEAD = '0028_studio_video_jobs';
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLE_NAMES.includes(getTableName(t)));

describe('migration 0029 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(creativeDocuments)).rejects.toThrow(); // archived_at not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds archived_at (null on every existing document), leaving every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const docs = await tdb.db.select().from(creativeDocuments);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.archivedAt === null)).toBe(true);
  });

  it('the seeded document reads through the new code as in use and stays in the default index', async () => {
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
      correlationId: 'corr_roll_forward_0029',
    };
    const documentId = tenantA.ids['creativeDocumentId'] as string;
    const got = await runInTenant(ctx, () => creativeService.documents.get(owner, { documentId }));
    expect(got).toMatchObject({ archivedAt: null, kind: 'graphic' });
    const [row] = await tdb.db.select().from(creativeDocuments).where(eq(creativeDocuments.id, documentId));
    const listed = await runInTenant(ctx, () =>
      creativeService.documents.list(owner, { brandId: row!.brandId, page: { limit: 200 } }),
    );
    expect(listed.items.map((d) => d.id)).toContain(documentId);
  });
});
