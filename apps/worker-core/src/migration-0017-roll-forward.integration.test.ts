import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import {
  brandDestinations,
  destinationReportRows,
  seoAuditPages,
  seoAuditRuns,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  FixtureSourceAdapter,
  configureDestinationSources,
  configureSourceAvailability,
  createDestinationRuntime,
  destinationReportService,
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
 * Ledger 1.g4 for migration 0017 (R2-1 part B report rows): on a database populated at the previous head (0016)
 * the migration only adds `destination_report_rows`; every existing row is unchanged and the new table is empty.
 * On the migrated data the report runtime reads a destination registered before the migration (with a grant
 * sealed then) through the fixture source, stores its rows, and the read model summarises them.
 */
const PREVIOUS_HEAD = '0016_destination_connect';
const NEW_TABLES: MySqlTable[] = [destinationReportRows];
/** Added by migration 0019 (R2-4); absent at both heads this suite compares. */
const LATER_TABLES: MySqlTable[] = [seoAuditRuns, seoAuditPages];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));

describe('migration 0017 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';
  let destinationBefore = '';

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
    await expect(tdb.db.select().from(destinationReportRows)).rejects.toThrow(); // not there at 0016
    configureCredentialBroker({ kms: new LocalKms('roll-forward-0017-master-secret-0123456789') });
    // A connected destination at the previous head: its grant sealed by the broker, its policy allowing reads.
    destinationBefore = `dst_${tenantA.tenantId.slice(-20)}`;
    const ctx = {
      tenantId: tenantA.tenantId,
      actor: { kind: 'user' as const, id: tenantA.ownerUserId },
      brandIds: 'all' as const,
      correlationId: 'corr_roll_forward_0017',
    };
    const credentialRefId = await runInTenant(ctx, () =>
      withTransaction(async (tx) =>
        credentialBroker.createCredentialRef(
          await credentialBroker.seal(tenantA.tenantId, destinationBefore, {
            accessToken: 'at_before_0017',
            refreshToken: 'rt_before_0017',
          }),
          tx,
        ),
      ),
    );
    await tdb.db.execute(
      `insert into brand_destinations (id, tenant_id, brand_id, kind, external_id, display_name, owner_user_id, credential_ref_id, token_expires_at, granted_scopes, health, health_checked_at, capability_version, status, created_at, updated_at, version) values ('${destinationBefore}', '${tenantA.tenantId}', '${tenantA.brandIds[0]}', 'ga4_property', 'properties/777', 'Acme web', '${tenantA.ownerUserId}', '${credentialRefId}', null, '[]', 'healthy', now(3), 1, 'active', now(3), now(3), 0)`,
    );
    await tdb.db.execute(
      `insert into source_use_policies (id, tenant_id, brand_id, destination_kind, data_type, allowed_uses, retention_days, version, reviewed_at, review_due_at, reviewed_by_id, created_at, updated_at) values ('sup_${tenantA.tenantId.slice(-20)}', '${tenantA.tenantId}', '${tenantA.brandIds[0]}', 'ga4_property', 'ga4.reports', '["read"]', null, 1, now(3), date_add(now(3), interval 90 day), '${tenantA.ownerUserId}', now(3), now(3))`,
    );
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the table, empty, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(destinationReportRows)).toEqual([]);
    const rows = await tdb.db
      .select()
      .from(brandDestinations)
      .where(eq(brandDestinations.id, destinationBefore));
    expect(rows[0]).toMatchObject({ kind: 'ga4_property', health: 'healthy' });
    expect(await tdb.db.select().from(sourceUsePolicies)).toHaveLength(1);
  });

  it('the report runtime reads the destination connected before the migration and the summary reads the rows back', async () => {
    const fixture = new FixtureSourceAdapter('ga4_property');
    fixture.reportRows = {
      'ga4.engagement': ['2026-09-26', '2026-09-27', '2026-09-28'].map((date, i) => ({
        date,
        dimensions: {},
        metrics: { sessions: 100 + i, engagedSessions: 50, keyEvents: 1 },
      })),
    };
    configureDestinationSources({ registry: new SourceRegistry().register(fixture) });
    configureSourceAvailability(() => true); // seedTwoTenants composed the api, whose env enables no source
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    const now = '2026-09-29T04:00:00.000Z';
    const platform = {
      tenantId: tenantA.tenantId,
      actor: { kind: 'platform_operator' as const, id: 'destination-report-sweep' },
      brandIds: 'all' as const,
      correlationId: 'corr_roll_forward_0017',
    };
    const runtime = createDestinationRuntime({ now: () => new Date(now) }).reports;
    const input = { ...platform, destinationId: destinationBefore, now };
    const plan = await runInTenant(platform, () => runtime.planDestinationReports(input));
    expect(plan.outcome).toBe('planned');
    if (plan.outcome !== 'planned') return;
    const engagement = plan.reports.find((r) => r.reportKey === 'ga4.engagement')!;
    const fetched = await runInTenant(platform, () =>
      runtime.fetchDestinationReport({ ...input, ...engagement }),
    );
    expect(fetched).toEqual({ outcome: 'fetched', rows: 3, days: 3 });
    expect(fixture.reportCalls[0]?.accessToken).toBe('at_before_0017'); // the grant sealed at 0016 was opened
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
    const summary = await runInTenant({ ...platform, actor: { kind: 'user', id: owner.id } }, () =>
      destinationReportService.summary(owner, {
        brandId: tenantA.brandIds[0],
        destinationId: destinationBefore,
        windowStart: '2026-09-22T00:00:00.000Z',
        windowEnd: '2026-09-28T23:59:59.999Z',
      }),
    );
    expect(summary.policy.allowed).toBe(true);
    const entry = summary.reports.find((r) => r.reportKey === 'ga4.engagement');
    expect(entry?.current).toMatchObject({
      days: 3,
      rows: 3,
      metrics: { sessions: 303, engagedSessions: 150 },
    });
  });
});
