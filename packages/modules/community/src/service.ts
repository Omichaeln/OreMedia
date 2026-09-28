import type { z } from 'zod';
import {
  CommentReply,
  ConversationList,
  ConversationMessagesList,
  type ResponseDraftState,
} from '@oremedia/contracts/community';
import {
  CapabilityUnsupportedError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { EntitlementSet, ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { authorize } from '@oremedia/domain/policy';
import { responseDraftMachine } from '@oremedia/domain/state-machines/response-draft';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { contentService } from '@oremedia/module-content';
import { audit, outbox } from '@oremedia/module-operations';
import {
  ChannelConnectionRepository,
  PublicationRepository,
  adapterFor,
  channelService,
} from '@oremedia/module-publishing';
import { communityReplyWorkflowId } from './outbox-routes';
import { InboxConversationRepository, InboxMessageRepository, ResponseDraftRepository } from './repositories';

const conversationsRepo = new InboxConversationRepository();
const messagesRepo = new InboxMessageRepository();
const draftsRepo = new ResponseDraftRepository();
const connectionsRepo = new ChannelConnectionRepository();
const publicationsRepo = new PublicationRepository();

type ConversationRow = Awaited<ReturnType<InboxConversationRepository['getById']>>;
type MessageRow = Awaited<ReturnType<InboxMessageRepository['getById']>>;
type DraftRow = Awaited<ReturnType<ResponseDraftRepository['getById']>>;
type ConnectionRow = Awaited<ReturnType<ChannelConnectionRepository['getById']>>;

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
/** inbox.respond is not entitlement-gated (ENTITLEMENT_GATED_ACTIONS), so the decision never reads these. */
const NO_ENTITLEMENTS: EntitlementSet = { limits: {}, features: {}, usage: {} };

export const POST_EXCERPT_LENGTH = 140;
const excerpt = (text: string, length = POST_EXCERPT_LENGTH): string =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

/**
 * Spec 16.5: raw handles are shown only in the inbox to users with inbox.respond. Everyone else who may read the
 * brand sees the comments without who wrote them. This is a display choice inside a read already authorised (and
 * audited) as brand.read, so it asks the pure decision: no audit row and no denial metric per inbox read. Replying
 * itself goes through policy.assert.
 */
function mayRespond(actor: ResolvedActor, brandId: string): boolean {
  return authorize({
    actor,
    action: 'inbox.respond',
    resource: brandResource(brandId),
    context: { entitlements: NO_ENTITLEMENTS, now: new Date() },
  }).allowed;
}

/** What the inbox needs from a channel: its name and whether (and how long) it can reply. */
function channelOf(connection: ConnectionRow) {
  let capability = null;
  try {
    capability = adapterFor(connection.providerKey).capability; // an uncertified provider cannot reply
  } catch {
    capability = null;
  }
  return {
    id: connection.id,
    providerKey: connection.providerKey,
    displayName: connection.displayName,
    status: connection.status,
    replySupported: capability?.comments.reply ?? false,
    replyMaxLength: capability?.text.maxLength ?? null,
  };
}

async function postOf(conversation: ConversationRow, tx?: Tx) {
  if (!conversation.publicationId) return { publicationId: null, postExcerpt: null, postUrl: null };
  const publication = await publicationsRepo.findById(conversation.publicationId, tx);
  if (!publication) return { publicationId: null, postExcerpt: null, postUrl: null };
  const variant = await contentService.variants.read(publication.channelVariantId, tx).catch(() => null);
  return {
    publicationId: publication.id,
    postExcerpt: variant ? excerpt(variant.text) : null,
    postUrl: publication.remoteUrl,
  };
}

/** A thread entry: a stored comment (inbound or the brand's recorded reply) or a reply still on its way. */
export interface ThreadItemDto {
  kind: 'message' | 'reply';
  id: string;
  direction: 'inbound' | 'outbound';
  /** The entry this one answers, when it is in the thread. */
  parentId: string | null;
  depth: number;
  authorHandle: string | null;
  text: string;
  at: string;
  classification: string | null;
  /** Outbound only: `sent` for a recorded reply, else the draft's state (queued / sending / failed / unknown). */
  replyState: ResponseDraftState | null;
  failure: { code: string; detail: string | null } | null;
}

/**
 * Threads a conversation: each entry follows the one it answers, siblings oldest first. An entry whose parent is
 * not stored (the post itself, a deleted comment, a row ingested before parents were kept) starts a thread.
 */
function thread(messages: MessageRow[], replies: DraftRow[], showHandles: boolean): ThreadItemDto[] {
  const byRemote = new Map(messages.map((m) => [m.remoteMessageId, m.id]));
  const entries: Array<Omit<ThreadItemDto, 'depth'>> = [
    ...messages.map((m) => ({
      kind: 'message' as const,
      id: m.id,
      direction: m.direction,
      parentId: m.parentRemoteMessageId ? (byRemote.get(m.parentRemoteMessageId) ?? null) : null,
      authorHandle: showHandles ? m.authorHandle : null,
      text: m.text,
      at: m.remoteCreatedAt.toISOString(),
      classification: m.classification,
      replyState: m.direction === 'outbound' ? ('sent' as const) : null,
      failure: null,
    })),
    ...replies.map((d) => ({
      kind: 'reply' as const,
      id: d.id,
      direction: 'outbound' as const,
      parentId: d.replyToMessageId,
      authorHandle: null,
      text: d.text,
      at: d.createdAt.toISOString(),
      classification: null,
      replyState: d.state,
      failure: d.failureCode ? { code: d.failureCode, detail: d.failureDetail } : null,
    })),
  ];
  const ids = new Set(entries.map((e) => e.id));
  const children = new Map<string | null, Array<Omit<ThreadItemDto, 'depth'>>>();
  for (const e of entries) {
    const parent = e.parentId && ids.has(e.parentId) && e.parentId !== e.id ? e.parentId : null;
    const list = children.get(parent) ?? [];
    list.push({ ...e, parentId: parent });
    children.set(parent, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const out: ThreadItemDto[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const e of children.get(parent) ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ ...e, depth });
      walk(e.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export const communityService = {
  conversations: {
    /** A brand's comment conversations, newest activity first, with the latest comment and the comment count. */
    async list(actor: ResolvedActor, input: z.input<typeof ConversationList>, tx?: Tx) {
      const parsed = ConversationList.parse(input);
      await brandService.assertExist([parsed.brandId], tx); // a foreign or unknown brand is NOT_FOUND
      await policy.assert(actor, 'brand.read', brandResource(parsed.brandId), {}, tx);
      const showHandles = mayRespond(actor, parsed.brandId);
      const page = await conversationsRepo.listForBrand(parsed.brandId, parsed.page, tx);
      const counts = await messagesRepo.countInbound(
        parsed.brandId,
        page.items.map((c) => c.id),
        tx,
      );
      const channels = new Map<string, ReturnType<typeof channelOf>>();
      const items = [];
      for (const c of page.items) {
        let channel = channels.get(c.channelConnectionId);
        if (!channel) {
          channel = channelOf(await connectionsRepo.getById(c.channelConnectionId, tx));
          channels.set(c.channelConnectionId, channel);
        }
        const latest = await messagesRepo.latestInbound(parsed.brandId, c.id, tx);
        items.push({
          id: c.id,
          brandId: c.brandId,
          state: c.state,
          channel,
          ...(await postOf(c, tx)),
          lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
          commentCount: counts.get(c.id) ?? 0,
          latest: latest
            ? {
                messageId: latest.id,
                text: excerpt(latest.text),
                authorHandle: showHandles ? latest.authorHandle : null,
                at: latest.remoteCreatedAt.toISOString(),
              }
            : null,
        });
      }
      return { items, nextCursor: page.nextCursor, canRespond: showHandles };
    },
  },

  messages: {
    /** One conversation threaded by parent, with the replies on their way and whether the caller may answer. */
    async list(actor: ResolvedActor, input: z.infer<typeof ConversationMessagesList>, tx?: Tx) {
      const parsed = ConversationMessagesList.parse(input);
      const conversation = await conversationsRepo.getById(parsed.conversationId, tx); // foreign → NOT_FOUND
      await policy.assert(actor, 'brand.read', brandResource(conversation.brandId), {}, tx);
      const showHandles = mayRespond(actor, conversation.brandId);
      const channel = channelOf(await connectionsRepo.getById(conversation.channelConnectionId, tx));
      const messages = await messagesRepo.listForConversation(conversation.brandId, conversation.id, tx);
      const replies = await draftsRepo.listOpenReplies(conversation.brandId, conversation.id, tx);
      return {
        conversation: {
          id: conversation.id,
          brandId: conversation.brandId,
          state: conversation.state,
          channel,
          ...(await postOf(conversation, tx)),
          lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.toISOString() : null,
        },
        canRespond: showHandles,
        canReply: showHandles && channel.replySupported,
        items: thread(messages, replies, showHandles),
      };
    },
  },

  /**
   * A person answers an inbound comment (inbox.respond; agents may only propose). The text is checked against the
   * channel's limit, a response draft is queued and `community.reply_requested` is written in the same transaction;
   * communityReplyWorkflowV1 posts it (the draft id is the idempotency key end to end).
   */
  async reply(actor: ResolvedActor, input: z.infer<typeof CommentReply>, tx: Tx) {
    const parsed = CommentReply.parse(input);
    const text = parsed.text.trim();
    if (!text) throw new ValidationFailedError([{ path: 'text', issue: 'empty' }]);
    const message = await messagesRepo.getById(parsed.messageId, tx); // foreign → NOT_FOUND
    const conversation = await conversationsRepo.getById(message.conversationId, tx);
    const decision = await policy.assert(actor, 'inbox.respond', brandResource(conversation.brandId), {}, tx);
    if (actor.kind !== 'user' || decision.obligations?.some((o) => o.type === 'propose_only'))
      throw new PolicyDeniedError('propose_only', 'Only a person can send a reply');
    if (message.direction !== 'inbound')
      throw new ValidationFailedError([{ path: 'messageId', issue: 'not_an_inbound_comment' }]);
    const connection = await connectionsRepo.getById(conversation.channelConnectionId, tx);
    const adapter = adapterFor(connection.providerKey);
    if (!adapter.capability.comments.reply || !adapter.comment)
      throw new CapabilityUnsupportedError([{ path: 'messageId', issue: 'channel_cannot_reply' }]);
    if (!(await channelService.channelUsable(connection.id, tx)))
      throw new ValidationFailedError(
        [{ path: 'messageId', issue: `channel_${connection.status}` }],
        'Reconnect the channel before replying',
      );
    const measured = adapter.measureText(text);
    if (measured.length > measured.limit)
      throw new ValidationFailedError(
        [{ path: 'text', issue: `too_long:${measured.length}>${measured.limit}` }],
        `The reply is ${measured.length} characters; ${connection.displayName} allows ${measured.limit}`,
      );

    const id = newId('responseDraft');
    const state = responseDraftMachine.transition('draft', 'send');
    await draftsRepo.create(
      {
        id,
        brandId: conversation.brandId,
        conversationId: conversation.id,
        authorKind: 'user',
        authorId: actor.id,
        text,
        factRefs: [],
        state,
        sentByUserId: actor.id,
        replyToMessageId: message.id,
      },
      tx,
    );
    await outbox.add(
      'community.reply_requested',
      { type: 'response_draft', id, version: 0 },
      {
        responseDraftId: id,
        workflowId: communityReplyWorkflowId(id),
        actorKind: actor.kind,
        actorId: actor.id,
      },
      tx,
      { brandId: conversation.brandId },
    );
    await audit.record(actorRef(actor), 'community.reply', { type: 'response_draft', id }, 'allowed', tx, {
      brandId: conversation.brandId,
      channelConnectionId: connection.id,
      toState: state,
    });
    return {
      responseDraftId: id,
      conversationId: conversation.id,
      replyToMessageId: message.id,
      state,
    };
  },
};
