import type { IncomingHttpHeaders } from 'node:http';
import type { DestinationReportSummaryV1, DestinationV1 } from '@oremedia/contracts/destinations';
import { DESTINATION_KIND_CAPABILITIES, webMetricByName } from '@oremedia/contracts/destinations';
import {
  COMPARISON_MINIMUM_SAMPLE,
  type MetricAggregateV1,
  type MetricValueV1,
} from '@oremedia/contracts/measurement';
import {
  OVERVIEW_AUDIT_LATENCY_HOURS,
  OVERVIEW_SOCIAL_GROUPS,
  OverviewSummary,
  type OverviewAuditV1,
  type OverviewFigureV1,
  type OverviewFreshnessV1,
  type OverviewLimitV1,
  type OverviewSocialV1,
  type OverviewSourceRefV1,
  type OverviewSourceState,
  type OverviewSourceV1,
  type OverviewSummaryV1,
  type OverviewWebSourceV1,
} from '@oremedia/contracts/overview';
import { SEO_AUDIT_DESTINATION_KIND, type SeoAuditSummaryV1 } from '@oremedia/contracts/seo-audit';
import type { MockBuilders, MockMember, t } from './mock-api';

/**
 * Overview slice of the UI-only transport (see mock-api.ts): overview.summary composed, as apps/api composes it
 * (packages/modules/overview), from the other mock routers' own procedures through callers (the social rollup and
 * per-publication values from measurement, the channels from publishing, the window's publications from the
 * calendar, the destinations with their report and audit summaries), with the same DTO shape, state precedence,
 * dictionary rules and limit statements. A test double, never a second implementation.
 */
const STALE_FACTOR = 2;
const DAY_MS = 86_400_000;
const NOT_SUMMED: Readonly<Record<string, string>> = {
  unique: 'unique people: never summed across posts',
  snapshot: 'a level at a moment: never summed',
  gauge: 'an intensity: never summed',
  rate: 'pooled from its operands when both are here',
};

/** The caller context the mock's procedures run under (headers, correlation id, the resolved member). */
export interface CallerCtx {
  headers: IncomingHttpHeaders;
  correlationId: string;
  member?: MockMember | null;
}
type Window = { windowStart: string; windowEnd: string };
interface BrandSummaryOut {
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
/** The procedures the overview composes, as createCallerFactory hands them for one context. */
export interface OverviewCallers {
  measurement: (ctx: CallerCtx) => {
    metrics: {
      brandSummary: (input: { brandId: string } & Window) => Promise<BrandSummaryOut>;
      query: (input: {
        brandId: string;
        subjectType: 'publication';
        subjectIds: string[];
        metricKeys: string[];
        windowStart: string;
        windowEnd: string;
        grouping: 'subject';
      }) => Promise<{ values: MetricValueV1[] }>;
    };
    definitions: {
      list: (
        input: Record<string, never>,
      ) => Promise<
        Array<{ key: string; providerKey: string | null; aggregation: string; separatesPaidOrganic: boolean }>
      >;
    };
  };
  publishing: (ctx: CallerCtx) => {
    channels: {
      list: (input: {
        brandId: string;
      }) => Promise<Array<{ id: string; providerKey: string; displayName: string; status: string }>>;
    };
  };
  content: (ctx: CallerCtx) => {
    calendar: {
      range: (input: { brandId: string; from: string; to: string }) => Promise<{
        publications: Array<{ publicationId: string; channelConnectionId: string | null; state: string }>;
      }>;
    };
  };
  destinations: (ctx: CallerCtx) => {
    list: (input: { brandId: string }) => Promise<{ items: DestinationV1[] }>;
    sources: { list: () => Promise<{ items: Array<{ kind: string; label: string; certified: boolean }> }> };
    reports: {
      summary: (
        input: { brandId: string; destinationId: string } & Window,
      ) => Promise<DestinationReportSummaryV1>;
    };
    audit: { summary: (input: { brandId: string; destinationId: string }) => Promise<SeoAuditSummaryV1> };
  };
}

interface OverviewBuilders {
  router: typeof t.router;
  query: MockBuilders['query'];
}

const round = (n: number) => Math.round(n * 100) / 100;
const staleReason = (ageHours: number, latencyHours: number) =>
  `${Math.round(ageHours)} h old, beyond ${latencyHours} h × ${STALE_FACTOR}`;
const policyReason = (p: { reason: string; dataType: string }) =>
  `reads not allowed by the source-use policy (${p.reason.replace(/_/g, ' ')} for ${p.dataType})`;

export function overviewRouters({ router, query }: OverviewBuilders, callers: OverviewCallers) {
  return router({
    summary: query.input(OverviewSummary).query(async ({ ctx, input }): Promise<OverviewSummaryV1> => {
      const measurement = callers.measurement(ctx);
      const window = { windowStart: input.windowStart, windowEnd: input.windowEnd };
      const start = input.windowStart.slice(0, 10);
      const end = input.windowEnd.slice(0, 10);
      const length =
        Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
      const days = { start, end, length };
      const now = Date.now();

      // Social: the brand rollup, then every channel against the window's released posts and their values.
      const rollup = await measurement.metrics.brandSummary({ brandId: input.brandId, ...window });
      const social = socialOf(rollup);
      const channels = await callers.publishing(ctx).channels.list({ brandId: input.brandId });
      const calendar = callers.content(ctx).calendar;
      const released = (
        publications: Array<{ publicationId: string; channelConnectionId: string | null; state: string }>,
      ) =>
        publications.flatMap((p) =>
          p.channelConnectionId !== null && (p.state === 'published' || p.state === 'removed')
            ? [{ publicationId: p.publicationId, channelConnectionId: p.channelConnectionId }]
            : [],
        );
      const ms = Date.parse(input.windowEnd) - Date.parse(input.windowStart);
      const current = released(
        (await calendar.range({ brandId: input.brandId, from: input.windowStart, to: input.windowEnd }))
          .publications,
      );
      const previous = released(
        (
          await calendar.range({
            brandId: input.brandId,
            from: new Date(Date.parse(input.windowStart) - ms).toISOString(),
            to: new Date(Date.parse(input.windowStart) - 1).toISOString(),
          })
        ).publications,
      );
      const definitions = await measurement.definitions.list({});
      const providers = new Set(channels.map((c) => c.providerKey));
      const keys = [
        ...new Set(
          definitions
            .filter(
              (d) => d.aggregation !== 'series' && (d.providerKey === null || providers.has(d.providerKey)),
            )
            .map((d) => d.key),
        ),
      ].slice(0, 50);
      const values =
        current.length > 0 && keys.length > 0
          ? (
              await measurement.metrics.query({
                brandId: input.brandId,
                subjectType: 'publication',
                subjectIds: current.map((p) => p.publicationId),
                metricKeys: keys,
                ...window,
                grouping: 'subject',
              })
            ).values
          : [];
      const sources: OverviewSourceV1[] = channels.map((c) => channelSource(c, current, previous, values));

      // Web sources and audits from the destinations the brand has.
      const destinations = callers.destinations(ctx);
      const listed = (await destinations.sources.list()).items;
      const web: OverviewWebSourceV1[] = [];
      const audits: OverviewAuditV1[] = [];
      const uncertified: Array<{ kind: string; label: string }> = [];
      for (const d of (await destinations.list({ brandId: input.brandId })).items.filter(
        (x) => x.status === 'active',
      )) {
        const source = listed.find((s) => s.kind === d.kind) ?? null;
        if (source && !source.certified && !uncertified.some((u) => u.kind === d.kind))
          uncertified.push({ kind: d.kind, label: source.label });
        if (d.kind === SEO_AUDIT_DESTINATION_KIND) {
          const composed = auditSourceOf(
            d,
            await destinations.audit.summary({ brandId: input.brandId, destinationId: d.id }),
            now,
          );
          audits.push(composed.entry);
          sources.push(composed.source);
          continue;
        }
        if (!source) continue;
        const summary = await destinations.reports.summary({
          brandId: input.brandId,
          destinationId: d.id,
          ...window,
        });
        if (summary.presentation === null) continue;
        const composed = webSourceOf(d, summary, length);
        web.push(composed.entry);
        sources.push(composed.source);
      }
      const separating = [...new Set(definitions.filter((d) => d.separatesPaidOrganic).map((d) => d.key))];
      const organicVsPaid: OverviewSummaryV1['organicVsPaid'] = {
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
      };
      const oremediaVsNative: OverviewSummaryV1['oremediaVsNative'] = {
        oremedia: {
          publications: social.sample.current,
          note: 'publications released through Oremedia in the window (the collection schedule reads each of them)',
        },
        native: {
          state: 'not_observed',
          reason:
            'posts made natively on a platform are not observed: ingestion collects per publication Oremedia released, so no native figure exists here',
        },
      };
      return {
        brandId: input.brandId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        days,
        social,
        web,
        audits,
        sources,
        organicVsPaid,
        oremediaVsNative,
        limits: limitsOf({ sources, web, audits, social, organicVsPaid, oremediaVsNative, uncertified }),
        computedAt: new Date(now).toISOString(),
      };
    }),
  });
}

function socialOf(summary: BrandSummaryOut): OverviewSocialV1 {
  const figures: OverviewFigureV1[] = OVERVIEW_SOCIAL_GROUPS.flatMap(([group, label]) => {
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
        coverage: {
          requested: summary.current.publications,
          withData: a.subjectsWithData,
          unit: 'posts' as const,
        },
        freshness: a.freshness
          ? {
              asOf: a.freshness.fetchedAt,
              ageHours: round(a.freshness.ageHours),
              latencyHours: a.freshness.latencyHours,
              stale: a.freshness.stale,
            }
          : null,
        source: { kind: 'social' as const, label: 'Social channels' },
        note: a.additive ? null : (NOT_SUMMED[a.kind] ?? 'not additive'),
      },
    ];
  });
  const oldest = figures
    .map((f) => f.freshness)
    .filter((f): f is OverviewFreshnessV1 => f !== null)
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

function channelSource(
  channel: { id: string; providerKey: string; displayName: string; status: string },
  current: Array<{ publicationId: string; channelConnectionId: string }>,
  previous: Array<{ publicationId: string; channelConnectionId: string }>,
  values: MetricValueV1[],
): OverviewSourceV1 {
  const min = COMPARISON_MINIMUM_SAMPLE;
  const mine = current.filter((p) => p.channelConnectionId === channel.id);
  const before = previous.filter((p) => p.channelConnectionId === channel.id).length;
  const ids = new Set(mine.map((p) => p.publicationId));
  const withData = values.filter(
    (v) => ids.has(v.subjectId) && v.value !== null && v.completeness !== 'unavailable',
  );
  const subjects = new Set(withData.map((v) => v.subjectId)).size;
  const ageHours = withData.length ? Math.max(...withData.map((v) => v.freshness.ageHours)) : null;
  const latencyHours = withData[0]?.freshness.latencyHours ?? 24;
  const stale = withData.some((v) => v.freshness.stale);
  const sufficient = mine.length >= min && before >= min;
  const base = {
    kind: 'channel' as const,
    id: channel.id,
    label: channel.displayName,
    platform: channel.providerKey,
    freshness: withData.length
      ? {
          asOf:
            withData
              .map((v) => v.freshness.fetchedAt)
              .sort()
              .at(-1) ?? null,
          ageHours: ageHours === null ? null : round(ageHours),
          latencyHours,
          stale,
        }
      : null,
    coverage: { requested: mine.length, withData: subjects, unit: 'posts' as const },
    sample: { current: mine.length, previous: before, minimum: min, sufficient },
    policy: null,
  };
  if (channel.status !== 'active')
    return {
      ...base,
      state: 'not_connected',
      reason: `connection ${channel.status.replace(/_/g, ' ')}: nothing is collected until it is reconnected`,
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
      reason: `fresh; ${mine.length} and ${before} posts of ${min} needed to compare`,
    };
  return { ...base, state: 'fresh', reason: `${subjects} of ${mine.length} posts have numbers` };
}

function webSourceOf(
  d: DestinationV1,
  summary: DestinationReportSummaryV1,
  windowDays: number,
): { entry: OverviewWebSourceV1; source: OverviewSourceV1 } {
  const ref: OverviewSourceRefV1 = {
    kind: 'web',
    id: d.id,
    label: d.displayName,
    platform: DESTINATION_KIND_CAPABILITIES[d.kind]?.label ?? d.kind,
  };
  const read = summary.reports.filter((e) => e.freshness.latestDate !== null);
  const latest = [...read]
    .sort((a, b) => (a.freshness.latestDate ?? '').localeCompare(b.freshness.latestDate ?? ''))
    .at(-1);
  const freshness: OverviewFreshnessV1 | null = latest
    ? {
        asOf: `${latest.freshness.latestDate}T23:59:59.999Z`,
        ageHours: latest.freshness.ageHours,
        latencyHours: latest.freshness.latencyHours,
        stale: read.some((e) => e.freshness.stale),
      }
    : null;
  const tiles =
    summary.reports.find((r) => r.reportKey === summary.presentation?.tiles.reportKey) ??
    summary.reports[0] ??
    null;
  const figures: OverviewFigureV1[] =
    tiles && summary.policy.allowed
      ? (summary.presentation?.tiles.metrics ?? []).flatMap((metric) => {
          const descriptor = webMetricByName(tiles.metrics, tiles.derived, metric);
          if (!descriptor) return [];
          const comparison = tiles.comparison.find((c) => c.metric === metric) ?? null;
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
              coverage: { requested: windowDays, withData: tiles.current.days, unit: 'days' as const },
              freshness: tiles.freshness.latestDate
                ? {
                    asOf: `${tiles.freshness.latestDate}T23:59:59.999Z`,
                    ageHours: tiles.freshness.ageHours,
                    latencyHours: tiles.freshness.latencyHours,
                    stale: tiles.freshness.stale,
                  }
                : null,
              source: ref,
              note: descriptor.kind === 'gauge' ? 'weighted mean, not compared' : null,
            },
          ];
        })
      : [];
  const entry: OverviewWebSourceV1 = {
    source: ref,
    policy: summary.policy,
    figures,
    console: summary.presentation?.console ?? null,
  };
  const base = {
    ...ref,
    freshness,
    coverage: tiles ? { requested: windowDays, withData: tiles.current.days, unit: 'days' as const } : null,
    sample: tiles ? tiles.sample : null,
    policy: summary.policy,
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

function auditSourceOf(
  d: DestinationV1,
  summary: SeoAuditSummaryV1,
  now: number,
): { entry: OverviewAuditV1; source: OverviewSourceV1 } {
  const ref: OverviewSourceRefV1 = {
    kind: 'audit',
    id: d.id,
    label: d.displayName,
    platform: DESTINATION_KIND_CAPABILITIES[d.kind]?.label ?? d.kind,
  };
  const run = summary.lastRun;
  const finishedAt = run?.finishedAt ?? null;
  const ageHours = finishedAt ? Math.max(0, (now - Date.parse(finishedAt)) / 3_600_000) : null;
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

function limitsOf(input: {
  sources: OverviewSourceV1[];
  web: OverviewWebSourceV1[];
  audits: OverviewAuditV1[];
  social: OverviewSocialV1;
  organicVsPaid: OverviewSummaryV1['organicVsPaid'];
  oremediaVsNative: OverviewSummaryV1['oremediaVsNative'];
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
    statement: input.organicVsPaid.paid.reason,
    source: null,
    link: null,
  });
  out.push({
    code: 'native_not_observed',
    statement: input.oremediaVsNative.native.reason,
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
