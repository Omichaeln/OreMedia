import type { SourceReportMetricV1 } from '@oremedia/contracts/destinations';
import type { SourceCapabilityV1, SourceReportSpec } from '../../source-contract';

/** GA4 standard properties finalise a day's data within 24 to 48 hours; one run asks for at most a quarter. */
const GA4_LATENCY_HOURS = 48;
const GA4_MAX_RANGE_DAYS = 90;

/** The Data API metrics by name with their D-15 kind (docs/contracts/metrics.md, "Web sources"). */
const METRIC: Record<string, SourceReportMetricV1> = {
  sessions: { name: 'sessions', label: 'Sessions', kind: 'flow' },
  // GA4 reports a day's total users per row; summed over days it is user-days, labelled so (never a reach).
  totalUsers: { name: 'totalUsers', label: 'Users (daily, summed)', kind: 'flow' },
  engagedSessions: { name: 'engagedSessions', label: 'Engaged sessions', kind: 'flow' },
  keyEvents: { name: 'keyEvents', label: 'Key events', kind: 'flow' },
  averageSessionDuration: {
    name: 'averageSessionDuration',
    label: 'Avg. session duration (s)',
    kind: 'gauge',
    weight: 'sessions',
  },
};
const ENGAGEMENT_RATE: SourceReportMetricV1 = {
  name: 'engagementRate',
  label: 'Engagement rate',
  kind: 'rate',
  numerator: 'engagedSessions',
  denominator: 'sessions',
};
const metrics = (...names: Array<keyof typeof METRIC>) => names.map((n) => METRIC[n] as SourceReportMetricV1);
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * The Data API reports the sweep reads (R2-1 part B), each one `runReport` call per page with the date dimension
 * first. Metric names are the API's; the dictionary (docs/contracts/metrics.md, "Web sources") says what each is.
 */
export const ga4Reports: SourceReportSpec[] = [
  {
    key: 'ga4.acquisition',
    label: 'Acquisition channels',
    dimensions: ['sessionDefaultChannelGroup'],
    dimensionLabels: { sessionDefaultChannelGroup: 'Channel' },
    metrics: metrics('sessions', 'totalUsers', 'engagedSessions', 'keyEvents'),
    derived: [ENGAGEMENT_RATE],
    latencyHours: GA4_LATENCY_HOURS,
    maxRangeDays: GA4_MAX_RANGE_DAYS,
  },
  {
    key: 'ga4.landing_pages',
    label: 'Landing pages',
    dimensions: ['landingPage'],
    dimensionLabels: { landingPage: 'Landing page' },
    metrics: metrics('sessions', 'engagedSessions', 'keyEvents'),
    derived: [ENGAGEMENT_RATE],
    latencyHours: GA4_LATENCY_HOURS,
    maxRangeDays: GA4_MAX_RANGE_DAYS,
    // A landing page with traffic that engages under half the property's rate is worth a look at its content.
    opportunity: {
      kind: 'low_engagement_page',
      rateMetric: 'engagementRate',
      volumeMetric: 'sessions',
      minVolume: 50,
      task: ({ subject, volume, rate, benchmark }) =>
        `Review the content and next step on landing page ${subject} (${volume} sessions, engagement rate ${pct(rate)} against ${pct(benchmark)} for the property)`,
    },
  },
  {
    key: 'ga4.engagement',
    label: 'Engagement',
    dimensions: [],
    dimensionLabels: {},
    metrics: metrics('sessions', 'engagedSessions', 'averageSessionDuration', 'keyEvents', 'totalUsers'),
    derived: [ENGAGEMENT_RATE],
    latencyHours: GA4_LATENCY_HOURS,
    maxRangeDays: GA4_MAX_RANGE_DAYS,
  },
];

/**
 * Google Analytics 4 property as a read-only source (ledger R2-1). Values from current Google documentation
 * knowledge; the quota figures are re-verified during certification with the deployment's own Cloud project
 * (docs/platform-apps/google.md). `certifiedAt` stays null until then.
 */
export const ga4PropertyCapability: SourceCapabilityV1 = {
  key: 'ga4_property',
  version: 1,
  vendor: 'Google',
  requiredScopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  latencyHours: GA4_LATENCY_HOURS,
  // Analytics Admin API: a per-project quota (requests per minute); the Data API's per-property token quotas apply
  // to the reports of part B, read behind the same limiter under the account scope.
  rateLimits: [
    { scope: 'account', limit: 300, windowSec: 60 },
    { scope: 'app', limit: 600, windowSec: 60 },
  ],
  reports: ga4Reports,
  presentation: {
    console: { label: 'Google Analytics', href: 'https://analytics.google.com/' },
    tiles: {
      reportKey: 'ga4.engagement',
      metrics: ['sessions', 'engagedSessions', 'keyEvents', 'engagementRate'],
    },
  },
  certifiedAt: null,
};
