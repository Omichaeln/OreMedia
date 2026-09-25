import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type MetricDefinitionDto = inferOutput<Trpc['measurement']['definitions']['list']>[number];
export type MetricsResultDto = inferOutput<Trpc['measurement']['metrics']['query']>;
export type MetricValueDto = MetricsResultDto['values'][number];
export type MetricAggregateDto = MetricsResultDto['aggregates'][number];

/** Spec 15.1: the global (capability register) and company metric definitions. One hook per query (spec 21.1). */
export function useMetricDefinitions() {
  const trpc = useTRPC();
  return useQuery(trpc.measurement.definitions.list.queryOptions({}));
}

/**
 * Spec 15.2: the latest value per (publication, metric) in the window, with freshness on every value, sums only
 * inside a comparable group and a coverage statement. Nothing is asked until there is something to ask about.
 */
export function usePublicationMetrics(
  brandId: string,
  publicationIds: string[],
  metricKeys: string[],
  windowStart: string,
  windowEnd: string,
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.measurement.metrics.query.queryOptions({
      brandId,
      subjectType: 'publication',
      subjectIds: publicationIds,
      metricKeys,
      windowStart,
      windowEnd,
      grouping: 'comparable_group',
    }),
    enabled: publicationIds.length > 0 && metricKeys.length > 0,
  });
}
