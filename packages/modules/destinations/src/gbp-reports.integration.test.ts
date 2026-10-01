import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
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
import { createDestinationRuntime } from './runtime';
import { destinationService, sourceUsePolicyService } from './service';
import { configureDestinationSources } from './sources';
import { FixtureSourceAdapter } from './testing/fixture-source';

/**
 * R2-2 (read-only slice under D-17) against MySQL 8: the generic connect flow, report sweep, read model and prune
 * over a Business Profile location with the fixture source carrying the real adapter's reports (gbp.performance,
 * gbp.surfaces under the `gbp.reports` data type). The kind reads only: a policy asking to retain is refused, so
 * the prune always keeps the 7-day operational cache; the platform API not being enabled degrades the destination
 * with the reason access_required, never a reconnect.
 */
const USER = 'usr_gbp_reports_test';
const NOW = '2026-09-29T04:00:00.000Z';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_gbp',
});
const member = (tenantId: string, role: MembershipRole): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_gbp_reports_test',
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

/** The location's last 40 days: 150 impressions, 6 website clicks, 3 calls and 4 direction requests a day; bookings only lately. */
function performanceRows(): SourceReportRow[] {
  const rows: SourceReportRow[] = [];
  for (let i = -39; i <= 0; i++)
    rows.push({
      date: day(i),
      dimensions: {},
      metrics: {
        impressions: 150,
        websiteClicks: 6,
        callClicks: 3,
        directionRequests: 4,
        ...(i >= -2 ? { bookings: 1 } : {}),
      },
    });
  return rows;
}
function surfaceRows(): SourceReportRow[] {
  const rows: SourceReportRow[] = [];
  for (let i = -39; i <= 0; i++)
    for (const [surface, impressions] of [
      ['Desktop Search', 40],
      ['Mobile Search', 75],
      ['Mobile Maps', 25],
      ['Desktop Maps', 10],
    ] as const)
      rows.push({ date: day(i), dimensions: { surface }, metrics: { impressions } });
  return rows;
}

describe('Business Profile location reports against MySQL 8 (R2-2 read-only slice)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const owner = () => member(tenantA, 'owner');
  const gbp = new FixtureSourceAdapter('gbp_location');
  const lock = new MemoryRateLimiterStore();
  const runtime = createDestinationRuntime({ now: () => new Date(NOW), reportLock: lock });
  const reports = createDestinationReportService({ now: () => new Date(NOW) });
  let locationId = '';
  const window = { windowStart: '2026-09-22T00:00:00.000Z', windowEnd: '2026-09-28T23:59:59.999Z' };
  const auditsOf = (action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, action)))
      .orderBy(asc(auditEvents.createdAt));
  const storedRows = (reportKey: string) =>
    tdb.db
      .select()
      .from(destinationReportRows)
      .where(
        and(
          eq(destinationReportRows.destinationId, locationId),
          eq(destinationReportRows.reportKey, reportKey),
        ),
      )
      .orderBy(asc(destinationReportRows.date), asc(destinationReportRows.dimensionKey));
  const setPolicy = (allowedUses: Array<'read' | 'retain'>, retentionDays?: number) =>
    run(tenantA, async (tx) => {
      const existing = (
        await sourceUsePolicyService.list(owner(), { brandId: brandA, destinationKind: 'gbp_location' }, tx)
      ).items.find((p) => p.dataType === 'gbp.reports');
      return sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'gbp_location',
          dataType: 'gbp.reports',
          allowedUses,
          ...(retentionDays ? { retentionDays } : {}),
          reviewDueAt: inDays(60),
          ...(existing ? { expectedVersion: existing.version } : {}),
        },
        tx,
      );
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: 'gbp-a-' + tenantA.slice(-6).toLowerCase() });
    await tdb.db.insert(users).values({ id: USER, email: 'gbp-reports-test@example.test', name: 'Gbp' });
    await tdb.db.insert(memberships).values({
      id: 'mem_gbp_reports_test',
      tenantId: tenantA,
      userId: USER,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A1',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    configureCredentialBroker({ kms: new LocalKms('gbp-reports-test-master-secret-0123456789ab') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureDestinationSources({ registry: new SourceRegistry().register(gbp) });
    configureSourceAvailability(() => true);
    gbp.reportRows = { 'gbp.performance': performanceRows(), 'gbp.surfaces': surfaceRows() };
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('connect: the grant lists the locations and the person selects one; the kind carries the real reports', async () => {
    gbp.targets = [
      { externalId: 'locations/777', displayName: 'Acme · Acme Harare (Harare)' },
      { externalId: 'locations/778', displayName: 'Acme · Acme Bulawayo' },
    ];
    const started = await run(tenantA, (tx) =>
      destinationService.connect.start(
        owner(),
        { brandId: brandA, kind: 'gbp_location', redirectUri: 'https://app.example/connect/callback' },
        tx,
      ),
    );
    const choice = await run(tenantA, (tx) =>
      destinationService.connect.complete(owner(), { state: started.state, code: 'good' }, tx),
    );
    expect(choice.targets.map((t) => t.externalId)).toEqual(['locations/777', 'locations/778']);
    const registered = await run(tenantA, (tx) =>
      destinationService.connect.select(
        owner(),
        { pendingId: choice.pendingId, externalId: 'locations/777' },
        tx,
      ),
    );
    expect(registered).toMatchObject({
      kind: 'gbp_location',
      externalId: 'locations/777',
      displayName: 'Acme · Acme Harare (Harare)',
      status: 'active',
    });
    locationId = registered.id;
    expect(gbp.capability.reports.map((r) => r.key)).toEqual(['gbp.performance', 'gbp.surfaces']);
  });

  it('D-17: the kind reads only, so a policy asking to retain is refused and a read policy carries no retention', async () => {
    await expect(setPolicy(['read', 'retain'], 30)).rejects.toBeInstanceOf(ValidationFailedError);
    const summary = await inTenant(tenantA, () =>
      reports.summary(owner(), { brandId: brandA, destinationId: locationId, ...window }),
    );
    expect(summary.policy).toEqual({ allowed: false, reason: 'no_policy', dataType: 'gbp.reports' });
    expect(summary.reports).toEqual([]);
    expect(summary.presentation).toEqual(gbp.capability.presentation ?? null);
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: locationId, now: NOW }),
      ),
    ).toEqual({ outcome: 'skipped', reason: 'no_policy' });
    expect((await auditsOf('destination.report.skipped')).at(-1)?.metadata).toMatchObject({
      reason: 'no_policy:gbp.reports',
      kind: 'gbp_location',
    });
    await expect(
      inTenant(tenantA, () =>
        reports.rows(owner(), {
          brandId: brandA,
          destinationId: locationId,
          reportKey: 'gbp.performance',
          ...window,
        }),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const policy = await setPolicy(['read']);
    expect(policy).toMatchObject({ allowedUses: ['read'], retentionDays: null });
  });

  it('the sweep plans both reports for the first-run 28 days and fetches the daily metrics into rows', async () => {
    const plan = await asPlatformJob(tenantA, () =>
      runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: locationId, now: NOW }),
    );
    expect(plan).toEqual({
      outcome: 'planned',
      reports: ['gbp.performance', 'gbp.surfaces'].map((reportKey) => ({
        reportKey,
        start: '2026-09-01',
        end: '2026-09-28',
      })),
    });
    for (const reportKey of ['gbp.performance', 'gbp.surfaces']) {
      const fetched = await asPlatformJob(tenantA, () =>
        runtime.reports.fetchDestinationReport({
          ...ctx(tenantA),
          destinationId: locationId,
          now: NOW,
          reportKey,
          start: '2026-09-01',
          end: '2026-09-28',
        }),
      );
      expect(fetched).toEqual({
        outcome: 'fetched',
        rows: reportKey === 'gbp.surfaces' ? 112 : 28,
        days: 28,
      });
    }
    expect(gbp.reportCalls.map((c) => c.externalId)).toEqual(['locations/777', 'locations/777']);
    const stored = await storedRows('gbp.performance');
    expect(stored).toHaveLength(28);
    expect(stored[0]).toMatchObject({
      brandId: brandA,
      date: '2026-09-01',
      dimensions: {},
      source: 'provider',
      metrics: { impressions: 150, websiteClicks: 6, callClicks: 3, directionRequests: 4 },
    });
    expect('bookings' in (stored[0]?.metrics ?? {})).toBe(false); // absent that day, never zero
    await asPlatformJob(tenantA, () =>
      runtime.reports.finishDestinationReports({
        ...ctx(tenantA),
        destinationId: locationId,
        now: NOW,
        health: 'healthy',
        fetched: [
          { reportKey: 'gbp.performance', rows: 28 },
          { reportKey: 'gbp.surfaces', rows: 112 },
        ],
        reason: null,
      }),
    );
    // The next plan reads on from the last stored day minus the five-day latency.
    await lock.reset(`lock:destination-report-sweep:${tenantA}:${locationId}`);
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.planDestinationReports({ ...ctx(tenantA), destinationId: locationId, now: NOW }),
      ),
    ).toMatchObject({
      outcome: 'planned',
      reports: expect.arrayContaining([
        { reportKey: 'gbp.performance', start: '2026-09-23', end: '2026-09-28' },
      ]),
    });
    await lock.reset(`lock:destination-report-sweep:${tenantA}:${locationId}`);
  });

  it('summary: the tiles’ flows summed, the website click rate pooled, the previous week compared; rows by surface; no opportunity for a single location', async () => {
    const summary = await inTenant(tenantA, () =>
      reports.summary(owner(), { brandId: brandA, destinationId: locationId, ...window }),
    );
    expect(summary).toMatchObject({
      kind: 'gbp_location',
      policy: { allowed: true, reason: 'allowed', dataType: 'gbp.reports' },
      presentation: {
        console: { label: 'Google Business Profile', href: 'https://business.google.com/' },
        tiles: { reportKey: 'gbp.performance' },
      },
    });
    const performance = summary.reports.find((r) => r.reportKey === 'gbp.performance')!;
    expect(performance.current).toEqual({
      windowStart: '2026-09-22',
      windowEnd: '2026-09-28',
      days: 7,
      rows: 7,
      metrics: {
        impressions: 1050,
        websiteClicks: 42,
        callClicks: 21,
        directionRequests: 28,
        conversations: null,
        bookings: 3,
        websiteClickRate: 42 / 1050,
      },
    });
    expect(performance.sample).toEqual({ current: 7, previous: 7, minimum: 5, sufficient: true });
    expect(performance.comparison.find((c) => c.metric === 'impressions')).toEqual({
      metric: 'impressions',
      kind: 'flow',
      current: 1050,
      previous: 1050,
      change: 0,
    });
    expect(performance.freshness).toMatchObject({
      latestDate: '2026-09-28',
      latencyHours: 120,
      stale: false,
    });
    const surfaces = await inTenant(tenantA, () =>
      reports.rows(owner(), {
        brandId: brandA,
        destinationId: locationId,
        reportKey: 'gbp.surfaces',
        ...window,
      }),
    );
    expect(surfaces.items.map((r) => [r.dimensions['surface'], r.metrics['impressions']])).toEqual([
      ['Mobile Search', 525],
      ['Desktop Search', 280],
      ['Mobile Maps', 175],
      ['Desktop Maps', 70],
    ]);
    const opportunities = await inTenant(tenantA, () =>
      reports.opportunities(owner(), { brandId: brandA, destinationId: locationId }),
    );
    expect(opportunities.items).toEqual([]);
  });

  it('the platform API not enabled for the project degrades the destination with the reason, never a reconnect; a 429 is rate limited', async () => {
    const input = {
      ...ctx(tenantA),
      destinationId: locationId,
      now: NOW,
      reportKey: 'gbp.performance',
      start: '2026-09-26',
      end: '2026-09-28',
    };
    gbp.nextReportBehaviours.push(
      { kind: 'access_required' },
      { kind: 'rate_limited' },
      { kind: 'forbidden' },
    );
    expect(await asPlatformJob(tenantA, () => runtime.reports.fetchDestinationReport(input))).toEqual({
      outcome: 'transient',
      reason: 'access_required',
    });
    expect(await asPlatformJob(tenantA, () => runtime.reports.fetchDestinationReport(input))).toEqual({
      outcome: 'rate_limited',
      retryAfterMs: 60_000,
    });
    expect(await asPlatformJob(tenantA, () => runtime.reports.fetchDestinationReport(input))).toEqual({
      outcome: 'unreachable',
      reason: 'reconnect_required',
    });
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.reports.finishDestinationReports({
          ...ctx(tenantA),
          destinationId: locationId,
          now: NOW,
          health: 'degraded',
          fetched: [],
          reason: 'access_required',
        }),
      ),
    ).toEqual({ health: 'degraded' });
    const row = (
      await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, locationId))
    )[0];
    expect(row?.health).toBe('degraded');
    expect(row?.status).toBe('active'); // the grant is intact: no reconnect asked
    expect((await auditsOf('destination.report.fetched')).at(-1)?.metadata).toMatchObject({
      reason: 'access_required',
      toState: 'degraded',
    });
    expect(await storedRows('gbp.performance')).toHaveLength(28); // nothing was written by the failed reads
  });

  it('prune: without `retain` (which the kind never allows) the 7-day operational cache applies', async () => {
    const pruned = await asPlatformJob(tenantA, () =>
      runtime.reports.pruneDestinationReports({ ...ctx(tenantA), destinationId: locationId, now: NOW }),
    );
    expect(pruned).toEqual({ deleted: 21 + 84, cutoff: '2026-09-22' });
    expect(await storedRows('gbp.performance')).toHaveLength(7);
    expect(await storedRows('gbp.surfaces')).toHaveLength(28);
    expect((await auditsOf('destination.report.pruned')).at(-1)?.metadata).toMatchObject({
      scope: 'gbp.reports',
      reason: 'cutoff=2026-09-22,retentionDays=7',
    });
  });
});
