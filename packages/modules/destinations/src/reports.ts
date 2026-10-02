import type { z } from 'zod';
import {
  DestinationReportOpportunities,
  DestinationReportRows,
  DestinationReportSummary,
  OPPORTUNITIES_MAX,
  OPPORTUNITY_RATE_FRACTION,
  OPPORTUNITY_WINDOW_DAYS,
  reportPrimaryMetric,
  webMetricValues,
  type DestinationKind,
  type DestinationReportComparisonV1,
  type DestinationReportFreshnessV1,
  type DestinationReportOpportunityV1,
  type DestinationReportQualityV1,
  type DestinationReportRowV1,
  type DestinationReportSummaryEntryV1,
  type DestinationReportSummaryV1,
  type DestinationReportWindowV1,
  type SourceReportMetricV1,
  type SourceReportQualityFlag,
} from '@oremedia/contracts/destinations';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { COMPARISON_MINIMUM_SAMPLE } from '@oremedia/contracts/measurement';
import type { Page } from '@oremedia/contracts/pagination';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { Tx } from '@oremedia/db';
import { policy } from '@oremedia/module-access';
import { STALE_FACTOR } from '@oremedia/module-measurement';
import type { SourceReportSpec } from '@oremedia/providers';
import { addDays, dateKey, dayEnd, reportUseDecision } from './report-runtime';
import {
  BrandDestinationRepository,
  DestinationReportRowRepository,
  type ReportDimensionAggregate,
} from './repositories';
import { StoredKind, brandResource, destinationOf, visibleBrand } from './service';
import { registry } from './sources';

/**
 * R2-1 part B read model over the stored report rows (restricted view, D-17): per report the window's totals by
 * the dictionary's kinds (flows summed, rates pooled, gauges weighted; D-15), its freshness, the previous window of
 * equal length with the D-14 minimum sample, drill-down rows per dimension value, and the computed opportunity
 * queue. A day without rows stays absent: nothing here turns a missing number into a zero.
 */
const destinationsRepo = new BrandDestinationRepository();
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

/**
 * Stale when the latest day's end is older than STALE_FACTOR × the report's latency (the dictionary's rule). The
 * day ends in the zone its rows are keyed in (RA-10); a UTC day without one.
 */
export function reportFreshness(
  latestDate: string | null,
  fetchedAt: Date | null,
  latencyHours: number,
  now: Date,
  timeZone: string | null = null,
): DestinationReportFreshnessV1 {
  if (!latestDate) return { latestDate: null, fetchedAt: null, ageHours: null, latencyHours, stale: true };
  const ageHours = Math.max(0, (now.getTime() - dayEnd(latestDate, timeZone).getTime()) / 3_600_000);
  return {
    latestDate,
    fetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
    ageHours: Math.round(ageHours * 100) / 100,
    latencyHours,
    stale: ageHours > latencyHours * STALE_FACTOR,
  };
}

/**
 * RA-10: the quality of a report's window. Provisional while the latest day may still move: inside the report's
 * latency after that day ended in its zone, flagged `partial_day` by the sweep (read before the day ended) or
 * `not_final` by the platform. The other flags are passed through as the platform exposed them.
 */
export function reportQuality(
  latestDate: string | null,
  timeZone: string | null,
  flags: readonly SourceReportQualityFlag[],
  latencyHours: number,
  now: Date,
): DestinationReportQualityV1 {
  const withinLatency =
    latestDate !== null && now.getTime() - dayEnd(latestDate, timeZone).getTime() < latencyHours * 3_600_000;
  return {
    timeZone,
    asOfLocalDate: latestDate,
    provisional:
      latestDate !== null && (withinLatency || flags.includes('partial_day') || flags.includes('not_final')),
    flags: [...flags],
  };
}

/** D-14 over days: flows and rates compare; a change needs a sufficient sample and a positive previous value. */
export function reportComparison(
  descriptors: readonly SourceReportMetricV1[],
  current: Record<string, number | null>,
  previous: Record<string, number | null>,
  sufficient: boolean,
): DestinationReportComparisonV1[] {
  return descriptors.flatMap((spec) => {
    if (spec.kind === 'gauge') return [];
    const a = current[spec.name] ?? null;
    const b = previous[spec.name] ?? null;
    const change = sufficient && a !== null && b !== null && b > 0 ? (a - b) / b : null;
    return [{ metric: spec.name, kind: spec.kind, current: a, previous: b, change }];
  });
}

const toRow = (a: ReportDimensionAggregate, spec: SourceReportSpec): DestinationReportRowV1 => ({
  dimensionKey: a.dimensionKey,
  dimensions: a.dimensions,
  days: a.days,
  metrics: webMetricValues(spec.metrics, spec.derived, a.sums),
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
    const capability = registry().capability(kind);
    const reports: SourceReportSpec[] = capability?.reports ?? [];
    const { dataType, decision } = await reportUseDecision(row.brandId, kind, reports, 'read', at, tx);
    return { row, kind, reports, presentation: capability?.presentation ?? null, dataType, decision };
  }

  async function windowOf(
    brandId: string,
    destinationId: string,
    spec: SourceReportSpec,
    start: string,
    end: string,
    tx?: Tx,
  ): Promise<
    DestinationReportWindowV1 & {
      latestDate: string | null;
      fetchedAt: Date | null;
      timeZone: string | null;
      flags: SourceReportQualityFlag[];
    }
  > {
    const [coverage, sums] = await Promise.all([
      rowsRepo.coverage(brandId, destinationId, spec.key, start, end, tx),
      rowsRepo.totals(brandId, destinationId, spec.key, spec.metrics, start, end, tx),
    ]);
    return {
      windowStart: start,
      windowEnd: end,
      days: coverage.days,
      rows: coverage.rows,
      metrics: webMetricValues(spec.metrics, spec.derived, sums),
      latestDate: coverage.latestDate,
      fetchedAt: coverage.fetchedAt,
      timeZone: coverage.timeZone,
      flags: coverage.flags,
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
      const { row, kind, reports, presentation, dataType, decision } = await readable(
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
          const { latestDate, fetchedAt, timeZone, flags, ...currentWindow } = current;
          const { latestDate: _l, fetchedAt: _f, timeZone: _z, flags: _q, ...previousWindow } = previous;
          void _l;
          void _f;
          void _z;
          void _q;
          entries.push({
            reportKey: spec.key,
            label: spec.label,
            dimensions: spec.dimensions.map((name) => ({ name, label: spec.dimensionLabels[name] ?? name })),
            metrics: spec.metrics,
            derived: spec.derived,
            freshness: reportFreshness(latestDate, fetchedAt, spec.latencyHours, at, timeZone),
            quality: reportQuality(latestDate, timeZone, flags, spec.latencyHours, at),
            current: currentWindow,
            previous: previousWindow,
            comparison: reportComparison(
              [...spec.metrics, ...spec.derived],
              current.metrics,
              previous.metrics,
              sufficient,
            ),
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
        presentation,
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
      return { items: page.items.map((a) => toRow(a, spec)), nextCursor: page.nextCursor };
    },

    /**
     * Computed, read-only: over the last 28 days, every opportunity rule the source's reports declare (a subject
     * with enough volume whose rate is below half the destination's pooled rate; the adapter words the task).
     * Creating tasks from them is a later step.
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
      // Every rule a report declares, applied the same way: the subject's rate against the pooled one.
      for (const spec of reports) {
        const rule = spec.opportunity;
        const dimension = spec.dimensions[0];
        if (!rule || !dimension) continue;
        const benchmark =
          webMetricValues(
            spec.metrics,
            spec.derived,
            await rowsRepo.totals(row.brandId, row.id, spec.key, spec.metrics, start, end, tx),
          )[rule.rateMetric] ?? null;
        if (benchmark === null) continue;
        const candidates = await rowsRepo.aggregateByDimension(
          row.brandId,
          row.id,
          spec.key,
          spec.metrics,
          reportPrimaryMetric(spec.metrics),
          start,
          end,
          { limit: 200 },
          tx,
        );
        for (const r of candidates.items.map((a) => toRow(a, spec))) {
          const volume = r.metrics[rule.volumeMetric] ?? null;
          const rate = r.metrics[rule.rateMetric] ?? null;
          if (volume === null || rate === null || volume < rule.minVolume) continue;
          if (rate >= benchmark * OPPORTUNITY_RATE_FRACTION) continue;
          const subject = r.dimensions[dimension] ?? '';
          items.push({
            kind: rule.kind,
            reportKey: spec.key,
            subject,
            metrics: r.metrics,
            benchmark: { metric: rule.rateMetric, value: benchmark },
            suggestedTask: rule.task({ subject, volume, rate, benchmark }),
          });
        }
      }
      return { items: items.slice(0, OPPORTUNITIES_MAX), windowStart: start, windowEnd: end };
    },
  };
  return service;
}

export const destinationReportService = createDestinationReportService();
