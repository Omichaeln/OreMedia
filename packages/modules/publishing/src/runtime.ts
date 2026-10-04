import type { ActivityHooks } from '@oremedia/contracts/agents';
import { renderedOutcomeOf, type RenderedOutcome } from '@oremedia/contracts/article';
import type { ArticleReadbackV1, ArticleReadbackVerificationV1 } from '@oremedia/contracts/destinations';
import { ARTICLE_TEXT_MAX_CHARS } from '@oremedia/contracts/content';
import {
  NotFoundError,
  PolicyDeniedError,
  ReleaseIntegrityError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import {
  PendingState,
  type DecryptedCredentials,
  type PendingCheck,
  type PublishOutcome,
  type ReconcileResult,
  type RemoteMutationOutcome,
} from '@oremedia/contracts/providers';
import { RENDERED_VALIDATION_DELAYS_MS } from '@oremedia/contracts/publishing';
import type {
  AttemptInputV1,
  AttemptResult,
  ChannelRevokeInputV1,
  ChannelRevokeResultV1,
  ChannelRevokeRuntimeV1,
  ClaimInputV1,
  ClaimResultV1,
  ConnectChoicePurgeInputV1,
  ConnectChoicePurgeResultV1,
  ConnectChoicePurgeRuntimeV1,
  FencedInputV1,
  FindRemotePostInputV1,
  HoldForHumanInputV1,
  HoldInputV1,
  MarkPublishedInputV1,
  OutcomeUnknownInputV1,
  PublicationRemoteChangeInputV1,
  PublicationRemoteVerification,
  PublicationSweepInputV1,
  RemoteChangeSweepInputV1,
  RemoteChangeSweepResultV1,
  RemoteChangeSweepRuntimeV1,
  PublicationWorkflowInputV1,
  PublishControlRuntimeV1,
  PublishOnceInputV1,
  PublishProviderRuntimeV1,
  PublicationSweepRuntimeV1,
  ReadScheduleResultV1,
  RecordRemoteChangeInputV1,
  RecordRemoteChangeResultV1,
  RefreshCredentialsResultV1,
  ReleaseEvaluationResultV1,
  RemoteChangeAttemptResultV1,
  RemoteChangeControlRuntimeV1,
  RemoteChangeProviderRuntimeV1,
  RenderedValidationInputV1,
  RenderedValidationResultV1,
  RenderedValidationRuntimeV1,
  RetryResultV1,
  SweepResultV1,
  TokenRefreshRuntimeV1,
  TokenRefreshWorkflowInputV1,
  TransitionResultV1,
} from '@oremedia/contracts/publishing';
import { requireTenant, runAsPlatform, runInTenant, withTransaction, type Tx } from '@oremedia/db';
import { hashCanonical, hashText } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { PublicationEvent } from '@oremedia/domain/state-machines/publication';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { policy } from '@oremedia/module-access';
import { MemoryRateLimiterStore, audit, outbox, type RateLimiterStore } from '@oremedia/module-operations';
import { METRIC, count, logger, record } from '@oremedia/observability';
import type { ChannelHealth, RevokeResult } from '@oremedia/contracts/providers';
import {
  ProviderRateLimitWaitExceeded,
  ProviderTransportError,
  outcomeFromClass,
  truncateForTemporal,
  type ProviderIO,
  type PublishRequest,
} from '@oremedia/providers';
import { credentialBroker } from './broker';
import { renderedValidationWorkflowId } from './outbox-routes';
import { failedChecksReason, fetchRenderedValidation, recordRenderedValidation } from './publications';
import {
  REMOTE_CHANGE_STALE_MS,
  STALE_CLOSURE_CODES,
  forRelease,
  publicationResource,
  reconcileWorkflowId,
  auditRevokeReason,
  targetIdOf,
  transition,
  workflowIdOf,
  type AttemptRow,
  type ConnectionRow,
  type PublicationRow,
} from './common';
import {
  approvals,
  destinations,
  providerClientFor,
  publishMedia,
  review,
  sweepDisconnectedCredentials,
  variants,
  workflowRunning,
  type DestinationMutationResult,
  type DestinationPublishResult,
} from './hooks';
import { adapterFor, providerIO, registry } from './providers';
import {
  ChannelConnectionRepository,
  CredentialRefRepository,
  PURGE_BATCH,
  PendingChannelGrantPurgeRepository,
  PublicationAttemptRepository,
  PublicationRemoteChangeRepository,
  PublicationRepository,
  PublicationSweepRepository,
  RemoteChangeSweepRepository,
  RemoteEvidenceRepository,
} from './repositories';

export interface PublishingRuntimeOptions {
  now?: () => Date;
  /** Per-connection refresh lock (Redis-backed in production; memory fallback). */
  refreshLock?: RateLimiterStore;
  /** Pre-send retries beyond this many attempts hold the publication for a person (spec 14.3 backoff has an end). */
  maxPreSendAttempts?: number;
}

export interface PublishingRuntime {
  control: PublishControlRuntimeV1;
  provider: PublishProviderRuntimeV1;
  tokenRefresh: TokenRefreshRuntimeV1;
  sweep: PublicationSweepRuntimeV1;
  /** publicationRemoteEditWorkflowV1 / publicationRemoteDeleteWorkflowV1: `core` and `publish-<providerKey>`. */
  remoteChangeControl: RemoteChangeControlRuntimeV1;
  remoteChangeProvider: RemoteChangeProviderRuntimeV1;
  /** remoteChangeSweepWorkflowV1 (`core`, hourly schedule). */
  remoteChangeSweep: RemoteChangeSweepRuntimeV1;
  connectChoicePurge: ConnectChoicePurgeRuntimeV1;
  /** renderedValidationWorkflowV1 (`core`, RA-04): the delayed re-validation of a live article's page. */
  renderedValidation: RenderedValidationRuntimeV1;
  /** channelRevokeWorkflowV1 (`core`, RA-01): the remote revoke of a disconnected channel's grant. */
  channelRevoke: ChannelRevokeRuntimeV1;
}

const publicationsRepo = new PublicationRepository();
const attemptsRepo = new PublicationAttemptRepository();
const evidenceRepo = new RemoteEvidenceRepository();
const connectionsRepo = new ChannelConnectionRepository();
const credentialsRepo = new CredentialRefRepository();
const sweepRepo = new PublicationSweepRepository();
const changesRepo = new PublicationRemoteChangeRepository();
const remoteSweepRepo = new RemoteChangeSweepRepository();
const pendingPurgeRepo = new PendingChannelGrantPurgeRepository();

/** The actor the workflow carries; every write is audited as that actor (spec 5.2 re-resolved by the host). */
const workflowActor = () => requireTenant().actor;

const MAX_PRE_SEND_ATTEMPTS = 8;
const REFRESH_LOCK_SECONDS = 60;
/** RA-01: a disconnected channel's credential the remote revoke has not shredded within this long is shredded by the sweeper. */
export const DISCONNECT_SHRED_FLOOR_MS = 60 * 60_000;
/** Hold reason when an export's bytes no longer hash to what the approval pinned (spec 3.g4). */
export const EXPORT_HASH_MISMATCH = 'export_hash_mismatch';

/** 30 s · 2^(n-1) capped at 30 minutes, never below the provider's Retry-After (spec 14.3 backoff). */
export function preSendBackoffMs(attemptNumber: number, retryAfterMs?: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attemptNumber - 1), 30 * 60_000);
  return Math.max(base, retryAfterMs ?? 0);
}

function assertFence(row: PublicationRow, fencingToken: number): void {
  if (row.fencingToken !== fencingToken)
    throw new ValidationFailedError(
      [{ path: 'fencingToken', issue: `stale_fencing_token:${fencingToken}!=${row.fencingToken}` }],
      'This attempt no longer holds the publication',
    );
}

async function loadAttempt(row: PublicationRow, attemptId: string, tx?: Tx): Promise<AttemptRow> {
  const attempt = await attemptsRepo.getById(attemptId, tx);
  if (attempt.publicationId !== row.id) throw new NotFoundError('PublicationAttempt', attemptId);
  return attempt;
}

const unchanged = (row: PublicationRow): TransitionResultV1 => ({
  state: row.state,
  version: row.version,
  changed: false,
});

/** One state move: machine transition, row update, audit and state_changed event, in the caller's transaction. */
async function move(
  row: PublicationRow,
  event: PublicationEvent,
  values: Partial<Parameters<PublicationRepository['update']>[2]>,
  action: string,
  reason: string | null,
  tx: Tx,
): Promise<TransitionResultV1> {
  const toState = transition(row.state, event, 'publicationId');
  await publicationsRepo.update(row.id, row.version, { ...values, state: toState }, tx);
  await audit.record(workflowActor(), action, { type: 'publication', id: row.id }, 'allowed', tx, {
    brandId: row.brandId,
    publicationId: row.id,
    fromState: row.state,
    toState,
    reason,
  });
  await outbox.add(
    'publication.state_changed',
    { type: 'publication', id: row.id, version: row.version + 1 },
    { publicationId: row.id, fromState: row.state, toState, reason },
    tx,
    { brandId: row.brandId },
  );
  return { state: toState, version: row.version + 1, changed: true };
}

const attemptResultOf = (a: AttemptRow): AttemptResult => ({
  attemptId: a.id,
  outcome: a.outcome,
  ...(a.remotePostId ? { remotePostId: a.remotePostId } : {}),
  ...(a.remoteJobId ? { remoteJobId: a.remoteJobId } : {}),
  ...(a.pendingState ? { pending: PendingState.parse(a.pendingState) } : {}),
  ...(a.errorCode ? { errorCode: a.errorCode } : {}),
  ...(a.errorDetail ? { errorDetail: a.errorDetail } : {}),
});

/** Converts the adapter's classified outcome into the attempt ledger's columns and the workflow's result. */
function fromOutcome(attemptId: string, outcome: PublishOutcome): AttemptResult {
  switch (outcome.outcome) {
    case 'accepted':
      return {
        attemptId,
        outcome: 'accepted',
        remotePostId: outcome.remotePostId,
        remoteUrl: outcome.remoteUrl,
      };
    case 'pending':
      return {
        attemptId,
        outcome: 'pending',
        pending: outcome.pending,
        ...(outcome.remoteJobId ? { remoteJobId: outcome.remoteJobId } : {}),
      };
    case 'rejected':
      return {
        attemptId,
        outcome: 'rejected',
        errorCode: outcome.code,
        errorDetail: truncateForTemporal(outcome.message),
      };
    case 'retryable_error':
      return {
        attemptId,
        outcome: 'retryable_error',
        errorCode: outcome.code,
        errorDetail: truncateForTemporal(outcome.message),
        ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
      };
    case 'unknown':
      return {
        attemptId,
        outcome: 'unknown',
        errorCode: outcome.code,
        errorDetail: truncateForTemporal(outcome.message),
      };
  }
}

export function createPublishingRuntime(opts: PublishingRuntimeOptions = {}): PublishingRuntime {
  const now = opts.now ?? (() => new Date());
  const refreshLock = opts.refreshLock ?? new MemoryRateLimiterStore();
  const maxPreSend = opts.maxPreSendAttempts ?? MAX_PRE_SEND_ATTEMPTS;
  const log = logger().child('publishing');

  const recordAttemptOutcome = (attemptId: string, result: AttemptResult, tx: Tx) =>
    attemptsRepo.recordOutcome(
      attemptId,
      {
        outcome: result.outcome,
        errorCode: result.errorCode ?? null,
        errorDetail: result.errorDetail ? result.errorDetail.slice(0, 2000) : null,
        remoteJobId: result.remoteJobId ?? null,
        remotePostId: result.remotePostId ?? null,
        pendingState: (result.pending as Record<string, unknown> | undefined) ?? null,
      },
      now(),
      tx,
    );

  const control: PublishControlRuntimeV1 = {
    async readSchedule({ publicationId }: PublicationWorkflowInputV1): Promise<ReadScheduleResultV1> {
      const row = await publicationsRepo.getById(publicationId);
      return { state: row.state, scheduledFor: row.scheduledFor.toISOString(), version: row.version };
    },

    cancelIfNotStarted: ({ publicationId }) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state !== 'scheduled') return unchanged(row);
        return move(
          row,
          'user_cancel',
          { stateReason: 'user_cancel' },
          'publication.cancel',
          'cancel_signal',
          tx,
        );
      }),

    /** scheduled → dispatching with a fencing token; the same claimant asking again gets the same claim back. */
    claimForDispatch: ({ publicationId, claimant }: ClaimInputV1): Promise<ClaimResultV1> =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        const target = await targetOf(row, tx);
        if (row.state === 'dispatching' && row.claimant === claimant)
          return {
            ok: true,
            fencingToken: row.fencingToken,
            providerKey: target.providerKey,
            channelConnectionId: targetIdOf(row),
          };
        if (row.state !== 'scheduled') return { ok: false, state: row.state };
        const fencingToken = row.fencingToken + 1;
        const at = now();
        await move(
          row,
          'claim',
          { fencingToken, claimant, claimedAt: at, stateReason: null },
          'publication.claim',
          claimant,
          tx,
        );
        record(METRIC.dispatchLatenessMs, Math.max(0, at.getTime() - row.scheduledFor.getTime()), {
          providerKey: target.providerKey,
        });
        return {
          ok: true,
          fencingToken,
          providerKey: target.providerKey,
          channelConnectionId: targetIdOf(row),
        };
      }),

    /** Spec 13.4 at dispatch, from the live rows; the decision is recorded as an audit event either way. */
    evaluateRelease: ({ publicationId, fencingToken }: FencedInputV1): Promise<ReleaseEvaluationResultV1> =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.getById(publicationId, tx);
        assertFence(row, fencingToken);
        const at = now();
        const decision = await review.evaluateRelease(forRelease(row), at, tx);
        await audit.record(
          workflowActor(),
          'publication.release_check',
          { type: 'publication', id: row.id },
          decision.allow ? 'allowed' : 'denied',
          tx,
          {
            brandId: row.brandId,
            publicationId: row.id,
            reason: decision.allow ? 'allow' : decision.reasons.join(','),
          },
        );
        return decision.allow ? { allow: true } : { allow: false, reasons: decision.reasons };
      }),

    hold: ({ publicationId, reasons }: HoldInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'held') return unchanged(row);
        count(METRIC.publicationOutcomes, 1, { outcome: 'held' });
        return move(
          row,
          'release_policy_failed',
          { holdReasons: reasons, stateReason: 'release_policy_failed' },
          'publication.hold',
          reasons.join(','),
          tx,
        );
      }),

    /** The claim is released (dispatching → scheduled: nothing was sent) and the row cancelled, both by the machine. */
    releaseClaimAndCancel: ({ publicationId, fencingToken }: FencedInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'cancelled') return unchanged(row);
        assertFence(row, fencingToken);
        if (await attemptsRepo.findByFence(row.id, fencingToken, tx))
          throw new ValidationFailedError([{ path: 'publicationId', issue: 'attempt_already_open' }]);
        await move(
          row,
          'retryable_pre_send',
          { claimedAt: null, claimant: workflowIdOf(row) },
          'publication.release_claim',
          'cancel_signal',
          tx,
        );
        const released = await publicationsRepo.lock(publicationId, tx);
        return move(
          released,
          'user_cancel',
          { stateReason: 'user_cancel' },
          'publication.cancel',
          'cancel_signal',
          tx,
        );
      }),

    /** The attempt row commits BEFORE any outbound call; a repeat for the same fence returns the same id. */
    openAttempt: ({ publicationId, fencingToken }: FencedInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        assertFence(row, fencingToken);
        const existing = await attemptsRepo.findByFence(row.id, fencingToken, tx);
        if (existing) return existing.id;
        if (row.state !== 'dispatching')
          throw new ValidationFailedError([
            { path: 'publicationId', issue: `open_attempt_in_state:${row.state}` },
          ]);
        const variant = await variants.get(row.channelVariantId, tx);
        const target = await targetOf(row, tx);
        const cap = target.connection ? registry().capability(target.providerKey) : undefined;
        const id = newId('publicationAttempt');
        await attemptsRepo.create(
          {
            id,
            publicationId: row.id,
            attemptNumber: (await attemptsRepo.countForPublication(row.id, tx)) + 1,
            fencingToken,
            requestFingerprint: hashCanonical({
              text: hashText(variant.text),
              altTexts: variant.altTexts,
              settings: variant.settings,
              exportHashes: variant.exportHashes,
            }),
            providerIdempotencyKey: cap?.idempotencyKeySupported ? id : null,
            startedAt: now(),
            outcome: 'unknown', // open: no outcome recorded until finishedAt is set
          },
          tx,
        );
        return id;
      }),

    markProcessing: ({ publicationId, attempt }: AttemptInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'processing') return unchanged(row);
        return move(
          row,
          'provider_pending',
          { stateReason: 'provider_pending' },
          'publication.processing',
          attempt.remoteJobId ?? null,
          tx,
        );
      }),

    /** dispatching/processing/outcome_unknown → published with an evidence row; a repeat changes nothing. */
    markPublished: ({ publicationId, attempt, evidence }: MarkPublishedInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'published') return unchanged(row);
        const remotePostId = evidence?.remotePostId ?? attempt?.remotePostId ?? null;
        const remoteUrl = evidence?.remoteUrl ?? attempt?.remoteUrl ?? null;
        if (!remotePostId)
          throw new ValidationFailedError([{ path: 'attempt', issue: 'remote_post_id_required' }]);
        const attemptId = evidence ? evidence.attemptId : (attempt?.attemptId ?? null);
        const event: PublicationEvent =
          row.state === 'dispatching'
            ? 'provider_accepted'
            : row.state === 'processing'
              ? 'poll_published'
              : 'reconcile_found';
        const kind = evidence
          ? 'reconciliation'
          : row.state === 'processing'
            ? 'status_poll'
            : 'accepted_response';
        const result = await move(
          row,
          event,
          { remotePostId, remoteUrl, stateReason: kind },
          'publication.published',
          kind,
          tx,
        );
        if (!(await evidenceRepo.exists(row.id, attemptId, kind, tx))) {
          const payload = {
            remotePostId,
            remoteUrl,
            attemptId,
            ...(evidence ? { matchedBy: evidence.matchedBy } : {}),
          };
          await evidenceRepo.create(
            {
              id: newId('remoteEvidence'),
              publicationId: row.id,
              attemptId,
              kind,
              remotePostId,
              remoteUrl,
              payload,
              payloadHash: hashCanonical(payload),
              capturedAt: now(),
            },
            tx,
          );
        }
        if (attemptId) await attemptsRepo.attachRemotePost(attemptId, remotePostId, tx);
        // Spec 13.1: the release approval is spent with the publication, in the same transaction.
        if (row.authority === 'approval' && row.approvalId)
          await approvals.consume(
            row.approvalId,
            row.id,
            Array.from(
              new Set([
                ...(await publicationsRepo.listPublishedChannelsForApproval(row.approvalId, tx)),
                targetIdOf(row),
              ]),
            ),
            tx,
          );
        // Spec 15.1: measurement collection starts from the publication moment (worker-ingest, its own queue).
        // A destination publication (R2-3) is measured through the brand's web sources, not per post.
        const actor = workflowActor();
        if (row.channelConnectionId)
          await outbox.add(
            'measurement.collection_due',
            { type: 'publication', id: row.id, version: row.version + 1 },
            {
              publicationId: row.id,
              channelConnectionId: row.channelConnectionId,
              actorKind: actor.kind,
              actorId: actor.id,
            },
            tx,
            { brandId: row.brandId },
          );
        // RA-04: a live article's page is checked again after the first delay (the workflow owns the later ones);
        // a draft is not public, so there is nothing to re-validate.
        if (row.destinationId && row.remoteStatus === 'live') await queueRenderedValidation(row, tx);
        count(METRIC.publicationOutcomes, 1, { outcome: 'published' });
        return result;
      }),

    markFailed: ({ publicationId, attempt }: AttemptInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'failed') return unchanged(row);
        // publishOnce already held the row (export_hash_mismatch): a person resolves it; nothing to fail.
        if (row.state === 'held') return unchanged(row);
        const event: PublicationEvent = row.state === 'processing' ? 'poll_failed' : 'provider_rejected';
        count(METRIC.publicationOutcomes, 1, { outcome: 'failed' });
        return move(
          row,
          event,
          { stateReason: (attempt.errorCode ?? 'rejected').slice(0, 120) },
          'publication.failed',
          attempt.errorCode ?? null,
          tx,
        );
      }),

    markOutcomeUnknown: ({ publicationId, attemptId }: OutcomeUnknownInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (attemptId) {
          const attempt = await loadAttempt(row, attemptId, tx);
          if (!attempt.finishedAt)
            await recordAttemptOutcome(
              attempt.id,
              { attemptId, outcome: 'unknown', errorCode: 'ambiguous' },
              tx,
            );
        }
        if (row.state === 'outcome_unknown') return unchanged(row);
        const event: PublicationEvent = row.state === 'processing' ? 'poll_unknown' : 'ambiguous_failure';
        count(METRIC.outcomeUnknownCount, 1);
        count(METRIC.publicationOutcomes, 1, { outcome: 'outcome_unknown' });
        return move(
          row,
          event,
          { stateReason: 'outcome_unknown' },
          'publication.outcome_unknown',
          attemptId,
          tx,
        );
      }),

    markRetryEligible: ({ publicationId }) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'retry_eligible') return unchanged(row);
        count(METRIC.publicationOutcomes, 1, { outcome: 'retry_eligible' });
        return move(
          row,
          'reconcile_absent',
          { stateReason: 'reconcile_absent' },
          'publication.retry_eligible',
          'definitely_absent',
          tx,
        );
      }),

    holdForHuman: ({ publicationId, reason }: HoldForHumanInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'held') return unchanged(row);
        count(METRIC.publicationOutcomes, 1, { outcome: 'held' });
        return move(
          row,
          'reconcile_exhausted',
          { holdReasons: [reason], stateReason: reason.slice(0, 120) },
          'publication.hold',
          reason,
          tx,
        );
      }),

    /** Only an attempt with NO sentAt proves the call was never made (spec 14.3); with sentAt the outcome is unknown. */
    retryAfterProvenNoEffect: ({ publicationId, attempt }: AttemptInputV1): Promise<RetryResultV1> =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        const attemptRow = await loadAttempt(row, attempt.attemptId, tx);
        if (attemptRow.sentAt) return { retried: false, reason: 'sent' };
        if (row.state === 'scheduled' && row.fencingToken === attemptRow.fencingToken)
          return { retried: true, scheduledFor: row.scheduledFor.toISOString() }; // repeat of a committed retry
        if (row.state !== 'dispatching') return { retried: false, reason: 'state' };
        if (attemptRow.attemptNumber >= maxPreSend) {
          await move(
            row,
            'release_policy_failed',
            { holdReasons: ['retry_budget_exhausted'], stateReason: 'retry_budget_exhausted' },
            'publication.hold',
            'retry_budget_exhausted',
            tx,
          );
          return { retried: false, reason: 'state' };
        }
        const scheduledFor = new Date(
          now().getTime() + preSendBackoffMs(attemptRow.attemptNumber, attempt.retryAfterMs),
        );
        await move(
          row,
          'retryable_pre_send',
          { scheduledFor, claimedAt: null, claimant: workflowIdOf(row), stateReason: 'retry_pre_send' },
          'publication.retry',
          attempt.errorCode ?? null,
          tx,
        );
        return { retried: true, scheduledFor: scheduledFor.toISOString() };
      }),
  };

  /**
   * A publication's target (R2-3): the channel connection with its provider adapter, or the brand destination
   * (described through the hook; its writes run behind the same hook, so no adapter is resolved here).
   */
  async function targetOf(row: PublicationRow, tx?: Tx) {
    if (row.destinationId) {
      const destination = await destinations.describe(row.destinationId, tx);
      if (!destination) throw new NotFoundError('Destination', row.destinationId);
      return { connection: null, destination, providerKey: destination.kind };
    }
    const connection = await connectionsRepo.getById(row.channelConnectionId ?? '', tx);
    return { connection, destination: null, providerKey: connection.providerKey };
  }

  /** Loads what one provider call needs, with the fence checked against the live row. */
  async function loadForProvider(input: {
    publicationId: string;
    attemptId: string | null;
    fencingToken?: number;
  }) {
    const row = await publicationsRepo.getById(input.publicationId);
    if (input.fencingToken !== undefined) assertFence(row, input.fencingToken);
    const attempt = input.attemptId ? await loadAttempt(row, input.attemptId) : null;
    if (attempt && input.fencingToken !== undefined && attempt.fencingToken !== input.fencingToken)
      throw new ValidationFailedError([{ path: 'attemptId', issue: 'attempt_fence_mismatch' }]);
    const target = await targetOf(row);
    const variant = await variants.get(row.channelVariantId);
    return { row, attempt, variant, ...target };
  }

  /** A channel call on a destination publication (R2-3): the destination has no channel adapter. */
  function channelOf<T extends { connection: ConnectionRow | null }>(loaded: T) {
    if (!loaded.connection)
      throw new ValidationFailedError([{ path: 'publicationId', issue: 'not_a_channel_publication' }]);
    return { connection: loaded.connection, adapter: adapterFor(loaded.connection.providerKey) };
  }

  /** The sentAt fence of an attempt: commits under the row lock only while the row is still dispatching. */
  const preSendFence = (row: PublicationRow, attempt: AttemptRow, hooks?: ActivityHooks) => async () => {
    hooks?.heartbeat(`publish:${attempt.id}:before_send`);
    await withTransaction(async (tx) => {
      const locked = await publicationsRepo.lock(row.id, tx);
      if (locked.state !== 'dispatching')
        throw new ValidationFailedError([{ path: 'publicationId', issue: `send_in_state:${locked.state}` }]);
      assertFence(locked, attempt.fencingToken);
      await attemptsRepo.markSent(attempt.id, now(), tx);
    });
  };

  /**
   * RA-04: the verification a write earned. The read-back must have matched what was sent for the rendered page to
   * count: `verified` needs both, a mismatch on either is `failed`, and a read-back that could not be compared (no
   * read allowed, missing) or a page not checked yet leaves the write `unverified` whatever else was seen.
   */
  const verificationOf = (
    readback: ArticleReadbackVerificationV1 | undefined,
    rendered: RenderedOutcome | null,
  ): PublicationRemoteVerification => {
    if (!readback || readback.outcome === 'unverified') return 'unverified';
    if (readback.outcome === 'mismatch') return 'failed';
    // A matching read-back alone proves the article, not the page: without a page check nothing is verified, and a
    // page that could not be read (PR-04) proves nothing either.
    return rendered ?? 'unverified';
  };

  /** A fresh `remote_readback` evidence row: the remote revision as last read, with what it proved (RA-04). */
  async function recordReadback(
    row: PublicationRow,
    attemptId: string | null,
    readback: ArticleReadbackV1,
    extra: Record<string, unknown>,
    at: Date,
    tx: Tx,
  ) {
    const payload = { ...readback, ...extra };
    await evidenceRepo.create(
      {
        id: newId('remoteEvidence'),
        publicationId: row.id,
        attemptId,
        kind: 'remote_readback',
        remotePostId: readback.remoteId,
        remoteUrl: readback.remoteUrl,
        payload,
        payloadHash: hashCanonical(payload),
        capturedAt: at,
      },
      tx,
    );
  }

  /**
   * Insert-only evidence of what a destination write read back, what the read-back proved and what its rendered
   * page showed (R2-3, RA-04), then the publication's remote status and verification from them (RA-02): the
   * status the read-back reports (`live` only for `publish`), never the publish mode asked for.
   */
  async function recordArticleEvidence(
    row: PublicationRow,
    attemptId: string,
    result: Pick<DestinationPublishResult, 'readback' | 'readbackVerification' | 'validation'>,
    tx: Tx,
  ) {
    const at = now();
    if (result.readback) {
      await recordReadback(
        row,
        attemptId,
        result.readback,
        { attemptId, ...(result.readbackVerification ? { verification: result.readbackVerification } : {}) },
        at,
        tx,
      );
      const locked = await publicationsRepo.lock(row.id, tx);
      const verification = verificationOf(
        result.readbackVerification,
        result.validation ? renderedOutcomeOf(result.validation) : null,
      );
      await publicationsRepo.update(
        locked.id,
        locked.version,
        {
          remoteStatus: result.readback.status === 'publish' ? 'live' : 'draft',
          remoteVerification: verification,
          remoteVerifiedAt: verification === 'verified' ? at : null,
        },
        tx,
      );
    }
    if (result.validation) {
      const payload = { ...result.validation };
      await evidenceRepo.create(
        {
          id: newId('remoteEvidence'),
          publicationId: row.id,
          attemptId,
          kind: 'rendered_validation',
          remotePostId: result.readback?.remoteId ?? null,
          remoteUrl: result.readback?.remoteUrl ?? null,
          payload,
          payloadHash: hashCanonical(payload),
          capturedAt: at,
        },
        tx,
      );
    }
  }

  /**
   * RA-04: publication.rendered_validation_due with `availableAt` at the first delay, for the row as it will be
   * after the caller's own update (version + 1): renderedValidationWorkflowV1 proves the live page at each delay.
   */
  async function queueRenderedValidation(row: PublicationRow, tx: Tx) {
    const actor = workflowActor();
    const publishedAt = now();
    await outbox.add(
      'publication.rendered_validation_due',
      { type: 'publication', id: row.id, version: row.version + 1 },
      {
        publicationId: row.id,
        publishedAt: publishedAt.toISOString(),
        workflowId: renderedValidationWorkflowId(row.id, row.version + 1),
        actorKind: actor.kind,
        actorId: actor.id,
      },
      tx,
      {
        brandId: row.brandId,
        availableAt: new Date(publishedAt.getTime() + RENDERED_VALIDATION_DELAYS_MS[0]),
      },
    );
  }

  const provider: PublishProviderRuntimeV1 = {
    /**
     * Spec 14.3/14.5: sentAt is committed immediately before the first outbound mutation; a repeat after sentAt never
     * re-sends (it reports unknown). An adapter's retryable_error with no sentAt goes back to scheduled; with sentAt
     * the workflow reconciles.
     */
    async publishOnce(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<AttemptResult> {
      const { tenantId, attemptId } = input;
      const loaded = await loadForProvider(input);
      const { row, attempt, variant } = loaded;
      if (!attempt) throw new NotFoundError('PublicationAttempt', attemptId);
      if (attempt.finishedAt) return attemptResultOf(attempt);
      if (attempt.sentAt) {
        const unknown: AttemptResult = {
          attemptId,
          outcome: 'unknown',
          errorCode: 'resumed_after_send',
          errorDetail: 'attempt already sent; never re-sent',
        };
        await withTransaction((tx) => recordAttemptOutcome(attemptId, unknown, tx));
        return unknown;
      }
      let result: AttemptResult;
      try {
        if (loaded.destination) {
          // R2-3: the destinations module writes the article behind the hook (the same sentAt fence before the
          // first mutation leaves) and reads it back; what it read and what the page showed become evidence.
          const written = await destinations.publish(
            {
              tenantId,
              destinationId: loaded.destination.id,
              publicationId: row.id,
              attemptId,
              idempotencyKey: attempt.providerIdempotencyKey ?? attemptId,
              variant,
            },
            hooks,
            preSendFence(row, attempt, hooks),
          );
          result = fromOutcome(attemptId, written);
          await withTransaction(async (tx) => {
            await recordArticleEvidence(row, attemptId, written, tx);
            await recordAttemptOutcome(attemptId, result, tx);
          });
          return result;
        }
        const { connection, adapter } = channelOf(loaded);
        const media = await publishMedia.forVariant(variant, {
          providerProcessingWindowSec: adapter.capability.media.publicUrlFetch.processingWindowSec,
        });
        const req: PublishRequest = {
          publicationId: row.id,
          attemptId,
          idempotencyKey: attempt.providerIdempotencyKey ?? attemptId,
          remoteAccountId: connection.remoteAccountId,
          text: variant.text,
          media: media.map((m, i) => ({
            ...m,
            ...(variant.altTexts[i] ? { altText: variant.altTexts[i] } : {}),
          })),
          settings: variant.settings,
          textFingerprint: hashText(variant.text),
          mediaFingerprints: variant.exportHashes,
        };
        result = await credentialBroker.withCredentials(tenantId, connection.id, async (creds) => {
          // The ledger commits sentAt immediately before the first mutation leaves (not before reads, media fetches
          // or the rate limiter), so a failure proven before it is retried with backoff (spec 14.3).
          // The pre-send fence: sentAt commits under the row lock only while the row is still dispatching under this
          // attempt's token, so a move that committed first (a restore hold, worker loss declared by the sweeper, a
          // re-release to a newer claim) stops the send; a throw here aborts the request as before_send.
          const io: ProviderIO = providerIO(adapter.key, tenantId, hooks, preSendFence(row, attempt, hooks));
          try {
            return fromOutcome(attemptId, await adapter.publish(req, creds, io));
          } catch (err) {
            if (err instanceof ProviderTransportError) {
              const cls = adapter.classifyError({ phase: err.phase, error: err });
              const classified = fromOutcome(attemptId, outcomeFromClass(cls, err.message));
              return err.phase === 'after_send' && classified.outcome === 'retryable_error'
                ? {
                    attemptId,
                    outcome: 'unknown',
                    errorCode: err.code,
                    errorDetail: truncateForTemporal(err),
                  }
                : classified;
            }
            return {
              attemptId,
              outcome: 'unknown',
              errorCode: 'adapter_error',
              errorDetail: truncateForTemporal(err),
            };
          }
        });
      } catch (err) {
        // Before any mutation (media, credentials, rate limiter): proven no effect, retryable with backoff.
        if (
          err instanceof ProviderRateLimitWaitExceeded ||
          (err instanceof ProviderTransportError && err.phase === 'before_send')
        )
          result = {
            attemptId,
            outcome: 'retryable_error',
            errorCode: 'pre_send',
            errorDetail: truncateForTemporal(err),
            retryAfterMs: 5_000,
          };
        else if (err instanceof PolicyDeniedError)
          result = {
            attemptId,
            outcome: 'rejected',
            errorCode: err.reason,
            errorDetail: truncateForTemporal(err),
          };
        else if (err instanceof ReleaseIntegrityError) {
          // Spec 3.g4: the export bytes no longer hash to what the approval pinned. Nothing was sent; the
          // publication is held for a person (never retried) and the attempt is closed as rejected.
          result = {
            attemptId,
            outcome: 'rejected',
            errorCode: EXPORT_HASH_MISMATCH,
            errorDetail: truncateForTemporal(err),
          };
          await withTransaction(async (tx) => {
            const locked = await publicationsRepo.lock(row.id, tx);
            if (locked.state !== 'dispatching') return;
            await move(
              locked,
              'release_policy_failed',
              { holdReasons: [EXPORT_HASH_MISMATCH], stateReason: EXPORT_HASH_MISMATCH },
              'publication.hold',
              EXPORT_HASH_MISMATCH,
              tx,
            );
          });
        } else throw err;
      }
      await withTransaction((tx) => recordAttemptOutcome(attemptId, result, tx));
      return result;
    },

    async checkStatus(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck> {
      const loaded = await loadForProvider(input);
      const { attempt } = loaded;
      if (loaded.destination)
        return {
          status: 'failed',
          code: 'not_supported',
          message: 'a destination write has no status check',
        };
      const { connection, adapter } = channelOf(loaded);
      if (!attempt?.pendingState)
        return { status: 'failed', code: 'no_pending_state', message: 'nothing to poll' };
      const checkStatus = adapter.checkStatus?.bind(adapter);
      if (!checkStatus)
        return { status: 'failed', code: 'not_supported', message: 'provider has no status check' };
      const check = await credentialBroker.withCredentials(input.tenantId, connection.id, (creds) =>
        checkStatus(
          PendingState.parse(attempt.pendingState),
          creds,
          providerIO(adapter.key, input.tenantId, hooks),
        ),
      );
      if (check.status === 'completed')
        await withTransaction((tx) => attemptsRepo.attachRemotePost(attempt.id, check.remotePostId, tx));
      return check;
    },

    async finalize(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck> {
      const loaded = await loadForProvider(input);
      const { attempt } = loaded;
      if (loaded.destination)
        return { status: 'failed', code: 'not_supported', message: 'a destination write has no finalize' };
      const { connection, adapter } = channelOf(loaded);
      if (!attempt?.pendingState)
        return { status: 'failed', code: 'no_pending_state', message: 'nothing to finalise' };
      const finalize = adapter.finalize?.bind(adapter);
      if (!finalize) return { status: 'failed', code: 'not_supported', message: 'provider has no finalize' };
      const check = await credentialBroker.withCredentials(input.tenantId, connection.id, (creds) =>
        finalize(
          PendingState.parse(attempt.pendingState),
          creds,
          providerIO(adapter.key, input.tenantId, hooks),
        ),
      );
      if (check.status === 'completed')
        await withTransaction((tx) => attemptsRepo.attachRemotePost(attempt.id, check.remotePostId, tx));
      return check;
    },

    /** Read-only reconciliation (spec 14.3): by id or by fingerprint scan, from the attempt's start time. */
    async findRemotePost(input: FindRemotePostInputV1, hooks?: ActivityHooks): Promise<ReconcileResult> {
      const loaded = await loadForProvider(input);
      const { row, attempt, variant } = loaded;
      // R2-3: a website has no post scan by fingerprint; an ambiguous write is settled by a person (held).
      if (loaded.destination)
        return { status: 'cannot_determine', reason: 'destination_lookup_not_supported' };
      const { connection, adapter } = channelOf(loaded);
      return credentialBroker.withCredentials(input.tenantId, connection.id, (creds) =>
        adapter.findRemotePost(
          {
            publicationId: row.id,
            attemptStartedAt: attempt?.startedAt ?? row.claimedAt ?? row.createdAt,
            textFingerprint: hashText(variant.text),
            mediaFingerprints: variant.exportHashes,
            remoteAccountId: connection.remoteAccountId,
          },
          creds,
          providerIO(adapter.key, input.tenantId, hooks),
        ),
      );
    },
  };

  const tokenRefresh: TokenRefreshRuntimeV1 = {
    async readRefreshSchedule({ channelConnectionId }: TokenRefreshWorkflowInputV1) {
      const row = await connectionsRepo.getById(channelConnectionId);
      return {
        status: row.status,
        tokenExpiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
      };
    },

    /** Spec 14.7 refresh: under a per-connection lock, a new credential row version; failure flags the connection. */
    async refreshCredentials({
      tenantId,
      channelConnectionId,
    }: TokenRefreshWorkflowInputV1): Promise<RefreshCredentialsResultV1> {
      const lock = await refreshLock.hit(
        `lock:token-refresh:${tenantId}:${channelConnectionId}`,
        REFRESH_LOCK_SECONDS,
      );
      if (lock.count > 1) return { ok: false, reason: 'locked' };
      const row = await connectionsRepo.getById(channelConnectionId);
      if (row.status !== 'active' && row.status !== 'refresh_needed')
        return { ok: false, reason: 'not_active' };
      const adapter = adapterFor(row.providerKey);
      let refreshed: Awaited<ReturnType<typeof adapter.refresh>>;
      try {
        refreshed = await credentialBroker.withCredentials(tenantId, row.id, (creds) =>
          adapter.refresh(creds, providerClientFor(adapter.key), providerIO(adapter.key, tenantId)),
        );
      } catch (err) {
        refreshed =
          err instanceof PolicyDeniedError && err.reason === 'credential_destroyed'
            ? { ok: false, reason: 'reconnect_required' }
            : { ok: false, reason: 'transient' };
        // Name and code only (as provider-io logs): a token endpoint error message can carry a URL with secrets.
        if (refreshed.reason === 'transient')
          log.warn(
            {
              channelConnectionId,
              errorName: (err as Error)?.name,
              errorCode: (err as { code?: string })?.code,
            },
            'token refresh failed',
          );
      }
      return withTransaction(async (tx) => {
        const locked = await connectionsRepo.lock(row.id, tx);
        if (refreshed.ok) {
          const sealed = await credentialBroker.seal(tenantId, locked.id, refreshed.credentials);
          const credentialRefId = newId('credentialRef');
          await credentialsRepo.create({ id: credentialRefId, ...sealed }, tx);
          const tokenExpiresAt = refreshed.tokenExpiresAt ? new Date(refreshed.tokenExpiresAt) : null;
          await connectionsRepo.update(
            locked.id,
            locked.version,
            { credentialRefId, tokenExpiresAt, status: 'active', health: 'ok', healthCheckedAt: now() },
            tx,
          );
          const old = await credentialsRepo.getById(locked.credentialRefId, tx);
          if (!old.destroyedAt) await credentialsRepo.destroy(old.id, old.version, 'rotated', tx);
          await audit.record(
            workflowActor(),
            'channel.token_refresh',
            { type: 'channel_connection', id: locked.id },
            'allowed',
            tx,
            {
              brandId: locked.brandId,
              channelConnectionId: locked.id,
              fromState: locked.status,
              toState: 'active',
            },
          );
          return { ok: true, tokenExpiresAt: tokenExpiresAt ? tokenExpiresAt.toISOString() : null };
        }
        const status = refreshed.reason === 'reconnect_required' ? 'reconnect_needed' : 'refresh_needed';
        // RA-01: a grant the platform refused for good is revoked; a refresh that did not go through leaves a
        // token about to expire (the workflow retries, then the row stays refresh_needed).
        const health: ChannelHealth =
          refreshed.reason === 'reconnect_required' ? 'revoked' : 'token_expiring';
        await connectionsRepo.update(
          locked.id,
          locked.version,
          { ...(locked.status !== status ? { status } : {}), health, healthCheckedAt: now() },
          tx,
        );
        count(METRIC.tokenRefreshFailures, 1, { providerKey: locked.providerKey, reason: refreshed.reason });
        if (status === 'reconnect_needed')
          count(METRIC.reconnectNeeded, 1, { providerKey: locked.providerKey });
        await audit.record(
          workflowActor(),
          'channel.token_refresh',
          { type: 'channel_connection', id: locked.id },
          'denied',
          tx,
          {
            brandId: locked.brandId,
            channelConnectionId: locked.id,
            fromState: locked.status,
            toState: status,
            reason: refreshed.reason,
          },
        );
        await outbox.add(
          'channel.reconnect_needed',
          { type: 'channel_connection', id: locked.id, version: locked.version + 1 },
          {
            channelConnectionId: locked.id,
            providerKey: locked.providerKey,
            status,
            reason: refreshed.reason,
          },
          tx,
          { brandId: locked.brandId },
        ); // notifies the brand's publishers
        return { ok: false, reason: refreshed.reason };
      });
    },
  };

  const channelRevoke: ChannelRevokeRuntimeV1 = {
    /**
     * RA-01: opens the disconnected connection's credential here (the API never can), asks the adapter (looked up
     * whether or not the provider is still certified) to revoke the grant at the platform, records the outcome in
     * the audit trail and destroys the credential row whatever the platform answered: a failed remote revoke
     * never keeps a token. Idempotent: a credential already destroyed (a repeat, a reconnect meanwhile, a
     * disconnect without remote revoke) is `already_destroyed`.
     */
    async revokeChannelAccess({
      tenantId,
      channelConnectionId,
    }: ChannelRevokeInputV1): Promise<ChannelRevokeResultV1> {
      const row = await connectionsRepo.getById(channelConnectionId);
      const credential = await credentialsRepo.getById(row.credentialRefId);
      if (credential.destroyedAt || row.status !== 'disabled') return { outcome: 'already_destroyed' };
      const adapter = registry().lookup(row.providerKey);
      const revokeAccess = adapter?.revokeAccess?.bind(adapter);
      let result: RevokeResult;
      if (!adapter || !revokeAccess) result = { outcome: 'not_supported' };
      else {
        try {
          // The one opener that may read a disconnected channel's credential, by saying so (broker.ts).
          result = await credentialBroker.withCredentials(
            tenantId,
            row.id,
            (creds) => revokeAccess(creds, providerClientFor(adapter.key), providerIO(adapter.key, tenantId)),
            undefined,
            { purpose: 'revoke' },
          );
        } catch (err) {
          if (err instanceof PolicyDeniedError && err.reason === 'credential_destroyed')
            return { outcome: 'already_destroyed' };
          // Name and code only (as provider-io logs): a token endpoint error message can carry a URL with secrets.
          result = {
            outcome: 'failed',
            reason: (err as { code?: string })?.code ?? (err as Error)?.name ?? 'error',
          };
          log.warn(
            {
              channelConnectionId,
              errorName: (err as Error)?.name,
              errorCode: (err as { code?: string })?.code,
            },
            'remote revoke failed; the credential is destroyed locally',
          );
        }
      }
      return withTransaction(async (tx) => {
        const locked = await connectionsRepo.lock(row.id, tx);
        // Re-checked under the lock: a reconnect since the read above gave the row a new credential that must
        // survive, whatever the platform answered about the old grant.
        if (locked.status !== 'disabled') return { outcome: 'already_destroyed' };
        const current = await credentialsRepo.getById(locked.credentialRefId, tx);
        if (!current.destroyedAt)
          await credentialsRepo.destroy(current.id, current.version, 'disconnected', tx);
        if (result.outcome === 'revoked' && locked.status === 'disabled')
          await connectionsRepo.update(
            locked.id,
            locked.version,
            { health: 'revoked', healthCheckedAt: now() },
            tx,
          );
        await audit.record(
          workflowActor(),
          'channel.remote_revoke',
          { type: 'channel_connection', id: locked.id },
          result.outcome === 'failed' ? 'denied' : 'allowed',
          tx,
          {
            brandId: locked.brandId,
            channelConnectionId: locked.id,
            remoteRevoke: result.outcome,
            reason: result.outcome === 'failed' ? auditRevokeReason(result.reason) : null,
          },
        );
        return result;
      });
    },
  };

  const sweep: PublicationSweepRuntimeV1 = {
    /**
     * Always-on safety net: a `scheduled` row past due with no running workflow gets its start re-emitted; a
     * `dispatching` claim older than the lease with no running workflow is worker loss → outcome_unknown, and a
     * reconcile workflow is requested. Finding anything is logged and counted (it means something else broke).
     */
    async sweepPublications(input: PublicationSweepInputV1): Promise<SweepResultV1> {
      const at = new Date(input.now);
      const stuck = await runAsPlatform('publication-sweeper', input.correlationId, () =>
        sweepRepo.findStuck(at, input.graceSeconds, input.claimLeaseSeconds),
      );
      const summary: SweepResultV1 = { scheduledReemitted: 0, dispatchingExpired: 0, credentialsShredded: 0 };
      // RA-01: the floor under the remote revoke. A credential a disconnect left to channelRevokeWorkflowV1 that
      // is still intact an hour later (the worker was down, the event dead-lettered) is shredded here, audited.
      const unshredded = await runAsPlatform('publication-sweeper', input.correlationId, () =>
        sweepRepo.findDisabledWithLiveCredential(new Date(at.getTime() - DISCONNECT_SHRED_FLOOR_MS)),
      );
      for (const ref of unshredded)
        await runInTenant(
          {
            tenantId: ref.tenantId,
            actor: { kind: 'service_principal', id: 'publication-sweeper' },
            brandIds: 'all',
            correlationId: input.correlationId,
          },
          () =>
            withTransaction(async (tx) => {
              const locked = await connectionsRepo.lock(ref.channelConnectionId, tx);
              const credential = await credentialsRepo.getById(locked.credentialRefId, tx);
              if (locked.status !== 'disabled' || credential.destroyedAt) return;
              await credentialsRepo.destroy(credential.id, credential.version, 'disconnected', tx);
              await audit.record(
                workflowActor(),
                'channel.credential_shredded',
                { type: 'channel_connection', id: locked.id },
                'allowed',
                tx,
                { brandId: locked.brandId, channelConnectionId: locked.id, reason: 'disconnect_shred_floor' },
              );
              summary.credentialsShredded = (summary.credentialsShredded ?? 0) + 1;
              log.warn(
                { tenantId: locked.tenantId, channelConnectionId: locked.id },
                'sweeper shredded the credential of a disconnected channel the remote revoke left behind',
              );
            }),
        );
      // The destinations module's floor for its disconnected destinations, on the same clock and bound.
      summary.credentialsShredded =
        (summary.credentialsShredded ?? 0) +
        (await sweepDisconnectedCredentials(
          new Date(at.getTime() - DISCONNECT_SHRED_FLOOR_MS),
          input.correlationId,
        ));
      for (const ref of stuck) {
        const workflowId = workflowIdOf({ id: ref.publicationId, claimant: ref.claimant });
        if (await workflowRunning(workflowId)) continue;
        await runInTenant(
          {
            tenantId: ref.tenantId,
            actor: { kind: 'service_principal', id: 'publication-sweeper' },
            brandIds: 'all',
            correlationId: input.correlationId,
          },
          () =>
            withTransaction(async (tx) => {
              const row = await publicationsRepo.lock(ref.publicationId, tx);
              if (row.state === 'scheduled') {
                await outbox.add(
                  'publication.scheduled',
                  { type: 'publication', id: row.id, version: row.version },
                  {
                    publicationId: row.id,
                    scheduledFor: row.scheduledFor.toISOString(),
                    workflowId,
                    rerelease: false,
                    actorKind: row.scheduledByKind,
                    actorId: row.scheduledById,
                    sweeper: true,
                  },
                  tx,
                  { brandId: row.brandId },
                );
                summary.scheduledReemitted += 1;
                log.warn(
                  { tenantId: row.tenantId, publicationId: row.id },
                  'sweeper re-emitted a past-due publication start',
                );
              } else if (row.state === 'dispatching') {
                const attempt = await attemptsRepo.findByFence(row.id, row.fencingToken, tx);
                const target = await targetOf(row, tx);
                if (attempt && !attempt.finishedAt)
                  await recordAttemptOutcome(
                    attempt.id,
                    { attemptId: attempt.id, outcome: 'unknown', errorCode: 'worker_lost' },
                    tx,
                  );
                await move(
                  row,
                  'ambiguous_failure',
                  { stateReason: 'claim_lease_expired' },
                  'publication.outcome_unknown',
                  'claim_lease_expired',
                  tx,
                );
                count(METRIC.outcomeUnknownCount, 1);
                await outbox.add(
                  'publication.reconcile_requested',
                  { type: 'publication', id: row.id, version: row.version + 1 },
                  {
                    publicationId: row.id,
                    attemptId: attempt?.id ?? null,
                    providerKey: target.providerKey,
                    workflowId: reconcileWorkflowId(row.id, row.version + 1),
                    actorKind: row.scheduledByKind,
                    actorId: row.scheduledById,
                  },
                  tx,
                  { brandId: row.brandId },
                );
                summary.dispatchingExpired += 1;
                log.warn(
                  { tenantId: row.tenantId, publicationId: row.id },
                  'sweeper found an expired dispatch claim (worker loss)',
                );
              }
            }),
        );
      }
      return summary;
    },
  };

  /** Loads a remote change with its publication; a change of another publication is NOT_FOUND. */
  async function loadRemoteChange(
    input: Pick<PublicationRemoteChangeInputV1, 'publicationId' | 'changeId'>,
    tx?: Tx,
  ) {
    const row = await publicationsRepo.getById(input.publicationId, tx);
    const change = await changesRepo.getById(input.changeId, tx);
    if (change.publicationId !== row.id) throw new NotFoundError('PublicationRemoteChange', input.changeId);
    return { row, change };
  }

  /**
   * R2-3: a change of a live article through the destinations hook. An edit reads the remote first and compares
   * it with the hash the product last read back; a remote that moved since is a `conflict` outcome, nothing is
   * overwritten and the refusal is audited. What a successful write reads back is evidence (recorded with the
   * outcome, recordRemoteChangeOutcome).
   */
  async function applyDestinationChange(
    input: PublicationRemoteChangeInputV1,
    row: PublicationRow,
    change: Awaited<ReturnType<typeof changesRepo.getById>>,
    kind: 'edit' | 'delete' | 'unpublish',
    remoteId: string,
    hooks: ActivityHooks | undefined,
  ): Promise<RemoteChangeAttemptResultV1> {
    const destinationId = row.destinationId as string;
    const target = { tenantId: input.tenantId, destinationId, remoteId };
    try {
      hooks?.heartbeat(`remote-${kind}:${change.id}:send`);
      if (kind === 'delete') return await destinations.delete(target, hooks);
      if (kind === 'unpublish') return await destinations.unpublish(target, hooks);
      const readback = await evidenceRepo.latestOfKind(row.id, 'remote_readback');
      const expectedHash =
        typeof readback?.payload['contentHash'] === 'string' ? readback.payload['contentHash'] : null;
      // RA-12: the modified instant travels with the hash, so a remote touched to the same content is a conflict too.
      const expectedModifiedAt =
        typeof readback?.payload['modifiedAt'] === 'string' ? readback.payload['modifiedAt'] : null;
      // PR-03: the site's own precondition, compared and written atomically by the site where it offers one.
      const expectedWriteToken =
        typeof readback?.payload['writeToken'] === 'string' ? readback.payload['writeToken'] : null;
      const result = await destinations.edit(
        {
          ...target,
          expectedHash,
          expectedModifiedAt,
          expectedWriteToken,
          html: change.text ?? '',
          idempotencyKey: change.id,
        },
        hooks,
      );
      if (result.outcome === 'rejected' && (result.code === 'conflict' || result.code === 'limited_mode'))
        await withTransaction((tx) =>
          audit.record(
            workflowActor(),
            'publication.edit_remote_conflict',
            { type: 'publication', id: row.id },
            'denied',
            tx,
            {
              brandId: row.brandId,
              publicationId: row.id,
              destinationId,
              reason: result.code === 'conflict' ? 'remote_changed_since_readback' : 'limited_mode',
            },
          ),
        );
      return result;
    } catch (err) {
      if (err instanceof ProviderRateLimitWaitExceeded || err instanceof ProviderTransportError)
        return { outcome: 'retryable_error', code: 'pre_send', message: truncateForTemporal(err, 300) };
      if (err instanceof PolicyDeniedError)
        return { outcome: 'rejected', code: err.reason, message: truncateForTemporal(err, 300) };
      throw err;
    }
  }

  /**
   * One platform call for a requested change. Nothing is sent once the change was recorded (a repeat after the
   * outcome, or a superseded workflow); a publication that is no longer published is refused without a call.
   */
  async function applyRemoteChange(
    input: PublicationRemoteChangeInputV1,
    activity: 'edit' | 'delete',
    actor: ResolvedActor,
    hooks: ActivityHooks | undefined,
  ): Promise<RemoteChangeAttemptResultV1> {
    const { row, change } = await loadRemoteChange(input);
    // An unpublish (R2-3) runs under the delete activity: the same converging, once-per-attempt call shape.
    const kind = change.kind;
    if ((activity === 'edit') !== (kind === 'edit'))
      throw new ValidationFailedError([{ path: 'changeId', issue: `remote_change_kind:${change.kind}` }]);
    if (change.state !== 'requested') return { outcome: 'skipped', reason: `change_${change.state}` };
    if (row.state !== 'published' || !row.remotePostId)
      return {
        outcome: 'rejected',
        code: `not_published:${row.state}`,
        message: 'the publication is no longer published',
      };
    // Spec 5.2: the requester must still hold the permission now, not only when they asked.
    const decision = await policy.decide(
      actor,
      kind === 'edit' ? 'publication.edit_remote' : 'publication.delete_remote',
      publicationResource(row),
    );
    if (!decision.allowed)
      return {
        outcome: 'rejected',
        code: `policy_denied:${decision.reason}`.slice(0, 80),
        message: 'the requester no longer holds the permission for this change',
      };
    const remotePostId = row.remotePostId;
    if (row.destinationId) return applyDestinationChange(input, row, change, kind, remotePostId, hooks);
    if (kind === 'unpublish')
      return {
        outcome: 'rejected',
        code: 'unpublish_not_supported',
        message: 'the channel cannot revert posts',
      };
    const connection = await connectionsRepo.getById(row.channelConnectionId ?? '');
    const adapter = adapterFor(connection.providerKey);
    const deletePost = adapter.deletePost?.bind(adapter);
    const editPost = adapter.editPost?.bind(adapter);
    const call:
      ((creds: DecryptedCredentials, io: ProviderIO) => Promise<RemoteMutationOutcome>) | undefined =
      kind === 'delete'
        ? deletePost && ((creds, io) => deletePost({ remotePostId }, creds, io))
        : editPost &&
          ((creds, io) =>
            editPost({ remotePostId, text: change.text ?? '', idempotencyKey: change.id }, creds, io));
    if (!call)
      return {
        outcome: 'rejected',
        code: `${kind}_not_supported`,
        message: `the channel cannot ${kind} posts`,
      };
    try {
      return await credentialBroker.withCredentials(input.tenantId, connection.id, (creds) => {
        hooks?.heartbeat(`remote-${kind}:${change.id}:send`);
        return call(creds, providerIO(adapter.key, input.tenantId, hooks));
      });
    } catch (err) {
      // Before any send (rate limiter, a destroyed credential): retry later, or refuse what cannot change.
      if (err instanceof ProviderRateLimitWaitExceeded || err instanceof ProviderTransportError)
        return { outcome: 'retryable_error', code: 'pre_send', message: truncateForTemporal(err, 300) };
      if (err instanceof PolicyDeniedError)
        return { outcome: 'rejected', code: err.reason, message: truncateForTemporal(err, 300) };
      throw err;
    }
  }

  const remoteChangeProvider: RemoteChangeProviderRuntimeV1 = {
    deleteRemotePost: (input, actor, hooks) => applyRemoteChange(input, 'delete', actor, hooks),
    editRemotePost: (input, actor, hooks) => applyRemoteChange(input, 'edit', actor, hooks),
  };

  const remoteChangeControl: RemoteChangeControlRuntimeV1 = {
    /**
     * Records a change's outcome once: the change moves out of `requested`, insert-only evidence is added for what
     * the platform confirmed, and a confirmed deletion moves the publication published → removed by the machine.
     * A failure leaves the publication as it was, with the reason on the change. A repeat changes nothing.
     */
    recordRemoteChangeOutcome: ({
      publicationId,
      changeId,
      result,
    }: RecordRemoteChangeInputV1): Promise<RecordRemoteChangeResultV1> =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        const { change } = await loadRemoteChange({ publicationId, changeId }, tx);
        const at = now();
        const succeeded = result.outcome === 'done' || result.outcome === 'already_absent';
        // A confirmation for a change already closed as stale: the platform did change the post, so the record
        // follows it (evidence, removal or current text) and the late arrival is logged and audited.
        const late =
          succeeded &&
          change.state === 'failed' &&
          (STALE_CLOSURE_CODES as readonly string[]).includes(change.errorCode ?? '');
        if (change.state !== 'requested' && !late)
          return { state: change.state, publicationState: row.state, changed: false };
        if (late) {
          await changesRepo.recordLateSuccess(change.id, STALE_CLOSURE_CODES, at, tx);
          log.warn(
            { tenantId: row.tenantId, publicationId: row.id, changeId: change.id },
            'remote change confirmed after it was closed as stale; recorded as succeeded',
          );
          await audit.record(
            workflowActor(),
            `publication.${change.kind}_remote_confirmed_late`,
            { type: 'publication', id: row.id },
            'allowed',
            tx,
            { brandId: row.brandId, publicationId: row.id, reason: change.errorCode },
          );
        }
        const mutation = result as DestinationMutationResult;
        if (!succeeded) {
          const failure = result as Exclude<RemoteMutationOutcome, { outcome: 'done' | 'already_absent' }>;
          await changesRepo.recordOutcome(
            change.id,
            {
              state: 'failed',
              errorCode: failure.code.slice(0, 80),
              errorDetail: truncateForTemporal(failure.message).slice(0, 2000),
            },
            at,
            tx,
          );
          // RA-12: a refusal as a conflict carries the current remote; stored, so the next edit compares against
          // what the site holds now instead of failing again on the stale hash. PR-03: with the refused edit's text
          // and the remote body beside it, so a person can compare them and re-apply the edit on purpose.
          if (mutation.readback)
            await recordReadback(
              row,
              null,
              mutation.readback,
              {
                changeId: change.id,
                refreshedAfter: failure.code,
                ...(mutation.conflict
                  ? {
                      conflict: {
                        ...mutation.conflict,
                        attemptedHtml: (change.text ?? '').slice(0, ARTICLE_TEXT_MAX_CHARS),
                      },
                    }
                  : {}),
              },
              at,
              tx,
            );
          await audit.record(
            workflowActor(),
            `publication.${change.kind}_remote_failed`,
            { type: 'publication', id: row.id },
            'allowed',
            tx,
            { brandId: row.brandId, publicationId: row.id, reason: failure.code.slice(0, 80) },
          );
          count(METRIC.publicationOutcomes, 1, { outcome: `remote_${change.kind}_failed` });
          return { state: 'failed', publicationState: row.state, changed: true };
        }
        // RA-12: the write went through but replaced a change made on the site between the adapter's read and its
        // write (a CMS without compare-and-swap): the change succeeded and says so, with what was lost as evidence.
        const overwritten = mutation.overwritten;
        if (!late)
          await changesRepo.recordOutcome(
            change.id,
            overwritten
              ? {
                  state: 'succeeded',
                  errorCode: 'conflict_overwritten',
                  errorDetail:
                    `the text was written, but it replaced a change made on the site between the read and the write (the site's revision of ${overwritten.replaced.modifiedAt ?? 'an unknown time'} was overwritten; the revision read before the write is recorded as evidence)`.slice(
                      0,
                      2000,
                    ),
                }
              : { state: 'succeeded', errorCode: null, errorDetail: null },
            at,
            tx,
          );
        if (overwritten)
          log.warn(
            { tenantId: row.tenantId, publicationId: row.id, changeId: change.id },
            'remote edit replaced a change made on the site between the read and the write',
          );
        const kind =
          change.kind === 'delete'
            ? 'remote_deletion'
            : change.kind === 'unpublish'
              ? 'remote_unpublish'
              : 'remote_edit';
        const readback = mutation.readback;
        const payload = {
          changeId: change.id,
          remotePostId: row.remotePostId,
          outcome: result.outcome,
          ...(change.textHash ? { textHash: change.textHash } : {}),
          ...(late ? { confirmedAfterStale: true } : {}),
          // R2-3: the remote revision read back after the write, with its hash (what the next edit must match).
          ...(readback ? { readback } : {}),
          ...(mutation.readbackVerification ? { verification: mutation.readbackVerification } : {}),
          ...(overwritten ? { overwritten } : {}),
        };
        await evidenceRepo.create(
          {
            id: newId('remoteEvidence'),
            publicationId: row.id,
            attemptId: null,
            kind,
            remotePostId: row.remotePostId,
            remoteUrl: row.remoteUrl,
            payload,
            payloadHash: hashCanonical(payload),
            capturedAt: at,
          },
          tx,
        );
        // A fresh read-back after an edit and after a revert (RA-02, RA-04): what the site holds now and what the
        // read-back proved. A revert counts only when the read-back says the article is no longer live; an edit of
        // a live article is unverified until the delayed page check (queued here) proves the page.
        if (readback && (change.kind === 'edit' || change.kind === 'unpublish')) {
          await recordReadback(
            row,
            null,
            readback,
            {
              changeId: change.id,
              ...(mutation.readbackVerification ? { verification: mutation.readbackVerification } : {}),
            },
            at,
            tx,
          );
          const reverted = change.kind === 'unpublish' && readback.status !== 'publish';
          const verification = verificationOf(mutation.readbackVerification, null);
          if (change.kind === 'unpublish' && !reverted)
            log.warn(
              { tenantId: row.tenantId, publicationId: row.id, changeId: change.id },
              'revert confirmed by the site but the article read back still live; status kept',
            );
          if (change.kind === 'edit' && row.remoteStatus === 'live') await queueRenderedValidation(row, tx);
          await publicationsRepo.update(
            row.id,
            row.version,
            {
              ...(reverted ? { remoteStatus: 'reverted' as const } : {}),
              remoteVerification: verification,
              remoteVerifiedAt: verification === 'verified' ? at : null,
            },
            tx,
          );
        }
        count(METRIC.publicationOutcomes, 1, { outcome: `remote_${change.kind}` });
        if (change.kind === 'delete' && row.state === 'published') {
          const moved = await move(
            row,
            'remote_deleted',
            { stateReason: result.outcome === 'already_absent' ? 'remote_already_absent' : 'remote_deleted' },
            'publication.removed',
            result.outcome,
            tx,
          );
          return { state: 'succeeded', publicationState: moved.state, changed: true };
        }
        await audit.record(
          workflowActor(),
          `publication.${change.kind}_remote_applied`,
          { type: 'publication', id: row.id },
          'allowed',
          tx,
          { brandId: row.brandId, publicationId: row.id, reason: result.outcome },
        );
        return { state: 'succeeded', publicationState: row.state, changed: true };
      }),
  };

  const renderedValidation: RenderedValidationRuntimeV1 = {
    /**
     * RA-04: the page of a live article fetched again at a delay after publish, outside any transaction (a public
     * fetch, bounded), then recorded under the row lock as evidence with the verification it sets. A publication
     * that is no longer a live article is skipped without a fetch; a repeat appends another result (idempotent in
     * effect: the latest evidence and the verification say the same).
     */
    async validateRenderedPublication(input: RenderedValidationInputV1): Promise<RenderedValidationResultV1> {
      const row = await publicationsRepo.getById(input.publicationId);
      if (row.state !== 'published' || !row.destinationId || !row.remoteUrl)
        return { outcome: 'skipped', reason: `not_a_published_article:${row.state}` };
      if (row.remoteStatus !== 'live')
        return { outcome: 'skipped', reason: `remote_${row.remoteStatus ?? 'unknown'}` };
      const result = await fetchRenderedValidation(row);
      return withTransaction(async (tx) => {
        const locked = await publicationsRepo.lock(row.id, tx);
        if (locked.state !== 'published' || locked.remoteStatus !== 'live')
          return { outcome: 'skipped', reason: `moved_before_record:${locked.state}` };
        await recordRenderedValidation(locked, result, tx);
        const outcome = renderedOutcomeOf(result);
        const ok = outcome === 'verified';
        await audit.record(
          workflowActor(),
          'publication.validate_rendered',
          { type: 'publication', id: row.id },
          ok ? 'allowed' : 'denied',
          tx,
          {
            brandId: row.brandId,
            publicationId: row.id,
            destinationId: row.destinationId,
            reason: failedChecksReason(result),
          },
        );
        return { outcome: 'validated', ok, verification: outcome };
      });
    },
  };

  const remoteChangeSweep: RemoteChangeSweepRuntimeV1 = {
    /**
     * Closes requested changes with no outcome past the stale threshold (a lost workflow), each in its own tenant
     * context and transaction, so the post can be edited or deleted again. A confirmation that still arrives is
     * recorded by recordRemoteChangeOutcome.
     */
    async sweepStaleRemoteChanges(input: RemoteChangeSweepInputV1): Promise<RemoteChangeSweepResultV1> {
      const before = new Date(new Date(input.now).getTime() - REMOTE_CHANGE_STALE_MS);
      const stale = await runAsPlatform('remote-change-sweeper', input.correlationId, () =>
        remoteSweepRepo.findStale(before),
      );
      let closed = 0;
      for (const ref of stale)
        await runInTenant(
          {
            tenantId: ref.tenantId,
            actor: { kind: 'service_principal', id: 'remote-change-sweeper' },
            brandIds: 'all',
            correlationId: input.correlationId,
          },
          () =>
            withTransaction(async (tx) => {
              const row = await publicationsRepo.lock(ref.publicationId, tx);
              const change = await changesRepo.getById(ref.changeId, tx);
              if (change.state !== 'requested' || change.requestedAt >= before) return;
              await changesRepo.recordOutcome(
                change.id,
                {
                  state: 'failed',
                  errorCode: 'stale_no_outcome',
                  errorDetail: 'no outcome was recorded in time; the request can be made again',
                },
                now(),
                tx,
              );
              await audit.record(
                workflowActor(),
                `publication.${change.kind}_remote_failed`,
                { type: 'publication', id: row.id },
                'allowed',
                tx,
                { brandId: row.brandId, publicationId: row.id, reason: 'stale_no_outcome' },
              );
              closed += 1;
              log.warn(
                { tenantId: row.tenantId, publicationId: row.id, changeId: change.id },
                'remote change sweeper closed a change with no outcome (its workflow was lost)',
              );
            }),
        );
      return { closed };
    },
  };

  const connectChoicePurge: ConnectChoicePurgeRuntimeV1 = {
    /**
     * Spec 14.7: expired account choices hold sealed long-lived user tokens; they are shredded and deleted across
     * tenants in bounded batches, whatever the retention sweep's dry-run setting.
     */
    async purgeExpiredConnectChoices(input: ConnectChoicePurgeInputV1): Promise<ConnectChoicePurgeResultV1> {
      const at = new Date(input.now);
      let rows = 0;
      for (;;) {
        const batch = await runAsPlatform('connect-choice-purge', input.correlationId, () =>
          withTransaction((tx) => pendingPurgeRepo.purgeExpired(at, tx)),
        );
        rows += batch;
        if (batch < PURGE_BATCH) break;
      }
      if (rows > 0) log.info({ count: rows }, 'expired connect choices purged');
      return { rows };
    },
  };

  return {
    control,
    provider,
    tokenRefresh,
    sweep,
    remoteChangeControl,
    remoteChangeProvider,
    remoteChangeSweep,
    connectChoicePurge,
    renderedValidation,
    channelRevoke,
  };
}
