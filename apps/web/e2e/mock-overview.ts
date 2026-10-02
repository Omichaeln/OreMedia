import type { IncomingHttpHeaders } from 'node:http';
import {
  DESTINATION_KIND_CAPABILITIES,
  type DestinationReportSummaryV1,
  type DestinationV1,
} from '@oremedia/contracts/destinations';
import {
  COMPARISON_MINIMUM_SAMPLE,
  QUERY_SUBJECTS_MAX,
  type MetricAggregateV1,
  type MetricValueV1,
} from '@oremedia/contracts/measurement';
import {
  OverviewSummary,
  type OverviewAuditV1,
  type OverviewSourceV1,
  type OverviewSummaryV1,
  type OverviewWebSourceV1,
} from '@oremedia/contracts/overview';
import type { SeoAuditSummaryV1 } from '@oremedia/contracts/seo-audit';
import {
  auditSourceOf,
  channelSource,
  limitsOf,
  socialOf,
  splitsOf,
  webSourceOf,
} from '@oremedia/module-overview';
import type { MockBuilders, MockMember, t } from './mock-api';

/**
 * Overview slice of the UI-only transport (see mock-api.ts): overview.summary composed, as apps/api composes it
 * (packages/modules/overview/src/summary.ts), from the other mock routers' own procedures through callers (the
 * social rollup and per-publication values from measurement, the channels from publishing, the window's
 * publications from the calendar, the destinations with their report and audit summaries), with the module's own
 * composition rules (compose.ts, pure and contracts-only). A test double, never a second implementation.
 */
const DAY_MS = 86_400_000;

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
  subjectsTotal: number;
  truncated: boolean;
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

/** Released channel publications of a calendar window (a website article has no post metrics, R2-3). */
const released = (
  publications: Array<{ publicationId: string; channelConnectionId: string | null; state: string }>,
) =>
  publications.flatMap((p) =>
    p.channelConnectionId !== null && (p.state === 'published' || p.state === 'removed')
      ? [{ publicationId: p.publicationId, channelConnectionId: p.channelConnectionId }]
      : [],
  );

export function overviewRouters({ router, query }: OverviewBuilders, callers: OverviewCallers) {
  return router({
    summary: query.input(OverviewSummary).query(async ({ ctx, input }): Promise<OverviewSummaryV1> => {
      const measurement = callers.measurement(ctx);
      const calendar = callers.content(ctx).calendar;
      const destinations = callers.destinations(ctx);
      const window = { windowStart: input.windowStart, windowEnd: input.windowEnd };
      const start = input.windowStart.slice(0, 10);
      const end = input.windowEnd.slice(0, 10);
      const length =
        Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
      const ms = Date.parse(input.windowEnd) - Date.parse(input.windowStart);
      const at = new Date();
      const [
        rollup,
        channels,
        currentCalendar,
        previousCalendar,
        definitions,
        listedDestinations,
        sourceList,
      ] = await Promise.all([
        measurement.metrics.brandSummary({ brandId: input.brandId, ...window }),
        callers.publishing(ctx).channels.list({ brandId: input.brandId }),
        calendar.range({ brandId: input.brandId, from: input.windowStart, to: input.windowEnd }),
        calendar.range({
          brandId: input.brandId,
          from: new Date(Date.parse(input.windowStart) - ms).toISOString(),
          to: new Date(Date.parse(input.windowStart) - 1).toISOString(),
        }),
        measurement.definitions.list({}),
        destinations.list({ brandId: input.brandId }),
        destinations.sources.list(),
      ]);
      const social = socialOf(rollup);
      const current = released(currentCalendar.publications);
      const previous = released(previousCalendar.publications);
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
      // As the server's population query: every released post, read in query-sized chunks (no newest-200 cut).
      const values: MetricValueV1[] = [];
      for (let i = 0; keys.length > 0 && i < current.length; i += QUERY_SUBJECTS_MAX)
        values.push(
          ...(
            await measurement.metrics.query({
              brandId: input.brandId,
              subjectType: 'publication',
              subjectIds: current.slice(i, i + QUERY_SUBJECTS_MAX).map((p) => p.publicationId),
              metricKeys: keys,
              ...window,
              grouping: 'subject',
            })
          ).values,
        );
      const sources: OverviewSourceV1[] = channels.map((c) =>
        channelSource(c, current, previous, values, COMPARISON_MINIMUM_SAMPLE),
      );

      const active = listedDestinations.items.filter((d) => d.status === 'active');
      const listed = sourceList.items;
      const listedKinds = new Set(listed.map((s) => s.kind));
      const uncertified: Array<{ kind: string; label: string }> = [];
      for (const d of active) {
        const source = listed.find((s) => s.kind === d.kind);
        if (source && !source.certified && !uncertified.some((u) => u.kind === d.kind))
          uncertified.push({ kind: d.kind, label: source.label });
      }
      const audits = await Promise.all(
        active
          .filter((d) => DESTINATION_KIND_CAPABILITIES[d.kind]?.auditable)
          .map(async (d) =>
            auditSourceOf(
              d,
              await destinations.audit.summary({ brandId: input.brandId, destinationId: d.id }),
              at,
            ),
          ),
      );
      const reports = await Promise.all(
        active
          .filter((d) => !DESTINATION_KIND_CAPABILITIES[d.kind]?.auditable && listedKinds.has(d.kind))
          .map(async (d) => ({
            destination: d,
            summary: await destinations.reports.summary({
              brandId: input.brandId,
              destinationId: d.id,
              ...window,
            }),
          })),
      );
      const web = reports
        .filter((r) => r.summary.presentation !== null)
        .map((r) => webSourceOf(r.destination, r.summary, length));
      sources.push(...audits.map((a) => a.source), ...web.map((w) => w.source));
      const splits = splitsOf(social, definitions);
      const webEntries: OverviewWebSourceV1[] = web.map((w) => w.entry);
      const auditEntries: OverviewAuditV1[] = audits.map((a) => a.entry);
      return {
        brandId: input.brandId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        days: { start, end, length },
        social,
        web: webEntries,
        audits: auditEntries,
        sources,
        organicVsPaid: splits.organicVsPaid,
        oremediaVsNative: splits.oremediaVsNative,
        limits: limitsOf({ sources, web: webEntries, audits: auditEntries, social, splits, uncertified }),
        computedAt: at.toISOString(),
      };
    }),
  });
}
