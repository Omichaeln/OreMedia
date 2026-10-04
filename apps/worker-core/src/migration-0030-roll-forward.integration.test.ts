import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { tenants } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { accessService, resolveTenantContext, tenantKinds } from '@oremedia/module-access';
import {
  LATER_TABLE_NAMES,
  seedTwoTenants,
  snapshotColumns,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src/seed';

/**
 * Migration 0030 (demo workspace stage 1: tenant kind): on a database populated at the previous head the migration
 * adds tenants.kind NOT NULL DEFAULT 'live'; every existing row is unchanged, every existing company reads as live
 * through the new code (tenant resolution, tenantKinds, access.listCompanies). The column is in LATER_COLUMNS
 * (seed.ts).
 */
const PREVIOUS_HEAD = '0029_document_archive';
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLE_NAMES.includes(getTableName(t)));

describe('migration 0030 rolls forward on a populated database (tenant kind)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
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
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(tenants)).rejects.toThrow(); // kind not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds kind (live on every existing company), leaving every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const rows = await tdb.db.select().from(tenants);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((t) => t.kind === 'live')).toBe(true);
  });

  it('the seeded companies read as live through tenant resolution, tenantKinds and the company list', async () => {
    const person = {
      kind: 'user' as const,
      userId: tenantA.ownerUserId,
      sessionId: 'ses_unused',
      selectedTenantId: null,
    };
    const resolved = await resolveTenantContext(person, tenantA.tenantId, 'corr_roll_forward_0030');
    expect(resolved.tenantKind).toBe('live');
    expect(await tenantKinds.of(tenantB.tenantId, 'corr_roll_forward_0030')).toBe('live');
    const companies = await accessService.listCompanies(tenantA.ownerUserId, 'corr_roll_forward_0030');
    expect(companies.map((c) => c.kind)).toEqual(['live']);
  });
});
