import type { SourceReportMetricV1 } from '@oremedia/contracts/destinations';
import type { SourceCapabilityV1, SourceReportSpec } from '../../source-contract';

/**
 * Business Profile Performance data lands a few days behind the day it covers (Google documents a lag of up to
 * five days before a day's figures are final); one run asks for at most a quarter.
 */
const GBP_LATENCY_HOURS = 120;
const GBP_MAX_RANGE_DAYS = 90;
/** The deployment opt-in: the owner applies for Business Profile API access separately and enables the kind once granted. */
export const GBP_ENABLE_SETTING = 'OREMEDIA_ENABLE_GBP';

/**
 * The Performance API's daily metrics as the rows carry them (docs/contracts/metrics.md, "Local sources"): the
 * four impression surfaces are summed into `impressions` by the adapter (the API reports each surface on its own);
 * every other metric is one API metric. All are flows (D-15): summed over days.
 */
const METRIC: Record<string, SourceReportMetricV1> = {
  impressions: { name: 'impressions', label: 'Impressions', kind: 'flow' },
  websiteClicks: { name: 'websiteClicks', label: 'Website clicks', kind: 'flow' },
  callClicks: { name: 'callClicks', label: 'Calls', kind: 'flow' },
  directionRequests: { name: 'directionRequests', label: 'Direction requests', kind: 'flow' },
  conversations: { name: 'conversations', label: 'Conversations', kind: 'flow' },
  bookings: { name: 'bookings', label: 'Bookings', kind: 'flow' },
};
const WEBSITE_CLICK_RATE: SourceReportMetricV1 = {
  name: 'websiteClickRate',
  label: 'Website click rate',
  kind: 'rate',
  numerator: 'websiteClicks',
  denominator: 'impressions',
};
const metrics = (...names: Array<keyof typeof METRIC>) => names.map((n) => METRIC[n] as SourceReportMetricV1);

/** The API's daily metric names behind each row metric; the four impression surfaces add up to `impressions`. */
export const GBP_IMPRESSION_METRICS: Readonly<Record<string, string>> = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'Desktop Maps',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'Desktop Search',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'Mobile Maps',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'Mobile Search',
};
export const GBP_ACTION_METRICS: Readonly<Record<string, string>> = {
  WEBSITE_CLICKS: 'websiteClicks',
  CALL_CLICKS: 'callClicks',
  BUSINESS_DIRECTION_REQUESTS: 'directionRequests',
  BUSINESS_CONVERSATIONS: 'conversations',
  BUSINESS_BOOKINGS: 'bookings',
};

/**
 * The Performance API reports the sweep reads (ledger R2-2, read-only slice): one `fetchMultiDailyMetricsTimeSeries`
 * call per report and range (the API pages nothing: a range is answered whole, at most ten metrics per call).
 * A destination is one location, so `gbp.performance` carries the day alone; `gbp.surfaces` splits the impressions
 * by the surface they were served on. No opportunity rule: the read model benchmarks a subject against the
 * destination's own pooled rate, and a single location has nothing to be compared with.
 */
export const gbpReports: SourceReportSpec[] = [
  {
    key: 'gbp.performance',
    label: 'Profile performance',
    dimensions: [],
    dimensionLabels: {},
    metrics: metrics(
      'impressions',
      'websiteClicks',
      'callClicks',
      'directionRequests',
      'conversations',
      'bookings',
    ),
    derived: [WEBSITE_CLICK_RATE],
    latencyHours: GBP_LATENCY_HOURS,
    maxRangeDays: GBP_MAX_RANGE_DAYS,
  },
  {
    key: 'gbp.surfaces',
    label: 'Impressions by surface',
    dimensions: ['surface'],
    dimensionLabels: { surface: 'Surface' },
    metrics: metrics('impressions'),
    derived: [],
    latencyHours: GBP_LATENCY_HOURS,
    maxRangeDays: GBP_MAX_RANGE_DAYS,
  },
];

/**
 * Google Business Profile location as a read-only source (ledger R2-2, D-17: reads only, no retention by default,
 * reviews, posts and replies out of scope). Values from current Google documentation knowledge; the quota figures
 * are re-verified during certification with the deployment's own Cloud project once Google grants Business
 * Profile API access (docs/platform-apps/google.md). `certifiedAt` stays null until then, and the kind is offered
 * only where the deployment sets OREMEDIA_ENABLE_GBP=1 beside its app credentials.
 */
export const gbpLocationCapability: SourceCapabilityV1 = {
  key: 'gbp_location',
  version: 1,
  vendor: 'Google',
  requiredScopes: ['https://www.googleapis.com/auth/business.manage'],
  latencyHours: GBP_LATENCY_HOURS,
  // The Business Profile APIs share a low per-project quota (requests per minute); every call of this adapter
  // counts against it, so the account and app scopes are both kept well under it.
  rateLimits: [
    { scope: 'account', limit: 60, windowSec: 60 },
    { scope: 'app', limit: 240, windowSec: 60 },
  ],
  reports: gbpReports,
  presentation: {
    console: { label: 'Google Business Profile', href: 'https://business.google.com/' },
    tiles: {
      reportKey: 'gbp.performance',
      metrics: ['impressions', 'websiteClicks', 'callClicks', 'directionRequests'],
    },
  },
  optInSetting: GBP_ENABLE_SETTING,
  certifiedAt: null,
};
