import { describe, expect, it } from 'vitest';
import type { DestinationReportSummaryV1, DestinationV1 } from '@oremedia/contracts/destinations';
import type { MetricAggregateV1, MetricValueV1 } from '@oremedia/contracts/measurement';
import { OVERVIEW_AUDIT_LATENCY_HOURS } from '@oremedia/contracts/overview';
import type { SeoAuditSummaryV1 } from '@oremedia/contracts/seo-audit';
import {
  auditSourceOf,
  channelSource,
  limitsOf,
  socialFigures,
  socialOf,
  splitsOf,
  webFigures,
  webSourceOf,
  type BrandSummaryResult,
} from './compose';

/**
 * The composition rules of the overview (R2-5): a source's state and its reason from what the module reported,
 * figures with their source label and freshness under the dictionary (D-15) and the D-14 sample, the splits as
 * stated limits, and the limit statements. Pure: nothing here reads a table.
 */
const NOW = new Date('2026-09-29T12:00:00.000Z');
const aggregate = (over: Partial<MetricAggregateV1>): MetricAggregateV1 => ({
  comparableGroup: 'impressions',
  kind: 'flow',
  additive: true,
  metricKeys: ['impressionCount'],
  value: 100,
  snapshotIds: [],
  subjectsWithData: 2,
  subjectsUnavailable: 0,
  freshness: { fetchedAt: '2026-09-29T10:00:00.000Z', ageHours: 2, latencyHours: 6, stale: false },
  stale: false,
  ...over,
});
const brandSummary = (over: Partial<BrandSummaryResult> = {}): BrandSummaryResult => ({
  ageDays: null,
  current: {
    publications: 6,
    aggregates: [
      aggregate({}),
      aggregate({
        comparableGroup: 'reach',
        kind: 'unique',
        additive: false,
        value: null,
        subjectsWithData: 1,
      }),
      aggregate({ comparableGroup: 'rate:engagement/impressions', kind: 'rate', value: 0.05 }),
    ],
    coverage: { subjectsRequested: 6, subjectsWithData: 2, staleValues: 0 },
  },
  previous: { publications: 5, aggregates: [aggregate({ value: 80 })] },
  comparison: [
    { comparableGroup: 'impressions', current: 100, previous: 80, change: 0.25 },
    { comparableGroup: 'rate:engagement/impressions', current: 0.05, previous: null, change: null },
  ],
  sample: { current: 6, previous: 5, minimum: 5, sufficient: true },
  subjectsTotal: 6,
  truncated: false,
  ...over,
});
const value = (over: Partial<MetricValueV1>): MetricValueV1 => ({
  snapshotId: 'ms_1',
  subjectType: 'publication',
  subjectId: 'pub_1',
  metricKey: 'impressionCount',
  comparableGroup: 'impressions',
  value: 10,
  series: null,
  completeness: 'complete',
  freshness: { fetchedAt: '2026-09-29T10:00:00.000Z', ageHours: 2, latencyHours: 6, stale: false },
  source: 'linkedin@v1',
  definitionVersion: 1,
  windowStart: '2026-09-22T00:00:00.000Z',
  windowEnd: '2026-09-29T00:00:00.000Z',
  brandTimezone: 'UTC',
  numeratorSnapshotId: null,
  denominatorSnapshotId: null,
  ...over,
});
const channel = { id: 'cc_1', providerKey: 'linkedin', displayName: 'Acme LinkedIn', status: 'active' };
const pubs = (n: number, channelConnectionId = 'cc_1') =>
  Array.from({ length: n }, (_, i) => ({ publicationId: `pub_${i + 1}`, channelConnectionId }));
const destination = (over: Partial<DestinationV1>): DestinationV1 => ({
  id: 'dst_1',
  brandId: 'brd_1',
  kind: 'ga4_property',
  externalId: 'properties/1',
  displayName: 'Acme web',
  ownerUserId: 'usr_1',
  grantedScopes: [],
  health: 'healthy',
  healthCheckedAt: null,
  capabilityVersion: 1,
  status: 'active',
  reportingTimeZone: null,
  currencyCode: null,
  writeSafety: 'unknown',
  writeSafetyCheckedAt: null,
  articleSelector: null,
  version: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});
const report = (over: Partial<DestinationReportSummaryV1> = {}): DestinationReportSummaryV1 => ({
  brandId: 'brd_1',
  destinationId: 'dst_1',
  kind: 'ga4_property',
  presentation: {
    console: { label: 'Google Analytics', href: 'https://analytics.google.com/' },
    tiles: { reportKey: 'ga4.engagement', metrics: ['sessions', 'engagementRate', 'averageSessionDuration'] },
  },
  policy: { allowed: true, reason: 'allowed', dataType: 'ga4.reports' },
  windowStart: '2026-09-22',
  windowEnd: '2026-09-28',
  reports: [
    {
      reportKey: 'ga4.engagement',
      label: 'Engagement',
      dimensions: [],
      metrics: [
        { name: 'sessions', label: 'Sessions', kind: 'flow' },
        { name: 'engagedSessions', label: 'Engaged sessions', kind: 'flow' },
        { name: 'averageSessionDuration', label: 'Avg. session duration', kind: 'gauge', weight: 'sessions' },
      ],
      derived: [
        {
          name: 'engagementRate',
          label: 'Engagement rate',
          kind: 'rate',
          numerator: 'engagedSessions',
          denominator: 'sessions',
        },
      ],
      freshness: {
        latestDate: '2026-09-28',
        fetchedAt: NOW.toISOString(),
        ageHours: 12,
        latencyHours: 48,
        stale: false,
      },
      quality: { timeZone: null, asOfLocalDate: '2026-09-28', provisional: false, flags: [] },
      current: {
        windowStart: '2026-09-22',
        windowEnd: '2026-09-28',
        days: 7,
        rows: 7,
        metrics: { sessions: 700, engagedSessions: 350, averageSessionDuration: 61.5, engagementRate: 0.5 },
      },
      previous: {
        windowStart: '2026-09-15',
        windowEnd: '2026-09-21',
        days: 7,
        rows: 7,
        metrics: { sessions: 500, engagedSessions: 200, averageSessionDuration: 50, engagementRate: 0.4 },
      },
      comparison: [
        { metric: 'sessions', kind: 'flow', current: 700, previous: 500, change: 0.4 },
        { metric: 'engagedSessions', kind: 'flow', current: 350, previous: 200, change: 0.75 },
        { metric: 'engagementRate', kind: 'rate', current: 0.5, previous: 0.4, change: 0.25 },
      ],
      sample: { current: 7, previous: 7, minimum: 5, sufficient: true },
    },
  ],
  computedAt: NOW.toISOString(),
  ...over,
});
const audit = (over: Partial<SeoAuditSummaryV1> = {}): SeoAuditSummaryV1 => ({
  brandId: 'brd_1',
  destinationId: 'dst_cms',
  origin: 'https://acme.example',
  policy: { allowed: true, reason: 'allowed', dataType: 'cms.audit' },
  canRun: true,
  canCreateWork: true,
  running: false,
  lastRun: {
    id: 'sar_1',
    brandId: 'brd_1',
    destinationId: 'dst_cms',
    origin: 'https://acme.example',
    trigger: 'scheduled',
    startedAt: '2026-09-28T05:00:00.000Z',
    finishedAt: '2026-09-28T05:10:00.000Z',
    outcome: 'completed',
    reason: null,
    pagesCrawled: 40,
    limitsHit: [],
    summary: { critical: 1, major: 2, minor: 3, byCheck: {} },
  },
  data: { kind: 'lab', note: 'lab data only; field data not connected' },
  fieldData: null,
  computedAt: NOW.toISOString(),
  ...over,
});
const cms = destination({ id: 'dst_cms', kind: 'cms_site', displayName: 'acme.example' });

describe('social figures (UX-11 rollup under D-14 and D-15)', () => {
  it('lists the window groups in reading order with the comparison, the sample and the source label', () => {
    const figures = socialFigures(brandSummary());
    expect(figures.map((f) => f.key)).toEqual(['impressions', 'reach', 'rate:engagement/impressions']);
    expect(figures[0]).toMatchObject({
      label: 'Impressions',
      kind: 'flow',
      value: 100,
      previous: 80,
      change: 0.25,
      sufficient: true,
      coverage: { requested: 6, withData: 2, unit: 'posts' },
      freshness: { asOf: '2026-09-29T10:00:00.000Z', ageHours: 2, latencyHours: 6, stale: false },
      source: { kind: 'social' },
      note: null,
    });
    // A unique count is listed, never summed (D-15): no value, the dictionary's words beside it.
    expect(figures[1]).toMatchObject({
      value: null,
      change: null,
      note: 'unique people: never summed across posts',
    });
    expect(figures[2]).toMatchObject({ kind: 'rate', value: 0.05, previous: null, change: null });
  });
  it('an insufficient sample carries no change (D-14) and the rollup keeps the oldest freshness', () => {
    const summary = brandSummary({
      sample: { current: 3, previous: 5, minimum: 5, sufficient: false },
      comparison: [{ comparableGroup: 'impressions', current: 100, previous: 80, change: null }],
    });
    const social = socialOf(summary);
    expect(social.figures[0]).toMatchObject({ change: null, previous: 80, sufficient: false });
    expect(social.freshness).toMatchObject({ ageHours: 2, stale: false });
    expect(social.ageDays).toBeNull();
  });
});

describe('channel source state (coverage and freshness per channel)', () => {
  const min = 5;
  it('a channel that needs reconnecting is not connected, whatever the window holds', () => {
    const s = channelSource({ ...channel, status: 'reconnect_needed' }, pubs(6), pubs(5), [value({})], min);
    expect(s).toMatchObject({ state: 'not_connected', kind: 'channel', platform: 'linkedin' });
    expect(s.reason).toContain('reconnect needed');
  });
  it('nothing published, then published but not yet measured, read as no data with the reason', () => {
    expect(channelSource(channel, [], [], [], min)).toMatchObject({
      state: 'no_data',
      reason: 'nothing published on this channel in the window',
      coverage: { requested: 0, withData: 0 },
      freshness: null,
    });
    const unmeasured = channelSource(
      channel,
      pubs(2),
      [],
      [value({ value: null, completeness: 'unavailable' })],
      min,
    );
    expect(unmeasured.state).toBe('no_data');
    expect(unmeasured.reason).toContain('2 posts published, no number returned yet');
  });
  it('stale beats insufficient sample beats fresh; the sample is the channel’s own posts on both sides', () => {
    const stale = channelSource(
      channel,
      pubs(6),
      pubs(5),
      [
        value({}),
        value({
          subjectId: 'pub_2',
          freshness: { fetchedAt: '2026-09-28T00:00:00.000Z', ageHours: 36, latencyHours: 6, stale: true },
        }),
      ],
      min,
    );
    expect(stale).toMatchObject({ state: 'stale', freshness: { ageHours: 36, stale: true } });
    expect(stale.reason).toBe('oldest value 36 h old, beyond 6 h × 2');
    const thin = channelSource(channel, pubs(2), pubs(5), [value({})], min);
    expect(thin).toMatchObject({
      state: 'insufficient_sample',
      sample: { current: 2, previous: 5, minimum: 5, sufficient: false },
    });
    const fresh = channelSource(channel, pubs(6), pubs(5), [value({}), value({ subjectId: 'pub_2' })], min);
    expect(fresh).toMatchObject({
      state: 'fresh',
      reason: '2 of 6 posts have numbers',
      coverage: { requested: 6, withData: 2, unit: 'posts' },
      freshness: { asOf: '2026-09-29T10:00:00.000Z', latencyHours: 6, stale: false },
    });
  });
  it('only this channel’s posts count: another channel’s values never leak into its coverage', () => {
    const s = channelSource(
      channel,
      [...pubs(1), ...pubs(1, 'cc_other')],
      [],
      [value({ subjectId: 'pub_1' })],
      min,
    );
    expect(s.coverage).toEqual({ requested: 1, withData: 1, unit: 'posts' });
  });
});

describe('web source (destinations.reports.summary) and its figures', () => {
  it('the adapter’s tile metrics become figures with their source, comparison and days of coverage', () => {
    const figures = webFigures(report(), { kind: 'web', id: 'dst_1', label: 'Acme web', platform: 'GA4' }, 7);
    expect(figures.map((f) => f.key)).toEqual(['sessions', 'engagementRate', 'averageSessionDuration']);
    expect(figures[0]).toMatchObject({
      label: 'Sessions',
      kind: 'flow',
      value: 700,
      previous: 500,
      change: 0.4,
      coverage: { requested: 7, withData: 7, unit: 'days' },
      freshness: { asOf: '2026-09-28T23:59:59.999Z', latencyHours: 48, stale: false },
      source: { kind: 'web', id: 'dst_1' },
    });
    expect(figures[2]).toMatchObject({ kind: 'gauge', change: null, note: 'weighted mean, not compared' });
  });
  it('a policy that forbids reads is blocked with the reason and carries no figure', () => {
    const { entry, source } = webSourceOf(
      destination({}),
      report({ policy: { allowed: false, reason: 'no_policy', dataType: 'ga4.reports' }, reports: [] }),
      7,
    );
    expect(source).toMatchObject({ state: 'blocked', platform: 'Google Analytics 4 property' });
    expect(source.reason).toBe('reads not allowed by the source-use policy (no policy for ga4.reports)');
    expect(entry.figures).toEqual([]);
    expect(entry.console?.href).toBe('https://analytics.google.com/');
  });
  it('no data, stale, insufficient sample and fresh, in that precedence', () => {
    const base = report();
    const entry = base.reports[0]!;
    const none = report({
      reports: [{ ...entry, freshness: { ...entry.freshness, latestDate: null, ageHours: null } }],
    });
    expect(webSourceOf(destination({}), none, 7).source.state).toBe('no_data');
    const stale = report({
      reports: [{ ...entry, freshness: { ...entry.freshness, ageHours: 120, stale: true } }],
    });
    expect(webSourceOf(destination({}), stale, 7).source).toMatchObject({
      state: 'stale',
      reason: 'latest day 120 h old, beyond 48 h × 2',
    });
    const thin = report({
      reports: [{ ...entry, sample: { current: 7, previous: 0, minimum: 5, sufficient: false } }],
    });
    expect(webSourceOf(destination({}), thin, 7).source).toMatchObject({
      state: 'insufficient_sample',
      reason: 'fresh; 7 and 0 days of 5 needed to compare',
    });
    expect(webSourceOf(destination({}), base, 7).source).toMatchObject({
      state: 'fresh',
      reason: 'as of 2026-09-28, UTC days · 7 of 7 days',
      coverage: { requested: 7, withData: 7, unit: 'days' },
      freshness: { timeZone: null, provisional: false },
    });
  });
  it('RA-10: the reporting zone and a provisional latest day are stated with the coverage, never hidden', () => {
    const base = report();
    const entry = base.reports[0]!;
    const zoned = report({
      reports: [
        {
          ...entry,
          quality: {
            timeZone: 'Africa/Johannesburg',
            asOfLocalDate: '2026-09-28',
            provisional: true,
            flags: ['sampled', 'partial_day'],
          },
        },
      ],
    });
    expect(webSourceOf(destination({}), zoned, 7).source).toMatchObject({
      state: 'fresh',
      reason: 'as of 2026-09-28, Africa/Johannesburg, provisional · 7 of 7 days',
      freshness: {
        asOf: '2026-09-28T21:59:59.999Z', // the day ends in Johannesburg, two hours before UTC does
        timeZone: 'Africa/Johannesburg',
        provisional: true,
      },
    });
    expect(
      webFigures(zoned, { kind: 'web', id: 'dst_1', label: 'Acme web', platform: 'GA4' }, 7)[0],
    ).toMatchObject({ freshness: { timeZone: 'Africa/Johannesburg', provisional: true } });
  });
});

describe('audit source (destinations.audit.summary)', () => {
  it('a completed run within the weekly cadence is fresh with its tiles in the reason', () => {
    const { entry, source } = auditSourceOf(cms, audit(), NOW);
    expect(source).toMatchObject({
      state: 'fresh',
      reason: '40 pages crawled · 1 critical, 2 major, 3 minor',
      coverage: { requested: 40, withData: 40, unit: 'pages' },
      freshness: {
        asOf: '2026-09-28T05:10:00.000Z',
        latencyHours: OVERVIEW_AUDIT_LATENCY_HOURS,
        stale: false,
      },
    });
    expect(entry.fieldData).toBeNull();
  });
  it('blocked, none yet, running first, failed, stale', () => {
    expect(
      auditSourceOf(
        cms,
        audit({ policy: { allowed: false, reason: 'review_overdue', dataType: 'cms.audit' }, lastRun: null }),
        NOW,
      ).source,
    ).toMatchObject({
      state: 'blocked',
      reason: 'reads not allowed by the source-use policy (review overdue for cms.audit)',
    });
    expect(auditSourceOf(cms, audit({ lastRun: null }), NOW).source.reason).toContain('no audit yet');
    expect(auditSourceOf(cms, audit({ lastRun: null, running: true }), NOW).source.reason).toBe(
      'the first audit is running',
    );
    const failed = audit();
    failed.lastRun = { ...failed.lastRun!, outcome: 'failed', reason: 'origin_unreachable' };
    expect(auditSourceOf(cms, failed, NOW).source).toMatchObject({
      state: 'no_data',
      reason: 'the last run failed (origin unreachable); no completed audit',
    });
    const old = audit();
    old.lastRun = { ...old.lastRun!, finishedAt: '2026-09-01T05:10:00.000Z' };
    expect(auditSourceOf(cms, old, NOW).source.state).toBe('stale');
  });
});

describe('splits and limits', () => {
  it('paid and native are stated as limits, never figures; separating definitions are named', () => {
    const social = socialOf(brandSummary());
    const splits = splitsOf(social, [
      { key: 'impressionCount', separatesPaidOrganic: false },
      { key: 'page_media_view', separatesPaidOrganic: true },
    ]);
    expect(splits.organicVsPaid.organic.publications).toBe(6);
    expect(splits.organicVsPaid.paid).toMatchObject({
      state: 'not_connected',
      separatingDefinitions: ['page_media_view'],
    });
    expect(splits.organicVsPaid.paid.reason).toContain('R3-4');
    expect(splits.oremediaVsNative.native.state).toBe('not_observed');
  });
  it('every blocker and consent statement is listed once, with its source and the D-19 link', () => {
    const social = socialOf(
      brandSummary({ sample: { current: 3, previous: 5, minimum: 5, sufficient: false } }),
    );
    const blocked = webSourceOf(
      destination({ id: 'dst_gsc', kind: 'search_console_site', displayName: 'Acme site' }),
      report({
        policy: { allowed: false, reason: 'no_policy', dataType: 'gsc.reports' },
        reports: [],
        presentation: null,
      }),
      7,
    );
    const ga4 = webSourceOf(destination({}), report(), 7);
    const site = auditSourceOf(cms, audit(), NOW);
    const notConnected = channelSource({ ...channel, status: 'reconnect_needed' }, [], [], [], 5);
    const stale = channelSource(
      { ...channel, id: 'cc_2', displayName: 'Acme X' },
      pubs(6, 'cc_2'),
      pubs(5, 'cc_2'),
      [
        value({
          freshness: { fetchedAt: '2026-09-27T00:00:00.000Z', ageHours: 60, latencyHours: 6, stale: true },
        }),
      ],
      5,
    );
    const limits = limitsOf({
      sources: [notConnected, stale, blocked.source, ga4.source, site.source],
      web: [blocked.entry, ga4.entry],
      audits: [site.entry],
      social,
      splits: splitsOf(social, []),
      uncertified: [{ kind: 'search_console_site', label: 'Search Console site' }],
    });
    expect(limits.map((l) => l.code)).toEqual([
      'not_connected',
      'policy_blocked',
      'source_uncertified',
      'field_data_not_connected',
      'ai_search_external',
      'paid_not_connected',
      'native_not_observed',
      'insufficient_sample',
      'stale',
      'latest_fetch_comparison',
    ]);
    expect(limits.find((l) => l.code === 'policy_blocked')).toMatchObject({
      statement:
        'Acme site: reads not allowed by the source-use policy (no policy for gsc.reports). Settings → Destinations sets the policy.',
      source: { kind: 'web', id: 'dst_gsc' },
    });
    expect(limits.find((l) => l.code === 'ai_search_external')?.link).toEqual({
      label: 'Open Google Analytics (external)',
      href: 'https://analytics.google.com/',
    });
    expect(limits.find((l) => l.code === 'stale')?.statement).toBe(
      'Acme X: oldest value 60 h old, beyond 6 h × 2.',
    );
    // With a post age asked for, the comparison is at that age (D-14) and the latest-fetch limit is not stated.
    const atAge = limitsOf({
      sources: [],
      web: [],
      audits: [],
      social: socialOf(brandSummary({ ageDays: 7 })),
      splits: splitsOf(social, []),
      uncertified: [],
    });
    expect(atAge.map((l) => l.code)).toEqual(['paid_not_connected', 'native_not_observed']);
  });
});
