import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type InboxItemDto = inferOutput<Trpc['review']['inbox']['list']>['items'][number];
/** Members get the full request; an external reviewer gets only the frozen manifest view (spec 5.6). */
export type ReviewRequestDto = inferOutput<Trpc['review']['requests']['get']>;
export type MemberReviewRequestDto = Extract<ReviewRequestDto, { decisions: unknown }>;
export type ExternalLinkCreatedDto = inferOutput<Trpc['review']['externalLinks']['create']>;

const INBOX_PAGE = 50;

/**
 * Spec 21.2 review inbox page by page (spec 7.4): open, stale and decided requests with the attention each needs.
 * The shell's nav count and the home screen's "needs you" read the same query, so every count comes from one list.
 */
export function useReviewInboxPages(brandId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId, page: { limit: INBOX_PAGE } };
  return useCursorPages({
    queryKey: trpc.review.inbox.list.queryKey(input),
    fetchPage: (cursor) => client.review.inbox.list.query({ brandId, page: { limit: INBOX_PAGE, cursor } }),
  });
}

export function useReviewRequest(reviewRequestId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.review.requests.get.queryOptions({ reviewRequestId: reviewRequestId ?? '' }),
    enabled: reviewRequestId !== null,
  });
}

export type ManifestMediaItemDto = inferOutput<Trpc['review']['requests']['media']>['items'][number];

/**
 * The manifest's rendered files as signed URLs (spec 13.3), re-signed before the 5-minute URLs lapse so an open
 * review never shows a broken image. Read by the inbox detail and the external portal alike (request-bound there).
 */
export function useManifestMedia(reviewRequestId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.review.requests.media.queryOptions({ reviewRequestId: reviewRequestId ?? '' }),
    enabled: reviewRequestId !== null,
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    retry: false,
  });
}

export const isMemberView = (r: ReviewRequestDto): r is MemberReviewRequestDto => 'decisions' in r;
