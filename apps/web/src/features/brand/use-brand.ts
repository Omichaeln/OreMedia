import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { BrandVersionState, FactState } from '@oremedia/contracts/brand';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type BrandDto = inferOutput<Trpc['brand']['get']>;
export type BrandVersionSummary = inferOutput<Trpc['brand']['versions']['list']>['items'][number];
export type BrandVersionDto = inferOutput<Trpc['brand']['versions']['get']>;
export type FactDto = inferOutput<Trpc['brand']['facts']['list']>['items'][number];
export type ObjectiveDto = inferOutput<Trpc['brand']['objectives']['list']>['items'][number];

/** One hook per query (spec 21.1); the tenant header comes from the URL, so no tenant argument here. */
export function useBrands() {
  const trpc = useTRPC();
  return useQuery(trpc.brand.list.queryOptions());
}

/**
 * Per visible brand of one company: overdue approvals, publications needing a person and those due this week.
 * The tenant is named on the request, so the portfolio can ask each company without being inside it. tRPC's own
 * key holds the path and input only, and the portfolio shows several companies at once, so the tenant joins the
 * key here. Review and publishing actions do not invalidate brand.*, so the counts are refetched on every visit.
 */
export function useBrandSummary(tenantId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  return useQuery({
    queryKey: [...trpc.brand.summary.queryKey(), { tenantId }],
    queryFn: () => client.brand.summary.query(undefined, { context: { tenantId } }),
    staleTime: 0,
  });
}

export function useBrand(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.brand.get.queryOptions({ brandId }));
}

export function useBrandVersions(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.brand.versions.list.queryOptions({ brandId, page: { limit: 50 } }));
}

export function useBrandVersion(brandId: string, versionId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.versions.get.queryOptions({ brandId, versionId: versionId ?? '' }),
    enabled: versionId !== null,
  });
}

export function useFacts(brandId: string, state?: FactState) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.facts.list.queryOptions({ brandId, state, page: { limit: 100 } }),
    placeholderData: keepPreviousData,
  });
}

export function useObjectives(brandId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.brand.objectives.list.queryOptions({ brandId, activeOnly: false, page: { limit: 50 } }),
  );
}

export const versionStateLabel: Record<BrandVersionState, string> = {
  draft: 'Proposed',
  in_review: 'In review',
  published: 'Published',
  retired: 'Retired',
};
