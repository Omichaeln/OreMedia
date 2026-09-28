import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';
import { IN_FLIGHT } from './community-helpers';

export type ConversationListDto = inferOutput<Trpc['community']['conversations']['list']>;
export type ConversationItemDto = ConversationListDto['items'][number];
export type ConversationViewDto = inferOutput<Trpc['community']['messages']['list']>;
export type ThreadItemDto = ConversationViewDto['items'][number];

/** The brand's comment conversations, newest activity first. One hook per query (spec 21.1). */
export function useConversations(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.community.conversations.list.queryOptions({ brandId, page: { limit: 50 } }));
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
