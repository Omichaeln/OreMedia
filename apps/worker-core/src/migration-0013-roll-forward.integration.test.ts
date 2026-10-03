import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { passwordSetupTokens, users } from '@oremedia/db/schema/access';
import { planItems } from '@oremedia/db/schema/content';
import {
  brandDestinations,
  destinationReportRows,
  pendingDestinationGrants,
  seoAuditPages,
  seoAuditRuns,
  sourceUsePolicies,
  seoFindingWork,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { accessService, hashToken } from '@oremedia/module-access';
import {
  seedTwoTenants,
  snapshotColumns,
  type SeededTenant,
  LATER_TABLE_NAMES,
} from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0013 (password sign-in): on a database populated at the previous head (0012) the
 * migration only adds `password_setup_tokens` and users.password_origin (null); every existing row is otherwise
 * unchanged (users.password_hash already existed and stays empty), the new table is empty, and an owner issues a setup link that a member of the migrated data
 * redeems and then signs in with.
 */
const PREVIOUS_HEAD = '0012_comment_replies';
const NEW_TABLES: MySqlTable[] = [passwordSetupTokens];
/** Added by later migrations (0014). */
const LATER_TABLES: MySqlTable[] = [
  planItems,
  brandDestinations,
  sourceUsePolicies,
  pendingDestinationGrants,
  destinationReportRows,
  seoAuditRuns,
  seoAuditPages,
  seoFindingWork,
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t))
  .filter((t) => !LATER_TABLE_NAMES.includes(getTableName(t)));

describe('migration 0013 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(passwordSetupTokens)).rejects.toThrow(); // not there at 0012
    await expect(tdb.db.select({ o: users.passwordOrigin }).from(users)).rejects.toThrow(); // nor the column
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the table, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(passwordSetupTokens)).toEqual([]);
    expect(
      (await tdb.db.select().from(users)).every((u) => u.passwordHash === null && u.passwordOrigin === null),
    ).toBe(true);
  });

  it('an owner issues a setup link on the migrated data; the member sets a password and signs in with it', async () => {
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
    const link = await runInTenant(
      {
        tenantId: tenantA.tenantId,
        actor: { kind: 'user', id: owner.id },
        brandIds: 'all',
        correlationId: 'corr_roll_forward_0013',
      },
      () =>
        withTransaction((tx) =>
          accessService.issuePasswordSetup(
            owner,
            { membershipId: tenantA.creatorMembershipId },
            'https://app.example.test',
            tx,
          ),
        ),
    );
    expect(link.url).toMatch(/^https:\/\/app\.example\.test\/set-password#token=pst_/);
    const token = link.url.slice(link.url.indexOf('#token=') + '#token='.length);
    expect(await tdb.db.select().from(passwordSetupTokens)).toMatchObject([
      {
        tenantId: tenantA.tenantId,
        userId: tenantA.creatorUserId,
        tokenHash: hashToken(token),
        usedAt: null,
      },
    ]);

    const origin = { correlationId: 'corr_roll_forward_0013', ipHash: null, userAgentHash: null };
    const password = 'migrated member passphrase';
    const redeemed = await accessService.redeemPasswordSetup(
      { token, password },
      { allowedDomains: null },
      origin,
    );
    expect(redeemed.ok).toBe(true);
    const [creator] = await tdb.db.select().from(users).where(eq(users.id, tenantA.creatorUserId));
    expect(creator?.passwordOrigin).toBe('setup_link');
    const signedIn = await accessService.signInWithPassword(
      { email: creator!.email, password },
      { allowedDomains: null },
      origin,
    );
    expect(signedIn).toMatchObject({ ok: true, userId: tenantA.creatorUserId });
  });
});
