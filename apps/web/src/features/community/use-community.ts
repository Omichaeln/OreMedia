import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useCursorPages } from '../../lib/cursor-pages';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';
import { IN_FLIGHT } from './community-helpers';

export type ConversationListDto = inferOutput<Trpc['community']['conversations']['list']>;
export type ConversationItemDto = ConversationListDto['items'][number];
export type ConversationViewDto = inferOutput<Trpc['community']['messages']['list']>;
export type ThreadItemDto = ConversationViewDto['items'][number];

const CONVERSATIONS_PAGE = 50;

/** New comments are collected in the background; the list re-reads itself this often so they appear without a reload. */
const CONVERSATIONS_REFRESH_MS = 30_000;

/**
 * The brand's comment conversations, newest activity first, page by page (spec 7.4). One hook per query (spec 21.1).
 * Refetched every 30 s (CONVERSATIONS_REFRESH_MS) so a comment collected after the page opened shows without a reload.
 */
export function useConversations(brandId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId, page: { limit: CONVERSATIONS_PAGE } };
  return useCursorPages({
    queryKey: trpc.community.conversations.list.queryKey(input),
    fetchPage: (cursor) =>
      client.community.conversations.list.query({ brandId, page: { limit: CONVERSATIONS_PAGE, cursor } }),
    refetchInterval: CONVERSATIONS_REFRESH_MS,
  });
}

/** While a reply is on its way the conversation is re-read this often, so its state moves without a click. */
export const IN_FLIGHT_REFRESH_MS = 5_000;

/** One conversation threaded by parent; nothing is asked until a conversation is chosen. */
export function useConversation(conversationId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.community.messages.list.queryOptions({ conversationId: conversationId ?? '' }),
    enabled: conversationId !== null,
    refetchInterval: (query) =>
      query.state.data?.items.some((i) => i.replyState !== null && IN_FLIGHT.has(i.replyState))
        ? IN_FLIGHT_REFRESH_MS
        : false,
  });
}
