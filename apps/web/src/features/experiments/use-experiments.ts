import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type ExperimentDto = inferOutput<Trpc['experiments']['get']>;
export type ExperimentSummaryDto = inferOutput<Trpc['experiments']['list']>['items'][number];
export type ResultsDto = inferOutput<Trpc['experiments']['results']['get']>;
export type ResultDto = ResultsDto['items'][number];
export type ComputeResultDto = inferOutput<Trpc['experiments']['results']['compute']>;

const EXPERIMENTS_PAGE = 50;

/** One hook per query (spec 21.1); the brand's experiments newest first, every state, page by page (spec 7.4). */
export function useExperiments(brandId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId, page: { limit: EXPERIMENTS_PAGE } };
  return useCursorPages({
    queryKey: trpc.experiments.list.queryKey(input),
    fetchPage: (cursor) =>
      client.experiments.list.query({ brandId, page: { limit: EXPERIMENTS_PAGE, cursor } }),
  });
}

export function useExperiment(experimentId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.experiments.get.queryOptions({ experimentId: experimentId ?? '' }),
    enabled: experimentId !== null,
  });
}

export function useExperimentResults(experimentId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.experiments.results.get.queryOptions({ experimentId: experimentId ?? '' }),
    enabled: experimentId !== null,
  });
}
