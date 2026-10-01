import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type OverviewSummaryDto = inferOutput<Trpc['overview']['summary']>;
export type OverviewSourceDto = OverviewSummaryDto['sources'][number];
export type OverviewFigureDto = OverviewSummaryDto['social']['figures'][number];
export type OverviewLimitDto = OverviewSummaryDto['limits'][number];

/**
 * R2-5: the brand's overview over a window of UTC day bounds (the same window the Performance screen's Web
 * section sends): social rollup, web sources, the last audit, every source's state, the splits and the limits,
 * composed server-side from the modules' own read models. One hook per query (spec 21.1).
 */
export function useOverviewSummary(brandId: string, windowStart: string, windowEnd: string) {
  const trpc = useTRPC();
  return useQuery(trpc.overview.summary.queryOptions({ brandId, windowStart, windowEnd }));
}
