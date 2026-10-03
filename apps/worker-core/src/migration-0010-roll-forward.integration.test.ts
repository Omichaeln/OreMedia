import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type Tx } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { studioGenerationJobs } from '@oremedia/db/schema/creative';
import { passwordSetupTokens } from '@oremedia/db/schema/access';
import {
  channelConnections,
  pendingChannelGrants,
  publicationRemoteChanges,
} from '@oremedia/db/schema/publishing';
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
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  configureChannelActivation,
  registerProviderClients,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';
import { composeModules } from './composition';

/**
 * Ledger 1.g4 for migration 0010 (choosing the account on connect, spec 14.7): on a database populated at the
 * previous head (0009) the migration only adds `pending_channel_grants`; every existing row is unchanged, the new
 * table is empty, and a connect flow whose login manages several accounts offers them on the migrated data (an
 * account already connected to another brand is not offered) and connects the one chosen.
 */
const PREVIOUS_HEAD = '0009_brand_classification';
const NEW_TABLES: MySqlTable[] = [pendingChannelGrants];
/** Added by later migrations (0011 and 0013: their migration-*-roll-forward tests). */
const LATER_TABLES: MySqlTable[] = [
  publicationRemoteChanges,
  passwordSetupTokens,
  planItems,
  brandDestinations,
  sourceUsePolicies,
  pendingDestinationGrants,
  destinationReportRows,
  seoAuditRuns,
  seoAuditPages,
  seoFindingWork,
  studioGenerationJobs, // 0027
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0010 rolls forward on a populated database (ledger 1.g4)', () => {
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
    await expect(tdb.db.select().from(pendingChannelGrants)).rejects.toThrow(); // not there at 0009
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the table, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(pendingChannelGrants)).toEqual([]);
  });

  it('a login with several accounts is offered the ones this brand may connect, and the chosen one connects', async () => {
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
    const inTenant = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant(
        {
          tenantId: tenantA.tenantId,
          actor: { kind: 'user', id: owner.id },
          brandIds: 'all',
          correlationId: 'corr_roll_forward_0010',
        },
        () => withTransaction(fn),
      );
    const [seeded] = await tdb.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.tenantId, tenantA.tenantId));
    const registry = new ProviderRegistry();
    const fixture = new FixtureProviderAdapter();
    registry.register(fixture);
    composeModules();
    configurePublishingProviders({ registry });
    configureCredentialBroker({ kms: new LocalKms('roll-forward-0010-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'c', clientSecret: 's' }));
    configureChannelActivation(null); // the composition root read an env with no PROVIDER_FIXTURE_PROVIDER_* refs
    fixture.grant = {
      ...fixture.grant,
      remoteAccountId: 'acct_rf_1',
      displayName: 'Page one',
      alternatives: [
        { remoteAccountId: 'acct_rf_2', displayName: 'Page two' },
        { remoteAccountId: seeded!.remoteAccountId, displayName: 'Seeded page' }, // connected to brand 1
      ],
    };
    const brandId = tenantA.brandIds[1];
    const started = await inTenant((tx) =>
      channelService.connect.start(
        owner,
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    const choice = await inTenant((tx) =>
      channelService.connect.complete(owner, { state: started.state, code: 'good' }, tx),
    );
    if (choice.outcome !== 'choose') throw new Error('expected a choice');
    expect(choice.options.map((o) => o.remoteAccountId)).toEqual(['acct_rf_1', 'acct_rf_2']);
    const connected = await inTenant((tx) =>
      channelService.connect.select(owner, { pendingId: choice.pendingId, remoteAccountId: 'acct_rf_2' }, tx),
    );
    expect(connected).toMatchObject({ outcome: 'connected', brandId, remoteAccountId: 'acct_rf_2' });
    expect(await tdb.db.select().from(pendingChannelGrants)).toEqual([]);
    expect(
      await tdb.db
        .select()
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.tenantId, tenantA.tenantId),
            eq(channelConnections.remoteAccountId, 'acct_rf_1'),
          ),
        ),
    ).toEqual([]);
  });
});
