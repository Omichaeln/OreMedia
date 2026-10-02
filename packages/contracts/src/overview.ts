import { z } from 'zod';
import type { SourceUseCheckReason, WebMetricKind } from './destinations';
import { MetricAgeDays, type MetricFreshness, type MetricKind } from './measurement';
import type { SeoAuditRunV1 } from './seo-audit';

/**
 * R2-5 unified performance overview: one read model that composes, for a brand and a window, the social channels
 * (measurement.metrics.brandSummary and the per-publication query), the web sources (destinations.reports.summary
 * per destination) and the last audit (destinations.audit.summary), each figure with its source label and
 * freshness, a coverage/freshness roll-up per source with the reason for its state, the organic vs paid and
 * Oremedia vs native splits (or their explicit limit), and the consent/blocker statements. Nothing here is a new
 * number: every value is the one its module already reports, under the dictionary's rules (D-14, D-15).
 */
export const OverviewSummary = z.object({
  brandId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  /** D-14: compare at one post age on both sides; omitted, each post's latest fetch stands (and the limit says so). */
  ageDays: MetricAgeDays.optional(),
});
export type OverviewSummary = z.infer<typeof OverviewSummary>;

/** The comparable groups the overview's social tiles read, in reading order (the Performance screen's set). */
export const OVERVIEW_SOCIAL_GROUPS: ReadonlyArray<[group: string, label: string]> = [
  ['impressions', 'Impressions'],
  ['reach', 'Reach'],
  ['engagement', 'Engagement'],
  ['likes', 'Likes and reactions'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
  ['saves', 'Saves'],
  ['clicks', 'Clicks'],
  ['rate:engagement/impressions', 'Engagement rate'],
];
/** The audit's reporting cadence (the weekly sweep, R2-4): a last run older than this × STALE_FACTOR is stale. */
export const OVERVIEW_AUDIT_LATENCY_HOURS = 7 * 24;

/**
 * The state of one source in the roll-up, in order of precedence: a policy that forbids the read, a source that
 * is not connected (or needs reconnecting), a connected source with nothing in the window, stale data, fresh data
 * whose comparison is below the D-14 minimum, fresh data. The reason beside it is the statement a person reads.
 */
export const OverviewSourceState = z.enum([
  'blocked',
  'not_connected',
  'no_data',
  'stale',
  'insufficient_sample',
  'fresh',
]);
export type OverviewSourceState = z.infer<typeof OverviewSourceState>;

/** Where a figure comes from: a social channel, a web destination or a website audit, named for the screen. */
export interface OverviewSourceRefV1 {
  kind: 'channel' | 'web' | 'audit';
  id: string;
  label: string;
  /** The provider key of a channel or the destination kind of a web / audit source. */
  platform: string;
}

/** Freshness of a source, in the dictionary's terms (stale beyond latency × STALE_FACTOR). */
export interface OverviewFreshnessV1 {
  /** The latest fetch (channels, audit) or the latest reported day's end (web); null when nothing was read. */
  asOf: string | null;
  ageHours: number | null;
  latencyHours: number;
  stale: boolean;
}

export interface OverviewSourceV1 extends OverviewSourceRefV1 {
  state: OverviewSourceState;
  reason: string;
  freshness: OverviewFreshnessV1 | null;
  /** What was asked and what came back, in the source's own unit (posts for channels, days for web, pages for audit). */
  coverage: { requested: number; withData: number; unit: 'posts' | 'days' | 'pages' } | null;
  /** D-14 sample on both sides of the comparison; null for a source that compares nothing (the audit). */
  sample: { current: number; previous: number; minimum: number; sufficient: boolean } | null;
  /** The source-use decision of a web or audit source (D-17); null for a channel. */
  policy: { allowed: boolean; reason: SourceUseCheckReason; dataType: string } | null;
}

/** A headline figure: one comparable group or web metric with its previous-window comparison and its source. */
export interface OverviewFigureV1 {
  /** The comparable group (social) or the report metric name (web). */
  key: string;
  label: string;
  kind: MetricKind | WebMetricKind;
  value: number | null;
  previous: number | null;
  /** (current − previous) ÷ previous when the sample suffices on both sides and previous > 0; else null. */
  change: number | null;
  sufficient: boolean;
  sample: { current: number; previous: number; minimum: number };
  /** Posts (social) or days (web) that carried the number, over those asked. */
  coverage: { requested: number; withData: number; unit: 'posts' | 'days' };
  freshness: OverviewFreshnessV1 | null;
  /** The social roll-up spans every channel; a web figure names its destination. */
  source: OverviewSourceRefV1 | { kind: 'social'; label: string };
  /** D-15: why a figure has no total (unique counts, levels and gauges are listed, never summed). */
  note: string | null;
}

export interface OverviewSocialV1 {
  figures: OverviewFigureV1[];
  /** Released channel publications in the window and the one before it (the D-14 sample). */
  sample: { current: number; previous: number; minimum: number; sufficient: boolean };
  /** The whole population of the window: `subjectsRequested` is every released publication, never a newest slice. */
  coverage: {
    subjectsRequested: number;
    subjectsWithData: number;
    staleValues: number;
    subjectsTotal: number;
    truncated: boolean;
  };
  freshness: MetricFreshness | null;
  ageDays: number | null;
}

export interface OverviewWebSourceV1 {
  source: OverviewSourceRefV1;
  policy: { allowed: boolean; reason: SourceUseCheckReason; dataType: string };
  figures: OverviewFigureV1[];
  /** D-19: the vendor console the AI-search row links to; never a figure. */
  console: { label: string; href: string } | null;
}

export interface OverviewAuditV1 {
  source: OverviewSourceRefV1;
  policy: { allowed: boolean; reason: SourceUseCheckReason; dataType: string };
  lastRun: SeoAuditRunV1 | null;
  running: boolean;
  data: { kind: 'lab'; note: string };
  fieldData: null;
}

/**
 * Organic vs paid: the metric dictionary marks a definition that separates paid from organic
 * (`separatesPaidOrganic`), but no paid-media connector is connected (ledger R3-4), so the split is stated as a
 * limit rather than invented. Oremedia vs native: ingestion collects per publication Oremedia released; posts
 * made natively on a platform are not observed, so that side is stated as a limit too.
 */
export interface OverviewPaidSplitV1 {
  organic: { publications: number; note: string };
  paid: { state: 'not_connected'; reason: string; separatingDefinitions: string[] };
}
export interface OverviewNativeSplitV1 {
  oremedia: { publications: number; note: string };
  native: { state: 'not_observed'; reason: string };
}

export const OverviewLimitCode = z.enum([
  'policy_blocked',
  'source_uncertified',
  'not_connected',
  'field_data_not_connected',
  'ai_search_external',
  'paid_not_connected',
  'native_not_observed',
  'insufficient_sample',
  'stale',
  'latest_fetch_comparison',
]);
export type OverviewLimitCode = z.infer<typeof OverviewLimitCode>;

/** A consent or blocker statement: what the overview cannot say and why, with the source it is about. */
export interface OverviewLimitV1 {
  code: OverviewLimitCode;
  statement: string;
  source: OverviewSourceRefV1 | null;
  /** D-19: a labelled external link where the vendor's own report stands in for a figure. */
  link: { label: string; href: string } | null;
}

export interface OverviewSummaryV1 {
  brandId: string;
  windowStart: string;
  windowEnd: string;
  /** The window as the web sources read it: inclusive UTC day keys. */
  days: { start: string; end: string; length: number };
  social: OverviewSocialV1;
  web: OverviewWebSourceV1[];
  audits: OverviewAuditV1[];
  sources: OverviewSourceV1[];
  organicVsPaid: OverviewPaidSplitV1;
  oremediaVsNative: OverviewNativeSplitV1;
  limits: OverviewLimitV1[];
  computedAt: string;
}
