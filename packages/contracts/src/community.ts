import { z } from 'zod';
import type { ActivityHooks } from './agents';
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';

/**
 * Comment inbox (spec 16.10 "Unified inbox", first slice): a brand's team reads the comments ingested on its
 * published posts (spec 16.5) and answers them; the answer is posted on the platform by communityReplyWorkflowV1.
 * Human sends only (agents stay propose-only on inbox.respond).
 */

/**
 * The lifecycle of a response draft. `draft` is a proposal (agents); `queued` → `sending` → `sent` is a human
 * send; `sending` is committed immediately before the platform call, so a send that may have gone out is never
 * repeated (it ends `outcome_unknown`). `failed` carries the reason.
 */
export const ResponseDraftState = z.enum([
  'draft',
  'queued',
  'sending',
  'sent',
  'failed',
  'outcome_unknown',
  'discarded',
]);
export type ResponseDraftState = z.infer<typeof ResponseDraftState>;

/** A reply can never be longer than this, whatever a channel allows (the channel's own limit applies first). */
export const REPLY_TEXT_MAX = 10_000;

export const ConversationList = z.object({ brandId: z.string(), page: PageRequest.default({}) });
export const ConversationMessagesList = z.object({ conversationId: z.string() });
export const CommentReply = z.object({
  /** The inbound comment being answered. */
  messageId: z.string(),
  text: z.string().min(1).max(REPLY_TEXT_MAX),
});

// ---- workflow contract (communityReplyWorkflowV1 on task queue `core`, workflow id `reply:<responseDraftId>`) ----

/** References only (spec 14.7 R5): activities re-load the draft, the conversation and the connection. */
export const CommunityReplyWorkflowInputV1 = TenantContextInput.extend({ responseDraftId: z.string() });
export type CommunityReplyWorkflowInputV1 = z.infer<typeof CommunityReplyWorkflowInputV1>;

/** The classified outcome of one send (the adapter's PublishOutcome, narrowed to what a comment can return). */
export type ReplySendResultV1 =
  | { outcome: 'accepted'; remoteMessageId: string; remoteUrl: string | null }
  | { outcome: 'rejected'; code: string; message: string }
  /** Proven not sent (nothing left the process, the draft is still `queued`): the workflow may try again. */
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number }
  | { outcome: 'unknown'; code: string; message: string };

export type RecordReplyOutcomeInputV1 = CommunityReplyWorkflowInputV1 & { result: ReplySendResultV1 };
export interface RecordReplyOutcomeResultV1 {
  state: ResponseDraftState;
  /** The outbound message row written for a sent reply. */
  messageId: string | null;
  changed: boolean;
}

/** Task queue `publish-<providerKey>` (the worker that holds provider credentials). */
export interface CommunityReplyProviderActivitiesV1 {
  /** retry.maximumAttempts 1 in the workflow: a send is never blindly retried; a repeat after `sending` is unknown. */
  sendReplyOnce(input: CommunityReplyWorkflowInputV1): Promise<ReplySendResultV1>;
}

/** Task queue `core`; idempotent (a repeat reports `changed: false`). */
export interface CommunityReplyControlActivitiesV1 {
  /** The provider queue of the draft's channel; null when the channel cannot reply (the draft is failed). */
  readReplyRoute(input: CommunityReplyWorkflowInputV1): Promise<{ providerKey: string | null }>;
  recordReplyOutcome(input: RecordReplyOutcomeInputV1): Promise<RecordReplyOutcomeResultV1>;
}

/** The module-side implementations the activities wrap (tenant context is established by the activity host). */
export interface CommunityReplyRuntimeV1 {
  readReplyRoute(input: CommunityReplyWorkflowInputV1): Promise<{ providerKey: string | null }>;
  sendReplyOnce(input: CommunityReplyWorkflowInputV1, hooks?: ActivityHooks): Promise<ReplySendResultV1>;
  recordReplyOutcome(input: RecordReplyOutcomeInputV1): Promise<RecordReplyOutcomeResultV1>;
}
