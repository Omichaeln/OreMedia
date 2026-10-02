import { z } from 'zod';

export const PublicationState = z.enum([
  'scheduled',
  'dispatching',
  'processing',
  'published',
  'failed',
  'outcome_unknown',
  'retry_eligible',
  'cancelled',
  'held',
  // Appended (additive): the live post was deleted on its platform through the product (publication.delete_remote).
  'removed',
]);
export type PublicationState = z.infer<typeof PublicationState>;

export const PublicationAuthority = z.enum(['approval', 'mandate']);
export type PublicationAuthority = z.infer<typeof PublicationAuthority>;

export const AttemptOutcome = z.enum(['accepted', 'pending', 'rejected', 'retryable_error', 'unknown']);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/** Spec 14.1: the scheduling command. */
export const ScheduleCommand = z.object({
  channelVariantId: z.string(),
  scheduledFor: z.string().datetime(),
  authority: PublicationAuthority,
  approvalId: z.string().optional(),
  mandateId: z.string().optional(),
  occurrence: z.string().max(40).optional(), // deliberate repeats get a new occurrence value
});
export type ScheduleCommand = z.infer<typeof ScheduleCommand>;

export const CancelCommand = z.object({ publicationId: z.string(), expectedVersion: z.number().int() });
export const RescheduleCommand = z.object({
  publicationId: z.string(),
  expectedVersion: z.number().int(),
  scheduledFor: z.string().datetime(),
});
export const ReconcileCommand = z.object({
  publicationId: z.string(),
  resolution: z.enum(['confirm_published', 'confirm_absent', 'cancel']),
  remotePostId: z.string().optional(),
  remoteUrl: z.string().optional(),
  note: z.string().max(500).optional(),
});

export interface AttemptResult {
  attemptId: string;
  outcome: AttemptOutcome;
  remotePostId?: string;
  remoteUrl?: string;
  remoteJobId?: string;
  pending?: unknown;
  errorCode?: string;
  errorDetail?: string;
  retryAfterMs?: number;
  error?: string;
}

export const ChannelConnectStart = z.object({
  brandId: z.string(),
  providerKey: z.string(),
  /**
   * Used only where the server has no public web origin (development, tests). A deployment with WEB_ORIGIN always
   * sends the provider back to its one registered callback, `${WEB_ORIGIN}/connect/callback`, whatever this says.
   */
  redirectUri: z.string().url().optional(),
});
export const ChannelConnectComplete = z.object({ state: z.string(), code: z.string() });

export const MandateSourceRules = z.object({
  onlyApprovedFacts: z.boolean().default(true),
  onlyApprovedTemplates: z.boolean().default(true),
  onlyApprovedAssets: z.boolean().default(true),
  requireBrandReviewClean: z.boolean().default(true),
});
export type MandateSourceRules = z.infer<typeof MandateSourceRules>;

export const MandateState = z.enum(['active', 'paused', 'revoked', 'expired']);
export const MandateCreate = z.object({
  brandId: z.string(),
  servicePrincipalId: z.string(),
  channelConnectionIds: z.array(z.string()).min(1).max(50),
  allowedContentClasses: z.array(z.string()).min(1).max(50),
  sourceRules: MandateSourceRules,
  maxPostsPerDay: z.number().int().min(1).max(100),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(), // mandates always expire
});

// ---------------------------------------------------------------------------------------------------------------
// Phase 5 publishing (spec 13.5, 14.1, 14.3, 14.7): router DTOs, workflow inputs, activity contracts and the
// cross-module hook shapes. Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PAGE_MAX, PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';
import type { ActivityHooks } from './agents';
import { ARTICLE_TEXT_MAX_CHARS, type ArticleDocumentV1 } from './content';
import type { ResolvedActor } from './policy';
import type {
  ChannelConnectionStatus,
  PendingCheck,
  ReconcileResult,
  RemoteMutationOutcome,
} from './providers';

// ---- router DTOs (spec 7.5 publishing router) ----
export const ChannelList = z.object({ brandId: z.string() });
export const ChannelDisconnect = z.object({
  channelConnectionId: z.string(),
  expectedVersion: z.number().int(),
});
export const PublicationGet = z.object({ publicationId: z.string() });
export const PublicationList = z.object({
  brandId: z.string(),
  state: PublicationState.optional(),
  page: PageRequest,
});
export const PublicationEvidence = z.object({ publicationId: z.string() });
export const PublicationDeleteRemote = z.object({ publicationId: z.string(), reason: z.string().max(500) });
/**
 * Replaces the text of a live post on a platform that allows it (publication.edit_remote). The text is checked
 * against the channel capability's text rules like a variant; media and settings stay as published. The request
 * is idempotent through the Idempotency-Key of the call, like every publication command.
 */
export const PublicationEditRemote = z.object({
  publicationId: z.string(),
  /** RA-03: an article's body (HTML for a website) is bounded by the one article text cap, as its variant is. */
  text: z.string().min(1).max(ARTICLE_TEXT_MAX_CHARS),
  reason: z.string().max(500).optional(),
});
/**
 * R2-3 rollback: a published article is set back to a draft on its website (publication.delete_remote: the same
 * people who may remove a post). The request is recorded as a remote change of kind `unpublish` and carried out by
 * publicationRemoteDeleteWorkflowV1 on the destination's queue; the publication stays published with the evidence.
 */
export const PublicationUnpublishRemote = z.object({
  publicationId: z.string(),
  reason: z.string().max(500),
});
/**
 * RA-02 (destination publications; null for a channel): what the website holds, set from the read-back at publish
 * (`live` only when the remote status is `publish`; a `publish` mode whose read-back is not live is a draft) and
 * `reverted` once the article was set back to a draft. Beside the publication state, which stays the approval's
 * binding (spec 13.1); never a replacement for it.
 */
export const PublicationRemoteStatus = z.enum(['draft', 'live', 'reverted']);
export type PublicationRemoteStatus = z.infer<typeof PublicationRemoteStatus>;
/**
 * RA-04: whether the write was proven: `verified` when the read-back matched what was sent and the rendered page
 * passed its checks (remoteVerifiedAt is then set), `failed` when either did not, `unverified` when nothing could
 * be compared (no read allowed, read-back missing).
 */
export const PublicationRemoteVerification = z.enum(['unverified', 'verified', 'failed']);
export type PublicationRemoteVerification = z.infer<typeof PublicationRemoteVerification>;
/**
 * Spec 17.6 restore rule (runbook "restore a single tenant", step 5): the restored tenant's in-flight publications,
 * or one brand's (`brandId` is required; null means the whole tenant). One call handles at most `limit` rows in its
 * own transaction; `hasMore` asks for another call.
 */
export const PublicationHoldRestored = z.object({
  brandId: z.string().nullable(),
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_MAX),
});

/**
 * Choosing the account (spec 14.7): when the person's grant addresses several accounts (Facebook Pages, Instagram
 * professional accounts, LinkedIn Pages), `connect.complete` connects nothing and answers `outcome: 'choose'` with a
 * one-shot `pendingId`; `connect.select` connects the chosen one, `connect.cancel` discards the choice. Both are
 * bound to the tenant, brand and actor that completed the flow and expire with it (CONNECT_STATE_TTL_MS).
 */
export const ChannelConnectSelect = z.object({
  pendingId: z.string().max(32),
  remoteAccountId: z.string().min(1).max(200),
});
export const ChannelConnectCancel = z.object({ pendingId: z.string().max(32) });

/** One account the grant can connect: names only, never tokens. */
export interface ChannelConnectOption {
  remoteAccountId: string;
  displayName: string;
}
/**
 * `connect.complete`'s answer when the person must choose. The connected answer is the channel connection itself
 * with `outcome: 'connected'` added, so a client written before the choice existed reads it unchanged.
 */
export interface ChannelConnectChoice {
  outcome: 'choose';
  pendingId: string;
  brandId: string;
  providerKey: string;
  options: ChannelConnectOption[];
  /** Accounts the grant listed that the provider did not return a grant for (left out, not an error). */
  unavailable: number;
  expiresAt: string;
}

/** Spec 13.5: the cancel response; `prevented: false` means dispatch already started and the outcome is reconciled. */
export type CancelResult =
  | { prevented: true; state: PublicationState; version: number }
  | { prevented: false; state: PublicationState; message: string };

/**
 * The publication as the release evaluator (spec 13.4, review module) sees it: references only. `id` is
 * 'preview' for the fail-fast pre-check at scheduling time (spec 14.1 previewPublication).
 */
export interface PublicationForRelease {
  id: string;
  tenantId: string;
  brandId: string;
  contentPackageId: string;
  contentRevisionId: string;
  channelVariantId: string;
  /** The channel, or null for a publication to a brand destination (R2-3); exactly one of the two is set. */
  channelConnectionId: string | null;
  destinationId: string | null;
  authority: PublicationAuthority;
  approvalId: string | null;
  mandateId: string | null;
  scheduledFor: string;
  state: PublicationState;
}

/** What the publishing module needs from a channel variant (content module `contentService.variants.get`). */
export interface ChannelVariantForPublishing {
  id: string;
  tenantId: string;
  brandId: string;
  contentPackageId: string;
  contentRevisionId: string;
  /** The channel, or null for a variant targeting a brand destination (R2-3); exactly one of the two is set. */
  channelConnectionId: string | null;
  destinationId: string | null;
  text: string;
  altTexts: string[];
  settings: Record<string, unknown>;
  exportIds: string[];
  exportHashes: string[];
  /** The revision's article (R2-3) for a destination variant; null for a channel variant or a plain copy. */
  article: ArticleDocumentV1 | null;
  version: number;
}

/** A publication's target: the channel connection or the brand destination it writes to (exactly one). */
export type PublishTargetRef = { channelConnectionId: string | null; destinationId: string | null };
export const publishTargetId = (t: PublishTargetRef): string =>
  t.destinationId ?? t.channelConnectionId ?? '';

// ---- workflow contract (publicationWorkflowV1 on task queue `core`, workflow id `pub:<publicationId>`) ----

/** Workflow input: references only (spec 14.7 R5). Activities re-load the row and the actor's grants (spec 5.2). */
export const PublicationWorkflowInputV1 = TenantContextInput.extend({ publicationId: z.string() });
export type PublicationWorkflowInputV1 = z.infer<typeof PublicationWorkflowInputV1>;

/** Signals relayed from the outbox to a running publication workflow (publicationSignalRelayV1). */
export const PublicationSignalV1 = z.discriminatedUnion('signal', [
  z.object({ workflowId: z.string(), signal: z.literal('cancel') }),
  z.object({ workflowId: z.string(), signal: z.literal('reschedule') }),
]);
export type PublicationSignalV1 = z.infer<typeof PublicationSignalV1>;

/** Reconciliation started on its own (sweeper-detected worker loss) runs the same loop as the publication workflow. */
export const PublicationReconcileInputV1 = PublicationWorkflowInputV1.extend({
  attemptId: z.string().nullable(),
  /** Chooses the `publish-<providerKey>` lookup queue; a key, never a connection object (R5). */
  providerKey: z.string(),
});
export type PublicationReconcileInputV1 = z.infer<typeof PublicationReconcileInputV1>;

export const TokenRefreshWorkflowInputV1 = TenantContextInput.extend({ channelConnectionId: z.string() });
export type TokenRefreshWorkflowInputV1 = z.infer<typeof TokenRefreshWorkflowInputV1>;

/** The sweeper is platform-level (it spans tenants, like the outbox dispatcher); it carries no tenant. */
export const PublicationSweepInputV1 = z.object({
  correlationId: z.string(),
  now: z.string().datetime(),
  /** A `dispatching` claim older than this with no running workflow is worker loss → outcome_unknown. */
  claimLeaseSeconds: z.number().int().positive(),
  /** A `scheduled` row this far past due with no running workflow gets its start event re-emitted. */
  graceSeconds: z.number().int().nonnegative(),
});
export type PublicationSweepInputV1 = z.infer<typeof PublicationSweepInputV1>;

export interface ReadScheduleResultV1 {
  state: PublicationState;
  scheduledFor: string;
  version: number;
}
export type ClaimInputV1 = PublicationWorkflowInputV1 & { claimant: string };
export type ClaimResultV1 =
  | {
      ok: true;
      fencingToken: number;
      /** The key that names a publication target's activity queue: the channel's provider key or the destination's kind. */
      providerKey: string;
      /** The target's id: the channel connection, or (R2-3) the destination. Kept under its v1 name; the workflow does not read it. */
      channelConnectionId: string;
    }
  | { ok: false; state: PublicationState };
export type FencedInputV1 = PublicationWorkflowInputV1 & { fencingToken: number };
export type ReleaseEvaluationResultV1 = { allow: true } | { allow: false; reasons: string[] };
export type HoldInputV1 = PublicationWorkflowInputV1 & { reasons: string[] };
export type AttemptInputV1 = PublicationWorkflowInputV1 & { attempt: AttemptResult };
export type ReconcileFound = Extract<ReconcileResult, { status: 'found' }>;
export type MarkPublishedInputV1 = PublicationWorkflowInputV1 & {
  attempt?: AttemptResult;
  evidence?: ReconcileFound & { attemptId: string | null };
};
export type OutcomeUnknownInputV1 = PublicationWorkflowInputV1 & { attemptId: string | null };
export type HoldForHumanInputV1 = PublicationWorkflowInputV1 & { reason: string };
export type RetryResultV1 =
  { retried: true; scheduledFor: string } | { retried: false; reason: 'sent' | 'state' };
/** Every control activity is idempotent: a repeat reports `changed: false` and the state it found. */
export interface TransitionResultV1 {
  state: PublicationState;
  version: number;
  changed: boolean;
}

/** Spec 14.3 `PublishControlActivities` (task queue `core`; every activity idempotent). */
export interface PublishControlActivitiesV1 {
  readSchedule(input: PublicationWorkflowInputV1): Promise<ReadScheduleResultV1>;
  cancelIfNotStarted(input: PublicationWorkflowInputV1): Promise<TransitionResultV1>;
  claimForDispatch(input: ClaimInputV1): Promise<ClaimResultV1>;
  evaluateRelease(input: FencedInputV1): Promise<ReleaseEvaluationResultV1>;
  hold(input: HoldInputV1): Promise<TransitionResultV1>;
  releaseClaimAndCancel(input: FencedInputV1): Promise<TransitionResultV1>;
  /** Commits the publication_attempts row BEFORE any outbound call; idempotent on (publicationId, fencingToken). */
  openAttempt(input: FencedInputV1): Promise<string>;
  markProcessing(input: AttemptInputV1): Promise<TransitionResultV1>;
  markPublished(input: MarkPublishedInputV1): Promise<TransitionResultV1>;
  markFailed(input: AttemptInputV1): Promise<TransitionResultV1>;
  markOutcomeUnknown(input: OutcomeUnknownInputV1): Promise<TransitionResultV1>;
  markRetryEligible(input: PublicationWorkflowInputV1): Promise<TransitionResultV1>;
  holdForHuman(input: HoldForHumanInputV1): Promise<TransitionResultV1>;
  /** Back to `scheduled` with backoff only when the attempt has no sentAt; with sentAt the outcome is unknown. */
  retryAfterProvenNoEffect(input: AttemptInputV1): Promise<RetryResultV1>;
}

export type PublishOnceInputV1 = FencedInputV1 & { attemptId: string };
export type FindRemotePostInputV1 = PublicationWorkflowInputV1 & { attemptId: string | null };

/** Spec 14.3 `ProviderActivities` + `ReconcileActivities` (task queue `publish-<providerKey>`). */
export interface PublishProviderActivitiesV1 {
  /** retry.maximumAttempts: 1 in the workflow; never retries a mutation after send. */
  publishOnce(input: PublishOnceInputV1): Promise<AttemptResult>;
  /** Read-only. */
  checkStatus(input: PublishOnceInputV1): Promise<PendingCheck>;
  /** Once finalisation went through, checkStatus reports completed (spec 20.3); a repeat never duplicates. */
  finalize(input: PublishOnceInputV1): Promise<PendingCheck>;
  /** Read-only, safe to retry. */
  findRemotePost(input: FindRemotePostInputV1): Promise<ReconcileResult>;
}

export interface RefreshScheduleResultV1 {
  status: ChannelConnectionStatus;
  tokenExpiresAt: string | null;
}
export type RefreshCredentialsResultV1 =
  | { ok: true; tokenExpiresAt: string | null }
  | { ok: false; reason: 'locked' | 'transient' | 'reconnect_required' | 'not_active' };

/** Spec 14.7 tokenRefreshWorkflowV1 activities (task queue `core`). */
export interface TokenRefreshActivitiesV1 {
  readRefreshSchedule(input: TokenRefreshWorkflowInputV1): Promise<RefreshScheduleResultV1>;
  refreshCredentials(input: TokenRefreshWorkflowInputV1): Promise<RefreshCredentialsResultV1>;
}

export interface SweepResultV1 {
  scheduledReemitted: number;
  dispatchingExpired: number;
}
export interface PublicationSweepActivitiesV1 {
  sweepPublications(input: PublicationSweepInputV1): Promise<SweepResultV1>;
}

/**
 * Spec 14.7 account choice: the periodic purge of expired pending choices (connectChoicePurgeWorkflowV1, a Temporal
 * schedule on task queue `core`). Platform-level: it spans tenants and carries none.
 */
export const ConnectChoicePurgeInputV1 = z.object({ correlationId: z.string(), now: z.string().datetime() });
export type ConnectChoicePurgeInputV1 = z.infer<typeof ConnectChoicePurgeInputV1>;
export interface ConnectChoicePurgeArgsV1 {
  correlationId?: string;
  now?: string;
}
export interface ConnectChoicePurgeResultV1 {
  /** Pending grant rows shredded and deleted. */
  rows: number;
}
export interface ConnectChoicePurgeActivitiesV1 {
  purgeExpiredConnectChoices(input: ConnectChoicePurgeInputV1): Promise<ConnectChoicePurgeResultV1>;
}

/** The module-side implementations the activities wrap (tenant context is established by the activity host). */
export type PublishControlRuntimeV1 = PublishControlActivitiesV1;
export interface PublishProviderRuntimeV1 {
  publishOnce(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<AttemptResult>;
  checkStatus(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck>;
  finalize(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck>;
  findRemotePost(input: FindRemotePostInputV1, hooks?: ActivityHooks): Promise<ReconcileResult>;
}
export type TokenRefreshRuntimeV1 = TokenRefreshActivitiesV1;
export type PublicationSweepRuntimeV1 = PublicationSweepActivitiesV1;

// ---------------------------------------------------------------------------------------------------------------
// Remote edit and deletion of published posts (appended; additive only). The API records a remote change and emits
// publication.edit_remote_requested / publication.delete_remote_requested; the outbox starts
// publicationRemoteEditWorkflowV1 / publicationRemoteDeleteWorkflowV1 on task queue `core`, which call the provider
// activity on `publish-<providerKey>` and record the outcome on `core`.
// ---------------------------------------------------------------------------------------------------------------
/** `unpublish` (R2-3): the live article is set back to a draft on its website (the rollback of a publish). */
export const RemoteChangeKind = z.enum(['edit', 'delete', 'unpublish']);
export type RemoteChangeKind = z.infer<typeof RemoteChangeKind>;
/** requested → succeeded | failed; a publication has at most one requested change at a time. */
export const RemoteChangeState = z.enum(['requested', 'succeeded', 'failed']);
export type RemoteChangeState = z.infer<typeof RemoteChangeState>;

/** Workflow input: references only (spec 14.7 R5); the text of an edit is read from the change row. */
export const PublicationRemoteChangeInputV1 = PublicationWorkflowInputV1.extend({
  changeId: z.string(),
  /** Chooses the `publish-<providerKey>` queue; a key, never a connection object (R5). */
  providerKey: z.string(),
});
export type PublicationRemoteChangeInputV1 = z.infer<typeof PublicationRemoteChangeInputV1>;

/** `skipped`: the change is no longer requested (already recorded, or superseded); nothing was sent. */
/** `publishing.publications.validateRendered` (R2-3): fetch the published page again and record what it shows. */
export const PublicationValidateRendered = z.object({ publicationId: z.string() });
export type PublicationValidateRendered = z.infer<typeof PublicationValidateRendered>;
export type RemoteChangeAttemptResultV1 = RemoteMutationOutcome | { outcome: 'skipped'; reason: string };
export type RecordRemoteChangeInputV1 = PublicationRemoteChangeInputV1 & { result: RemoteMutationOutcome };
/** Idempotent: a repeat reports `changed: false` and what it found. */
export interface RecordRemoteChangeResultV1 {
  state: RemoteChangeState;
  publicationState: PublicationState;
  changed: boolean;
}

/** Task queue `publish-<providerKey>`: one platform call each; the workflow bounds the retries. */
export interface RemoteChangeProviderActivitiesV1 {
  deleteRemotePost(input: PublicationRemoteChangeInputV1): Promise<RemoteChangeAttemptResultV1>;
  editRemotePost(input: PublicationRemoteChangeInputV1): Promise<RemoteChangeAttemptResultV1>;
}
/** Task queue `core`. */
export interface RemoteChangeControlActivitiesV1 {
  recordRemoteChangeOutcome(input: RecordRemoteChangeInputV1): Promise<RecordRemoteChangeResultV1>;
}
/**
 * `actor` is the requester re-resolved by the activity host at the point of effect (spec 5.2): the runtime re-checks
 * publication.edit_remote / delete_remote for it before anything is sent.
 */
export interface RemoteChangeProviderRuntimeV1 {
  deleteRemotePost(
    input: PublicationRemoteChangeInputV1,
    actor: ResolvedActor,
    hooks?: ActivityHooks,
  ): Promise<RemoteChangeAttemptResultV1>;
  editRemotePost(
    input: PublicationRemoteChangeInputV1,
    actor: ResolvedActor,
    hooks?: ActivityHooks,
  ): Promise<RemoteChangeAttemptResultV1>;
}
export type RemoteChangeControlRuntimeV1 = RemoteChangeControlActivitiesV1;

/**
 * remoteChangeSweepWorkflowV1 (task queue `core`, started hourly by the Temporal schedule `remote-change-sweep`):
 * requested remote changes with no outcome past the stale threshold are closed as failed (`stale_no_outcome`), so
 * a lost workflow never leaves a post blocked. Platform-level like the publication sweeper: no tenant in the input.
 */
export const RemoteChangeSweepInputV1 = z.object({
  correlationId: z.string(),
  now: z.string().datetime(),
});
export type RemoteChangeSweepInputV1 = z.infer<typeof RemoteChangeSweepInputV1>;
export interface RemoteChangeSweepResultV1 {
  closed: number;
}
export interface RemoteChangeSweepActivitiesV1 {
  sweepStaleRemoteChanges(input: RemoteChangeSweepInputV1): Promise<RemoteChangeSweepResultV1>;
}
export type RemoteChangeSweepRuntimeV1 = RemoteChangeSweepActivitiesV1;
export type ConnectChoicePurgeRuntimeV1 = ConnectChoicePurgeActivitiesV1;

// ---------------------------------------------------------------------------------------------------------------
// RA-04 delayed re-validation of a live article (appended; additive only). markPublished emits
// publication.rendered_validation_due through the outbox with `availableAt`; the outbox starts
// renderedValidationWorkflowV1 on task queue `core`, which re-runs the rendered validation at the delays and
// records each result as evidence with the publication's verification.
// ---------------------------------------------------------------------------------------------------------------
/**
 * When the rendered page of a live article is checked again after publish: 2 and 15 minutes (RA-04). Mirrored in
 * rendered-validation.workflow.v1.ts (workflow code imports no values); its test asserts the two agree.
 */
export const RENDERED_VALIDATION_DELAYS_MS = [2 * 60_000, 15 * 60_000] as const;
export const RenderedValidationInputV1 = PublicationWorkflowInputV1.extend({
  /** The publication moment the delays count from. */
  publishedAt: z.string().datetime(),
});
export type RenderedValidationInputV1 = z.infer<typeof RenderedValidationInputV1>;
/** `skipped`: the publication is no longer a published article (nothing to validate); nothing was recorded. */
export type RenderedValidationResultV1 =
  | { outcome: 'validated'; ok: boolean; verification: PublicationRemoteVerification }
  | { outcome: 'skipped'; reason: string };
/** Task queue `core`: no credential (the page is public), one fetch per call; idempotent (evidence is appended). */
export interface RenderedValidationActivitiesV1 {
  validateRenderedPublication(input: RenderedValidationInputV1): Promise<RenderedValidationResultV1>;
}
export type RenderedValidationRuntimeV1 = RenderedValidationActivitiesV1;
