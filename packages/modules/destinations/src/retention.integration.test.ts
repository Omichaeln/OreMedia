import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { SEO_AUDIT_KEEP_RUNS } from '@oremedia/contracts/seo-audit';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import {
  brandDestinations,
  destinationReportRows,
  seoAuditPages,
  seoAuditRuns,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { clearRetentionHandlers, registerRetentionHandler, retention } from '@oremedia/module-operations';
import { sourceRegistry } from '@oremedia/providers';
import { configureSourceAvailability } from './hooks';
import { destinationRetention } from './retention';
import { configureDestinationSources } from './sources';

/**
 * RA-05 against MySQL 8: the platform retention sweep expires destination report rows and SEO audit runs on its
 * own clock, from the brand's source-use policy (D-17), without any fetch: a disconnected destination, a kind
 * this deployment disabled or never certified, one whose last read failed, one the registry does not know, a
 * policy whose `retain` was revoked. Dry run counts and removes nothing; another tenant's rows are never touched.
 */
const NOW = new Date('2026-10-02T03:00:00.000Z');
const DAY_MS = 86_400_000;
const RETENTION_ACTOR = { kind: 'platform_operator' as const, id: 'retention-sweep' };
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: RETENTION_ACTOR,
  brandIds: 'all',
  correlationId: 'corr_retention_test',
});
const sweep = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const dayKey = (days: number) => daysAgo(days).toISOString().slice(0, 10);

describe('destination retention in the platform sweep against MySQL 8 (RA-05)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const owner = newId('user');
  const disconnected = newId('destination'); // GA4 (uncertified in the real registry), disconnected, no credential
  const disabled = newId('destination'); // Search Console, active with a credential, kind disabled here, last read failed
  const unknownKind = newId('destination'); // a kind the source registry declares no reports for
  const retained = newId('destination'); // GA4 under a `retain` policy of 30 days
  const site = newId('destination'); // a website, disconnected, with audit runs
  const foreign = newId('destination'); // another tenant's GA4 with expired rows
  const policyRetained = newId('sourceUsePolicy');
  const runIds = [1, 2, 3, 4, 5, 6].map(() => newId('seoAuditRun'));
  const runningRun = newId('seoAuditRun');

  const destination = (
    id: string,
    tenantId: string,
    brandId: string,
    kind: string,
    extra: Partial<typeof brandDestinations.$inferInsert> = {},
  ): typeof brandDestinations.$inferInsert => ({
    id,
    tenantId,
    brandId,
    kind,
    externalId: `ext-${id.slice(-8)}`,
    displayName: id,
    ownerUserId: owner,
    credentialRefId: null,
    tokenExpiresAt: null,
    grantedScopes: [],
    health: 'unknown',
    healthCheckedAt: null,
    capabilityVersion: 1,
    status: 'active',
    ...extra,
  });
  const reportRow = (
    tenantId: string,
    brandId: string,
    destinationId: string,
    reportKey: string,
    ageDays: number,
  ): typeof destinationReportRows.$inferInsert => ({
    id: newId('destinationReportRow'),
    tenantId,
    brandId,
    destinationId,
    reportKey,
    date: dayKey(ageDays),
    dimensions: { q: `d${ageDays}` },
    dimensionKey: hashCanonical({ q: `d${ageDays}` }),
    metrics: { clicks: 1 },
    fetchedAt: daysAgo(ageDays - 1),
    source: 'provider',
  });
  const policy = (
    brandId: string,
    destinationKind: string,
    dataType: string,
    allowedUses: string[],
    retentionDays: number | null,
    id = newId('sourceUsePolicy'),
  ): typeof sourceUsePolicies.$inferInsert => ({
    id,
    tenantId: tenantA,
    brandId,
    destinationKind,
    dataType,
    allowedUses,
    retentionDays,
    version: 1,
    reviewedAt: NOW,
    reviewDueAt: daysAgo(-60),
    reviewedById: owner,
  });
  const rowDays = async (destinationId: string) =>
    (
      await tdb.db
        .select({ date: destinationReportRows.date })
        .from(destinationReportRows)
        .where(eq(destinationReportRows.destinationId, destinationId))
        .orderBy(asc(destinationReportRows.date))
    ).map((r) => r.date);
  const runsOf = async (destinationId: string) =>
    (
      await tdb.db
        .select({ id: seoAuditRuns.id })
        .from(seoAuditRuns)
        .where(eq(seoAuditRuns.destinationId, destinationId))
    ).map((r) => r.id);
  const auditsOf = (action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, action)))
      .orderBy(asc(auditEvents.createdAt));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'retention-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'retention-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: owner, email: 'retention-test@example.test', name: 'Ret' });
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    // The real registry: every source adapter uncertified (certifiedAt null), so no read could ever be planned.
    configureDestinationSources({ registry: sourceRegistry });
    configureSourceAvailability((kind) => kind !== 'search_console_site'); // OREMEDIA_DISABLED_SOURCES
    await tdb.db.insert(brandDestinations).values([
      destination(disconnected, tenantA, brandA, 'ga4_property', { status: 'disconnected' }),
      destination(disabled, tenantA, brandA, 'search_console_site', {
        credentialRefId: newId('credentialRef'),
        health: 'unreachable',
        healthCheckedAt: daysAgo(1),
      }),
      destination(unknownKind, tenantA, brandA, 'discord_webhook'),
      destination(retained, tenantA, brandA2, 'ga4_property', { credentialRefId: newId('credentialRef') }),
      destination(site, tenantA, brandA, 'cms_site', { status: 'disconnected' }),
      destination(foreign, tenantB, brandB, 'ga4_property'),
    ]);
    await tdb.db
      .insert(sourceUsePolicies)
      .values([
        policy(brandA, 'ga4_property', 'ga4.reports', ['read'], null),
        policy(brandA2, 'ga4_property', 'ga4.reports', ['read', 'retain'], 30, policyRetained),
        policy(brandA, 'cms_site', 'cms.audit', ['read'], null),
      ]);
    await tdb.db
      .insert(destinationReportRows)
      .values([
        reportRow(tenantA, brandA, disconnected, 'ga4.acquisition', 12),
        reportRow(tenantA, brandA, disconnected, 'ga4.acquisition', 2),
        reportRow(tenantA, brandA, disabled, 'gsc.queries', 12),
        reportRow(tenantA, brandA, disabled, 'gsc.queries', 2),
        reportRow(tenantA, brandA, unknownKind, 'x.report', 12),
        reportRow(tenantA, brandA, unknownKind, 'x.report', 2),
        reportRow(tenantA, brandA2, retained, 'ga4.acquisition', 40),
        reportRow(tenantA, brandA2, retained, 'ga4.acquisition', 20),
        reportRow(tenantA, brandA2, retained, 'ga4.acquisition', 2),
        reportRow(tenantB, brandB, foreign, 'ga4.acquisition', 12),
      ]);
    await tdb.db.insert(seoAuditRuns).values([
      ...runIds.map((id, i) => ({
        id,
        tenantId: tenantA,
        brandId: brandA,
        destinationId: site,
        origin: 'https://site.example',
        trigger: 'scheduled' as const,
        startedAt: daysAgo(30 - i),
        finishedAt: daysAgo(30 - i),
        outcome: 'completed' as const,
      })),
      {
        id: runningRun,
        tenantId: tenantA,
        brandId: brandA,
        destinationId: site,
        origin: 'https://site.example',
        trigger: 'scheduled',
        startedAt: daysAgo(40),
        outcome: 'running',
      },
    ]);
    await tdb.db.insert(seoAuditPages).values(
      [runIds[0]!, runIds[5]!].map((runId) => ({
        id: newId('seoAuditPage'),
        tenantId: tenantA,
        brandId: brandA,
        runId,
        url: 'https://site.example/',
        urlHash: hashCanonical({ url: 'https://site.example/' }),
        depth: 0,
        status: 200,
        fetchedAt: NOW,
      })),
    );
  });
  afterAll(async () => {
    clearRetentionHandlers();
    await tdb?.drop();
  });

  it('a dry run counts the rows and runs past their retention and removes nothing', async () => {
    expect(await sweep(tenantA, (tx) => destinationRetention.pruneReports(NOW, true, tx))).toBe(4);
    expect(await sweep(tenantA, (tx) => destinationRetention.pruneSeoAudits(NOW, true, tx))).toBe(
      runIds.length - SEO_AUDIT_KEEP_RUNS,
    );
    expect(await rowDays(disconnected)).toHaveLength(2);
    expect(await runsOf(site)).toHaveLength(runIds.length + 1);
    expect(await auditsOf('destination.report.pruned')).toHaveLength(0);
  });

  it('report rows expire by the cache for a disconnected, disabled, failed or unknown destination and by the policy with `retain`, without any fetch', async () => {
    expect(await sweep(tenantA, (tx) => destinationRetention.pruneReports(NOW, false, tx))).toBe(4);
    expect(await rowDays(disconnected)).toEqual([dayKey(2)]); // 7-day cache: the 12-day-old day went
    expect(await rowDays(disabled)).toEqual([dayKey(2)]);
    expect(await rowDays(unknownKind)).toEqual([dayKey(2)]);
    expect(await rowDays(retained)).toEqual([dayKey(20), dayKey(2)]); // retain 30 days: the 40-day-old day went
    expect(await rowDays(foreign)).toEqual([dayKey(12)]); // another tenant: untouched
    const audits = await auditsOf('destination.report.pruned');
    expect(audits.map((a) => a.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          count: 1,
          kind: 'ga4_property',
          reason: `cutoff=${dayKey(7)},retentionDays=7`,
        }),
        expect.objectContaining({ count: 1, kind: 'search_console_site', scope: 'gsc.reports' }),
        expect.objectContaining({ count: 1, kind: 'discord_webhook', scope: 'discord_webhook.reports' }),
        expect.objectContaining({
          count: 1,
          kind: 'ga4_property',
          reason: `cutoff=${dayKey(30)},retentionDays=30`,
        }),
      ]),
    );
    expect(audits.every((a) => a.actorKind === 'platform_operator' && a.actorId === 'retention-sweep')).toBe(
      true,
    );
    // A second pass finds nothing past its retention.
    expect(await sweep(tenantA, (tx) => destinationRetention.pruneReports(NOW, false, tx))).toBe(0);
  });

  it('a revoked `retain` falls back to the cache on the next sweep', async () => {
    await tdb.db
      .update(sourceUsePolicies)
      .set({ allowedUses: ['read'], version: 2 })
      .where(eq(sourceUsePolicies.id, policyRetained));
    expect(await sweep(tenantA, (tx) => destinationRetention.pruneReports(NOW, false, tx))).toBe(1);
    expect(await rowDays(retained)).toEqual([dayKey(2)]); // the 20-day-old day went with the 7-day cache
  });

  it('audit runs of a disconnected website keep the last runs (pages go with them), a running run stays, then expire by the policy', async () => {
    expect(await sweep(tenantA, (tx) => destinationRetention.pruneSeoAudits(NOW, false, tx))).toBe(
      runIds.length - SEO_AUDIT_KEEP_RUNS,
    );
    expect((await runsOf(site)).sort()).toEqual([...runIds.slice(-SEO_AUDIT_KEEP_RUNS), runningRun].sort());
    expect(await tdb.db.select().from(seoAuditPages).where(eq(seoAuditPages.runId, runIds[0]!))).toHaveLength(
      0,
    );
    expect(await tdb.db.select().from(seoAuditPages).where(eq(seoAuditPages.runId, runIds[5]!))).toHaveLength(
      1,
    );
    expect((await auditsOf('seo_audit.pruned'))[0]?.metadata).toMatchObject({
      count: runIds.length - SEO_AUDIT_KEEP_RUNS,
      reason: `keep=${SEO_AUDIT_KEEP_RUNS}`,
    });
    await tdb.db
      .update(sourceUsePolicies)
      .set({ allowedUses: ['read', 'retain'], retentionDays: 20, version: 2 })
      .where(and(eq(sourceUsePolicies.brandId, brandA), eq(sourceUsePolicies.dataType, 'cms.audit')));
    expect(await sweep(tenantA, (tx) => destinationRetention.pruneSeoAudits(NOW, false, tx))).toBe(
      SEO_AUDIT_KEEP_RUNS,
    ); // every completed run started 25 to 28 days ago
    expect(await runsOf(site)).toEqual([runningRun]);
  });

  it('runs under the sweep as a `source_use_policy` class: applied on every sweep, audited per handler', async () => {
    clearRetentionHandlers();
    registerRetentionHandler({
      name: 'destinations.reports',
      dataClass: 'source_use_policy',
      run: (now, dryRun, tx) => destinationRetention.pruneReports(now, dryRun, tx),
    });
    await tdb.db
      .insert(destinationReportRows)
      .values(reportRow(tenantA, brandA, disconnected, 'ga4.acquisition', 9));
    const later = new Date(NOW.getTime() + DAY_MS);
    const results = await sweep(tenantA, (tx) => retention.apply(RETENTION_ACTOR, later, false, tx));
    expect(results).toEqual([
      {
        dataClass: 'source_use_policy',
        handler: 'destinations.reports',
        retentionDays: null,
        cutoff: later.toISOString(),
        rows: 1,
      },
    ]);
    expect(await rowDays(disconnected)).toEqual([dayKey(2)]);
    expect((await auditsOf('retention.apply')).map((a) => a.metadata)).toEqual([
      expect.objectContaining({ scope: 'destinations.reports', count: 1 }),
    ]);
  });
});
