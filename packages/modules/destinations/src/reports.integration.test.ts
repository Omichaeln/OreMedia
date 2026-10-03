import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { runAsPlatform, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { brandDestinations, destinationReportRows } from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { MemoryRateLimiterStore } from '@oremedia/module-operations';
import { LocalKms, configureCredentialBroker, registerProviderClients } from '@oremedia/module-publishing';
import { SourceRegistry, type SourceReportRow } from '@oremedia/providers';
import { configureSourceAvailability } from './hooks';
import { createDestinationReportService } from './reports';
import { MAX_REPORT_PAGES, REPORTING_ZONE_RECHECK_DAYS } from './report-runtime';
import { DestinationReportTargetRepository } from './repositories';
import { createDestinationRuntime } from './runtime';
import { destinationService, sourceUsePolicyService } from './service';
import { configureDestinationSources } from './sources';
import { FixtureSourceAdapter } from './testing/fixture-source';

/**
 * R2-1 part B against MySQL 8: the report runtime (policy gate, incremental plan, paged read through the broker
 * with one refresh on a 401, window replacement, health and audit, retention prune) with the fixture source, and
 * the read model over the rows (D-15 totals, D-14 comparison, freshness, drill-down paging, opportunities).
 * Cross-tenant and cross-brand: NOT_FOUND; a policy that does not allow reads: nothing summarised, rows refused.
 */
const USER = 'usr_reports_test';
const NOW = '2026-09-29T04:00:00.000Z';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_reports',
});
const member = (tenantId: string, role: MembershipRole): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_reports_test',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);
const REPORTS_ACTOR = { kind: 'platform_operator' as const, id: 'destination-report-sweep' };
const asPlatformJob = <T>(tenantId: string, fn: () => Promise<T>) =>
  runInTenant({ tenantId, actor: REPORTS_ACTOR, brandIds: 'all', correlationId: 'corr_sweep' }, fn);
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const day = (offsetFromSep28: number) =>
  new Date(Date.parse('2026-09-28T00:00:00.000Z') + offsetFromSep28 * 86_400_000).toISOString().slice(0, 10);

/** Search Console rows: two queries per day over the last 40 days, "acme login" strong and "acme pricing" weak. */
function gscQueries(): SourceReportRow[] {
  const rows: SourceReportRow[] = [];
  for (let i = -39; i <= 0; i++) {
    rows.push({
      date: day(i),
      dimensions: { query: 'acme login' },
      metrics: { clicks: 30, impressions: 100, ctr: 0.3, position: 1.2 },
    });
    rows.push({
      date: day(i),
      dimensions: { query: 'acme pricing' },
      metrics: { clicks: 2, impressions: 200, ctr: 0.01, position: 8 },
    });
  }
  return rows;
}

describe('destination reports against MySQL 8 (R2-1 part B)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const owner = () => member(tenantA, 'owner');
  const fixture = new FixtureSourceAdapter('search_console_site');
  const ga4 = new FixtureSourceAdapter('ga4_property');
  const lock = new MemoryRateLimiterStore();
  const runtime = createDestinationRuntime({ now: () => new Date(NOW), reportLock: lock });
  const reports = createDestinationReportService({ now: () => new Date(NOW) });
  let siteId = '';
  let propertyId = '';
  const window = { windowStart: '2026-09-22T00:00:00.000Z', windowEnd: '2026-09-28T23:59:59.999Z' };

  async function connect(adapter: FixtureSourceAdapter, externalId: string): Promise<string> {
    adapter.targets = [{ externalId, displayName: externalId }];
    const started = await run(tenantA, (tx) =>
      destinationService.connect.start(
        owner(),
        { brandId: brandA, kind: adapter.key, redirectUri: 'https://app.example/connect/callback' },
        tx,
      ),
    );
    const choice = await run(tenantA, (tx) =>
      destinationService.connect.complete(owner(), { state: started.state, code: 'good' }, tx),
    );
    const registered = await run(tenantA, (tx) =>
      destinationService.connect.select(owner(), { pendingId: choice.pendingId, externalId }, tx),
    );
    return registered.id;
  }
  const setPolicy = (dataType: string, allowedUses: Array<'read' | 'retain'>, retentionDays?: number) =>
    run(tenantA, async (tx) => {
      const existing = (
        await sourceUsePolicyService.list(
          owner(),
          { brandId: brandA, destinationKind: 'search_console_site' },
          tx,
        )
      ).items.find((p) => p.dataType === dataType);
      return sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'search_console_site',
          dataType,
          allowedUses,
          ...(retentionDays ? { retentionDays } : {}),
          reviewDueAt: inDays(60),
          ...(existing ? { expectedVersion: existing.version } : {}),
        },
        tx,
      );
    });
  const auditsOf = (action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, action)))
      .orderBy(asc(auditEvents.createdAt));
  const storedRows = (destinationId: string, reportKey?: string) =>
    tdb.db
      .select()
      .from(destinationReportRows)
      .where(
        and(
          eq(destinationReportRows.destinationId, destinationId),
          ...(reportKey ? [eq(destinationReportRows.reportKey, reportKey)] : []),
        ),
      )
      .orderBy(asc(destinationReportRows.date), asc(destinationReportRows.dimensionKey));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'reports-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'reports-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: USER, email: 'reports-test@example.test', name: 'Rep' });
    await tdb.db.insert(memberships).values({
      id: 'mem_reports_test',
      tenantId: tenantA,
      userId: USER,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configureCredentialBroker({ kms: new LocalKms('reports-test-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureDestinationSources({ registry: new SourceRegistry().register(fixture).register(ga4) });
    configureSourceAvailability(() => true);
    fixture.reportRows = { 'gsc.queries': gscQueries() };
    siteId = await connect(fixture, 'sc-domain:acme.example');
    propertyId = await connect(ga4, 'properties/1001');
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('the sweep lists active destinations of the kinds with reports across tenants, references only', async () => {
    const targets = await runtime.reports.listDestinationReportTargets({ correlationId: 'c', now: NOW });
    expect(targets).toEqual(
      expect.arrayContaining([
        { tenantId: tenantA, destinationId: siteId },
        { tenantId: tenantA, destinationId: propertyId },
      ]),
    );
    expect(Object.keys(targets[0] ?? {})).toEqual(['tenantId', 'destinationId']);
  });

  it('the target listing pages past its batch with a cursor, so a deployment beyond one batch is read whole', async () => {
    const repo = new DestinationReportTargetRepository();
    const kinds = ['search_console_site', 'ga4_property'];
    const seen: string[] = [];
    let pages = 0;
    await runAsPlatform('destination-report-sweep', 'c', async () => {
      for (let cursor: string | undefined; ;) {
        const page = await repo.listTargets(kinds, { limit: 1, cursor });
        pages += 1;
        seen.push(...page.items.map((t) => t.destinationId));
        expect(page.items.length).toBeLessThanOrEqual(1);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(await repo.listTargets([], { limit: 1 })).toEqual({ items: [], nextCursor: null });
    });
    expect(pages).toBe(2);
    expect(seen.sort()).toEqual([siteId, propertyId].sort());
  });

  it('without a policy allowing reads the plan is skipped with an audit and nothing is read (D-17)', async () => {
    const plan = await asPlatformJob(tenantA, () =>
      runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: siteId, now: NOW }),
    );
    expect(plan).toEqual({ outcome: 'skipped', reason: 'no_policy' });
    const skipped = await auditsOf('destination.report.skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.metadata).toMatchObject({
      reason: 'no_policy:gsc.reports',
      kind: 'search_console_site',
    });
    expect(fixture.reportCalls).toEqual([]);
    const summary = await inTenant(tenantA, () =>
      reports.summary(owner(), { brandId: brandA, destinationId: siteId, ...window }),
    );
    expect(summary.policy).toEqual({ allowed: false, reason: 'no_policy', dataType: 'gsc.reports' });
    expect(summary.reports).toEqual([]);
    await expect(
      inTenant(tenantA, () =>
        reports.rows(owner(), {
          brandId: brandA,
          destinationId: siteId,
          reportKey: 'gsc.queries',
          ...window,
        }),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('with a read policy the plan is the first-run 28 days per report, under a per-destination lock', async () => {
    await setPolicy('gsc.reports', ['read']);
    const input = { ...ctx(tenantA), destinationId: siteId, now: NOW };
    const plan = await asPlatformJob(tenantA, () => runtime.reports.planDestinationReports(input));
    expect(plan).toEqual({
      outcome: 'planned',
      reports: ['gsc.queries', 'gsc.pages', 'gsc.countries_devices'].map((reportKey) => ({
        reportKey,
        start: '2026-09-01',
        end: '2026-09-28',
      })),
    });
    expect(await asPlatformJob(tenantA, () => runtime.reports.planDestinationReports(input))).toEqual({
      outcome: 'skipped',
      reason: 'locked',
    });
    await lock.reset(`lock:destination-report-sweep:${tenantA}:${siteId}`);
  });

  it('a fetch pages through the report, stores one row per day and dimensions, and a re-fetch replaces the window', async () => {
    fixture.reportPageSize = 7;
    fixture.reportCalls.length = 0;
    const input = { ...ctx(tenantA), destinationId: siteId, now: NOW, reportKey: 'gsc.queries' };
    const fetched = await asPlatformJob(tenantA, () =>
      runtime.reports.fetchDestinationReport({ ...input, start: '2026-09-01', end: '2026-09-28' }),
    );
    expect(fetched).toEqual({ outcome: 'fetched', rows: 56, days: 28 });
    expect(fixture.reportCalls).toHaveLength(8); // 56 rows in pages of 7
    expect(fixture.reportCalls[0]).toMatchObject({
      externalId: 'sc-domain:acme.example',
      report: 'gsc.queries',
      dateRange: { start: '2026-09-01', end: '2026-09-28' },
      accessToken: 'at_fixture_src',
    });
    expect(fixture.reportCalls[1]?.pageToken).toBe('7');
    const stored = await storedRows(siteId, 'gsc.queries');
    expect(stored).toHaveLength(56);
    expect(stored[0]).toMatchObject({
      brandId: brandA,
      date: '2026-09-01',
      source: 'provider',
      metrics: { clicks: 30, impressions: 100, ctr: 0.3, position: 1.2 },
    });
    expect(new Set(stored.map((r) => r.dimensionKey)).size).toBe(2);
    // The platform revises the last days: the window is replaced, never duplicated, older days untouched.
    fixture.reportPageSize = 1000;
    fixture.reportRows = {
      'gsc.queries': gscQueries().map((r) =>
        r.date >= '2026-09-26' && r.dimensions['query'] === 'acme login'
          ? { ...r, metrics: { ...r.metrics, clicks: 31 } }
          : r,
      ),
    };
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.fetchDestinationReport({ ...input, start: '2026-09-26', end: '2026-09-28' }),
      ),
    ).toEqual({ outcome: 'fetched', rows: 6, days: 3 });
    const after = await storedRows(siteId, 'gsc.queries');
    expect(after).toHaveLength(56);
    expect(after.filter((r) => r.date >= '2026-09-26' && r.metrics['clicks'] === 31)).toHaveLength(3);
    expect(after.filter((r) => r.date < '2026-09-26' && r.metrics['clicks'] === 31)).toHaveLength(0);
    // The next plan reads on from the last stored day minus the latency (3 days), capped by the lock no more.
    const plan = await asPlatformJob(tenantA, () =>
      runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: siteId, now: NOW }),
    );
    expect(plan).toMatchObject({
      outcome: 'planned',
      reports: expect.arrayContaining([{ reportKey: 'gsc.queries', start: '2026-09-25', end: '2026-09-28' }]),
    });
    await lock.reset(`lock:destination-report-sweep:${tenantA}:${siteId}`);
  });

  it('a report beyond the page cap is not stored at all: the fetch is transient and the window stays as it was', async () => {
    fixture.reportPageSize = 1; // 56 rows → 56 pages, over MAX_REPORT_PAGES
    fixture.reportCalls.length = 0;
    const before = await storedRows(siteId, 'gsc.queries');
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.fetchDestinationReport({
          ...ctx(tenantA),
          destinationId: siteId,
          now: NOW,
          reportKey: 'gsc.queries',
          start: '2026-09-01',
          end: '2026-09-28',
        }),
      ),
    ).toEqual({ outcome: 'transient', reason: 'page_cap' });
    expect(fixture.reportCalls).toHaveLength(MAX_REPORT_PAGES);
    expect(await storedRows(siteId, 'gsc.queries')).toEqual(before); // nothing truncated was written
    fixture.reportPageSize = 1000;
  });

  it('a 401 is refreshed once through the daily refresh and the read retried with the new token', async () => {
    fixture.nextReportBehaviours.push({ kind: 'unauthorised' });
    fixture.reportCalls.length = 0;
    fixture.refreshCalls.length = 0;
    const before = await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, siteId));
    const fetched = await asPlatformJob(tenantA, () =>
      runtime.reports.fetchDestinationReport({
        ...ctx(tenantA),
        destinationId: siteId,
        now: NOW,
        reportKey: 'gsc.pages',
        start: '2026-09-26',
        end: '2026-09-28',
      }),
    );
    expect(fetched).toEqual({ outcome: 'fetched', rows: 0, days: 0 }); // no gsc.pages rows scripted
    expect(fixture.refreshCalls).toHaveLength(1);
    expect(fixture.reportCalls.map((c) => c.accessToken)).toEqual([
      'at_fixture_src',
      'at_fixture_src_refreshed',
    ]);
    const after = await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, siteId));
    expect(after[0]?.credentialRefId).not.toBe(before[0]?.credentialRefId); // rotated by the refresh
  });

  it('a quota 429 is rate limited, a 403 unreachable, a transport failure transient; nothing is written', async () => {
    const input = {
      ...ctx(tenantA),
      destinationId: siteId,
      now: NOW,
      reportKey: 'gsc.countries_devices',
      start: '2026-09-26',
      end: '2026-09-28',
    };
    fixture.nextReportBehaviours.push({ kind: 'rate_limited' }, { kind: 'forbidden' }, { kind: 'transient' });
    expect(await asPlatformJob(tenantA, () => runtime.reports.fetchDestinationReport(input))).toEqual({
      outcome: 'rate_limited',
      retryAfterMs: 60_000,
    });
    expect(await asPlatformJob(tenantA, () => runtime.reports.fetchDestinationReport(input))).toEqual({
      outcome: 'unreachable',
      reason: 'reconnect_required',
    });
    expect(await asPlatformJob(tenantA, () => runtime.reports.fetchDestinationReport(input))).toEqual({
      outcome: 'transient',
      reason: 'transport_after_send',
    });
    expect(await storedRows(siteId, 'gsc.countries_devices')).toEqual([]);
  });

  it('finish records the outcome with counts and moves health through the row lock; healthy again later', async () => {
    const input = { ...ctx(tenantA), destinationId: siteId, now: NOW };
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.finishDestinationReports({
          ...input,
          health: 'degraded',
          fetched: [{ reportKey: 'gsc.queries', rows: 6 }],
          reason: 'rate_limited',
        }),
      ),
    ).toEqual({ health: 'degraded' });
    let row = (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, siteId)))[0];
    expect(row?.health).toBe('degraded');
    const fetchedAudits = await auditsOf('destination.report.fetched');
    expect(fetchedAudits.at(-1)).toMatchObject({
      decision: 'denied',
      actorKind: 'platform_operator',
      metadata: {
        count: 6,
        scope: 'gsc.queries',
        reason: 'rate_limited',
        fromState: 'healthy',
        toState: 'degraded',
      },
    });
    expect((await auditsOf('destination.health')).at(-1)?.metadata).toMatchObject({
      fromState: 'healthy',
      toState: 'degraded',
    });
    await asPlatformJob(tenantA, () =>
      runtime.reports.finishDestinationReports({
        ...input,
        health: 'healthy',
        fetched: [{ reportKey: 'gsc.queries', rows: 6 }],
        reason: null,
      }),
    );
    row = (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, siteId)))[0];
    expect(row?.health).toBe('healthy');
  });

  it('summary: D-15 totals per report, the previous window with the D-14 sample, freshness from the latest day', async () => {
    const summary = await inTenant(tenantA, () =>
      reports.summary(owner(), { brandId: brandA, destinationId: siteId, ...window }),
    );
    expect(summary).toMatchObject({
      brandId: brandA,
      destinationId: siteId,
      kind: 'search_console_site',
      policy: { allowed: true, reason: 'allowed', dataType: 'gsc.reports' },
      windowStart: '2026-09-22',
      windowEnd: '2026-09-28',
    });
    const queries = summary.reports.find((r) => r.reportKey === 'gsc.queries')!;
    // 7 days × (30 + 2 clicks, 100 + 200 impressions), with the revised 31 clicks on the last three days.
    expect(queries.current).toEqual({
      windowStart: '2026-09-22',
      windowEnd: '2026-09-28',
      days: 7,
      rows: 14,
      metrics: {
        clicks: 227,
        impressions: 2100,
        ctr: 227 / 2100,
        position: (7 * (1.2 * 100 + 8 * 200)) / 2100,
      },
    });
    expect(queries.previous).toMatchObject({
      windowStart: '2026-09-15',
      windowEnd: '2026-09-21',
      days: 7,
      rows: 14,
    });
    expect(queries.sample).toEqual({ current: 7, previous: 7, minimum: 5, sufficient: true });
    expect(queries.comparison.find((c) => c.metric === 'clicks')).toEqual({
      metric: 'clicks',
      kind: 'flow',
      current: 227,
      previous: 224,
      change: 3 / 224,
    });
    expect(queries.comparison.some((c) => c.metric === 'position')).toBe(false); // a gauge is never compared
    expect(queries.freshness).toMatchObject({ latestDate: '2026-09-28', latencyHours: 72, stale: false });
    // A report with no rows: nulls and an insufficient sample, never zero.
    const pages = summary.reports.find((r) => r.reportKey === 'gsc.pages')!;
    expect(pages.current).toMatchObject({ days: 0, rows: 0, metrics: { clicks: null, ctr: null } });
    expect(pages.sample.sufficient).toBe(false);
    expect(pages.freshness).toMatchObject({ latestDate: null, stale: true });
    // A shorter window than the data: the previous window reads the stored days before it.
    const short = await inTenant(tenantA, () =>
      reports.summary(owner(), {
        brandId: brandA,
        destinationId: siteId,
        windowStart: '2026-09-27T00:00:00.000Z',
        windowEnd: '2026-09-28T23:59:59.999Z',
      }),
    );
    expect(short.reports.find((r) => r.reportKey === 'gsc.queries')?.sample).toEqual({
      current: 2,
      previous: 2,
      minimum: 5,
      sufficient: false,
    });
  });

  it('rows: one entry per dimension value by the primary metric, paged by cursor', async () => {
    const page1 = await inTenant(tenantA, () =>
      reports.rows(owner(), {
        brandId: brandA,
        destinationId: siteId,
        reportKey: 'gsc.queries',
        ...window,
        limit: 1,
      }),
    );
    expect(page1.items).toEqual([
      {
        dimensionKey: expect.any(String),
        dimensions: { query: 'acme login' },
        days: 7,
        metrics: { clicks: 213, impressions: 700, ctr: 213 / 700, position: 1.2 },
      },
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await inTenant(tenantA, () =>
      reports.rows(owner(), {
        brandId: brandA,
        destinationId: siteId,
        reportKey: 'gsc.queries',
        ...window,
        limit: 1,
        cursor: page1.nextCursor!,
      }),
    );
    expect(page2.items.map((r) => r.dimensions)).toEqual([{ query: 'acme pricing' }]);
    expect(page2.items[0]?.metrics).toEqual({ clicks: 14, impressions: 1400, ctr: 0.01, position: 8 });
    expect(page2.nextCursor).toBeNull();
    const unknown = await inTenant(tenantA, () =>
      reports.rows(owner(), { brandId: brandA, destinationId: siteId, reportKey: 'gsc.nope', ...window }),
    );
    expect(unknown).toEqual({ items: [], nextCursor: null });
  });

  it('opportunities: a query with enough impressions and a CTR under half the pooled one; GA4 landing pages likewise', async () => {
    const site = await inTenant(tenantA, () =>
      reports.opportunities(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(site.windowStart).toBe('2026-09-01');
    expect(site.windowEnd).toBe('2026-09-28');
    expect(site.items).toHaveLength(1);
    expect(site.items[0]).toMatchObject({
      kind: 'low_ctr_query',
      reportKey: 'gsc.queries',
      subject: 'acme pricing',
      metrics: { impressions: 5600, ctr: 0.01 },
      benchmark: { metric: 'ctr' },
    });
    expect(site.items[0]?.suggestedTask).toContain('"acme pricing"');
    // GA4: a landing page with 60 sessions and a 10% engagement rate against a pooled 45%.
    await run(tenantA, (tx) =>
      sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'ga4_property',
          dataType: 'ga4.reports',
          allowedUses: ['read'],
          reviewDueAt: inDays(60),
        },
        tx,
      ),
    );
    ga4.reportRows = {
      'ga4.landing_pages': [-3, -2, -1, 0].flatMap((i) => [
        {
          date: day(i),
          dimensions: { landingPage: '/' },
          metrics: { sessions: 100, engagedSessions: 55, keyEvents: 2 },
        },
        {
          date: day(i),
          dimensions: { landingPage: '/pricing' },
          metrics: { sessions: 15, engagedSessions: 1, keyEvents: 0 },
        },
        {
          date: day(i),
          dimensions: { landingPage: '/tiny' },
          metrics: { sessions: 2, engagedSessions: 0, keyEvents: 0 },
        },
      ]),
    };
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.fetchDestinationReport({
          ...ctx(tenantA),
          destinationId: propertyId,
          now: NOW,
          reportKey: 'ga4.landing_pages',
          start: '2026-09-01',
          end: '2026-09-28',
        }),
      ),
    ).toEqual({ outcome: 'fetched', rows: 12, days: 4 });
    const property = await inTenant(tenantA, () =>
      reports.opportunities(owner(), { brandId: brandA, destinationId: propertyId }),
    );
    expect(property.items).toEqual([
      expect.objectContaining({
        kind: 'low_engagement_page',
        reportKey: 'ga4.landing_pages',
        subject: '/pricing',
        metrics: expect.objectContaining({ sessions: 60, engagementRate: 4 / 60 }),
        benchmark: { metric: 'engagementRate', value: 224 / 468 },
      }),
    ]); // "/tiny" has too few sessions to mean anything
  });

  it('RA-10: a property in a non-UTC zone plans its days in that zone, remembers it, and keys the stored rows by it', async () => {
    // 04:00 UTC on 29 September is 21:00 on the 28th in Los Angeles: the 28th is still running there, so the
    // plan ends on the 27th (UTC "yesterday" would have read a partial day); the zone comes from the target
    // metadata the adapter reads, never from a guess.
    ga4.targetMetadata = { reportingTimeZone: 'America/Los_Angeles', currencyCode: 'usd' };
    ga4.describeCalls.length = 0;
    const plan = await asPlatformJob(tenantA, () =>
      runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: propertyId, now: NOW }),
    );
    expect(ga4.describeCalls).toEqual([{ externalId: 'properties/1001', accessToken: 'at_fixture_src' }]);
    expect(plan).toEqual({
      outcome: 'planned',
      reports: [
        { reportKey: 'ga4.acquisition', start: '2026-08-31', end: '2026-09-27' },
        // the landing pages are stored to the 28th (as UTC days): re-read from the 26th, to the zone's yesterday
        { reportKey: 'ga4.landing_pages', start: '2026-09-26', end: '2026-09-27' },
        { reportKey: 'ga4.engagement', start: '2026-08-31', end: '2026-09-27' },
      ],
    });
    await lock.reset(`lock:destination-report-sweep:${tenantA}:${propertyId}`);
    const remembered = await inTenant(tenantA, () =>
      destinationService.get(owner(), { brandId: brandA, destinationId: propertyId }),
    );
    expect(remembered).toMatchObject({ reportingTimeZone: 'America/Los_Angeles', currencyCode: 'USD' });
    expect(
      (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, propertyId)))[0]
        ?.reportingZoneCheckedAt,
    ).toEqual(new Date(NOW));
    // The rows stored before the zone was known are UTC days (time zone null) and still read as before; a row
    // from before migration 0021 carries no quality at all (null), one the sweep stored without a zone, none ([]).
    const legacy = await storedRows(propertyId, 'ga4.landing_pages');
    expect(legacy).toHaveLength(12);
    expect(
      legacy.every((r) => r.timeZone === null && Array.isArray(r.quality) && r.quality.length === 0),
    ).toBe(true);
    await tdb.db.insert(destinationReportRows).values({
      id: newId('destinationReportRow'),
      tenantId: tenantA,
      brandId: brandA,
      destinationId: propertyId,
      reportKey: 'ga4.acquisition',
      date: '2026-09-27',
      dimensions: { sessionDefaultChannelGroup: 'Direct' },
      dimensionKey: 'legacy',
      metrics: { sessions: 10, totalUsers: 8, engagedSessions: 5, keyEvents: 0 },
      fetchedAt: new Date('2026-09-28T05:00:00.000Z'),
      source: 'provider',
      timeZone: null,
      quality: null,
    });

    // A fetch that (as a GA4 answer does) states the zone and its quality beside the rows, read while the 28th
    // is still running in that zone: the 28th is flagged a partial day, the rest carry the platform's flags.
    ga4.reportTimeZone = 'America/Los_Angeles';
    ga4.reportQuality = ['sampled'];
    ga4.reportRows = {
      ...ga4.reportRows,
      'ga4.engagement': [-2, -1, 0].map((i) => ({
        date: day(i),
        dimensions: {},
        metrics: { sessions: 100, engagedSessions: 60, averageSessionDuration: 70, keyEvents: 1 },
      })),
    };
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.fetchDestinationReport({
          ...ctx(tenantA),
          destinationId: propertyId,
          now: NOW,
          reportKey: 'ga4.engagement',
          start: '2026-09-26',
          end: '2026-09-28',
        }),
      ),
    ).toEqual({ outcome: 'fetched', rows: 3, days: 3 });
    const engagement = await storedRows(propertyId, 'ga4.engagement');
    expect(engagement.map((r) => [r.date, r.timeZone, r.quality])).toEqual([
      ['2026-09-26', 'America/Los_Angeles', ['sampled']],
      ['2026-09-27', 'America/Los_Angeles', ['sampled']],
      ['2026-09-28', 'America/Los_Angeles', ['sampled', 'partial_day']],
    ]);

    // The read model: the engagement window reads as of the 28th in Los Angeles, provisional (a partial day,
    // and within the 48 h latency), sampled; the legacy landing pages read as UTC days without flags, provisional
    // only because their latest day is still inside the latency; a report never read carries nothing.
    const summary = await inTenant(tenantA, () =>
      reports.summary(owner(), { brandId: brandA, destinationId: propertyId, ...window }),
    );
    expect(summary.reports.find((r) => r.reportKey === 'ga4.engagement')?.quality).toEqual({
      timeZone: 'America/Los_Angeles',
      asOfLocalDate: '2026-09-28',
      provisional: true,
      flags: ['sampled', 'partial_day'],
    });
    expect(summary.reports.find((r) => r.reportKey === 'ga4.engagement')?.freshness).toMatchObject({
      latestDate: '2026-09-28',
      ageHours: 0, // the 28th ends at 06:59:59.999Z on the 29th in Los Angeles, after `now`
      stale: false,
    });
    expect(summary.reports.find((r) => r.reportKey === 'ga4.landing_pages')?.quality).toEqual({
      timeZone: null,
      asOfLocalDate: '2026-09-28',
      provisional: true,
      flags: [],
    });
    expect(summary.reports.find((r) => r.reportKey === 'ga4.landing_pages')?.current).toMatchObject({
      days: 4,
      rows: 12,
    });
    const acquisition = summary.reports.find((r) => r.reportKey === 'ga4.acquisition')!;
    expect(acquisition.quality).toEqual({
      timeZone: null,
      asOfLocalDate: '2026-09-27',
      provisional: true, // a UTC day that ended 28 hours ago, inside the 48 h latency
      flags: [],
    });
    expect(acquisition.current).toMatchObject({ days: 1, rows: 1, metrics: { sessions: 10 } });
    expect(acquisition.freshness).toMatchObject({ latestDate: '2026-09-27', ageHours: 28.0, stale: false });

    // A remembered zone read within the last REPORTING_ZONE_RECHECK_DAYS is not asked for again.
    ga4.describeCalls.length = 0;
    await asPlatformJob(tenantA, () =>
      runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: propertyId, now: NOW }),
    );
    expect(ga4.describeCalls).toEqual([]);
    await lock.reset(`lock:destination-report-sweep:${tenantA}:${propertyId}`);
    // Past the window, a refused metadata read keeps the remembered zone: the plan still ends on its yesterday.
    await tdb.db
      .update(brandDestinations)
      .set({
        reportingZoneCheckedAt: new Date(Date.parse(NOW) - (REPORTING_ZONE_RECHECK_DAYS + 1) * 86_400_000),
      })
      .where(eq(brandDestinations.id, propertyId));
    ga4.targetMetadata = { kind: 'forbidden' };
    const again = await asPlatformJob(tenantA, () =>
      runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: propertyId, now: NOW }),
    );
    expect(ga4.describeCalls).toHaveLength(1);
    expect(again).toMatchObject({
      outcome: 'planned',
      reports: expect.arrayContaining([
        { reportKey: 'ga4.engagement', start: '2026-09-26', end: '2026-09-27' },
      ]),
    });
    await lock.reset(`lock:destination-report-sweep:${tenantA}:${propertyId}`);
    ga4.targetMetadata = null;
    ga4.reportTimeZone = null;
    ga4.reportQuality = [];
  });

  it("prune: the operational cache keeps 7 days without `retain`; with `retain` the policy's retention applies", async () => {
    expect(await storedRows(siteId, 'gsc.queries')).toHaveLength(56);
    const input = { ...ctx(tenantA), destinationId: siteId, now: NOW };
    const pruned = await asPlatformJob(tenantA, () => runtime.reports.pruneDestinationReports(input));
    expect(pruned).toEqual({ deleted: 42, cutoff: '2026-09-22' }); // 21 days × 2 rows before the cut-off
    const kept = await storedRows(siteId, 'gsc.queries');
    expect(kept).toHaveLength(14);
    expect(kept[0]?.date).toBe('2026-09-22');
    expect((await auditsOf('destination.report.pruned')).at(-1)?.metadata).toMatchObject({
      count: 42,
      scope: 'gsc.reports',
      reason: 'cutoff=2026-09-22,retentionDays=7',
    });
    await setPolicy('gsc.reports', ['read', 'retain'], 30);
    expect(await asPlatformJob(tenantA, () => runtime.reports.pruneDestinationReports(input))).toEqual({
      deleted: 0,
      cutoff: '2026-08-30',
    });
  });

  it('a foreign tenant or another brand of the tenant finds no destination; a disconnected one is skipped', async () => {
    await expect(
      runInTenant(ctx(tenantB), () =>
        reports.summary(member(tenantB, 'owner'), { brandId: brandB, destinationId: siteId, ...window }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () =>
        reports.summary(owner(), { brandId: brandA2, destinationId: siteId, ...window }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () => reports.opportunities(owner(), { brandId: brandA2, destinationId: siteId })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      runInTenant({ ...ctx(tenantB), actor: REPORTS_ACTOR }, () =>
        runtime.reports.planDestinationReports({ ...ctx(tenantB), destinationId: siteId, now: NOW }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const row = (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, siteId)))[0]!;
    await run(tenantA, (tx) =>
      destinationService.disconnect(
        owner(),
        { brandId: brandA, destinationId: siteId, expectedVersion: row.version },
        tx,
      ),
    );
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: siteId, now: NOW }),
      ),
    ).toEqual({ outcome: 'skipped', reason: 'not_active' });
    expect(
      (await runtime.reports.listDestinationReportTargets({ correlationId: 'c', now: NOW })).some(
        (t) => t.destinationId === siteId,
      ),
    ).toBe(false);
  });
});
