import { randomUUID } from 'node:crypto';
import {
  CommentReply,
  ConversationList,
  ConversationMessagesList,
  type ResponseDraftState,
} from '@oremedia/contracts/community';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { MockBuilders, t } from './mock-api';

/**
 * Comment inbox slice of the UI-only transport (see mock-api.ts): community.conversations.list,
 * community.messages.list and community.reply with the same paths, DTO shapes and error envelope as apps/api
 * (packages/modules/community). Seeded relative to "now"; `settle` stands in for communityReplyWorkflowV1.
 * A test double, never a second implementation.
 */
export const PC = {
  conversations: { launch: 'conv_launch', recipe: 'conv_recipe' },
  messages: {
    question: 'msg_question',
    followUp: 'msg_follow_up',
    praise: 'msg_praise',
    recipe: 'msg_recipe',
  },
  failedReply: 'rdft_failed',
  maxLength: 280,
} as const;

/** Spec 5.5 default grants of inbox.respond. */
const RESPONDERS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin', 'brand_manager', 'community']);

interface Message {
  id: string;
  conversationId: string;
  remoteMessageId: string;
  parentRemoteMessageId: string | null;
  direction: 'inbound' | 'outbound';
  authorHandle: string;
  text: string;
  at: string;
}
interface Reply {
  id: string;
  conversationId: string;
  replyToMessageId: string;
  text: string;
  state: ResponseDraftState;
  failure: { code: string; detail: string | null } | null;
  createdAt: string;
}
interface Conversation {
  id: string;
  postExcerpt: string;
  channel: { id: string; providerKey: string; displayName: string };
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export class CommunityBackend {
  readonly conversations: Conversation[] = [];
  readonly messages: Message[] = [];
  readonly replies: Reply[] = [];

  constructor(
    readonly brandId: string,
    readonly role: () => MembershipRole,
    seed = true,
  ) {
    if (!seed) return;
    const channel = { id: 'cc_e2e_linkedin', providerKey: 'linkedin_page', displayName: 'Acme on LinkedIn' };
    this.conversations.push(
      {
        id: PC.conversations.launch,
        postExcerpt: 'Spring collection is live: raw linen, natural dyes.',
        channel,
      },
      { id: PC.conversations.recipe, postExcerpt: 'How we dye with walnut hulls.', channel },
    );
    const m = (
      id: string,
      conversationId: string,
      remote: string,
      parent: string | null,
      handle: string,
      text: string,
      minutes: number,
    ) =>
      this.messages.push({
        id,
        conversationId,
        remoteMessageId: remote,
        parentRemoteMessageId: parent,
        direction: 'inbound',
        authorHandle: handle,
        text,
        at: ago(minutes),
      });
    m(PC.messages.question, PC.conversations.launch, 'c_1', null, '@bea', 'Do you ship to Norway?', 60);
    m(PC.messages.followUp, PC.conversations.launch, 'c_2', 'c_1', '@kofi', 'Same question for Ghana!', 50);
    m(PC.messages.praise, PC.conversations.launch, 'c_3', null, '@lina', 'The colours are beautiful.', 30);
    m(PC.messages.recipe, PC.conversations.recipe, 'c_9', null, '@dan', 'Can I try this at home?', 400);
    this.replies.push({
      id: PC.failedReply,
      conversationId: PC.conversations.launch,
      replyToMessageId: PC.messages.praise,
      text: 'Thank you Lina!',
      state: 'failed',
      failure: { code: 'comment_blocked', detail: 'The platform refused the comment.' },
      createdAt: ago(20),
    });
  }

  canRespond(): boolean {
    return RESPONDERS.has(this.role());
  }

  /** Backdoor for the reply workflow: settles a queued reply as the platform answered. */
  settle(replyId: string, state: 'sent' | 'failed' | 'outcome_unknown', failure?: string): void {
    const r = this.replies.find((x) => x.id === replyId);
    if (!r) throw new Error(`no reply ${replyId}`);
    if (state === 'sent') {
      const parent = this.messages.find((x) => x.id === r.replyToMessageId);
      this.messages.push({
        id: `msg_${randomUUID().slice(0, 8)}`,
        conversationId: r.conversationId,
        remoteMessageId: `c_out_${r.id}`,
        parentRemoteMessageId: parent?.remoteMessageId ?? null,
        direction: 'outbound',
        authorHandle: 'Acme on LinkedIn',
        text: r.text,
        at: new Date().toISOString(),
      });
    }
    r.state = state;
    r.failure = failure ? { code: failure, detail: null } : null;
  }

  lastActivity(conversationId: string): string {
    const times = this.messages
      .filter((x) => x.conversationId === conversationId)
      .map((x) => x.at)
      .sort();
    return times[times.length - 1] ?? new Date(0).toISOString();
  }

  /** The server's threading (packages/modules/community service.ts), on the mock rows. */
  thread(conversationId: string) {
    const show = this.canRespond();
    const msgs = this.messages.filter((x) => x.conversationId === conversationId);
    const byRemote = new Map(msgs.map((x) => [x.remoteMessageId, x.id]));
    const entries = [
      ...msgs.map((x) => ({
        kind: 'message' as const,
        id: x.id,
        direction: x.direction,
        parentId: x.parentRemoteMessageId ? (byRemote.get(x.parentRemoteMessageId) ?? null) : null,
        authorHandle: show ? x.authorHandle : null,
        text: x.text,
        at: x.at,
        classification: null,
        replyState: x.direction === 'outbound' ? ('sent' as ResponseDraftState) : null,
        failure: null as Reply['failure'],
      })),
      ...this.replies
        .filter((r) => r.conversationId === conversationId && r.state !== 'sent')
        .map((r) => ({
          kind: 'reply' as const,
          id: r.id,
          direction: 'outbound' as const,
          parentId: r.replyToMessageId as string | null,
          authorHandle: null,
          text: r.text,
          at: r.createdAt,
          classification: null,
          replyState: r.state as ResponseDraftState | null,
          failure: r.failure,
        })),
    ];
    const out: Array<(typeof entries)[number] & { depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const e of entries
        .filter((x) => x.parentId === parent)
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
        out.push({ ...e, depth });
        walk(e.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }
}

export interface CommunityBuilders {
  router: typeof t.router;
  query: MockBuilders['query'];
  mutation: MockBuilders['mutation'];
}

export function communityRouters(b: CommunityBackend, { router, query, mutation }: CommunityBuilders) {
  const brandOf = (brandId: string) => {
    if (brandId !== b.brandId) throw new NotFoundError('Brand', brandId);
  };
  const channelOf = (c: Conversation) => ({
    ...c.channel,
    status: 'active' as const,
    replySupported: true,
    replyMaxLength: PC.maxLength as number | null,
  });
  const conversationOf = (id: string) => {
    const c = b.conversations.find((x) => x.id === id);
    if (!c) throw new NotFoundError('InboxConversation', id);
    return c;
  };
  return router({
    conversations: router({
      list: query.input(ConversationList).query(({ input }) => {
        brandOf(input.brandId);
        const show = b.canRespond();
        const items = b.conversations
          .map((c) => {
            const inbound = b.messages
              .filter((x) => x.conversationId === c.id && x.direction === 'inbound')
              .sort((x, y) => y.at.localeCompare(x.at));
            const latest = inbound[0];
            return {
              id: c.id,
              brandId: b.brandId,
              state: 'open' as const,
              channel: channelOf(c),
              publicationId: `pub_${c.id}`,
              postExcerpt: c.postExcerpt as string | null,
              postUrl: 'https://www.linkedin.com/feed/update/urn:li:share:1' as string | null,
              lastMessageAt: b.lastActivity(c.id) as string | null,
              commentCount: inbound.length,
              latest: latest
                ? {
                    messageId: latest.id,
                    text: latest.text,
                    authorHandle: show ? latest.authorHandle : null,
                    at: latest.at,
                  }
                : null,
            };
          })
          .sort((x, y) => (y.lastMessageAt ?? '').localeCompare(x.lastMessageAt ?? ''));
        return { items, nextCursor: null as string | null, canRespond: show };
      }),
    }),
    messages: router({
      list: query.input(ConversationMessagesList).query(({ input }) => {
        const c = conversationOf(input.conversationId);
        const show = b.canRespond();
        return {
          conversation: {
            id: c.id,
            brandId: b.brandId,
            state: 'open' as const,
            channel: channelOf(c),
            publicationId: `pub_${c.id}` as string | null,
            postExcerpt: c.postExcerpt as string | null,
            postUrl: 'https://www.linkedin.com/feed/update/urn:li:share:1' as string | null,
            lastMessageAt: b.lastActivity(c.id) as string | null,
          },
          canRespond: show,
          canReply: show,
          items: b.thread(c.id),
        };
      }),
    }),
    reply: mutation.input(CommentReply).mutation(({ input }) => {
      const message = b.messages.find((x) => x.id === input.messageId);
      if (!message) throw new NotFoundError('InboxMessage', input.messageId);
      if (!b.canRespond()) throw new PolicyDeniedError('role_missing');
      const text = input.text.trim();
      if ([...text].length > PC.maxLength)
        throw new ValidationFailedError(
          [{ path: 'text', issue: `too_long:${[...text].length}>${PC.maxLength}` }],
          `The reply is ${[...text].length} characters; Acme on LinkedIn allows ${PC.maxLength}`,
        );
      const id = `rdft_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      b.replies.push({
        id,
        conversationId: message.conversationId,
        replyToMessageId: message.id,
        text,
        state: 'queued',
        failure: null,
        createdAt: new Date().toISOString(),
      });
      return {
        responseDraftId: id,
        conversationId: message.conversationId,
        replyToMessageId: message.id,
        state: 'queued' as ResponseDraftState,
      };
    }),
  });
}
