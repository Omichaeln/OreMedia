import { useQueries, useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { AssetKind, AssetPurpose, DerivativePurpose } from '@oremedia/contracts/assets';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type AssetDto = inferOutput<Trpc['assets']['get']>;
export type AssetListItemDto = inferOutput<Trpc['assets']['list']>['items'][number];
export type AssetIssueDto = AssetListItemDto['issues'][number];
export type AssetRefDto = inferOutput<Trpc['assets']['search']>['items'][number];
export type BrandFontFaceDto = inferOutput<Trpc['assets']['fonts']['list']>['items'][number];

const SEARCH_PAGE = 50;

export interface AssetListFilter {
  state?: AssetListItemDto['state'];
  needsAttention?: boolean;
  query?: string;
}

/**
 * Spec 21.2 asset states: every asset of the brand with the issues that keep it out of the eligibility search
 * (processing, missing or expired rights, retired…), page by page. The librarian's view beside `useAssetSearch`.
 */
export function useAssetList(brandId: string, filter: AssetListFilter) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = {
    brandId,
    ...(filter.state ? { state: filter.state } : {}),
    ...(filter.needsAttention ? { needsAttention: true } : {}),
    ...(filter.query ? { query: filter.query } : {}),
  };
  return useCursorPages({
    queryKey: trpc.assets.list.queryKey({ ...input, page: { limit: SEARCH_PAGE } }),
    fetchPage: (cursor) => client.assets.list.query({ ...input, page: { limit: SEARCH_PAGE, cursor } }),
  });
}

/** The words the library uses for each issue (colour is never the only carrier). */
export const ASSET_ISSUE_TEXT: Record<AssetIssueDto, { label: string; detail: string }> = {
  pending_review: { label: 'Pending review', detail: 'Ingested and awaiting approval; not usable yet.' },
  rejected: { label: 'Rejected', detail: 'Rejected at review.' },
  retired: { label: 'Retired', detail: 'No longer usable in new work; existing usages are recorded.' },
  rights_unknown: {
    label: 'Missing rights',
    detail: 'No usage rights recorded; ineligible for creative and logo use until they are.',
  },
  rights_expired: { label: 'Expired rights', detail: 'The recorded rights have expired.' },
  rights_expiring: { label: 'Rights expiring', detail: 'The recorded rights expire within 30 days.' },
  no_version: { label: 'No version', detail: 'The file has not been ingested.' },
};

/** Spec 9.2: the search returns eligible assets only; ineligible ones never appear here. Page by page (spec 7.4). */
export function useAssetSearch(brandId: string, purpose: AssetPurpose, query?: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const search = { brandId, purpose, channelConnectionIds: [], query: query || undefined };
  return useCursorPages({
    queryKey: trpc.assets.search.queryKey({ query: search, page: { limit: SEARCH_PAGE } }),
    fetchPage: (cursor) =>
      client.assets.search.query({ query: search, page: { limit: SEARCH_PAGE, cursor } }),
  });
}

/**
 * This brand's approved assets of the given kinds, whatever their rights (the `reference` purpose): what the brand
 * kit editor offers as logos and reference imagery. Rights are recorded separately where a purpose needs them.
 */
export function useBrandAssetsOfKind(brandId: string, kinds: AssetKind[]) {
  const trpc = useTRPC();
  return useQuery(
    trpc.assets.search.queryOptions({
      query: { brandId, purpose: 'reference', channelConnectionIds: [], kinds },
      page: { limit: 100 },
    }),
  );
}

export function useAsset(assetId: string | null) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.assets.get.queryOptions({ assetId: assetId ?? '' }), enabled: assetId !== null });
}

/** An asset's versions, newest first (the brand system may pin one that is no longer current). */
export function useAssetVersions(assetId: string, enabled = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.assets.versions.list.queryOptions({ assetId, page: { limit: 50 } }),
    enabled,
  });
}

/** Spec 9.3: a 5-minute signed GET; refreshed before it expires. */
export function useSignedUrl(
  assetVersionId: string | null,
  derivative: DerivativePurpose | 'original' = 'preview',
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.assets.media.signedUrl.queryOptions({ assetVersionId: assetVersionId ?? '', derivative }),
    enabled: assetVersionId !== null,
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    retry: false,
  });
}

/**
 * Signed URLs for every asset version a document references, as one map (a single useQueries call). Images use the
 * web derivative; fonts have no derivatives, so their files are fetched as the original.
 */
export function useAssetUrls(
  assetVersionIds: string[],
  derivative: 'web' | 'original' = 'web',
): Map<string, string> {
  const trpc = useTRPC();
  const results = useQueries({
    queries: assetVersionIds.map((assetVersionId) => ({
      ...trpc.assets.media.signedUrl.queryOptions({ assetVersionId, derivative }),
      staleTime: 4 * 60_000,
      refetchInterval: 4 * 60_000,
      retry: false,
    })),
  });
  const map = new Map<string, string>();
  results.forEach((r, i) => {
    const id = assetVersionIds[i];
    if (id && r.data?.url) map.set(id, r.data.url);
  });
  return map;
}

/** Brand kit typography: the brand's font faces (an imported face's subset files are one face). */
export function useBrandFonts(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.assets.fonts.list.queryOptions({ brandId }));
}
