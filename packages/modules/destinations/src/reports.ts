import type { z } from 'zod';
import {
  DestinationReportOpportunities,
  DestinationReportRows,
  DestinationReportSummary,
  OPPORTUNITIES_MAX,
  OPPORTUNITY_MIN_IMPRESSIONS,
  OPPORTUNITY_MIN_SESSIONS,
  OPPORTUNITY_RATE_FRACTION,
  OPPORTUNITY_WINDOW_DAYS,
  reportDataType,
  reportPrimaryMetric,
  webMetricSpec,
  webMetricValues,
  type DestinationKind,
  type DestinationReportComparisonV1,
  type DestinationReportFreshnessV1,
  type DestinationReportOpportunityV1,
  type DestinationReportRowV1,
  type DestinationReportSummaryEntryV1,
  type DestinationReportSummaryV1,
  type DestinationReportWindowV1,
  type SourceUseCheckResult,
} from '@oremedia/contracts/destinations';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { COMPARISON_MINIMUM_SAMPLE } from '@oremedia/contracts/measurement';
import type { Page } from '@oremedia/contracts/pagination';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { Tx } from '@oremedia/db';
import { policy } from '@oremedia/module-access';
import { STALE_FACTOR } from '@oremedia/module-measurement';
import type { SourceReportSpec } from '@oremedia/providers';
import { addDays, dateKey } from './report-runtime';
import {
  BrandDestinationRepository,
  DestinationReportRowRepository,
  SourceUsePolicyRepository,
  type ReportDimensionAggregate,
} from './repositories';
import { StoredKind, brandResource, destinationOf, sourceUseDecision, visibleBrand } from './service';
import { registry } from './sources';

/**
 * R2-1 part B read model over the stored report rows (restricted view, D-17): per report the window's totals by
 * the dictionary's kinds (flows summed, rates pooled, gauges weighted; D-15), its freshness, the previous window of
 * equal length with the D-14 minimum sample, drill-down rows per dimension value, and the computed opportunity
 * queue. A day without rows stays absent: nothing here turns a missing number into a zero.
 */
const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();
const rowsRepo = new DestinationReportRowRepository();
const DAY_MS = 86_400_000;

export interface ReportQueryOptions {
  now?: () => Date;
}

/** The inclusive UTC day keys of a datetime window (the web sends day bounds; the platforms report by day). */
const dayWindow = (windowStart: string, windowEnd: string) => {
  const start = windowStart.slice(0, 10);
  const end = windowEnd.slice(0, 10);
  const length = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  return { start, end, length: Math.max(1, length) };
};

/** Stale when the latest day's end is older than STALE_FACTOR × the report's latency (the dictionary's rule). */
export function reportFreshness(
  latestDate: string | null,
  fetchedAt: Date | null,
  latencyHours: number,
  now: Date,
): DestinationReportFreshnessV1 {
  if (!latestDate) return { latestDate: null, fetchedAt: null, ageHours: null, latencyHours, stale: true };
  const ageHours = Math.max(0, (now.getTime() - Date.parse(`${latestDate}T23:59:59.999Z`)) / 3_600_000);
  return {
    latestDate,
    fetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
    ageHours: Math.round(ageHours * 100) / 100,
    latencyHours,
    stale: ageHours > latencyHours * STALE_FACTOR,
  };
}

/** D-14 over days: flows and rates compare; a change needs a sufficient sample and a positive previous value. */
export function reportComparison(
  current: Record<string, number | null>,
  previous: Record<string, number | null>,
  sufficient: boolean,
): DestinationReportComparisonV1[] {
  return Object.keys(current).flatMap((metric) => {
    const spec = webMetricSpec(metric);
    if (!spec || spec.kind === 'gauge') return [];
    const a = current[metric] ?? null;
    const b = previous[metric] ?? null;
    const change = sufficient && a !== null && b !== null && b > 0 ? (a - b) / b : null;
    return [{ metric, kind: spec.kind, current: a, previous: b, change }];
  });
}

const toRow = (a: ReportDimensionAggregate, metrics: readonly string[]): DestinationReportRowV1 => ({
  dimensionKey: a.dimensionKey,
  dimensions: a.dimensions,
  days: a.days,
  metrics: webMetricValues(metrics, a.sums),
});

export function createDestinationReportService(opts: ReportQueryOptions = {}) {
  const now = opts.now ?? (() => new Date());

  /** The destination under its brand (foreign → NOT_FOUND), brand.read asserted, with its reports and policy. */
  async function readable(actor: ResolvedActor, brandId: string, destinationId: string, at: Date, tx?: Tx) {
    await visibleBrand(actor, brandId, tx);
    const row = await destinationOf(
      brandId,
      destinationId,
      await destinationsRepo.findById(destinationId, tx),
    );
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    const kind: DestinationKind = StoredKind.parse(row.kind);
    const reports: SourceReportSpec[] = registry().capability(kind)?.reports ?? [];
    const dataType = reports[0] ? reportDataType(reports[0].key) : `${kind}.reports`;
    const decision: SourceUseCheckResult = sourceUseDecision(
      await policiesRepo.findByKey(row.brandId, kind, dataType, tx),
      'read',
      at,
    );
    return { row, kind, reports, dataType, decision };
  }

  async function windowOf(
    brandId: string,
    destinationId: string,
    spec: SourceReportSpec,
    start: string,
    end: string,
    tx?: Tx,
  ): Promise<DestinationReportWindowV1 & { latestDate: string | null; fetchedAt: Date | null }> {
    const [coverage, sums] = await Promise.all([
      rowsRepo.coverage(brandId, destinationId, spec.key, start, end, tx),
      rowsRepo.totals(brandId, destinationId, spec.key, spec.metrics, start, end, tx),
    ]);
    return {
      windowStart: start,
      windowEnd: end,
      days: coverage.days,
      rows: coverage.rows,
      metrics: webMetricValues(spec.metrics, sums),
      latestDate: coverage.latestDate,
      fetchedAt: coverage.fetchedAt,
    };
  }

  const service = {
    /** Per report: totals, freshness and the previous equal-length window (D-14, D-15). brand.read on the brand. */
    async summary(
      actor: ResolvedActor,
      input: z.infer<typeof DestinationReportSummary>,
      tx?: Tx,
    ): Promise<DestinationReportSummaryV1> {
      const parsed = DestinationReportSummary.parse(input);
      const at = now();
      const { row, kind, reports, dataType, decision } = await readable(
        actor,
        parsed.brandId,
        parsed.destinationId,
        at,
        tx,
      );
      const { start, end, length } = dayWindow(parsed.windowStart, parsed.windowEnd);
      const entries: DestinationReportSummaryEntryV1[] = [];
      if (decision.allowed)
        for (const spec of reports) {
          const current = await windowOf(row.brandId, row.id, spec, start, end, tx);
          const previous = await windowOf(
            row.brandId,
            row.id,
            spec,
            addDays(start, -length),
            addDays(start, -1),
            tx,
          );
          const sufficient =
            current.days >= COMPARISON_MINIMUM_SAMPLE && previous.days >= COMPARISON_MINIMUM_SAMPLE;
          const { latestDate, fetchedAt, ...currentWindow } = current;
          const { latestDate: _l, fetchedAt: _f, ...previousWindow } = previous;
          void _l;
          void _f;
          entries.push({
            reportKey: spec.key,
            dimensions: spec.dimensions,
            metrics: spec.metrics,
            freshness: reportFreshness(latestDate, fetchedAt, spec.latencyHours, at),
            current: currentWindow,
            previous: previousWindow,
            comparison: reportComparison(current.metrics, previous.metrics, sufficient),
            sample: {
              current: current.days,
              previous: previous.days,
              minimum: COMPARISON_MINIMUM_SAMPLE,
              sufficient,
            },
          });
        }
      return {
        brandId: row.brandId,
        destinationId: row.id,
        kind,
        policy: { allowed: decision.allowed, reason: decision.reason, dataType },
        windowStart: start,
        windowEnd: end,
        reports: entries,
        computedAt: at.toISOString(),
      };
    },

    /** Drill-down: the window's values per dimension value, by the report's primary metric, paged by cursor. */
    async rows(
      actor: ResolvedActor,
      input: z.input<typeof DestinationReportRows>,
      tx?: Tx,
    ): Promise<Page<DestinationReportRowV1>> {
      const parsed = DestinationReportRows.parse(input);
      const { row, reports, decision } = await readable(
        actor,
        parsed.brandId,
        parsed.destinationId,
        now(),
        tx,
      );
      if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
      const spec = reports.find((r) => r.key === parsed.reportKey);
      if (!spec) return { items: [], nextCursor: null };
      const { start, end } = dayWindow(parsed.windowStart, parsed.windowEnd);
      const page = await rowsRepo.aggregateByDimension(
        row.brandId,
        row.id,
        spec.key,
        spec.metrics,
        reportPrimaryMetric(spec.metrics),
        start,
        end,
        { limit: parsed.limit, cursor: parsed.cursor },
        tx,
      );
      return { items: page.items.map((a) => toRow(a, spec.metrics)), nextCursor: page.nextCursor };
    },

    /**
     * Computed, read-only: over the last 28 days, Search Console queries and pages with enough impressions and a
     * CTR below half the destination's pooled CTR, and GA4 landing pages with enough sessions and an engagement
     * rate below half the pooled one. Creating tasks from them is a later step.
     */
    async opportunities(
      actor: ResolvedActor,
      input: z.infer<typeof DestinationReportOpportunities>,
      tx?: Tx,
    ): Promise<{ items: DestinationReportOpportunityV1[]; windowStart: string; windowEnd: string }> {
      const parsed = DestinationReportOpportunities.parse(input);
      const at = now();
      const { row, reports, decision } = await readable(actor, parsed.brandId, parsed.destinationId, at, tx);
      if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
      const end = addDays(dateKey(at), -1);
      const start = addDays(end, -(OPPORTUNITY_WINDOW_DAYS - 1));
      const items: DestinationReportOpportunityV1[] = [];
      const candidates = async (spec: SourceReportSpec) =>
        (
          await rowsRepo.aggregateByDimension(
            row.brandId,
            row.id,
            spec.key,
            spec.metrics,
            reportPrimaryMetric(spec.metrics),
            start,
            end,
            { limit: 200 },
            tx,
          )
        ).items.map((a) => toRow(a, spec.metrics));
      const pooled = async (spec: SourceReportSpec, metric: string) =>
        webMetricValues(
          spec.metrics,
          await rowsRepo.totals(row.brandId, row.id, spec.key, spec.metrics, start, end, tx),
        )[metric] ?? null;
      for (const spec of reports) {
        const dimension = spec.dimensions[0];
        if (!dimension) continue;
        if (spec.key === 'gsc.queries' || spec.key === 'gsc.pages') {
          const benchmark = await pooled(spec, 'ctr');
          if (benchmark === null) continue;
          for (const r of await candidates(spec)) {
            const impressions = r.metrics['impressions'] ?? null;
            const ctr = r.metrics['ctr'] ?? null;
            if (impressions === null || ctr === null || impressions < OPPORTUNITY_MIN_IMPRESSIONS) continue;
            if (ctr >= benchmark * OPPORTUNITY_RATE_FRACTION) continue;
            const subject = r.dimensions[dimension] ?? '';
            items.push({
              kind: spec.key === 'gsc.queries' ? 'low_ctr_query' : 'low_ctr_page',
              reportKey: spec.key,
              subject,
              metrics: r.metrics,
              benchmark: { metric: 'ctr', value: benchmark },
              suggestedTask:
                spec.key === 'gsc.queries'
                  ? `Rewrite the title and description of the page ranking for "${subject}" (${impressions} impressions, CTR ${pct(ctr)} against ${pct(benchmark)} for the site)`
                  : `Rewrite the title and description of ${subject} (${impressions} impressions, CTR ${pct(ctr)} against ${pct(benchmark)} for the site)`,
            });
          }
        } else if (spec.key === 'ga4.landing_pages') {
          const benchmark = await pooled(spec, 'engagementRate');
          if (benchmark === null) continue;
          for (const r of await candidates(spec)) {
            const sessions = r.metrics['sessions'] ?? null;
            const rate = r.metrics['engagementRate'] ?? null;
            if (sessions === null || rate === null || sessions < OPPORTUNITY_MIN_SESSIONS) continue;
            if (rate >= benchmark * OPPORTUNITY_RATE_FRACTION) continue;
            const subject = r.dimensions[dimension] ?? '';
            items.push({
              kind: 'low_engagement_page',
              reportKey: spec.key,
              subject,
              metrics: r.metrics,
              benchmark: { metric: 'engagementRate', value: benchmark },
              suggestedTask: `Review the content and next step on landing page ${subject} (${sessions} sessions, engagement rate ${pct(rate)} against ${pct(benchmark)} for the property)`,
            });
          }
        }
      }
      return { items: items.slice(0, OPPORTUNITIES_MAX), windowStart: start, windowEnd: end };
    },
  };
  return service;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export const destinationReportService = createDestinationReportService();
