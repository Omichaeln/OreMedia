import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type RunDto = inferOutput<Trpc['agents']['runs']['get']>;
export type StepDto = inferOutput<Trpc['agents']['runs']['steps']>['items'][number];
export type InvocationDto = StepDto['invocations'][number];

/** While a run is live the screen polls; a terminal run is a record and is fetched once (spec 12.2 states). */
const LIVE: ReadonlySet<string> = new Set(['planned', 'running', 'waiting_for_review']);
const POLL_MS = 5_000;
const RUNS_PAGE = 50;

/** One hook per query (spec 21.1); the tenant header comes from the URL. */
export function useAgentRun(runId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.agents.runs.get.queryOptions({ runId: runId ?? '' }),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data && LIVE.has(q.state.data.state) ? POLL_MS : false),
  });
}

export function useAgentRunSteps(runId: string | null, live: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.agents.runs.steps.queryOptions({ runId: runId ?? '', page: { limit: 200 } }),
    enabled: runId !== null,
    refetchInterval: live ? POLL_MS : false,
  });
}

/** The brand's runs, newest first, page by page (spec 7.4); the list polls while any run shown is live. */
export function useAgentRunList(brandId: string, limit: number = RUNS_PAGE) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId, page: { limit } };
  return useCursorPages({
    queryKey: trpc.agents.runs.list.queryKey(input),
    fetchPage: (cursor) =>
      client.agents.runs.list.query({ brandId, page: { limit, ...(cursor ? { cursor } : {}) } }),
    refetchInterval: (items) => (items.some((r) => LIVE.has(r.state)) ? POLL_MS : false),
  });
}
