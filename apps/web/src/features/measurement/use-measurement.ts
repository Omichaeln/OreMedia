import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { MetricAgeDays } from '@oremedia/contracts/measurement';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type MetricDefinitionDto = inferOutput<Trpc['measurement']['definitions']['list']>[number];
export type MetricsResultDto = inferOutput<Trpc['measurement']['metrics']['query']>;
export type MetricValueDto = MetricsResultDto['values'][number];
export type MetricAggregateDto = MetricsResultDto['aggregates'][number];

/** Spec 15.1: the global (capability register) and company metric definitions. One hook per query (spec 21.1). */
export function useMetricDefinitions() {
  const trpc = useTRPC();
  return useQuery(trpc.measurement.definitions.list.queryOptions({}));
}

/** Publications per page of the per-publication values (the query's own subject bound). */
const VALUES_PAGE = 200;

/**
 * Spec 15.2: the latest value per (publication, metric) for every released publication of the window (one
 * channel's with `channelConnectionId`), with freshness on every value; with `ageDays`, each post's total at
 * that age instead (so posts published on different days compare). The server pages the publications newest
 * first and every page is read (spec 7.4), so a window past one page is never cut to its newest posts; `complete`
 * says when the last page is in. Nothing is asked until there is something to ask about.
 */
export function usePublicationValues(
  brandId: string,
  metricKeys: string[],
  windowStart: string,
  windowEnd: string,
  opts: { ageDays?: MetricAgeDays; channelConnectionId?: string | null; enabled: boolean },
) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = {
    brandId,
    metricKeys,
    windowStart,
    windowEnd,
    ...(opts.ageDays ? { ageDays: opts.ageDays } : {}),
    ...(opts.channelConnectionId ? { channelConnectionId: opts.channelConnectionId } : {}),
  };
  return useCursorPages({
    queryKey: trpc.measurement.metrics.publicationValues.queryKey({ ...input, page: { limit: VALUES_PAGE } }),
    fetchPage: (cursor) =>
      client.measurement.metrics.publicationValues.query({ ...input, page: { limit: VALUES_PAGE, cursor } }),
    enabled: opts.enabled && metricKeys.length > 0,
    readAll: true,
  });
}

export type BrandPerformanceDto = inferOutput<Trpc['measurement']['metrics']['brandSummary']>;
export type AttributeAggregateDto = inferOutput<Trpc['measurement']['attributes']['aggregate']>;
export type QualityDto = inferOutput<Trpc['measurement']['quality']['get']>;
export type TrackedLinkDto = inferOutput<Trpc['measurement']['links']['list']>['items'][number];

/**
 * UX-11: one brand's window beside the previous one, by the dictionary's rules (D-14, D-15), over every released
 * publication of the window (one channel's with `channelConnectionId`): the Performance totals read it.
 */
export function useBrandPerformance(
  brandId: string,
  windowStart: string,
  windowEnd: string,
  ageDays?: MetricAgeDays,
  channelConnectionId?: string | null,
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.measurement.metrics.brandSummary.queryOptions({
      brandId,
      windowStart,
      windowEnd,
      ...(ageDays ? { ageDays } : {}),
      ...(channelConnectionId ? { channelConnectionId } : {}),
    }),
  );
}

/**
 * UX-11 from the portfolio: the same rollup asked of one company for one of its brands. The tenant is named on
 * the request (as useBrandSummary does) and joins the key, since the portfolio shows several companies at once.
 */
export function useBrandPerformanceOf(
  tenantId: string,
  brandId: string,
  windowStart: string,
  windowEnd: string,
  ageDays: MetricAgeDays,
) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId, windowStart, windowEnd, ageDays };
  return useQuery({
    queryKey: [...trpc.measurement.metrics.brandSummary.queryKey(input), { tenantId }],
    queryFn: () => client.measurement.metrics.brandSummary.query(input, { context: { tenantId } }),
    retry: false,
  });
}

/** UX-12: what the creative did, as the pooled rate per captured attribute value beside the brand's. */
export function useAttributeAggregate(
  brandId: string,
  windowStart: string,
  windowEnd: string,
  enabled: boolean,
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.measurement.attributes.aggregate.queryOptions({ brandId, windowStart, windowEnd }),
    enabled,
  });
}

/** Spec 15.3: the engagement quality composite of one publication, with its components and what is unavailable. */
export function usePublicationQuality(
  brandId: string,
  publicationId: string | null,
  windowStart: string,
  windowEnd: string,
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.measurement.quality.get.queryOptions({
      brandId,
      publicationId: publicationId ?? '',
      windowStart,
      windowEnd,
    }),
    enabled: publicationId !== null,
  });
}

/** Spec 15.4: the tracked links of one publication with the clicks the redirector recorded. */
export function useTrackedLinks(brandId: string, publicationId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.measurement.links.list.queryOptions({
      brandId,
      publicationId: publicationId ?? '',
      page: { limit: 50 },
    }),
    enabled: publicationId !== null,
  });
}
