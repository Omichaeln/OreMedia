import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { FactState } from '@oremedia/contracts/brand';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';
import { useCompanies } from '../portfolio/use-companies';

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

/** The brands the person may see in one company, asked with that tenant (the portfolio performance view). */
export function useBrandsOf(tenantId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  return useQuery({
    queryKey: [...trpc.brand.list.queryKey(), { tenantId }],
    queryFn: () => client.brand.list.query(undefined, { context: { tenantId } }),
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

/**
 * D-22: the proposals waiting on a person, newest first: drafts or versions in review newer than the applied brand
 * system (an imported brand skill, an agent's suggestion). With nothing applied yet, every open one is a proposal.
 */
export function pendingProposals(
  items: readonly BrandVersionSummary[],
  publishedVersionId: string | null,
): BrandVersionSummary[] {
  const applied = items.find((v) => v.id === publishedVersionId);
  return items
    .filter(
      (v) => (v.state === 'draft' || v.state === 'in_review') && (!applied || v.number > applied.number),
    )
    .sort((a, b) => b.number - a.number);
}

/** D-22: the proposed update the brand system screen offers to review: the newest pending proposal, if any. */
export const pendingProposal = (
  items: readonly BrandVersionSummary[],
  publishedVersionId: string | null,
): BrandVersionSummary | null => pendingProposals(items, publishedVersionId)[0] ?? null;

/** Roles holding brand.edit_standards and brand.publish_version (role-grants MANAGERS); the server re-checks. */
const BRAND_SYSTEM_ROLES = new Set(['owner', 'admin', 'brand_manager']);

/** D-22: whether the person's role in the company may edit and save the brand system (offers Edit, Save, Discard). */
export function useCanSaveBrandSystem(companyId: string): boolean {
  const companies = useCompanies();
  const role = companies.data?.find((c) => c.tenantId === companyId)?.role ?? null;
  return role !== null && BRAND_SYSTEM_ROLES.has(role);
}

/** UX-20 (D-13): what saving the brand system reaches now; read each time the preview opens. */
export function useBrandVersionImpact(brandId: string, enabled = true) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.brand.versions.impact.queryOptions({ brandId }), enabled, staleTime: 0 });
}
