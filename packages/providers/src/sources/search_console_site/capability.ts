import type { SourceReportMetricV1 } from '@oremedia/contracts/destinations';
import type {
  SourceCapabilityV1,
  SourceReportOpportunitySpec,
  SourceReportSpec,
} from '../../source-contract';

/** Search analytics data is final about two to three days after the day it covers; one run asks for at most a quarter. */
const GSC_LATENCY_HOURS = 72;
const GSC_MAX_RANGE_DAYS = 90;
/** The search analytics metrics with their D-15 kind: CTR pools clicks over impressions, position weighs by impressions. */
const GSC_METRICS: SourceReportMetricV1[] = [
  { name: 'clicks', label: 'Clicks', kind: 'flow' },
  { name: 'impressions', label: 'Impressions', kind: 'flow' },
  { name: 'ctr', label: 'CTR', kind: 'rate', numerator: 'clicks', denominator: 'impressions' },
  { name: 'position', label: 'Position', kind: 'gauge', weight: 'impressions' },
];
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
/** A query or page shown often whose CTR is under half the site's: its title and description are worth rewriting. */
const lowCtr = (
  kind: SourceReportOpportunitySpec['kind'],
  what: (subject: string) => string,
): SourceReportOpportunitySpec => ({
  kind,
  rateMetric: 'ctr',
  volumeMetric: 'impressions',
  minVolume: 100,
  task: ({ subject, volume, rate, benchmark }) =>
    `Rewrite the title and description of ${what(subject)} (${volume} impressions, CTR ${pct(rate)} against ${pct(benchmark)} for the site)`,
});

/**
 * The search analytics reports the sweep reads (R2-1 part B): one `searchAnalytics/query` per page with `date`
 * as the first dimension. Metric names are the API's; the dictionary (docs/contracts/metrics.md, "Web sources")
 * says what each is (CTR a rate of clicks over impressions, position a gauge weighted by impressions).
 */
export const searchConsoleReports: SourceReportSpec[] = [
  {
    key: 'gsc.queries',
    label: 'Queries',
    dimensions: ['query'],
    dimensionLabels: { query: 'Query' },
    metrics: GSC_METRICS,
    derived: [],
    latencyHours: GSC_LATENCY_HOURS,
    maxRangeDays: GSC_MAX_RANGE_DAYS,
    opportunity: lowCtr('low_ctr_query', (subject) => `the page ranking for "${subject}"`),
  },
  {
    key: 'gsc.pages',
    label: 'Pages',
    dimensions: ['page'],
    dimensionLabels: { page: 'Page' },
    metrics: GSC_METRICS,
    derived: [],
    latencyHours: GSC_LATENCY_HOURS,
    maxRangeDays: GSC_MAX_RANGE_DAYS,
    opportunity: lowCtr('low_ctr_page', (subject) => subject),
  },
  {
    key: 'gsc.countries_devices',
    label: 'Countries and devices',
    dimensions: ['country', 'device'],
    dimensionLabels: { country: 'Country', device: 'Device' },
    metrics: GSC_METRICS,
    derived: [],
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
  presentation: {
    console: { label: 'Search Console', href: 'https://search.google.com/search-console' },
    tiles: { reportKey: 'gsc.countries_devices', metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  },
  certifiedAt: null,
};
