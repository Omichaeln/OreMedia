import { z } from 'zod';

export const Completeness = z.enum(['complete', 'partial', 'unavailable']);
export type Completeness = z.infer<typeof Completeness>;

export const MetricSubjectType = z.enum(['publication', 'channel', 'campaign', 'link']);

export const MetricDefinitionInput = z.object({
  key: z.string().max(80),
  providerKey: z.string().max(40).nullable(),
  nativeName: z.string().max(120),
  unit: z.string().max(40),
  aggregation: z.enum(['sum', 'max', 'last', 'avg', 'series']),
  comparableGroup: z.string().max(40),
  definitionVersion: z.number().int().min(1),
  separatesPaidOrganic: z.boolean().default(false),
});

export const MetricsQuery = z.object({
  brandId: z.string(),
  subjectType: MetricSubjectType,
  subjectIds: z.array(z.string()).min(1).max(200),
  metricKeys: z.array(z.string()).min(1).max(50),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});

export const TrackedLinkCreate = z.object({
  brandId: z.string(),
  publicationId: z.string().optional(),
  variantId: z.string().optional(),
  experimentId: z.string().optional(),
  destination: z.string().url().max(2000),
  utm: z.record(z.string().max(200)).default({}),
});

export const ConversionSource = z.enum(['crm', 'pixel', 'form']);

// ---------------------------------------------------------------------------------------------------------------
// Phase 6 measurement module (spec 15, 16.2, 16.5 first half). Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';
import { CreativeAttributesV1 } from './content';

export const MetricAggregation = z.enum(['sum', 'max', 'last', 'avg', 'series']);
export type MetricAggregation = z.infer<typeof MetricAggregation>;

/**
 * D-15 metric dictionary (docs/contracts/metrics.md): what a number is, which decides what may be summed. A flow
 * (impressions, clicks, likes) adds across posts; a unique count (reach, followers reached) never adds across
 * posts, days or platforms; a snapshot (follower count) is a level at a moment; a gauge (watch time, retention)
 * is averaged or kept as a series; a rate carries its denominator and is pooled, never averaged.
 */
export const MetricKind = z.enum(['flow', 'unique', 'snapshot', 'gauge', 'rate']);
export type MetricKind = z.infer<typeof MetricKind>;

const KIND_OF_GROUP: Readonly<Record<string, MetricKind>> = {
  reach: 'unique',
  followers: 'snapshot',
  watch_time: 'gauge',
  impressions: 'flow',
  engagement: 'flow',
  likes: 'flow',
  comments: 'flow',
  shares: 'flow',
  saves: 'flow',
  clicks: 'flow',
  negative_feedback: 'flow',
};
/**
 * The kind of a comparable group (D-15). Rates are the derived `rate:` groups; an unrecognised group is a flow
 * only when its name says it counts something that happens, a unique count when it says unique, otherwise a gauge.
 */
export function kindFor(comparableGroup: string): MetricKind {
  if (comparableGroup.startsWith('rate:')) return 'rate';
  const known = KIND_OF_GROUP[comparableGroup];
  if (known) return known;
  const leaf = comparableGroup.replace(/^other:/, '');
  if (/unique/i.test(leaf)) return 'unique';
  if (/rate|pct|percent|ratio|avg|average/i.test(leaf)) return 'rate';
  if (/count|total|clicks?|views?|plays?|sends?|taps?|opens?/i.test(leaf)) return 'flow';
  return 'gauge';
}

export const MetricDefinitionList = z.object({
  /** Restrict to one provider's native definitions; omitted lists global and tenant definitions. */
  providerKey: z.string().max(40).optional(),
});
export const MetricDefinitionGet = z.object({ definitionId: z.string() });
/** Tenant-defined metrics carry the caller's tenant; global rows are seeded from the capability register. */
export const MetricDefinitionCreate = MetricDefinitionInput.extend({
  definition: z.string().max(1000).optional(),
});

export const MetricGrouping = z.enum(['subject', 'metric', 'comparable_group']);
export type MetricGrouping = z.infer<typeof MetricGrouping>;
/** The post ages the collection schedule pulls at (metricCollectionWorkflowV1: +1 d, +3 d, +7 d, +28 d). */
export const MetricAgeDays = z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(28)]);
export type MetricAgeDays = z.infer<typeof MetricAgeDays>;
/**
 * Spec 15.2 query: brand, range, metric keys, grouping; every value carries freshness and completeness. With
 * `ageDays`, each value is the post's total at that age (the first pull at or after it, within two days) instead
 * of the latest, so posts of different ages compare; each value keeps its window, so the real age is visible.
 */
export const MetricsQueryV1 = MetricsQuery.extend({
  grouping: MetricGrouping.default('subject'),
  ageDays: MetricAgeDays.optional(),
});
export type MetricsQueryV1 = z.infer<typeof MetricsQueryV1>;

/**
 * UX-11: a brand's performance over a window with the previous window of equal length beside it (D-14: same post
 * age on both sides, "insufficient sample" below the minimum), from the dictionary's rules (D-15).
 */
export const BrandPerformanceSummary = z.object({
  brandId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  ageDays: MetricAgeDays.optional(),
  /** One channel's released publications only (the Performance screen's channel filter); omitted, every channel. */
  channelConnectionId: z.string().optional(),
});
/**
 * The per-call bound of `MetricsQuery.subjectIds`. A window's whole population is aggregated server side in chunks
 * of this (brandSummary, the attribute aggregate, the overview), never cut to its newest rows; the result says so
 * with `subjectsTotal` and `truncated: false`.
 */
export const QUERY_SUBJECTS_MAX = 200;
/** The internal query over a whole population (the composed read models); the public query keeps the per-call cap. */
export const MetricsPopulationQueryV1 = MetricsQueryV1.extend({ subjectIds: z.array(z.string()).min(1) });
export type MetricsPopulationQueryV1 = z.infer<typeof MetricsPopulationQueryV1>;
/**
 * The per-publication values of a window's released publications, newest first, one page of publications per call
 * (the Performance screen reads every page): the latest fetch per (publication, metric), or the total at `ageDays`.
 */
export const PublicationMetricsPage = z.object({
  brandId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  metricKeys: z.array(z.string()).min(1).max(50),
  ageDays: MetricAgeDays.optional(),
  channelConnectionId: z.string().optional(),
  page: PageRequest,
});
export type PublicationMetricsPage = z.infer<typeof PublicationMetricsPage>;
/** D-14: a comparison with fewer publications than this on either side reads "insufficient sample". */
export const COMPARISON_MINIMUM_SAMPLE = 5;
/** Spec 15.2: a value is stale when older than the provider's reporting latency × this factor. */
export const STALE_FACTOR = 2;
/** The latency assumed for a provider whose capability is not registered in the process (never a certified one). */
export const DEFAULT_LATENCY_HOURS = 24;
/** D-15: why a group has no total, in the words of the dictionary (docs/contracts/metrics.md), by metric kind. */
export const NOT_SUMMED: Readonly<Record<string, string>> = {
  unique: 'unique people: never summed across posts',
  snapshot: 'a level at a moment: never summed',
  gauge: 'an intensity: never summed',
  rate: 'pooled from its operands when both are here',
};

/** UX-12: what the creative did, per captured attribute value, as the pooled engagement rate of its posts. */
export const CreativeAttributesAggregate = z.object({
  brandId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});

export const EngagementQualityGet = z.object({
  brandId: z.string(),
  publicationId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});

export const TrackedLinkList = z.object({
  brandId: z.string(),
  publicationId: z.string().optional(),
  variantId: z.string().optional(),
  page: PageRequest,
});

export const CreativeAttributesGet = z.object({
  contentRevisionId: z.string().optional(),
  channelVariantId: z.string().optional(),
  attributeId: z.string().optional(),
});
/** Humans may correct any attribute; the row then records source = human_corrected (spec 16.2). */
export const CreativeAttributesCorrect = z.object({
  attributeId: z.string(),
  expectedVersion: z.number().int(),
  attributes: CreativeAttributesV1.partial(),
});

/** Every number is shown next to its freshness (spec 15.2): stale when older than latency × 2. */
export interface MetricFreshness {
  fetchedAt: string;
  ageHours: number;
  latencyHours: number;
  stale: boolean;
}

export interface MetricValueV1 {
  snapshotId: string;
  subjectType: z.infer<typeof MetricSubjectType>;
  subjectId: string;
  metricKey: string;
  comparableGroup: string;
  value: number | null;
  series: Array<{ at: string; value: number }> | null;
  completeness: Completeness;
  freshness: MetricFreshness;
  source: string;
  definitionVersion: number;
  windowStart: string;
  windowEnd: string;
  brandTimezone: string;
  numeratorSnapshotId: string | null;
  denominatorSnapshotId: string | null;
}

/**
 * An aggregate over one comparable_group only (spec 15.2); nothing is summed across groups. `kind` (D-15) says what
 * the value is: a flow is the sum across subjects, a rate the pooled ratio of its operands' sums, and a unique,
 * snapshot or gauge group is not additive, so its value is null and only the per-subject values stand.
 */
export interface MetricAggregateV1 {
  comparableGroup: string;
  kind: MetricKind;
  additive: boolean;
  metricKeys: string[];
  value: number | null;
  snapshotIds: string[];
  subjectsWithData: number;
  subjectsUnavailable: number;
  freshness: MetricFreshness | null;
  stale: boolean;
}

/** A coverage statement travels with every query result: what was asked, what was available, what is stale. */
export interface MetricCoverageV1 {
  subjectsRequested: number;
  subjectsWithData: number;
  metricsRequested: string[];
  metricsWithData: string[];
  metricsUnavailable: string[];
  staleValues: number;
  windowStart: string;
  windowEnd: string;
}

// ---- workflow contracts (metricCollectionWorkflowV1 on `ingest-metrics`, commentIngestionWorkflowV1 on `ingest-comments`) ----

export const MetricCollectionWorkflowInputV1 = TenantContextInput.extend({ publicationId: z.string() });
export type MetricCollectionWorkflowInputV1 = z.infer<typeof MetricCollectionWorkflowInputV1>;

/** What the schedule is derived from: the publication moment and the capability's analytics latency (spec 15.1). */
export interface CollectionPlanV1 {
  /** A publication that is not (or no longer) published has nothing to collect. */
  collectable: boolean;
  providerKey: string;
  publishedAt: string | null;
  latencyHours: number;
  commentsReadable: boolean;
}

export type PullMetricsInputV1 = MetricCollectionWorkflowInputV1 & {
  /** Pull number in the schedule (0-based), so the activity is idempotent per (publication, metric, window). */
  pullIndex: number;
  windowStart: string;
  windowEnd: string;
};

export interface PullMetricsResultV1 {
  /** Rows written by this call; a repeat of an already-written window writes nothing. */
  written: number;
  skipped: number;
  unavailable: number;
}

export interface MetricCollectionActivitiesV1 {
  readCollectionPlan(input: MetricCollectionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullMetrics(input: PullMetricsInputV1): Promise<PullMetricsResultV1>;
}

export const CommentIngestionWorkflowInputV1 = TenantContextInput.extend({ publicationId: z.string() });
export type CommentIngestionWorkflowInputV1 = z.infer<typeof CommentIngestionWorkflowInputV1>;

export type PullCommentsInputV1 = CommentIngestionWorkflowInputV1 & {
  pullIndex: number;
  since: string | null;
  cursor: string | null;
};

export interface PullCommentsResultV1 {
  ingested: number;
  duplicates: number;
  nextCursor: string | null;
}

export interface CommentIngestionActivitiesV1 {
  readCollectionPlan(input: CommentIngestionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullComments(input: PullCommentsInputV1): Promise<PullCommentsResultV1>;
}

/** The module-side implementations the activities wrap (tenant context is established by the activity host). */
export interface MetricCollectionRuntimeV1 {
  readCollectionPlan(input: MetricCollectionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullMetrics(
    input: PullMetricsInputV1,
    hooks?: { heartbeat(detail: string): void },
  ): Promise<PullMetricsResultV1>;
}
export interface CommentIngestionRuntimeV1 {
  readCollectionPlan(input: CommentIngestionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullComments(
    input: PullCommentsInputV1,
    hooks?: { heartbeat(detail: string): void },
  ): Promise<PullCommentsResultV1>;
}
