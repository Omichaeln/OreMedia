import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type WebReportSummaryDto = inferOutput<Trpc['destinations']['reports']['summary']>;
export type WebReportEntryDto = WebReportSummaryDto['reports'][number];
export type WebReportRowDto = inferOutput<Trpc['destinations']['reports']['rows']>['items'][number];
export type WebOpportunityDto = inferOutput<
  Trpc['destinations']['reports']['opportunities']
>['items'][number];

/**
 * R2-1 part B: one GA4 property's or Search Console site's reports over the window, by the dictionary's rules
 * (D-14, D-15), with the previous window beside it and whether the source-use policy allows the read. One hook
 * per query (spec 21.1).
 */
export function useWebReportSummary(
  brandId: string,
  destinationId: string,
  windowStart: string,
  windowEnd: string,
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.destinations.reports.summary.queryOptions({ brandId, destinationId, windowStart, windowEnd }),
  );
}

/** The drill-down of one report: the window's values per dimension value, by the report's primary metric. */
export function useWebReportRows(
  brandId: string,
  destinationId: string,
  reportKey: string,
  windowStart: string,
  windowEnd: string,
  enabled: boolean,
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.destinations.reports.rows.queryOptions({
      brandId,
      destinationId,
      reportKey,
      windowStart,
      windowEnd,
      limit: 50,
    }),
    enabled,
  });
}

/** The computed opportunity queue of one destination over the last 28 days (read-only; tasks come later). */
export function useWebOpportunities(brandId: string, destinationId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.destinations.reports.opportunities.queryOptions({ brandId, destinationId }),
    enabled,
  });
}
