import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { SeoAuditPageSeverity } from '@oremedia/contracts/seo-audit';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type SeoAuditSummaryDto = inferOutput<Trpc['destinations']['audit']['summary']>;
export type SeoAuditRunDto = inferOutput<Trpc['destinations']['audit']['runs']['list']>['items'][number];
export type SeoAuditPageDto = inferOutput<Trpc['destinations']['audit']['pages']['list']>['items'][number];
export type SeoAuditFindingDto = inferOutput<Trpc['destinations']['audit']['findings']>['items'][number];

/** A run in progress is polled until it closes; a closed summary is read once. */
const RUNNING_POLL_MS = 10_000;

/**
 * R2-4: one website destination's last audit (tiles, lab-data note, whether a run is in progress and whether the
 * person may start one), its findings grouped by check and its pages by severity. One hook per query (spec 21.1).
 */
export function useSeoAuditSummary(brandId: string, destinationId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.destinations.audit.summary.queryOptions({ brandId, destinationId }),
    refetchInterval: (query) => (query.state.data?.running ? RUNNING_POLL_MS : false),
  });
}

export function useSeoAuditFindings(brandId: string, destinationId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.destinations.audit.findings.queryOptions({ brandId, destinationId }),
    enabled,
  });
}

export function useSeoAuditPages(
  brandId: string,
  destinationId: string,
  severity: SeoAuditPageSeverity | undefined,
  enabled: boolean,
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.destinations.audit.pages.list.queryOptions({ brandId, destinationId, severity, limit: 50 }),
    enabled,
  });
}

/** `destinations.audit.run`: opens an on-demand run (seo_audit.run); the audit reads refetch once it is accepted. */
export function useRunSeoAudit() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.destinations.audit.run.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.destinations.audit.pathFilter());
      },
    }),
  );
}
