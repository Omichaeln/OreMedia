import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { authEvents, externalIdentities, users } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { accessService } from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0003 (D-03 Google sign-in): on a database populated at the previous head (0002) the
 * migration only adds `external_identities` and `auth_events`; every existing row is unchanged, the new tables are
 * empty, and an existing user signs in with Google against the migrated data (linked by verified email).
 */
const PREVIOUS_HEAD = '0002_provider_jobs_routing_previews_ledger_idempotency';
const NEW_TABLES: MySqlTable[] = [externalIdentities, authEvents];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t));

describe('migration 0003 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(externalIdentities)).rejects.toThrow(); // not there at 0002
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the two tables, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    for (const t of NEW_TABLES) expect(await tdb.db.select().from(t)).toEqual([]);
  });

  it('an existing user signs in with Google on the migrated data', async () => {
    const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
    const result = await accessService.signInWithExternalIdentity(
      {
        provider: 'google',
        subject: 'google-roll-forward',
        email: owner?.email,
        emailVerified: true,
        hostedDomain: 'example.test',
      },
      { allowedDomains: null },
      { correlationId: 'corr_roll_forward_0003', ipHash: null, userAgentHash: null },
    );
    expect(result).toMatchObject({ ok: true, userId: tenantA.ownerUserId });
    expect(
      await tdb.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, owner?.id as string)),
    ).toHaveLength(1);
  });
});
