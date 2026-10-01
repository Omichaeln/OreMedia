import type { SourceCapabilityV1, SourceReportSpec } from '../../source-contract';

/** GA4 standard properties finalise a day's data within 24 to 48 hours; one run asks for at most a quarter. */
const GA4_LATENCY_HOURS = 48;
const GA4_MAX_RANGE_DAYS = 90;

/**
 * The Data API reports the sweep reads (R2-1 part B), each one `runReport` call per page with the date dimension
 * first. Metric names are the API's; the dictionary (docs/contracts/metrics.md, "Web sources") says what each is.
 */
export const ga4Reports: SourceReportSpec[] = [
  {
    key: 'ga4.acquisition',
    dimensions: ['sessionDefaultChannelGroup'],
    metrics: ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents'],
    latencyHours: GA4_LATENCY_HOURS,
    maxRangeDays: GA4_MAX_RANGE_DAYS,
  },
  {
    key: 'ga4.landing_pages',
    dimensions: ['landingPage'],
    metrics: ['sessions', 'engagedSessions', 'keyEvents'],
    latencyHours: GA4_LATENCY_HOURS,
    maxRangeDays: GA4_MAX_RANGE_DAYS,
  },
  {
    key: 'ga4.engagement',
    dimensions: [],
    metrics: ['sessions', 'engagedSessions', 'averageSessionDuration', 'keyEvents', 'totalUsers'],
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
  certifiedAt: null,
};
