import type { DestinationReportSummaryV1, DestinationV1 } from '@oremedia/contracts/destinations';
import { DESTINATION_KIND_CAPABILITIES, webMetricByName } from '@oremedia/contracts/destinations';
import {
  DEFAULT_LATENCY_HOURS,
  NOT_SUMMED,
  STALE_FACTOR,
  type MetricAggregateV1,
  type MetricFreshness,
  type MetricValueV1,
} from '@oremedia/contracts/measurement';
import {
  OVERVIEW_AUDIT_LATENCY_HOURS,
  OVERVIEW_SOCIAL_GROUPS,
  type OverviewAuditV1,
  type OverviewFigureV1,
  type OverviewFreshnessV1,
  type OverviewLimitV1,
  type OverviewNativeSplitV1,
  type OverviewPaidSplitV1,
  type OverviewSocialV1,
  type OverviewSourceRefV1,
  type OverviewSourceState,
  type OverviewSourceV1,
  type OverviewWebSourceV1,
} from '@oremedia/contracts/overview';
import type { SeoAuditSummaryV1 } from '@oremedia/contracts/seo-audit';

/**
 * The pure composition rules of the overview (R2-5): how each module's read model becomes a source state with
 * its reason, a figure with its source label and freshness, and a limit statement. No I/O and contracts only, so
 * the web's mock transport composes with the same functions; summary.ts composes the services and hands their
 * results in.
 */

/** The social roll-up the measurement module returns (measurement.metrics.brandSummary). */
export interface BrandSummaryResult {
  ageDays: number | null;
  current: {
    publications: number;
    aggregates: MetricAggregateV1[];
    coverage: { subjectsRequested: number; subjectsWithData: number; staleValues: number };
  };
  previous: { publications: number; aggregates: MetricAggregateV1[] };
  comparison: Array<{
    comparableGroup: string;
    current: number | null;
    previous: number | null;
    change: number | null;
  }>;
  sample: { current: number; previous: number; minimum: number; sufficient: boolean };
}

/** A channel connection as the publishing module lists it (publishing.channels.list). */
export interface ChannelRow {
  id: string;
  providerKey: string;
  displayName: string;
  status: string;
}

/** A released channel publication of a window (publishing.calendarRange, released states only). */
export interface ReleasedPublication {
  publicationId: string;
  channelConnectionId: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

const fromMetricFreshness = (f: MetricFreshness | null): OverviewFreshnessV1 | null =>
  f ? { asOf: f.fetchedAt, ageHours: round(f.ageHours), latencyHours: f.latencyHours, stale: f.stale } : null;

const staleReason = (ageHours: number, latencyHours: number) =>
  `${Math.round(ageHours)} h old, beyond ${latencyHours} h × ${STALE_FACTOR}`;

export const channelRef = (c: ChannelRow): OverviewSourceRefV1 => ({
  kind: 'channel',
  id: c.id,
  label: c.displayName,
  platform: c.providerKey,
});
export const destinationRef = (d: DestinationV1, kind: 'web' | 'audit'): OverviewSourceRefV1 => ({
  kind,
  id: d.id,
  label: d.displayName,
  platform: DESTINATION_KIND_CAPABILITIES[d.kind]?.label ?? d.kind,
});

/** The social headline figures (UX-11 rollup): one per comparable group the window returned, in reading order. */
export function socialFigures(summary: BrandSummaryResult): OverviewFigureV1[] {
  return OVERVIEW_SOCIAL_GROUPS.flatMap(([group, label]) => {
    const a = summary.current.aggregates.find((x) => x.comparableGroup === group);
    if (!a) return [];
    const before = summary.previous.aggregates.find((x) => x.comparableGroup === group) ?? null;
    const c = summary.comparison.find((x) => x.comparableGroup === group) ?? null;
    return [
      {
        key: group,
        label,
        kind: a.kind,
        value: a.value,
        previous: c ? c.previous : before ? before.value : null,
        change: c ? c.change : null,
        sufficient: summary.sample.sufficient,
        sample: {
          current: summary.sample.current,
          previous: summary.sample.previous,
          minimum: summary.sample.minimum,
        },
        coverage: { requested: summary.current.publications, withData: a.subjectsWithData, unit: 'posts' },
        freshness: fromMetricFreshness(a.freshness),
        source: { kind: 'social', label: 'Social channels' },
        note: a.additive ? null : (NOT_SUMMED[a.kind] ?? 'not additive'),
      },
    ];
  });
}

export function socialOf(summary: BrandSummaryResult): OverviewSocialV1 {
  const figures = socialFigures(summary);
  const oldest = figures
    .map((f) => f.freshness)
    .filter((f): f is OverviewFreshnessV1 => f !== null && f.ageHours !== null)
    .sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0))[0];
  return {
    figures,
    sample: summary.sample,
    coverage: summary.current.coverage,
    freshness: oldest
      ? {
          fetchedAt: oldest.asOf ?? '',
          ageHours: oldest.ageHours ?? 0,
          latencyHours: oldest.latencyHours,
          stale: oldest.stale,
        }
      : null,
    ageDays: summary.ageDays,
  };
}

/**
 * One channel's state: its connection status first, then what the window holds (posts asked, posts with a number),
 * then the freshness of what came back and whether the D-14 sample on both sides allows a comparison.
 */
export function channelSource(
  channel: ChannelRow,
  current: ReleasedPublication[],
  previous: ReleasedPublication[],
  values: MetricValueV1[],
  minimumSample: number,
): OverviewSourceV1 {
  const mine = current.filter((p) => p.channelConnectionId === channel.id);
  const before = previous.filter((p) => p.channelConnectionId === channel.id).length;
  const ids = new Set(mine.map((p) => p.publicationId));
  const withData = values.filter(
    (v) => ids.has(v.subjectId) && v.value !== null && v.completeness !== 'unavailable',
  );
  const subjects = new Set(withData.map((v) => v.subjectId)).size;
  const latest =
    withData
      .map((v) => v.freshness.fetchedAt)
      .sort()
      .at(-1) ?? null;
  const ageHours = withData.length ? Math.max(...withData.map((v) => v.freshness.ageHours)) : null;
  const latencyHours = withData[0]?.freshness.latencyHours ?? DEFAULT_LATENCY_HOURS;
  const stale = withData.some((v) => v.freshness.stale);
  const sufficient = mine.length >= minimumSample && before >= minimumSample;
  const base = {
    ...channelRef(channel),
    freshness: withData.length
      ? { asOf: latest, ageHours: ageHours === null ? null : round(ageHours), latencyHours, stale }
      : null,
    coverage: { requested: mine.length, withData: subjects, unit: 'posts' as const },
    sample: { current: mine.length, previous: before, minimum: minimumSample, sufficient },
    policy: null,
  };
  const status = channel.status.replace(/_/g, ' ');
  if (channel.status !== 'active')
    return {
      ...base,
      state: 'not_connected',
      reason: `connection ${status}: nothing is collected until it is reconnected`,
    };
  if (mine.length === 0)
    return { ...base, state: 'no_data', reason: 'nothing published on this channel in the window' };
  if (subjects === 0)
    return {
      ...base,
      state: 'no_data',
      reason: `${mine.length} ${mine.length === 1 ? 'post' : 'posts'} published, no number returned yet (collection runs at the channel's reporting delay)`,
    };
  if (stale && ageHours !== null)
    return { ...base, state: 'stale', reason: `oldest value ${staleReason(ageHours, latencyHours)}` };
  if (!sufficient)
    return {
      ...base,
      state: 'insufficient_sample',
      reason: `fresh; ${mine.length} and ${before} posts of ${minimumSample} needed to compare`,
    };
  return { ...base, state: 'fresh', reason: `${subjects} of ${mine.length} posts have numbers` };
}

const policyReason = (p: { reason: string; dataType: string }) =>
  `reads not allowed by the source-use policy (${p.reason.replace(/_/g, ' ')} for ${p.dataType})`;

const reportFreshness = (entries: DestinationReportSummaryV1['reports']): OverviewFreshnessV1 | null => {
  const read = entries.filter((e) => e.freshness.latestDate !== null);
  if (read.length === 0) return null;
  const latest = read
    .sort((a, b) => (a.freshness.latestDate ?? '').localeCompare(b.freshness.latestDate ?? ''))
    .at(-1);
  if (!latest) return null;
  return {
    asOf: `${latest.freshness.latestDate}T23:59:59.999Z`,
    ageHours: latest.freshness.ageHours,
    latencyHours: latest.freshness.latencyHours,
    stale: read.some((e) => e.freshness.stale),
  };
};

/** The tiles report of a web source (the adapter's presentation names it), or the first report. */
const tilesEntry = (summary: DestinationReportSummaryV1) =>
  summary.reports.find((r) => r.reportKey === summary.presentation?.tiles.reportKey) ??
  summary.reports[0] ??
  null;

/** A web source's headline figures: the metrics its adapter presents as tiles, each with its comparison (D-14). */
export function webFigures(
  summary: DestinationReportSummaryV1,
  ref: OverviewSourceRefV1,
  windowDays: number,
): OverviewFigureV1[] {
  const tiles = tilesEntry(summary);
  if (!tiles || !summary.policy.allowed) return [];
  return (summary.presentation?.tiles.metrics ?? []).flatMap((metric) => {
    const descriptor = webMetricByName(tiles.metrics, tiles.derived, metric);
    if (!descriptor) return [];
    const comparison = tiles.comparison.find((c) => c.metric === metric) ?? null;
    const freshness = reportFreshness([tiles]);
    return [
      {
        key: metric,
        label: descriptor.label,
        kind: descriptor.kind,
        value: tiles.current.metrics[metric] ?? null,
        previous: comparison ? comparison.previous : (tiles.previous.metrics[metric] ?? null),
        change: comparison ? comparison.change : null,
        sufficient: tiles.sample.sufficient,
        sample: {
          current: tiles.sample.current,
          previous: tiles.sample.previous,
          minimum: tiles.sample.minimum,
        },
        coverage: { requested: windowDays, withData: tiles.current.days, unit: 'days' },
        freshness,
        source: ref,
        note: descriptor.kind === 'gauge' ? 'weighted mean, not compared' : null,
      },
    ];
  });
}

export function webSourceOf(
  destination: DestinationV1,
  summary: DestinationReportSummaryV1,
  windowDays: number,
): { entry: OverviewWebSourceV1; source: OverviewSourceV1 } {
  const ref = destinationRef(destination, 'web');
  const tiles = tilesEntry(summary);
  const freshness = reportFreshness(summary.reports);
  const base = {
    ...ref,
    freshness,
    coverage: tiles ? { requested: windowDays, withData: tiles.current.days, unit: 'days' as const } : null,
    sample: tiles ? tiles.sample : null,
    policy: summary.policy,
  };
  const entry: OverviewWebSourceV1 = {
    source: ref,
    policy: summary.policy,
    figures: webFigures(summary, ref, windowDays),
    console: summary.presentation?.console ?? null,
  };
  const state = (state: OverviewSourceState, reason: string) => ({
    entry,
    source: { ...base, state, reason },
  });
  if (!summary.policy.allowed) return state('blocked', policyReason(summary.policy));
  if (summary.reports.length === 0) return state('no_data', 'no report declared for this source');
  if (!freshness)
    return state('no_data', 'no data read yet (the daily sweep stores a day once the platform reports it)');
  if (freshness.stale && freshness.ageHours !== null)
    return state('stale', `latest day ${staleReason(freshness.ageHours, freshness.latencyHours)}`);
  if (tiles && !tiles.sample.sufficient)
    return state(
      'insufficient_sample',
      `fresh; ${tiles.sample.current} and ${tiles.sample.previous} days of ${tiles.sample.minimum} needed to compare`,
    );
  return state(
    'fresh',
    `data to ${freshness.asOf?.slice(0, 10)}${tiles ? ` · ${tiles.current.days} of ${windowDays} days` : ''}`,
  );
}

export function auditSourceOf(
  destination: DestinationV1,
  summary: SeoAuditSummaryV1,
  now: Date,
): { entry: OverviewAuditV1; source: OverviewSourceV1 } {
  const ref = destinationRef(destination, 'audit');
  const run = summary.lastRun;
  const finishedAt = run?.finishedAt ?? null;
  const ageHours = finishedAt ? Math.max(0, (now.getTime() - Date.parse(finishedAt)) / 3_600_000) : null;
  const stale = ageHours !== null && ageHours > OVERVIEW_AUDIT_LATENCY_HOURS * STALE_FACTOR;
  const entry: OverviewAuditV1 = {
    source: ref,
    policy: summary.policy,
    lastRun: run,
    running: summary.running,
    data: summary.data,
    fieldData: summary.fieldData,
  };
  const base = {
    ...ref,
    freshness: finishedAt
      ? {
          asOf: finishedAt,
          ageHours: ageHours === null ? null : round(ageHours),
          latencyHours: OVERVIEW_AUDIT_LATENCY_HOURS,
          stale,
        }
      : null,
    coverage: run
      ? { requested: run.pagesCrawled, withData: run.pagesCrawled, unit: 'pages' as const }
      : null,
    sample: null,
    policy: summary.policy,
  };
  const state = (state: OverviewSourceState, reason: string) => ({
    entry,
    source: { ...base, state, reason },
  });
  if (!summary.policy.allowed) return state('blocked', policyReason(summary.policy));
  if (!run)
    return state(
      'no_data',
      summary.running ? 'the first audit is running' : 'no audit yet (the weekly sweep runs on Mondays)',
    );
  if (run.outcome !== 'completed')
    return state(
      'no_data',
      `the last run ${run.outcome}${run.reason ? ` (${run.reason.replace(/_/g, ' ')})` : ''}; no completed audit`,
    );
  if (stale && ageHours !== null)
    return state('stale', `last audit ${staleReason(ageHours, OVERVIEW_AUDIT_LATENCY_HOURS)}`);
  return state(
    'fresh',
    `${run.pagesCrawled} pages crawled · ${run.summary.critical} critical, ${run.summary.major} major, ${run.summary.minor} minor`,
  );
}

/** Organic vs paid and Oremedia vs native, stated from what is connected (never invented, see the contract). */
export function splitsOf(
  social: OverviewSocialV1,
  definitions: Array<{ key: string; separatesPaidOrganic: boolean }>,
): { organicVsPaid: OverviewPaidSplitV1; oremediaVsNative: OverviewNativeSplitV1 } {
  const separating = [...new Set(definitions.filter((d) => d.separatesPaidOrganic).map((d) => d.key))];
  return {
    organicVsPaid: {
      organic: {
        publications: social.sample.current,
        note: 'every social figure as the platform reports it for the post; no paid dimension is applied',
      },
      paid: {
        state: 'not_connected',
        reason:
          'paid: not connected (ledger R3-4, paid-media connectors); no figure is split or estimated until a connector is certified',
        separatingDefinitions: separating,
      },
    },
    oremediaVsNative: {
      oremedia: {
        publications: social.sample.current,
        note: 'publications released through Oremedia in the window (the collection schedule reads each of them)',
      },
      native: {
        state: 'not_observed',
        reason:
          'posts made natively on a platform are not observed: ingestion collects per publication Oremedia released, so no native figure exists here',
      },
    },
  };
}

/** The consent / blocker statements (D-17, D-19, R3-4, D-14): what the overview cannot say, and why. */
export function limitsOf(input: {
  sources: OverviewSourceV1[];
  web: OverviewWebSourceV1[];
  audits: OverviewAuditV1[];
  social: OverviewSocialV1;
  splits: { organicVsPaid: OverviewPaidSplitV1; oremediaVsNative: OverviewNativeSplitV1 };
  /** Connected destination kinds whose source adapter is not certified on this deployment. */
  uncertified: Array<{ kind: string; label: string }>;
}): OverviewLimitV1[] {
  const out: OverviewLimitV1[] = [];
  const ref = (s: OverviewSourceV1): OverviewSourceRefV1 => ({
    kind: s.kind,
    id: s.id,
    label: s.label,
    platform: s.platform,
  });
  for (const s of input.sources) {
    if (s.state === 'blocked')
      out.push({
        code: 'policy_blocked',
        statement: `${s.label}: ${s.reason}. Settings → Destinations sets the policy.`,
        source: ref(s),
        link: null,
      });
    if (s.state === 'not_connected')
      out.push({ code: 'not_connected', statement: `${s.label}: ${s.reason}.`, source: ref(s), link: null });
  }
  for (const u of input.uncertified)
    out.push({
      code: 'source_uncertified',
      statement: `${u.label}: the source adapter is not certified on this deployment; nothing is read from it.`,
      source: null,
      link: null,
    });
  for (const a of input.audits)
    if (a.policy.allowed)
      out.push({
        code: 'field_data_not_connected',
        statement: `${a.source.label}: ${a.data.note}; the audit is what the crawler measured, never what visitors experienced.`,
        source: a.source,
        link: null,
      });
  for (const w of input.web)
    if (w.console)
      out.push({
        code: 'ai_search_external',
        statement: `${w.source.label}: AI search has no verified official API, so no figure is shown (D-19); the vendor console is linked instead.`,
        source: w.source,
        link: { label: `Open ${w.console.label} (external)`, href: w.console.href },
      });
  out.push({
    code: 'paid_not_connected',
    statement: input.splits.organicVsPaid.paid.reason,
    source: null,
    link: null,
  });
  out.push({
    code: 'native_not_observed',
    statement: input.splits.oremediaVsNative.native.reason,
    source: null,
    link: null,
  });
  if (!input.social.sample.sufficient)
    out.push({
      code: 'insufficient_sample',
      statement: `Social channels: ${input.social.sample.current} and ${input.social.sample.previous} publications of ${input.social.sample.minimum} needed on each side; the comparison reads insufficient sample (D-14).`,
      source: null,
      link: null,
    });
  for (const s of input.sources)
    if (s.kind !== 'channel' && s.state === 'insufficient_sample')
      out.push({
        code: 'insufficient_sample',
        statement: `${s.label}: ${s.reason}.`,
        source: ref(s),
        link: null,
      });
  for (const s of input.sources)
    if (s.state === 'stale')
      out.push({ code: 'stale', statement: `${s.label}: ${s.reason}.`, source: ref(s), link: null });
  if (input.social.ageDays === null)
    out.push({
      code: 'latest_fetch_comparison',
      statement:
        "Social figures compare each post's latest fetch with the previous window's, not at one post age; the Performance trend compares at one age (D-14).",
      source: null,
      link: null,
    });
  return out;
}
