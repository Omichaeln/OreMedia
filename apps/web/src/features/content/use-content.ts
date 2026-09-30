import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type CampaignDto = inferOutput<Trpc['content']['campaigns']['get']>;
export type BriefDto = inferOutput<Trpc['content']['briefs']['get']>;
export type PackageDto = inferOutput<Trpc['content']['packages']['get']>;
export type PackageSummaryDto = inferOutput<Trpc['content']['packages']['list']>['items'][number];
export type PackageDocumentDto = PackageDto['creativeDocuments'][number];
export type PackageRevisionSummaryDto = PackageDto['revisions'][number];
export type PackageVariantDto = PackageDto['variants'][number];

/** Rows per page of the planner's columns (spec 7.4: more on request, never cut at the first page). */
const LIST_PAGE = 50;

/** One hook per query (spec 21.1). */
export function useCampaigns(brandId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId };
  return useCursorPages({
    queryKey: trpc.content.campaigns.list.queryKey(input),
    fetchPage: (cursor) =>
      client.content.campaigns.list.query({
        ...input,
        page: { limit: LIST_PAGE, ...(cursor ? { cursor } : {}) },
      }),
  });
}

export function useBriefs(brandId: string, campaignId: string | null) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId, ...(campaignId ? { campaignId } : {}) };
  return useCursorPages({
    queryKey: trpc.content.briefs.list.queryKey(input),
    fetchPage: (cursor) =>
      client.content.briefs.list.query({
        ...input,
        page: { limit: LIST_PAGE, ...(cursor ? { cursor } : {}) },
      }),
  });
}

export function useBrief(briefId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.content.briefs.get.queryOptions({ briefId: briefId ?? '' }),
    enabled: briefId !== null,
  });
}

export function usePackage(contentPackageId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.content.packages.get.queryOptions({ contentPackageId: contentPackageId ?? '' }),
    enabled: contentPackageId !== null,
  });
}

/** The brand's content packages, newest first, page by page; a brief's are the ones pointing at it. */
export function usePackages(brandId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId };
  return useCursorPages({
    queryKey: trpc.content.packages.list.queryKey(input),
    fetchPage: (cursor) =>
      client.content.packages.list.query({
        ...input,
        page: { limit: LIST_PAGE, ...(cursor ? { cursor } : {}) },
      }),
  });
}

export type PackagesQuery = ReturnType<typeof usePackages>;

export type PackageForDocumentDto = inferOutput<
  Trpc['content']['packages']['listForDocument']
>['items'][number];

/** The live packages whose current revision pins a studio document (UX-01); the server bounds the set, no cursor. */
export function usePackagesForDocument(documentId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.content.packages.listForDocument.queryOptions({ documentId, page: { limit: 50 } }));
}
