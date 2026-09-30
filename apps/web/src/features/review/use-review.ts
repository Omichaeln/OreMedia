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

export const isMemberView = (r: ReviewRequestDto): r is MemberReviewRequestDto => 'decisions' in r;
