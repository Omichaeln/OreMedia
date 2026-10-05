import type { ActivityHooks } from '@oremedia/contracts/agents';
import type {
  CommunityReplyRuntimeV1,
  CommunityReplyWorkflowInputV1,
  RecordReplyOutcomeInputV1,
  RecordReplyOutcomeResultV1,
  ReplySendResultV1,
} from '@oremedia/contracts/community';
import { OremediaError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { PublishOutcome } from '@oremedia/contracts/providers';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { hashText } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import {
  responseDraftMachine,
  type ResponseDraftEvent,
} from '@oremedia/domain/state-machines/response-draft';
import { policy, resolveTenantContext } from '@oremedia/module-access';
import { audit } from '@oremedia/module-operations';
import {
  ChannelConnectionRepository,
  adapterFor,
  certificationRefusal,
  channelService,
  credentialBroker,
  providerIO,
} from '@oremedia/module-publishing';
import {
  ProviderRateLimitWaitExceeded,
  ProviderTransportError,
  outcomeFromClass,
  truncateForTemporal,
  type ProviderIO,
} from '@oremedia/providers';
import { InboxConversationRepository, InboxMessageRepository, ResponseDraftRepository } from './repositories';

const draftsRepo = new ResponseDraftRepository();
const conversationsRepo = new InboxConversationRepository();
const messagesRepo = new InboxMessageRepository();
const connectionsRepo = new ChannelConnectionRepository();

type DraftRow = Awaited<ReturnType<ResponseDraftRepository['getById']>>;

export interface CommunityReplyRuntimeOptions {
  now?: () => Date;
}

/** Outbound rows are the brand's own account, not a person: the author hash names the channel, unsalted. */
export const outboundAuthorHash = (channelConnectionId: string): string =>
  hashText(`outbound:${channelConnectionId}`);

const unknown = (code: string, err: unknown): ReplySendResultV1 => ({
  outcome: 'unknown',
  code,
  message: truncateForTemporal(err),
});

function fromOutcome(outcome: PublishOutcome): ReplySendResultV1 {
  switch (outcome.outcome) {
    case 'accepted':
      return { outcome: 'accepted', remoteMessageId: outcome.remotePostId, remoteUrl: outcome.remoteUrl };
    case 'pending': // a comment is never processed asynchronously; a pending answer is not a posted reply
      return { outcome: 'unknown', code: 'pending_not_supported', message: 'the platform answered pending' };
    case 'rejected':
      return { outcome: 'rejected', code: outcome.code, message: truncateForTemporal(outcome.message) };
    case 'retryable_error':
      return {
        outcome: 'retryable_error',
        code: outcome.code,
        message: truncateForTemporal(outcome.message),
        ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
      };
    case 'unknown':
      return { outcome: 'unknown', code: outcome.code, message: truncateForTemporal(outcome.message) };
  }
}

async function move(
  draft: DraftRow,
  event: ResponseDraftEvent,
  values: Parameters<ResponseDraftRepository['update']>[2],
  tx: Tx,
) {
  const state = responseDraftMachine.transition(draft.state, event);
  await draftsRepo.update(draft.id, draft.version, { ...values, state }, tx);
  await audit.record(
    requireTenant().actor,
    `community.reply_${state}`,
    { type: 'response_draft', id: draft.id },
    'allowed',
    tx,
    { brandId: draft.brandId, fromState: draft.state, toState: state },
  );
  return state;
}

/**
 * Spec 13.4 at the point of effect (as owner_still_authorised): the person who sent the reply still holds
 * inbox.respond on the brand now, re-resolved from their current membership, never the decision at send time;
 * and the channel is still usable. The failure reason, or null.
 */
async function sendRefusal(draft: DraftRow, channelConnectionId: string, tx: Tx): Promise<string | null> {
  if (!(await channelService.channelUsable(channelConnectionId, tx))) return 'channel_not_usable';
  if (draft.authorKind !== 'user' || !draft.sentByUserId) return 'sender_not_authorised';
  const ctx = requireTenant();
  try {
    const { actor } = await resolveTenantContext(
      {
        kind: 'user',
        userId: draft.sentByUserId,
        sessionId: `reply:${draft.id}`,
        selectedTenantId: ctx.tenantId,
      },
      ctx.tenantId,
      ctx.correlationId,
      tx,
    );
    return (await policy.stillHas(actor, 'inbox.respond', draft.brandId, tx))
      ? null
      : 'sender_not_authorised';
  } catch (err) {
    if (err instanceof OremediaError) return 'sender_not_authorised'; // membership gone or disabled
    throw err;
  }
}

/** The recorded result of a draft that already finished (a repeated activity reports it, never re-sends). */
async function settledResult(draft: DraftRow): Promise<ReplySendResultV1 | null> {
  switch (draft.state) {
    case 'sent': {
      const message = draft.outboundMessageId ? await messagesRepo.findById(draft.outboundMessageId) : null;
      return { outcome: 'accepted', remoteMessageId: message?.remoteMessageId ?? '', remoteUrl: null };
    }
    case 'failed':
      return { outcome: 'rejected', code: draft.failureCode ?? 'failed', message: draft.failureDetail ?? '' };
    case 'outcome_unknown':
      return { outcome: 'unknown', code: draft.failureCode ?? 'outcome_unknown', message: '' };
    case 'sending':
      // `sending` commits immediately before the platform call: the reply may exist, so it is never sent again.
      return { outcome: 'unknown', code: 'resumed_after_send', message: 'reply already sent; never re-sent' };
    case 'queued':
      return null;
    default:
      return { outcome: 'rejected', code: `not_queued:${draft.state}`, message: 'the draft was not sent' };
  }
}

/**
 * The runtime behind communityReplyWorkflowV1. `sendReplyOnce` runs on the provider's queue with maximumAttempts 1:
 * the draft moves queued → sending (with sentAt) under its row lock immediately before the one platform call, so a
 * repeat, a retry or a lost worker never posts the reply twice (a send that may have happened ends
 * outcome_unknown). The draft id is the adapter's idempotency key. `recordReplyOutcome` runs on `core`: it writes
 * the outbound message and settles the draft, idempotently.
 */
export function createCommunityReplyRuntime(
  opts: CommunityReplyRuntimeOptions = {},
): CommunityReplyRuntimeV1 {
  const now = opts.now ?? (() => new Date());

  async function load(responseDraftId: string, tx?: Tx) {
    const draft = await draftsRepo.getById(responseDraftId, tx);
    const conversation = await conversationsRepo.getById(draft.conversationId, tx);
    const connection = await connectionsRepo.getById(conversation.channelConnectionId, tx);
    return { draft, conversation, connection };
  }

  return {
    async readReplyRoute({ responseDraftId }: CommunityReplyWorkflowInputV1) {
      const { connection } = await load(responseDraftId);
      try {
        const adapter = adapterFor(connection.providerKey);
        return { providerKey: adapter.capability.comments.reply && adapter.comment ? adapter.key : null };
      } catch {
        return { providerKey: null }; // no longer certified here: the reply cannot be sent
      }
    },

    async sendReplyOnce(input: CommunityReplyWorkflowInputV1, hooks?: ActivityHooks) {
      const { tenantId, responseDraftId } = input;
      const { draft, conversation, connection } = await load(responseDraftId);
      const settled = await settledResult(draft);
      if (settled) return settled;
      if (!draft.replyToMessageId)
        return { outcome: 'rejected', code: 'no_parent_comment', message: 'the draft answers no comment' };
      const parent = await messagesRepo.getById(draft.replyToMessageId);
      // #89: replying must still be certified when the reply is sent, not only when it was queued.
      const uncertified = certificationRefusal(connection.providerKey, ['comment_reply']);
      if (uncertified)
        return {
          outcome: 'rejected',
          code: uncertified,
          message: 'the channel is no longer certified to reply; nothing was sent',
        };
      const adapter = adapterFor(connection.providerKey);
      const comment = adapter.comment?.bind(adapter);
      if (!comment || !adapter.capability.comments.reply)
        return { outcome: 'rejected', code: 'comments_reply_unsupported', message: adapter.key };

      let sent = false;
      let refused = null as string | null;
      let result: ReplySendResultV1;
      try {
        result = await credentialBroker.withCredentials(tenantId, connection.id, async (creds) => {
          // The send boundary: `sending` + sentAt commit under the row lock only while the draft is still queued, the
          // sender still holds inbox.respond and the channel is usable, so an outcome recorded first (a timed-out
          // attempt settled by the workflow), a revoked role or a disconnected channel stops this send. A refusal is
          // committed as `failed` with its reason; a throw here aborts the request as before_send.
          const io: ProviderIO = providerIO(adapter.key, tenantId, hooks, async () => {
            hooks?.heartbeat(`reply:${responseDraftId}:before_send`);
            const stop = await withTransaction(async (tx) => {
              const locked = await draftsRepo.lock(responseDraftId, tx);
              if (locked.state !== 'queued') return `send_in_state:${locked.state}`;
              const refusal = await sendRefusal(locked, connection.id, tx);
              if (refusal) {
                await move(locked, 'fail', { failureCode: refusal, failureDetail: null }, tx);
                refused = refusal;
                return refusal;
              }
              await move(locked, 'begin_send', { sentAt: now() }, tx);
              return null;
            });
            if (stop) throw new ValidationFailedError([{ path: 'responseDraftId', issue: stop }]);
            sent = true;
          });
          try {
            return fromOutcome(
              await comment(
                {
                  remotePostId: conversation.remoteThreadId,
                  replyToRemoteId: parent.remoteMessageId,
                  text: draft.text,
                  idempotencyKey: draft.id,
                },
                creds,
                io,
              ),
            );
          } catch (err) {
            if (err instanceof ProviderTransportError) {
              const classified = fromOutcome(
                outcomeFromClass(adapter.classifyError({ phase: err.phase, error: err }), err.message),
              );
              return err.phase === 'after_send' && classified.outcome === 'retryable_error'
                ? unknown(err.code ?? 'transport_after_send', err)
                : classified;
            }
            return unknown('adapter_error', err);
          }
        });
      } catch (err) {
        // Before any mutation (credentials, rate limiter): proven no effect, retryable with backoff.
        if (
          err instanceof ProviderRateLimitWaitExceeded ||
          (err instanceof ProviderTransportError && err.phase === 'before_send')
        )
          return {
            outcome: 'retryable_error',
            code: 'pre_send',
            message: truncateForTemporal(err),
            retryAfterMs: 5_000,
          };
        if (err instanceof PolicyDeniedError)
          return { outcome: 'rejected', code: err.reason, message: truncateForTemporal(err) };
        throw err;
      }
      // Refused at the boundary: nothing was sent and the draft is already failed with the reason.
      if (refused)
        return { outcome: 'rejected', code: refused, message: 'the reply was refused before it was sent' };
      // Once `sending` is committed the reply is never posted again: a platform answer that is retryable (the
      // platform refused it without effect, e.g. rate limited) settles the draft as failed; a person can send anew.
      if (sent && result.outcome === 'retryable_error')
        return { outcome: 'rejected', code: result.code, message: result.message };
      return result;
    },

    async recordReplyOutcome(input: RecordReplyOutcomeInputV1): Promise<RecordReplyOutcomeResultV1> {
      const { result } = input;
      return withTransaction(async (tx) => {
        const draft = await draftsRepo.lock(input.responseDraftId, tx);
        if (responseDraftMachine.terminal.includes(draft.state))
          return { state: draft.state, messageId: draft.outboundMessageId, changed: false };
        if (draft.state === 'draft')
          throw new ValidationFailedError([{ path: 'responseDraftId', issue: 'not_sent' }]);

        if (result.outcome === 'accepted') {
          const { conversation, connection } = await load(draft.id, tx);
          const parent = draft.replyToMessageId
            ? await messagesRepo.findById(draft.replyToMessageId, tx)
            : null;
          // Ingestion may already have stored the brand's reply as a comment: one row per remote id, always.
          const existing = await messagesRepo.findRemote(conversation.id, result.remoteMessageId, tx);
          // A row ingested without the author's id is the brand's own reply stored as a comment: correct it.
          if (existing?.direction === 'inbound') await messagesRepo.markOutbound(existing.id, tx);
          const messageId = existing?.id ?? newId('message');
          const at = draft.sentAt ?? now();
          if (!existing)
            await messagesRepo.create(
              {
                id: messageId,
                brandId: draft.brandId,
                conversationId: conversation.id,
                remoteMessageId: result.remoteMessageId,
                parentRemoteMessageId: parent?.remoteMessageId ?? null,
                direction: 'outbound',
                authorHash: outboundAuthorHash(connection.id),
                authorHandle: connection.displayName.slice(0, 200),
                text: draft.text,
                sentiment: null,
                classification: null,
                substantive: null,
                clusterId: null,
                remoteCreatedAt: at,
              },
              tx,
            );
          let current = draft;
          if (current.state === 'queued') {
            // Accepted means the call was made: the boundary committed `sending` (defensive for a lost commit).
            await move(current, 'begin_send', { sentAt: at }, tx);
            current = await draftsRepo.lock(draft.id, tx);
          }
          const state = await move(current, 'accept', { outboundMessageId: messageId }, tx);
          if (!conversation.lastMessageAt || at > conversation.lastMessageAt)
            await conversationsRepo.update(conversation.id, conversation.version, { lastMessageAt: at }, tx);
          return { state, messageId, changed: true };
        }

        const failure = {
          failureCode: result.code.slice(0, 100),
          failureDetail: result.message ? result.message.slice(0, 500) : null,
        };
        // Unknown after the boundary: the reply may exist. Anything else (rejected, retries exhausted, unknown
        // before the boundary, which the lock proves) was not posted.
        const event: ResponseDraftEvent =
          result.outcome === 'unknown' && draft.state === 'sending' ? 'lose' : 'fail';
        const state = await move(draft, event, failure, tx);
        return { state, messageId: null, changed: true };
      });
    },
  };
}

/**
 * Comment ingestion found a comment written by the connected account itself (the brand's own reply, stored
 * outbound). A reply of this conversation that is still sending or ended outcome_unknown, answering the same comment
 * with the same text, was posted after all: it is confirmed sent and linked to that row. At most one draft moves.
 */
export async function confirmIngestedOwnReply(
  input: { conversationId: string; messageId: string; parentRemoteMessageId: string | null; text: string },
  tx: Tx,
): Promise<string | null> {
  if (!input.parentRemoteMessageId) return null;
  const conversation = await conversationsRepo.getById(input.conversationId, tx);
  const parent = await messagesRepo.findRemote(conversation.id, input.parentRemoteMessageId, tx);
  if (!parent) return null;
  const candidates = await draftsRepo.listUnconfirmedReplies(
    conversation.brandId,
    conversation.id,
    parent.id,
    tx,
  );
  const match = candidates.find((d) => d.text.trim() === input.text.trim());
  if (!match) return null;
  const locked = await draftsRepo.lock(match.id, tx);
  if (!responseDraftMachine.can(locked.state, 'confirm')) return null;
  await move(
    locked,
    'confirm',
    { outboundMessageId: input.messageId, failureCode: null, failureDetail: null },
    tx,
  );
  return locked.id;
}
