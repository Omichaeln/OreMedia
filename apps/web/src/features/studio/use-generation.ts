import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { inferInput, inferOutput } from '@trpc/tanstack-react-query';
import type { Trpc } from '../../lib/trpc';
import { useTRPC } from '../../lib/trpc';

export type GenerationJobDto = inferOutput<Trpc['creative']['generation']['get']>;
export type GenerationPreflightDto = inferOutput<Trpc['creative']['generation']['preflight']>;
export type GenerationPreflightInput = inferInput<Trpc['creative']['generation']['preflight']>;

/** How often a live job is read (it moves through queued → generating → validating → saving in seconds). */
export const GENERATION_POLL_MS = 1000;

/** STU-1b: the preflight of the request as it stands; null while the form is not ready to be checked. */
export function useGenerationPreflight(input: GenerationPreflightInput | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.generation.preflight.queryOptions(
      input ?? { documentId: '', baseRevisionId: '', request: { kind: 'generate', brief: {} } },
    ),
    enabled: input !== null,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** One generation job, read every second while it is live (the panel shows its progress). */
export function useGenerationJob(jobId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.generation.get.queryOptions({ jobId: jobId ?? '' }),
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data && !q.state.data.live ? false : GENERATION_POLL_MS),
  });
}

/** The document's live jobs and its last finished one: the panel reattaches to them after a reload. */
export function useActiveGenerations(documentId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.generation.active.queryOptions({ documentId }));
}
