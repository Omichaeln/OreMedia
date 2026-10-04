import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { VideoAiRequestInput } from '@oremedia/contracts/video-ai';
import { useTRPC, type Trpc } from '../../../lib/trpc';

/**
 * STU-3 studio video AI reads: the document's live and last jobs (the panels reattach to them after a reload), one
 * job polled while it runs, the preflight of a request as it is being written, and the assets a storyboard shot may
 * show. Mutations (start, cancel, retry, assemble, accept) live with the panels that make them.
 */
export type VideoAiJobDto = inferOutput<Trpc['creative']['videoAi']['get']>;
export type VideoAiPreflightDto = inferOutput<Trpc['creative']['videoAi']['preflight']>;
export type VideoAiProposalDto = NonNullable<NonNullable<VideoAiJobDto['result']>['proposal']>;

const POLL_MS = 1500;

/** Every live job of the document and the last finished storyboard and recut; polled while one runs. */
export function useVideoAiActive(documentId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.videoAi.active.queryOptions({ documentId }),
    refetchInterval: (q) => (q.state.data?.items.length ? POLL_MS : false),
  });
}

/** One job, polled until it finishes. */
export function useVideoAiJob(jobId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.videoAi.get.queryOptions({ jobId: jobId ?? '' }),
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data && !q.state.data.live ? false : POLL_MS),
  });
}

/** What a request would use and cost, and what blocks it (nothing is written). */
export function useVideoAiPreflight(
  documentId: string,
  baseRevisionId: string,
  request: VideoAiRequestInput | null,
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.videoAi.preflight.queryOptions({
      documentId,
      baseRevisionId,
      request: request ?? { kind: 'storyboard', brief: {} },
    }),
    enabled: request !== null,
    staleTime: 10_000,
  });
}

/** The brand's footage and stills a shot may show (eligible for creative use; the server checks again). */
export function useShotAssets(brandId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.assets.search.queryOptions({
      query: {
        brandId,
        purpose: 'creative',
        channelConnectionIds: [],
        kinds: ['video', 'photo', 'illustration', 'icon'],
      },
      page: { limit: 100 },
    }),
  );
}

/** The brand's approved facts in force, to pick by statement. */
export function useEffectiveFacts(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.brand.facts.list.queryOptions({ brandId, effective: true, page: { limit: 100 } }));
}

/** A job's progress in words (the panels announce it through a live region). */
export function jobStatusText(job: Pick<VideoAiJobDto, 'state' | 'kind' | 'error'>): string {
  const what = job.kind === 'storyboard' ? 'storyboard' : 'change';
  switch (job.state) {
    case 'queued':
      return `Your ${what} is queued`;
    case 'generating':
      return `Writing the ${what}`;
    case 'validating':
      return 'Checking it against the brand, the assets and the timeline';
    case 'saving':
      return 'Saving';
    case 'completed':
      return job.kind === 'storyboard' ? 'Storyboard ready' : 'Proposal ready';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return `It did not finish: ${job.error?.message ?? 'unknown error'}`;
  }
}
