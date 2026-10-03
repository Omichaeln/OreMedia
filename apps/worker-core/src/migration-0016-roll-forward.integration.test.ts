import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type Tx } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { studioGenerationJobs } from '@oremedia/db/schema/creative';
import {
  brandDestinations,
  destinationReportRows,
  pendingDestinationGrants,
  seoAuditPages,
  seoAuditRuns,
  seoFindingWork,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  FixtureSourceAdapter,
  configureDestinationSources,
  configureSourceAvailability,
  destinationService,
} from '@oremedia/module-destinations';
import {
  LocalKms,
  configureCredentialBroker,
  credentialBroker,
  registerProviderClients,
} from '@oremedia/module-publishing';
import { SourceRegistry } from '@oremedia/providers';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0016 (R2-1 destination connect): on a database populated at the previous head (0015)
 * the migration adds `pending_destination_grants` and `brand_destinations.token_expires_at`; every existing row is
 * unchanged (a destination registered before reads back with no expiry), the new table is empty, and on the
 * migrated data a person connects a source through the flow, chooses a target and the destination holds its
 * sealed grant. The migration's `source_use_policies.version` default change (1 → 0) only reconciles the schema
 * helper the R2-0 review switched to; it changes no behaviour (the service writes 1 on the first record).
 */
const PREVIOUS_HEAD = '0015_brand_destinations';
const NEW_TABLES: MySqlTable[] = [pendingDestinationGrants];
/** Added by later migrations (0017). */
const LATER_TABLES: MySqlTable[] = [
  destinationReportRows,
  seoAuditRuns,
  seoAuditPages,
  seoFindingWork,
  studioGenerationJobs,
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0016 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';
  let destinationBefore = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      // token_expires_at is in LATER_COLUMNS (seed.ts), so the snapshot names only what exists at 0015.
      out[getTableName(table)] = await tdb.db.select(snapshotColumns(table)).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(pendingDestinationGrants)).rejects.toThrow(); // not there at 0015
    // A destination registered at the previous head, without the column the migration adds.
    destinationBefore = `dst_${tenantA.tenantId.slice(-20)}`;
    await tdb.db.execute(
      `insert into brand_destinations (id, tenant_id, brand_id, kind, external_id, display_name, owner_user_id, credential_ref_id, granted_scopes, health, health_checked_at, capability_version, status, created_at, updated_at, version) values ('${destinationBefore}', '${tenantA.tenantId}', '${tenantA.brandIds[0]}', 'cms_site', 'https://acme.example', 'Acme site', '${tenantA.ownerUserId}', null, '[]', 'unknown', null, 1, 'active', now(3), now(3), 0)`,
    );
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the table and the column, empty and null, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(pendingDestinationGrants)).toEqual([]);
    const rows = await tdb.db
      .select()
      .from(brandDestinations)
      .where(eq(brandDestinations.id, destinationBefore));
    expect(rows[0]).toMatchObject({ kind: 'cms_site', tokenExpiresAt: null });
  });

  it('a person connects a source, chooses a target and the destination holds its sealed grant', async () => {
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
    const brandId = tenantA.brandIds[0];
    const fixture = new FixtureSourceAdapter('search_console_site');
    fixture.targets = [{ externalId: 'sc-domain:acme.example', displayName: 'sc-domain:acme.example' }];
    configureDestinationSources({ registry: new SourceRegistry().register(fixture) });
    configureSourceAvailability(() => true); // seedTwoTenants composed the api, whose env enables no source
    configureCredentialBroker({ kms: new LocalKms('roll-forward-0016-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    const run = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant(
        {
          tenantId: tenantA.tenantId,
          actor: { kind: 'user', id: owner.id },
          brandIds: 'all',
          correlationId: 'corr_roll_forward_0016',
        },
        () => withTransaction(fn),
      );
    const started = await run((tx) =>
      destinationService.connect.start(
        owner,
        { brandId, kind: 'search_console_site', redirectUri: 'https://app.example/connect/callback' },
        tx,
      ),
    );
    expect(new URL(started.url).searchParams.get('access_type')).toBe('offline');
    const choice = await run((tx) =>
      destinationService.connect.complete(owner, { state: started.state, code: 'good' }, tx),
    );
    expect(choice.targets).toEqual(fixture.targets);
    const registered = await run((tx) =>
      destinationService.connect.select(
        owner,
        { pendingId: choice.pendingId, externalId: 'sc-domain:acme.example' },
        tx,
      ),
    );
    expect(registered).toMatchObject({ kind: 'search_console_site', health: 'healthy', status: 'active' });
    const rows = await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, registered.id));
    expect(rows[0]?.credentialRefId).toBeTruthy();
    expect(rows[0]?.tokenExpiresAt).toBeInstanceOf(Date);
    const opened = await runInTenant(
      {
        tenantId: tenantA.tenantId,
        actor: { kind: 'user', id: owner.id },
        brandIds: 'all',
        correlationId: 'corr_roll_forward_0016',
      },
      () =>
        credentialBroker.withCredentialRef(
          {
            tenantId: tenantA.tenantId,
            credentialRefId: rows[0]!.credentialRefId!,
            aad: `${tenantA.tenantId}:${registered.id}`,
          },
          async (creds) => creds.refreshToken,
        ),
    );
    expect(opened).toBe('rt_fixture_src');
    expect(await tdb.db.select().from(pendingDestinationGrants)).toEqual([]);
  });
});
