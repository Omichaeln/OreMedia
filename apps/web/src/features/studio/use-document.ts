import { useQuery } from '@tanstack/react-query';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient } from '../../lib/trpc';

/** One hook per query (spec 21.1). */
export function useDocument(documentId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.documents.get.queryOptions({ documentId }));
}

/** Documents a page at a time (spec 7.4); the home and the package forms show more on request. */
const DOCUMENTS_PAGE = 50;

/**
 * The brand's documents, newest first, page by page; optionally only those created for one content package. Archived
 * documents are left out unless `archived` asks for them (then only they are listed).
 */
export function useDocuments(
  brandId: string,
  opts: { contentPackageId?: string; enabled?: boolean; archived?: boolean } = {},
) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = {
    brandId,
    ...(opts.contentPackageId ? { contentPackageId: opts.contentPackageId } : {}),
    ...(opts.archived ? { archived: true } : {}),
  };
  return useCursorPages({
    queryKey: trpc.creative.documents.list.queryKey(input),
    fetchPage: (cursor) =>
      client.creative.documents.list.query({
        ...input,
        page: { limit: DOCUMENTS_PAGE, ...(cursor ? { cursor } : {}) },
      }),
    enabled: opts.enabled,
  });
}

const REVISIONS_PAGE = 50;

/** The studio's history, newest first, page by page (spec 7.4). */
export function useRevisions(documentId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { documentId, page: { limit: REVISIONS_PAGE } };
  return useCursorPages({
    queryKey: trpc.creative.revisions.list.queryKey(input),
    fetchPage: (cursor) =>
      client.creative.revisions.list.query({ documentId, page: { limit: REVISIONS_PAGE, cursor } }),
  });
}

const COMMENTS_PAGE = 50;

/** A document's comments page by page (spec 7.4); the studio header counts the open ones from the same query. */
export function useCommentPages(documentId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { documentId, page: { limit: COMMENTS_PAGE } };
  return useCursorPages({
    queryKey: trpc.creative.comments.list.queryKey(input),
    fetchPage: (cursor) =>
      client.creative.comments.list.query({ documentId, page: { limit: COMMENTS_PAGE, cursor } }),
  });
}

export function useTemplates(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.templates.list.queryOptions({ brandId, page: { limit: 50 } }));
}

/** STU-1a: active templates with their current version document in one read (the creation gallery). */
export function useTemplatesWithCurrent(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.creative.templates.listCurrent.queryOptions({ brandId, page: { limit: 50 } }));
}

/** STU-2b: the built-in starter video templates, bound to the brand (the creation screen's video start). */
export function useVideoTemplates(brandId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.creative.videoTemplates.list.queryOptions({ brandId }), enabled });
}

export function useTemplate(templateId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.templates.get.queryOptions({ templateId: templateId ?? '' }),
    enabled: templateId !== null,
  });
}

/** Polls a render job until it is ready or failed (the worker moves it; the client only watches). */
export function useRenderJob(renderJobId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.renders.get.queryOptions({ renderJobId: renderJobId ?? '' }),
    enabled: renderJobId !== null,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === 'ready' || state === 'failed' || state === 'cancelled' ? false : 2000;
    },
  });
}
