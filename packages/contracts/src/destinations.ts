import { z } from 'zod';
import type { ActivityHooks } from './agents';
import type { ErrorDetail } from './errors';
import { TenantContextInput } from './tenancy';

/**
 * Brand destinations (ledger R2-0): the non-social places a brand reads from or writes to (an analytics property,
 * a Search Console site, a Business Profile location, a website CMS, a Discord webhook), with who connected
 * them, what the grant covers, their last known health and the capability version they were registered under.
 * Source-use policies (D-17) say, per destination kind and data type, what the product may do with the data
 * (`read` through a restricted view, `retain` a copy for a bounded time, `write` back to the destination), as a
 * versioned record with a review date; a use without a current policy is refused.
 */
export const DestinationKind = z.enum([
  'ga4_property',
  'search_console_site',
  'gbp_location',
  'cms_site',
  'discord_webhook',
]);
export type DestinationKind = z.infer<typeof DestinationKind>;

export const DestinationHealth = z.enum(['unknown', 'healthy', 'degraded', 'unreachable']);
export type DestinationHealth = z.infer<typeof DestinationHealth>;

export const DestinationStatus = z.enum(['active', 'disconnected']);
export type DestinationStatus = z.infer<typeof DestinationStatus>;

export const SourceUse = z.enum(['read', 'retain', 'write']);
export type SourceUse = z.infer<typeof SourceUse>;

/** A data type a policy covers, namespaced by its source: `ga4.reports`, `gbp.reviews`, `cms.articles`. */
export const SourceUseDataType = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
  .max(80);

/**
 * What each kind of destination can be used for; the only place the kinds differ. Every service and UI rule reads
 * it generically: a policy may allow only the uses listed here. gbp_location is read-only with no retention
 * (D-17: no permanent ingestion, writes off); cms_site reads and writes (D-16) and may retain its audit runs
 * (R2-4, `cms.audit`); a Discord webhook only writes (D-18: announcements, no inbound).
 */
export const DESTINATION_KIND_CAPABILITIES: Readonly<
  Record<DestinationKind, { label: string; uses: readonly SourceUse[]; auditable?: true }>
> = {
  ga4_property: { label: 'Google Analytics 4 property', uses: ['read', 'retain'] },
  search_console_site: { label: 'Search Console site', uses: ['read', 'retain'] },
  gbp_location: { label: 'Google Business Profile location', uses: ['read'] },
  // `auditable`: the kind the technical SEO audit (R2-4) crawls; the overview lists its last run (R2-5).
  cms_site: { label: 'Website CMS', uses: ['read', 'retain', 'write'], auditable: true },
  discord_webhook: { label: 'Discord webhook', uses: ['write'] },
};

/** Never the credential reference: a destination DTO carries identity, scopes, health and state only. */
export interface DestinationV1 {
  id: string;
  brandId: string;
  kind: DestinationKind;
  externalId: string;
  displayName: string;
  ownerUserId: string;
  grantedScopes: string[];
  health: DestinationHealth;
  healthCheckedAt: string | null;
  capabilityVersion: number;
  status: DestinationStatus;
  /** RA-10: the zone the source reports its days in and its currency, once the sweep has learnt them; else null. */
  reportingTimeZone: string | null;
  currencyCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceUsePolicyV1 {
  id: string;
  brandId: string;
  destinationKind: DestinationKind;
  dataType: string;
  allowedUses: SourceUse[];
  retentionDays: number | null;
  version: number;
  reviewedAt: string;
  reviewDueAt: string;
  reviewedById: string;
  createdAt: string;
  updatedAt: string;
}

// ---- router DTOs (destinations.*) ----

/** A brand has a handful of destinations: the list is not paged. */
export const DestinationList = z.object({ brandId: z.string(), kind: DestinationKind.optional() });
export const DestinationGet = z.object({ brandId: z.string(), destinationId: z.string() });
export const DestinationRegister = z.object({
  brandId: z.string(),
  kind: DestinationKind,
  externalId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  grantedScopes: z.array(z.string().max(200)).max(50).default([]),
  capabilityVersion: z.number().int().min(1).default(1),
});
export const DestinationSetHealth = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  health: DestinationHealth,
  expectedVersion: z.number().int(),
});
export const DestinationDisconnect = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  expectedVersion: z.number().int(),
});

export const SourceUsePolicyList = z.object({
  brandId: z.string(),
  destinationKind: DestinationKind.optional(),
});
/** Retention is bounded: at most ten years, and only when `retain` is allowed. */
export const SOURCE_USE_RETENTION_MAX_DAYS = 3650;
export const SourceUsePolicySet = z.object({
  brandId: z.string(),
  destinationKind: DestinationKind,
  dataType: SourceUseDataType,
  allowedUses: z.array(SourceUse).max(3),
  retentionDays: z.number().int().min(1).max(SOURCE_USE_RETENTION_MAX_DAYS).nullable().optional(),
  reviewDueAt: z.string().datetime(),
  /** Required when a policy for the (kind, data type) already exists; its version then moves on. */
  expectedVersion: z.number().int().optional(),
});
export const SourceUseCheck = z.object({
  brandId: z.string(),
  destinationKind: DestinationKind,
  dataType: SourceUseDataType,
  use: SourceUse,
});

/**
 * The pure rules of a source-use policy (the service and the UI mock apply them, the unit test proves them): every
 * allowed use is one the kind offers, and `retain` carries a retention period. Empty when the policy is valid.
 */
export function sourceUseIssues(
  kind: DestinationKind,
  allowedUses: readonly SourceUse[],
  retentionDays: number | null | undefined,
): ErrorDetail[] {
  const capable = DESTINATION_KIND_CAPABILITIES[kind].uses;
  const issues: ErrorDetail[] = allowedUses
    .filter((u, i) => allowedUses.indexOf(u) === i && !capable.includes(u))
    .map((u) => ({ path: 'allowedUses', issue: `${u}_not_supported_by_${kind}` }));
  if (allowedUses.includes('retain') && !retentionDays)
    issues.push({ path: 'retentionDays', issue: 'required_for_retain' });
  return issues;
}

// ---- connect flow (R2-1 part A): a Google grant attached to a new destination ----

/** `connect.start`: the source adapter's authorisation URL for a kind with a certified, enabled source adapter. */
export const DestinationConnectStart = z.object({
  brandId: z.string(),
  kind: DestinationKind,
  /** As for channels: used only where the server has no public web origin (development, tests). */
  redirectUri: z.string().url().optional(),
});
export const DestinationConnectComplete = z.object({ state: z.string(), code: z.string() });
export const DestinationConnectSelect = z.object({
  pendingId: z.string().max(32),
  externalId: z.string().min(1).max(200),
});
export const DestinationConnectCancel = z.object({ pendingId: z.string().max(32) });

/** One remote thing the grant can read: names only, never tokens. */
export interface DestinationConnectTarget {
  externalId: string;
  displayName: string;
}
/**
 * `connect.complete`'s answer: nothing is registered yet; the person confirms one target with `select`, even when
 * the grant can read only one.
 */
export interface DestinationConnectChoice {
  pendingId: string;
  brandId: string;
  kind: DestinationKind;
  targets: DestinationConnectTarget[];
  expiresAt: string;
}

/** `sources.list`: a kind with a registered source adapter, whether it is certified and enabled on this deployment. */
export interface DestinationSourceV1 {
  kind: DestinationKind;
  label: string;
  /** The platform the person authorises at (from the adapter's capability), for the screen's copy. */
  vendor: string;
  certified: boolean;
  /** App credentials configured and the kind not listed in OREMEDIA_DISABLED_SOURCES. */
  enabled: boolean;
  /** How it connects (R2-3, appended): a vendor OAuth flow, or a site address with an integration secret. */
  connect?: 'oauth' | 'secret';
  /** For a secret connect: what the secret is called and where it comes from (the adapter's capability). */
  credential?: { label: string; hint: string };
}

// ---- destinationTokenRefreshWorkflowV1 (task queue `core`) ----

/** The daily refresh is platform-level (it spans tenants like the retention sweep); a schedule starts it with fixed args. */
export const DestinationTokenRefreshArgsV1 = z.object({
  correlationId: z.string().optional(),
  now: z.string().datetime().optional(),
  /** Destinations whose token expires within this many hours of `now` are refreshed (default 24). */
  withinHours: z.number().int().positive().optional(),
});
export type DestinationTokenRefreshArgsV1 = z.infer<typeof DestinationTokenRefreshArgsV1>;
export interface DestinationTokenRefreshInputV1 {
  correlationId: string;
  now: string;
  withinHours: number;
}
/** A destination due for refresh: references only (spec 14.7 R5). */
export interface DestinationRefreshRefV1 {
  tenantId: string;
  destinationId: string;
}
export const DestinationRefreshInputV1 = TenantContextInput.extend({ destinationId: z.string() });
export type DestinationRefreshInputV1 = z.infer<typeof DestinationRefreshInputV1>;
export type DestinationRefreshResultV1 =
  | { ok: true; tokenExpiresAt: string | null }
  | { ok: false; reason: 'locked' | 'transient' | 'reconnect_required' | 'not_active' };
export interface DestinationRefreshActivitiesV1 {
  listDueDestinationRefreshes(input: DestinationTokenRefreshInputV1): Promise<DestinationRefreshRefV1[]>;
  refreshDestinationCredential(input: DestinationRefreshInputV1): Promise<DestinationRefreshResultV1>;
}
/** The module-side implementation the activities wrap (tenant context is established by the activity host). */
export type DestinationRefreshRuntimeV1 = DestinationRefreshActivitiesV1;

export const SourceUseCheckReason = z.enum(['no_policy', 'not_allowed', 'review_overdue', 'allowed']);
export type SourceUseCheckReason = z.infer<typeof SourceUseCheckReason>;
export interface SourceUseCheckResult {
  allowed: boolean;
  reason: SourceUseCheckReason;
  policy: SourceUsePolicyV1 | null;
}

// ---- source reports (R2-1 part B): what the daily sweep stores per destination and the read model over it ----

/** The source-use data type a report key's prefix names: `ga4.acquisition` → `ga4.reports`. */
export const reportDataType = (reportKey: string): string => `${reportKey.split('.')[0]}.reports`;

/**
 * Working default under D-17 while a policy allows `read` without `retain`: the rows are an operational cache
 * (the screen reads the last days; nothing older than this is kept). With `retain`, the policy's retentionDays
 * applies instead.
 */
export const REPORT_CACHE_DAYS = 7;
/** A first run reads this many days; later runs read from the last stored day minus the report's latency. */
export const REPORT_FIRST_RUN_DAYS = 28;

/**
 * What a web metric is (D-15, docs/contracts/metrics.md "Web sources"): each source adapter describes the metrics
 * of its reports with one of these, and the kind decides the aggregate. Generic code reads the descriptors; it
 * never names a vendor's metric.
 */
export type WebMetricKind = 'flow' | 'rate' | 'gauge';
export interface SourceReportMetricV1 {
  /** The platform's metric name as the rows carry it (and, for a derived rate, the key it is reported under). */
  name: string;
  label: string;
  kind: WebMetricKind;
  /** A rate pools Σ numerator ÷ Σ denominator; a gauge is a mean weighted by `weight` (absent: a plain mean). */
  numerator?: string;
  denominator?: string;
  weight?: string;
}

/**
 * RA-10: what a fetched report says about its own completeness, as the source adapter exposes it (never inferred):
 * `sampled` (the platform answered from a sample), `thresholded` (rows withheld below a privacy threshold),
 * `data_loss` (rows folded into an "other" row), `not_final` (the platform marks the data as not yet final); the
 * sweep adds `partial_day` to a day that had not ended in the reporting zone when it was read.
 */
export const SourceReportQualityFlag = z.enum([
  'sampled',
  'thresholded',
  'data_loss',
  'not_final',
  'partial_day',
]);
export type SourceReportQualityFlag = z.infer<typeof SourceReportQualityFlag>;
/** The zone and currency of a report target, as its adapter reads them from the platform (null: not exposed). */
export interface SourceTargetMetadataV1 {
  reportingTimeZone: string | null;
  currencyCode: string | null;
}
/**
 * The quality of a report's stored window as the read model states it: the zone its days are keyed in (null for
 * UTC days stored before the zone was known), the latest local day it reads "as of", whether that day may still
 * move (inside the report's latency, flagged partial, or not final) and the flags the window carries.
 */
export interface DestinationReportQualityV1 {
  timeZone: string | null;
  asOfLocalDate: string | null;
  provisional: boolean;
  flags: SourceReportQualityFlag[];
}

/** A report's descriptor by name, among its fetched metrics and the rates derived from them. */
export const webMetricByName = (
  metrics: readonly SourceReportMetricV1[],
  derived: readonly SourceReportMetricV1[],
  name: string,
): SourceReportMetricV1 | undefined => [...metrics, ...derived].find((m) => m.name === name);

/**
 * The sums one aggregate needs (the repository computes them in SQL, the UI mock in memory): Σ of every flow and
 * ratio operand, and for a gauge Σ value × weight beside Σ weight. `rows` says whether anything was summed at all.
 */
export interface WebMetricSums {
  rows: number;
  sums: Record<string, number>;
  weighted: Record<string, number>;
}

/** Pure in-memory sums (the mock transport and tests); a metric a row does not carry adds nothing. */
export function webMetricSums(
  metrics: readonly SourceReportMetricV1[],
  rows: ReadonlyArray<Record<string, number | undefined>>,
): WebMetricSums {
  const out: WebMetricSums = { rows: rows.length, sums: {}, weighted: {} };
  for (const row of rows)
    for (const spec of metrics) {
      const value = row[spec.name];
      if (typeof value !== 'number') continue;
      if (spec.kind === 'gauge') {
        const weight = spec.weight ? row[spec.weight] : 1;
        if (typeof weight !== 'number') continue;
        out.weighted[spec.name] = (out.weighted[spec.name] ?? 0) + value * weight;
        out.sums[spec.name] = (out.sums[spec.name] ?? 0) + weight;
      } else out.sums[spec.name] = (out.sums[spec.name] ?? 0) + value;
    }
  return out;
}

/**
 * The D-15 aggregate of each metric from its sums: a flow is its sum, a rate Σ numerator ÷ Σ denominator (null on
 * a zero or missing denominator), a gauge Σ value × weight ÷ Σ weight. A metric without rows is null, never zero.
 * The report's derived rates are added when both operands are among its metrics.
 */
export function webMetricValues(
  metrics: readonly SourceReportMetricV1[],
  derived: readonly SourceReportMetricV1[],
  sums: WebMetricSums,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const flow = (name: string): number | null => (name in sums.sums ? (sums.sums[name] as number) : null);
  const rate = (spec: SourceReportMetricV1): number | null => {
    const n = spec.numerator ? flow(spec.numerator) : null;
    const d = spec.denominator ? flow(spec.denominator) : null;
    return n !== null && d !== null && d > 0 ? n / d : null;
  };
  for (const spec of metrics) {
    if (sums.rows === 0) out[spec.name] = null;
    else if (spec.kind === 'flow') out[spec.name] = flow(spec.name);
    else if (spec.kind === 'rate') out[spec.name] = rate(spec);
    else {
      const weight = sums.sums[spec.name];
      const weighted = sums.weighted[spec.name];
      out[spec.name] =
        weight !== undefined && weighted !== undefined && weight > 0 ? weighted / weight : null;
    }
  }
  const names = new Set(metrics.map((m) => m.name));
  for (const spec of derived)
    if (spec.numerator && spec.denominator && names.has(spec.numerator) && names.has(spec.denominator))
      out[spec.name] = sums.rows === 0 ? null : rate(spec);
  return out;
}

/** The sort key of a report's drill-down: its first metric (sessions, clicks). */
export const reportPrimaryMetric = (metrics: readonly SourceReportMetricV1[]): string =>
  metrics[0]?.name ?? '';

// ---- router DTOs (destinations.reports.*) ----

export const DESTINATION_REPORT_ROWS_MAX = 200;
export const DestinationReportSummary = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});
export const DestinationReportRows = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  reportKey: z.string().max(60),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  limit: z.number().int().min(1).max(DESTINATION_REPORT_ROWS_MAX).default(50),
  cursor: z.string().max(512).optional(),
});
export const DestinationReportOpportunities = z.object({ brandId: z.string(), destinationId: z.string() });

/** Opportunity window and ratio (R2-1); each report's rule names its own volume metric and minimum. */
export const OPPORTUNITY_WINDOW_DAYS = 28;
export const OPPORTUNITY_RATE_FRACTION = 0.5;
export const OPPORTUNITIES_MAX = 20;

export interface DestinationReportFreshnessV1 {
  /** The latest day with rows, or null when nothing has been read yet. */
  latestDate: string | null;
  fetchedAt: string | null;
  /** Hours since the end of the latest day; stale beyond STALE_FACTOR × the report's latency. */
  ageHours: number | null;
  latencyHours: number;
  stale: boolean;
}
export interface DestinationReportWindowV1 {
  windowStart: string;
  windowEnd: string;
  /** Days with at least one row: absent days stay absent (D-15, never a zero). */
  days: number;
  rows: number;
  metrics: Record<string, number | null>;
}
export interface DestinationReportComparisonV1 {
  metric: string;
  kind: WebMetricKind;
  current: number | null;
  previous: number | null;
  change: number | null;
}
export interface DestinationReportSummaryEntryV1 {
  reportKey: string;
  label: string;
  dimensions: Array<{ name: string; label: string }>;
  metrics: SourceReportMetricV1[];
  /** Rates derived from the report's flows (reported in `metrics` values under their own name). */
  derived: SourceReportMetricV1[];
  freshness: DestinationReportFreshnessV1;
  /** RA-10: the zone the days are keyed in and whether the latest day is still provisional. */
  quality: DestinationReportQualityV1;
  current: DestinationReportWindowV1;
  previous: DestinationReportWindowV1;
  comparison: DestinationReportComparisonV1[];
  /** D-14 with days as the unit: below the minimum on either side the comparison reads insufficient. */
  sample: { current: number; previous: number; minimum: number; sufficient: boolean };
}
/** How the kind's source presents itself: the vendor console the AI-search row links to (D-19) and the tiles. */
export interface DestinationReportPresentationV1 {
  console: { label: string; href: string };
  tiles: { reportKey: string; metrics: string[] };
}
export interface DestinationReportSummaryV1 {
  brandId: string;
  destinationId: string;
  kind: DestinationKind;
  /** From the source adapter's capability; null for a kind without a registered source. */
  presentation: DestinationReportPresentationV1 | null;
  /** Whether the source-use policy allows `read` of the kind's reports; nothing is summarised when it does not. */
  policy: { allowed: boolean; reason: SourceUseCheckReason; dataType: string };
  windowStart: string;
  windowEnd: string;
  reports: DestinationReportSummaryEntryV1[];
  computedAt: string;
}
export interface DestinationReportRowV1 {
  dimensionKey: string;
  dimensions: Record<string, string>;
  days: number;
  metrics: Record<string, number | null>;
}
export const DestinationReportOpportunityKind = z.enum([
  'low_ctr_query',
  'low_ctr_page',
  'low_engagement_page',
]);
export type DestinationReportOpportunityKind = z.infer<typeof DestinationReportOpportunityKind>;
export interface DestinationReportOpportunityV1 {
  kind: DestinationReportOpportunityKind;
  reportKey: string;
  subject: string;
  metrics: Record<string, number | null>;
  /** The destination's own pooled rate the subject fell below half of. */
  benchmark: { metric: string; value: number };
  suggestedTask: string;
}

// ---- destinationReportSweepWorkflowV1 / destinationReportsWorkflowV1 (task queue `ingest-metrics`) ----

/** The daily sweep is platform-level (it spans tenants like the token refresh); a schedule starts it with fixed args. */
export const DestinationReportSweepArgsV1 = z.object({
  correlationId: z.string().optional(),
  now: z.string().datetime().optional(),
});
export type DestinationReportSweepArgsV1 = z.infer<typeof DestinationReportSweepArgsV1>;
export interface DestinationReportSweepInputV1 {
  correlationId: string;
  now: string;
}
/** A destination to read today: references only (spec 14.7 R5). */
export interface DestinationReportTargetV1 {
  tenantId: string;
  destinationId: string;
}
export const DestinationReportsInputV1 = TenantContextInput.extend({
  destinationId: z.string(),
  now: z.string().datetime(),
});
export type DestinationReportsInputV1 = z.infer<typeof DestinationReportsInputV1>;
export const DestinationReportPlanSkipReason = z.enum([
  'no_policy',
  'review_overdue',
  'not_allowed',
  'not_active',
  'source_not_enabled',
  'locked',
  'up_to_date',
]);
export type DestinationReportPlanSkipReason = z.infer<typeof DestinationReportPlanSkipReason>;
export interface DestinationReportRangeV1 {
  reportKey: string;
  /** Inclusive ISO dates. */
  start: string;
  end: string;
}
export type DestinationReportPlanV1 =
  | { outcome: 'skipped'; reason: DestinationReportPlanSkipReason }
  | { outcome: 'planned'; reports: DestinationReportRangeV1[] };
export const DestinationReportFetchInputV1 = DestinationReportsInputV1.extend({
  reportKey: z.string().max(60),
  start: z.string(),
  end: z.string(),
});
export type DestinationReportFetchInputV1 = z.infer<typeof DestinationReportFetchInputV1>;
export type DestinationReportFetchResultV1 =
  | { outcome: 'fetched'; rows: number; days: number }
  | { outcome: 'rate_limited'; retryAfterMs: number | null }
  | { outcome: 'unreachable'; reason: 'reconnect_required' | 'rejected' }
  | { outcome: 'transient'; reason: string }
  | { outcome: 'skipped'; reason: 'not_active' };
export const DestinationReportFinishInputV1 = DestinationReportsInputV1.extend({
  health: DestinationHealth,
  fetched: z.array(z.object({ reportKey: z.string(), rows: z.number().int() })),
  reason: z.string().nullable(),
});
export type DestinationReportFinishInputV1 = z.infer<typeof DestinationReportFinishInputV1>;
export interface DestinationReportsActivitiesV1 {
  /** The policy check, the lock and the incremental ranges; a refusal is recorded as a skipped audit. */
  planDestinationReports(input: DestinationReportsInputV1): Promise<DestinationReportPlanV1>;
  /** Reads one report over its range through the broker and replaces the window's rows (never rows in Temporal). */
  fetchDestinationReport(input: DestinationReportFetchInputV1): Promise<DestinationReportFetchResultV1>;
  /** Records the run's audit with counts and sets the destination's health from the outcome. */
  finishDestinationReports(input: DestinationReportFinishInputV1): Promise<{ health: DestinationHealth }>;
  /** Applies the source-use retention (or the operational cache) to the destination's rows. */
  pruneDestinationReports(input: DestinationReportsInputV1): Promise<{ deleted: number; cutoff: string }>;
}
export interface DestinationReportSweepActivitiesV1 {
  listDestinationReportTargets(input: DestinationReportSweepInputV1): Promise<DestinationReportTargetV1[]>;
}
/** The module-side implementation the activities wrap (tenant context is established by the activity host). */
export interface DestinationReportsRuntimeV1
  extends DestinationReportSweepActivitiesV1, Omit<DestinationReportsActivitiesV1, 'fetchDestinationReport'> {
  /** The fetch heartbeats per page through the hooks the activity host passes. */
  fetchDestinationReport(
    input: DestinationReportFetchInputV1,
    hooks?: ActivityHooks,
  ): Promise<DestinationReportFetchResultV1>;
}

// ---- website articles (ledger R2-3, D-16): a CMS connected with a sealed secret, verified by the worker ----

/** The source-use data type every article write (publish, edit, revert) and read-back is checked against. */
export const CMS_ARTICLES_DATA_TYPE = 'cms.articles';
/**
 * What a secret-based connect grants, recorded as the destination's scopes: writes land as drafts (D-16 preview
 * by default); a live publish needs the `publish` scope the connecting person granted explicitly.
 */
export const CMS_SCOPE_WRITE = 'articles:write';
export const CMS_SCOPE_PUBLISH = 'articles:publish';
/** A destination variant's `settings.publishMode`: `draft` unless the person asks for `publish` and the grant allows it. */
export const CmsPublishMode = z.enum(['draft', 'publish']);
export type CmsPublishMode = z.infer<typeof CmsPublishMode>;

/**
 * `connect.withSecret`: a website connected with an integration identity and its secret (an application
 * password). The secret is sealed by the broker in the API process and never returned, logged or decrypted
 * there; the worker verifies it (destinationVerifyWorkflowV1) and sets the health.
 */
export const DestinationConnectWithSecret = z.object({
  brandId: z.string(),
  kind: z.literal('cms_site'),
  siteUrl: z.string().url().max(200),
  username: z.string().min(1).max(200),
  secret: z.string().min(1).max(500),
  displayName: z.string().min(1).max(200).optional(),
  /** Lets a destination variant publish live (`settings.publishMode: 'publish'`); off, every write is a draft. */
  allowPublish: z.boolean().default(false),
});

// ---- destinationVerifyWorkflowV1 (task queue `core`) ----

export const DestinationVerifyInputV1 = TenantContextInput.extend({ destinationId: z.string() });
export type DestinationVerifyInputV1 = z.infer<typeof DestinationVerifyInputV1>;
export type DestinationVerifyResultV1 =
  | { ok: true; health: DestinationHealth }
  | { ok: false; reason: 'locked' | 'transient' | 'reconnect_required' | 'not_active' | 'no_credential' };
export interface DestinationVerifyActivitiesV1 {
  /** Opens the sealed secret in the worker, asks the adapter to verify it and records the health found. */
  verifyDestinationCredential(input: DestinationVerifyInputV1): Promise<DestinationVerifyResultV1>;
}
/** The module-side implementation the activity wraps (tenant context is established by the activity host). */
export type DestinationVerifyRuntimeV1 = DestinationVerifyActivitiesV1;

// ---- article read-back (R2-3): the remote revision as evidence ----

/** The remote article as read back after a write: identity, state, and the hash of its content (never the body). */
export interface ArticleReadbackV1 {
  remoteId: string;
  remoteUrl: string;
  title: string;
  slug: string;
  status: string;
  modifiedAt: string | null;
  /**
   * The adapter's hash of the remote revision (RA-12: title, slug, status, terms and content); an edit refuses when
   * the current remote hash differs.
   */
  contentHash: string;
}

/**
 * The fields a read-back is compared on (RA-04): the content, title, slug and status against what was sent, and
 * the modified instant against the write's own response (RA-12: a remote touched again since the write differs).
 */
export const ArticleReadbackField = z.enum(['content', 'title', 'slug', 'status', 'modifiedAt']);
export type ArticleReadbackField = z.infer<typeof ArticleReadbackField>;
/**
 * RA-04: what the read-back after a write proved. `verified` when every field matched what was sent, `mismatch`
 * when at least one differed (named), `unverified` when nothing could be compared (the source-use policy allows no
 * read, or the read-back was missing) with the reason; never silently the write's own response.
 */
export interface ArticleReadbackVerificationV1 {
  outcome: 'verified' | 'mismatch' | 'unverified';
  matched: ArticleReadbackField[];
  mismatched: ArticleReadbackField[];
  reason: string | null;
  /** The fingerprint of the exact HTML sent (what `content` was compared on). */
  sentHash: string;
}
