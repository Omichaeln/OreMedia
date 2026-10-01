import type { SourceCapabilityV1, SourceReportSpec } from '../../source-contract';

/** Search analytics data is final about two to three days after the day it covers; one run asks for at most a quarter. */
const GSC_LATENCY_HOURS = 72;
const GSC_MAX_RANGE_DAYS = 90;
const GSC_METRICS = ['clicks', 'impressions', 'ctr', 'position'];

/**
 * The search analytics reports the sweep reads (R2-1 part B): one `searchAnalytics/query` per page with `date`
 * as the first dimension. Metric names are the API's; the dictionary (docs/contracts/metrics.md, "Web sources")
 * says what each is (CTR a rate of clicks over impressions, position a gauge weighted by impressions).
 */
export const searchConsoleReports: SourceReportSpec[] = [
  {
    key: 'gsc.queries',
    dimensions: ['query'],
    metrics: GSC_METRICS,
    latencyHours: GSC_LATENCY_HOURS,
    maxRangeDays: GSC_MAX_RANGE_DAYS,
  },
  {
    key: 'gsc.pages',
    dimensions: ['page'],
    metrics: GSC_METRICS,
    latencyHours: GSC_LATENCY_HOURS,
    maxRangeDays: GSC_MAX_RANGE_DAYS,
  },
  {
    key: 'gsc.countries_devices',
    dimensions: ['country', 'device'],
    metrics: GSC_METRICS,
    latencyHours: GSC_LATENCY_HOURS,
    maxRangeDays: GSC_MAX_RANGE_DAYS,
  },
];

/**
 * Google Search Console site as a read-only source (ledger R2-1). Values from current Google documentation
 * knowledge; quota figures are re-verified during certification (docs/platform-apps/google.md). `certifiedAt`
 * stays null until then.
 */
export const searchConsoleSiteCapability: SourceCapabilityV1 = {
  key: 'search_console_site',
  version: 1,
  vendor: 'Google',
  requiredScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  latencyHours: GSC_LATENCY_HOURS,
  // Search Console API: per-site and per-project query-per-minute quotas.
  rateLimits: [
    { scope: 'account', limit: 200, windowSec: 60 },
    { scope: 'app', limit: 1200, windowSec: 60 },
  ],
  reports: searchConsoleReports,
  certifiedAt: null,
};
