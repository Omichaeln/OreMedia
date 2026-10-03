import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { requireTenant, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { brandDestinations, destinationReportRows, seoAuditRuns } from '@oremedia/db/schema/destinations';
import { metricSnapshots } from '@oremedia/db/schema/measurement';
import { publications } from '@oremedia/db/schema/publishing';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import {
  configureDestinationCms,
  configureSourceAvailability,
  sourceUsePolicyService,
} from '@oremedia/module-destinations';
import { registerCalendarSource } from '@oremedia/module-content';
import {
  attributeService,
  definitionService,
  metricService,
  registerMeasurementBrandChecker,
  registerMeasurementPublicationSource,
} from '@oremedia/module-measurement';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  connectedChannel,
  fixtureCapability,
  publicationService,
  configureChannelActivation,
  registerProviderClients,
  registerPublishingBrandChecker,
} from '@oremedia/module-publishing';
import { CmsRegistry, ProviderRegistry } from '@oremedia/providers';
import { createOverviewService } from './summary';

/**
 * R2-5 against MySQL 8: the overview composes the measurement, publishing and destinations services on one seeded
 * brand (three channels in three states, a GA4 property with a week of rows, a Search Console site without a
 * policy, a website with a completed audit) and reports every source's state with its reason, every figure with
 * its source and freshness, the splits as stated limits and the limit statements. Cross-tenant: NOT_FOUND.
 */
const USER = 'usr_overview_test';
/** Real time: the composed services read their own clocks (freshness is an age against now). */
const NOW = new Date();
const DAY = 86_400_000;
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_overview',
});
const member = (tenantId: string, role: MembershipRole = 'owner'): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: `mem_overview_${tenantId.slice(-6)}`,
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);
const dayKey = (offset: number) => new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);
/** The last seven UTC days as the web sends them (today included; the platforms have not reported it). */
const window = { windowStart: `${dayKey(-6)}T00:00:00.000Z`, windowEnd: `${dayKey(0)}T23:59:59.999Z` };

describe('overview read model against MySQL 8 (R2-5)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter(
    fixtureCapability({
      analytics: { post: ['impressionCount', 'engagement'], account: [], latencyHours: 2 },
    }),
  );
  registry.register(fixture);
  const overview = createOverviewService({ now: () => NOW });
  const ga4Id = newId('destination');
  const gscId = newId('destination');
  const siteId = newId('destination');
  let freshChannel = '';
  let disabledChannel = '';
  let idleChannel = '';

  const connect = async (remoteAccountId: string) => {
    fixture.grant.remoteAccountId = remoteAccountId;
    const started = await run(tenantA, (tx) =>
      channelService.connect.start(
        member(tenantA),
        { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return run(tenantA, (tx) =>
      channelService.connect
        .complete(member(tenantA), { state: started.state, code: 'good' }, tx)
        .then(connectedChannel),
    );
  };
  /** A published post on the channel at `at`, with an impressions snapshot fetched `fetchedAt` (or none). */
  const publish = async (
    channelConnectionId: string,
    at: Date,
    impressions: number | null,
    fetchedAt = new Date(NOW.getTime() - 3_600_000),
  ) => {
    const id = newId('publication');
    await tdb.db.insert(publications).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      contentPackageId: newId('contentPackage'),
      contentRevisionId: newId('contentRevision'),
      channelVariantId: newId('channelVariant'),
      channelConnectionId,
      occurrenceKey: `test:${id}`,
      authority: 'approval',
      approvalId: newId('releaseApproval'),
      mandateId: null,
      scheduledFor: at,
      state: 'published',
      remotePostId: `post_${id.slice(-6)}`,
      remoteUrl: 'https://fixture.example/p/1',
      scheduledByKind: 'user',
      scheduledById: USER,
    });
    if (impressions === null) return id;
    await tdb.db.insert(metricSnapshots).values({
      id: newId('metricSnapshot'),
      tenantId: tenantA,
      brandId: brandA,
      subjectType: 'publication',
      subjectId: id,
      metricKey: 'impressionCount',
      value: impressions,
      series: null,
      windowStart: at,
      windowEnd: fetchedAt,
      fetchedAt,
      source: `${FIXTURE_PROVIDER_KEY}@v1`,
      completeness: 'complete',
      definitionVersion: 1,
      numeratorSnapshotId: null,
      denominatorSnapshotId: null,
      brandTimezone: 'UTC',
    });
    return id;
  };
  const destination = (id: string, kind: string, externalId: string, displayName: string) =>
    tdb.db.insert(brandDestinations).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      kind,
      externalId,
      displayName,
      ownerUserId: USER,
      credentialRefId: null,
      tokenExpiresAt: null,
      grantedScopes: [],
      health: 'healthy',
      healthCheckedAt: NOW,
      capabilityVersion: 1,
      status: 'active',
    });
  const setPolicy = (destinationKind: 'ga4_property' | 'cms_site', dataType: string) =>
    run(tenantA, (tx) =>
      sourceUsePolicyService.set(
        member(tenantA),
        {
          brandId: brandA,
          destinationKind,
          dataType,
          allowedUses: ['read'],
          reviewDueAt: new Date(NOW.getTime() + 60 * DAY).toISOString(),
        },
        tx,
      ),
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'overview-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'overview-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: USER, email: 'overview-test@example.test', name: 'Ove' });
    await tdb.db.insert(memberships).values([
      {
        id: `mem_overview_${tenantA.slice(-6)}`,
        tenantId: tenantA,
        userId: USER,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
      {
        id: `mem_overview_${tenantB.slice(-6)}`,
        tenantId: tenantB,
        userId: USER,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configurePublishingProviders({ registry });
    configureCredentialBroker({ kms: new LocalKms('overview-test-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureChannelActivation(null); // the composition root read an env with no PROVIDER_FIXTURE_PROVIDER_* refs
    configureDestinationCms({ registry: new CmsRegistry() });
    configureSourceAvailability(() => true);
    // What brandService.assertExist does for the hooks: a brand of another tenant does not exist (spec 5.3).
    const checker = {
      assertExist: async (ids: string[]) => {
        const known = requireTenant().tenantId === tenantA ? brandA : brandB;
        for (const id of ids) if (id !== known) throw new NotFoundError('Brand', id);
      },
    };
    registerPublishingBrandChecker(checker);
    registerMeasurementBrandChecker(checker);
    registerMeasurementPublicationSource((brandId, from, to, tx) =>
      publicationService.calendarRangeAll(brandId, from, to, tx),
    );
    registerCalendarSource((brandId, from, to, tx) =>
      publicationService.calendarRange(brandId, from, to, tx),
    );
    await definitionService.seedGlobal([fixture.capability]);

    freshChannel = (await connect('acct_fresh')).id;
    const disabled = await connect('acct_disabled');
    await run(tenantA, (tx) =>
      channelService.disconnect(
        member(tenantA),
        { channelConnectionId: disabled.id, expectedVersion: disabled.version },
        tx,
      ),
    );
    disabledChannel = disabled.id;
    idleChannel = (await connect('acct_idle')).id;
    // Six posts this week with a number each, five the week before: the D-14 sample holds on both sides.
    for (let i = 1; i <= 6; i++)
      await publish(freshChannel, new Date(NOW.getTime() - i * DAY + 3_600_000), 100);
    for (let i = 1; i <= 5; i++) {
      const at = new Date(NOW.getTime() - (6 + i) * DAY);
      await publish(freshChannel, at, 80, new Date(at.getTime() + 3_600_000)); // fetched inside its own window
    }

    await destination(ga4Id, 'ga4_property', 'properties/1001', 'Acme web');
    await destination(gscId, 'search_console_site', 'sc-domain:acme.example', 'Acme site');
    await destination(siteId, 'cms_site', 'https://acme.example', 'acme.example');
    await setPolicy('ga4_property', 'ga4.reports');
    await setPolicy('cms_site', 'cms.audit');
    // Fourteen days of the GA4 engagement report up to yesterday: a week against the week before.
    await tdb.db.insert(destinationReportRows).values(
      Array.from({ length: 14 }, (_, i) => ({
        id: newId('destinationReportRow'),
        tenantId: tenantA,
        brandId: brandA,
        destinationId: ga4Id,
        reportKey: 'ga4.engagement',
        date: dayKey(-1 - i),
        dimensions: {},
        dimensionKey: hashCanonical({}),
        metrics: { sessions: 100, engagedSessions: 50, keyEvents: 3, averageSessionDuration: 60 },
        fetchedAt: NOW,
        source: 'provider',
      })),
    );
    await tdb.db.insert(seoAuditRuns).values({
      id: newId('seoAuditRun'),
      tenantId: tenantA,
      brandId: brandA,
      destinationId: siteId,
      origin: 'https://acme.example',
      trigger: 'scheduled',
      requestedById: null,
      startedAt: new Date(NOW.getTime() - DAY),
      finishedAt: new Date(NOW.getTime() - DAY + 600_000),
      outcome: 'completed',
      pagesCrawled: 40,
      summary: { critical: 1, major: 2, minor: 3, byCheck: { missing_title: 1 } },
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('composes every source with its state and reason, every figure with its source and freshness, and the limits', async () => {
    const result = await inTenant(tenantA, () =>
      overview.summary(member(tenantA), { brandId: brandA, ...window }),
    );
    expect(result.days).toEqual({ start: dayKey(-6), end: dayKey(0), length: 7 });

    // (a) social: the brand rollup under D-14 / D-15, source-labelled.
    const impressions = result.social.figures.find((f) => f.key === 'impressions');
    expect(impressions).toMatchObject({
      label: 'Impressions',
      kind: 'flow',
      value: 600,
      previous: 400,
      change: 0.5,
      sufficient: true,
      coverage: { requested: 6, withData: 6, unit: 'posts' },
      source: { kind: 'social' },
    });
    expect(impressions?.freshness).toMatchObject({ latencyHours: 2, stale: false });
    expect(impressions?.freshness?.ageHours).toBeGreaterThanOrEqual(1);
    expect(impressions?.freshness?.ageHours).toBeLessThan(1.5);
    expect(result.social.sample).toEqual({ current: 6, previous: 5, minimum: 5, sufficient: true });

    // (d) the roll-up: one chip per channel and per destination, each with its state and reason.
    const byId = new Map(result.sources.map((s) => [s.id, s]));
    expect(byId.get(freshChannel)).toMatchObject({
      kind: 'channel',
      platform: FIXTURE_PROVIDER_KEY,
      state: 'fresh',
      reason: '6 of 6 posts have numbers',
      coverage: { requested: 6, withData: 6, unit: 'posts' },
      sample: { current: 6, previous: 5, minimum: 5, sufficient: true },
      freshness: { latencyHours: 2, stale: false },
    });
    expect(byId.get(disabledChannel)).toMatchObject({ state: 'not_connected' });
    expect(byId.get(disabledChannel)?.reason).toContain('connection disabled');
    expect(byId.get(idleChannel)).toMatchObject({
      state: 'no_data',
      reason: 'nothing published on this channel in the window',
    });
    expect(byId.get(ga4Id)).toMatchObject({
      kind: 'web',
      platform: 'Google Analytics 4 property',
      state: 'fresh',
      coverage: { requested: 7, withData: 6, unit: 'days' },
      sample: { current: 6, previous: 7, minimum: 5, sufficient: true },
      policy: { allowed: true, reason: 'allowed', dataType: 'ga4.reports' },
    });
    expect(byId.get(ga4Id)?.freshness).toMatchObject({
      asOf: `${dayKey(-1)}T23:59:59.999Z`,
      latencyHours: 48,
      stale: false,
    });
    expect(byId.get(gscId)).toMatchObject({
      kind: 'web',
      state: 'blocked',
      reason: 'reads not allowed by the source-use policy (no policy for gsc.reports)',
      policy: { allowed: false, reason: 'no_policy' },
    });
    expect(byId.get(siteId)).toMatchObject({
      kind: 'audit',
      state: 'fresh',
      reason: '40 pages crawled · 1 critical, 2 major, 3 minor',
      coverage: { requested: 40, withData: 40, unit: 'pages' },
    });

    // (b) web figures: the adapter's tiles, summed over the days the platform reported (today is absent, never zero).
    const ga4 = result.web.find((w) => w.source.id === ga4Id);
    expect(ga4?.figures.find((f) => f.key === 'sessions')).toMatchObject({
      value: 600,
      previous: 700,
      coverage: { requested: 7, withData: 6, unit: 'days' },
      source: { kind: 'web', id: ga4Id, label: 'Acme web' },
    });
    expect(ga4?.figures.find((f) => f.key === 'engagementRate')?.value).toBeCloseTo(0.5);
    expect(ga4?.console).toEqual({ label: 'Google Analytics', href: 'https://analytics.google.com/' });
    expect(result.web.find((w) => w.source.id === gscId)?.figures).toEqual([]);

    // (c) the last audit, lab data only.
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]).toMatchObject({
      source: { id: siteId, kind: 'audit' },
      lastRun: { pagesCrawled: 40, outcome: 'completed' },
      data: { kind: 'lab' },
      fieldData: null,
    });

    // (e), (f) the splits are stated limits, never figures.
    expect(result.organicVsPaid.paid).toMatchObject({ state: 'not_connected', separatingDefinitions: [] });
    expect(result.organicVsPaid.organic.publications).toBe(6);
    expect(result.oremediaVsNative.native.state).toBe('not_observed');

    // (g) the limits: the disabled channel, the blocked site, the two uncertified adapters of this checkout, lab
    // data, D-19 per web source (the blocked one links its console too), R3-4, native, latest-fetch comparison.
    expect(result.limits.map((l) => l.code)).toEqual([
      'not_connected',
      'policy_blocked',
      'source_uncertified',
      'source_uncertified',
      'field_data_not_connected',
      'ai_search_external',
      'ai_search_external',
      'paid_not_connected',
      'native_not_observed',
      'latest_fetch_comparison',
    ]);
    expect(result.limits.filter((l) => l.code === 'source_uncertified').map((l) => l.statement)).toEqual([
      'Google Analytics 4 property: the source adapter is not certified on this deployment; nothing is read from it.',
      'Search Console site: the source adapter is not certified on this deployment; nothing is read from it.',
    ]);
    expect(result.limits.find((l) => l.code === 'policy_blocked')?.source?.id).toBe(gscId);
    expect(result.limits.find((l) => l.code === 'ai_search_external')?.link?.href).toBe(
      'https://analytics.google.com/',
    );
  });

  it('a window with nothing in it: no social figure, the channel and the web source read no data, the social sample is insufficient', async () => {
    const result = await inTenant(tenantA, () =>
      overview.summary(member(tenantA), {
        brandId: brandA,
        windowStart: `${dayKey(-40)}T00:00:00.000Z`,
        windowEnd: `${dayKey(-34)}T23:59:59.999Z`,
      }),
    );
    expect(result.social.figures).toEqual([]);
    expect(result.social.sample).toMatchObject({ current: 0, previous: 0, sufficient: false });
    expect(result.sources.find((s) => s.id === freshChannel)).toMatchObject({ state: 'no_data' });
    expect(result.sources.find((s) => s.id === ga4Id)).toMatchObject({ state: 'no_data' });
    expect(result.limits.map((l) => l.code)).toContain('insufficient_sample');
  });

  it('an old window with more than 200 posts is counted whole (RA-06): totals, comparison and coverage span every post in the overview, the brand rollup and the attribute aggregate', async () => {
    // 350 posts published 60 days ago on the fresh channel, 10 impressions each (fetched inside their own window),
    // and 6 the week before with 80 each: more than the query's 200-subject cap and older than everything seeded
    // above, so a "newest 200" read of either listing or query would miss most of them.
    const seed = async (count: number, at: Date, impressions: number) => {
      const rows = Array.from({ length: count }, (_, i) => {
        const id = newId('publication');
        const scheduledFor = new Date(at.getTime() + i * 60_000);
        const fetchedAt = new Date(scheduledFor.getTime() + 3_600_000);
        return {
          publication: {
            id,
            tenantId: tenantA,
            brandId: brandA,
            contentPackageId: newId('contentPackage'),
            contentRevisionId: newId('contentRevision'),
            channelVariantId: newId('channelVariant'),
            channelConnectionId: freshChannel,
            occurrenceKey: `test:${id}`,
            authority: 'approval' as const,
            approvalId: newId('releaseApproval'),
            mandateId: null,
            scheduledFor,
            state: 'published' as const,
            remotePostId: `post_${id.slice(-6)}`,
            remoteUrl: 'https://fixture.example/p/1',
            scheduledByKind: 'user' as const,
            scheduledById: USER,
          },
          snapshot: {
            id: newId('metricSnapshot'),
            tenantId: tenantA,
            brandId: brandA,
            subjectType: 'publication' as const,
            subjectId: id,
            metricKey: 'impressionCount',
            value: impressions,
            series: null,
            windowStart: scheduledFor,
            windowEnd: fetchedAt,
            fetchedAt,
            source: `${FIXTURE_PROVIDER_KEY}@v1`,
            completeness: 'complete' as const,
            definitionVersion: 1,
            numeratorSnapshotId: null,
            denominatorSnapshotId: null,
            brandTimezone: 'UTC',
          },
        };
      });
      for (let i = 0; i < rows.length; i += 100) {
        const slice = rows.slice(i, i + 100);
        await tdb.db.insert(publications).values(slice.map((r) => r.publication));
        await tdb.db.insert(metricSnapshots).values(slice.map((r) => r.snapshot));
      }
    };
    await seed(350, new Date(NOW.getTime() - 60 * DAY), 10);
    await seed(6, new Date(NOW.getTime() - 67 * DAY), 80);
    const window = {
      brandId: brandA,
      windowStart: `${dayKey(-63)}T00:00:00.000Z`,
      windowEnd: `${dayKey(-57)}T23:59:59.999Z`,
    };
    const change = (3500 - 480) / 480;

    const result = await inTenant(tenantA, () => overview.summary(member(tenantA), window));
    expect(result.social.sample).toEqual({ current: 350, previous: 6, minimum: 5, sufficient: true });
    expect(result.social.coverage).toEqual({
      subjectsRequested: 350,
      subjectsWithData: 350,
      staleValues: 350,
      subjectsTotal: 350,
      truncated: false,
    });
    expect(result.social.figures.find((f) => f.key === 'impressions')).toMatchObject({
      value: 3500,
      previous: 480,
      change,
      sufficient: true,
      coverage: { requested: 350, withData: 350, unit: 'posts' },
    });
    // The channel's own coverage spans every post too (the values were read in chunks, never the newest 200).
    expect(result.sources.find((s) => s.id === freshChannel)).toMatchObject({
      state: 'stale',
      coverage: { requested: 350, withData: 350, unit: 'posts' },
      sample: { current: 350, previous: 6, minimum: 5, sufficient: true },
    });

    // The portfolio path (measurement.metrics.brandSummary) reads the same whole population.
    const rollup = await inTenant(tenantA, () => metricService.brandSummary(member(tenantA), window));
    expect(rollup).toMatchObject({ subjectsTotal: 350, truncated: false });
    expect(rollup.current).toMatchObject({
      publications: 350,
      coverage: { subjectsRequested: 350, subjectsWithData: 350 },
    });
    expect(rollup.current.aggregates.find((a) => a.comparableGroup === 'impressions')).toMatchObject({
      value: 3500,
      subjectsWithData: 350,
    });
    expect(rollup.comparison.find((c) => c.comparableGroup === 'impressions')).toEqual({
      comparableGroup: 'impressions',
      kind: 'flow',
      current: 3500,
      previous: 480,
      change,
    });
    // One channel's posts only: the idle channel published nothing in the window.
    const idle = await inTenant(tenantA, () =>
      metricService.brandSummary(member(tenantA), { ...window, channelConnectionId: idleChannel }),
    );
    expect(idle.current).toMatchObject({ publications: 0, aggregates: [] });

    // The attribute aggregate counts every publication of the window (none carries engagement here).
    const attributes = await inTenant(tenantA, () => attributeService.aggregate(member(tenantA), window));
    expect(attributes).toMatchObject({ publications: 350, withNumbers: 0 });

    // Past the calendar's own 1000-row bound (CALENDAR_RANGE_MAX): the publication source pages to the end, so
    // 1100 posts of one window are all counted, in the overview, the rollup and the per-publication pages.
    await seed(1100, new Date(NOW.getTime() - 90 * DAY), 1);
    const big = {
      brandId: brandA,
      windowStart: `${dayKey(-93)}T00:00:00.000Z`,
      windowEnd: `${dayKey(-87)}T23:59:59.999Z`,
    };
    const bigResult = await inTenant(tenantA, () => overview.summary(member(tenantA), big));
    expect(bigResult.social.coverage).toMatchObject({ subjectsRequested: 1100, subjectsWithData: 1100 });
    expect(bigResult.social.figures.find((f) => f.key === 'impressions')).toMatchObject({ value: 1100 });
    expect(bigResult.sources.find((s) => s.id === freshChannel)).toMatchObject({
      coverage: { requested: 1100, withData: 1100, unit: 'posts' },
    });
    const bigRollup = await inTenant(tenantA, () => metricService.brandSummary(member(tenantA), big));
    expect(bigRollup).toMatchObject({ subjectsTotal: 1100, truncated: false });
    expect(bigRollup.current.aggregates.find((a) => a.comparableGroup === 'impressions')).toMatchObject({
      value: 1100,
      subjectsWithData: 1100,
    });
    let pages = 0;
    let seen = 0;
    for (let cursor: string | undefined; ;) {
      const page = await inTenant(tenantA, () =>
        metricService.publicationValues(member(tenantA), {
          ...big,
          metricKeys: ['impressionCount'],
          page: { limit: 200, cursor },
        }),
      );
      pages += 1;
      seen += page.items.length;
      expect(page.subjectsTotal).toBe(1100);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect({ pages, seen }).toEqual({ pages: 6, seen: 1100 });
  });

  it('cross-tenant: a foreign brand is NOT_FOUND, in either direction', async () => {
    await expect(
      inTenant(tenantB, () => overview.summary(member(tenantB), { brandId: brandA, ...window })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () => overview.summary(member(tenantA), { brandId: brandB, ...window })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
