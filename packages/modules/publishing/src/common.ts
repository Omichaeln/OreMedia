import { z } from 'zod';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { PublicationForRelease } from '@oremedia/contracts/publishing';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import { publicationMachine, type PublicationEvent } from '@oremedia/domain/state-machines/publication';
import type { PublicationState } from '@oremedia/contracts/publishing';
import { missingScopes } from '@oremedia/providers';
import { registry } from './providers';
import type {
  ChannelConnectionRepository,
  PublicationAttemptRepository,
  PublicationRemoteChangeRepository,
  PublicationRepository,
  RemoteEvidenceRepository,
} from './repositories';

export type ConnectionRow = Awaited<ReturnType<ChannelConnectionRepository['getById']>>;
export type PublicationRow = Awaited<ReturnType<PublicationRepository['getById']>>;
export type AttemptRow = Awaited<ReturnType<PublicationAttemptRepository['getById']>>;
export type EvidenceRow = Awaited<ReturnType<RemoteEvidenceRepository['getById']>>;
export type RemoteChangeRow = Awaited<ReturnType<PublicationRemoteChangeRepository['getById']>>;

export const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });

/** The policy resource of a publication (spec 5.5: its state and channel take part in the decision). */
export const publicationResource = (p: PublicationRow) => ({
  type: 'publication',
  tenantId: p.tenantId,
  brandId: p.brandId,
  id: p.id,
  channelId: p.channelConnectionId,
  state: p.state,
});

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
export function transition(from: PublicationState, event: PublicationEvent, path: string): PublicationState {
  try {
    return publicationMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

/**
 * Spec 14.2: a stable workflow id per publication, `pub:<publicationId>`. The starter's reuse policy
 * (ALLOW_DUPLICATE_FAILED_ONLY) never restarts a completed run, so a re-release after a hold or a proven absence
 * (held/retry_eligible → scheduled) starts a new generation suffixed with the row version it was released at.
 * The id in force is stored on the row (`claimant`, `<workflowId>` while scheduled, `<workflowId>:<runId>` once
 * claimed) so cancel and reschedule signals reach the right execution.
 */
export const publicationWorkflowId = (publicationId: string, generation: number): string =>
  generation === 0 ? `pub:${publicationId}` : `pub:${publicationId}:r${generation}`;
export const reconcileWorkflowId = (publicationId: string, version: number): string =>
  `pub:${publicationId}:reconcile:${version}`;
/** One workflow per remote change request: `pub:<publicationId>:remote:<changeId>` (the outbox starts it USE_EXISTING). */
export const remoteChangeWorkflowId = (publicationId: string, changeId: string): string =>
  `pub:${publicationId}:remote:${changeId}`;
const RUN_ID_SUFFIX = /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const workflowIdOf = (row: Pick<PublicationRow, 'id' | 'claimant'>): string =>
  row.claimant ? row.claimant.replace(RUN_ID_SUFFIX, '') : publicationWorkflowId(row.id, 0);

/** Spec 13.4 channel_active: active, not reconnect_needed, granted scopes cover the capability's requiredScopes. */
export function connectionUsable(row: ConnectionRow): boolean {
  if (row.status !== 'active') return false;
  const cap = registry().capability(row.providerKey);
  if (!cap || !cap.certifiedAt) return false;
  return missingScopes(cap.requiredScopes, row.grantedScopes).length === 0;
}

/** Never the credential reference: a connection DTO carries state and scopes only. */
export const toConnectionDto = (c: ConnectionRow) => ({
  id: c.id,
  brandId: c.brandId,
  providerKey: c.providerKey,
  remoteAccountId: c.remoteAccountId,
  displayName: c.displayName,
  grantedScopes: c.grantedScopes,
  missingScopes: c.missingScopes,
  status: c.status,
  tokenExpiresAt: c.tokenExpiresAt ? c.tokenExpiresAt.toISOString() : null,
  capabilityVersion: c.capabilityVersion,
  usable: connectionUsable(c),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
  version: c.version,
});

/** Versioned JSON is validated on read (spec 6.1): hold reasons are release check names or runtime reasons. */
const HoldReasons = z.array(z.string()).nullable();

export const toPublicationDto = (p: PublicationRow) => ({
  id: p.id,
  brandId: p.brandId,
  contentPackageId: p.contentPackageId,
  contentRevisionId: p.contentRevisionId,
  channelVariantId: p.channelVariantId,
  channelConnectionId: p.channelConnectionId,
  occurrenceKey: p.occurrenceKey,
  authority: p.authority,
  approvalId: p.approvalId,
  mandateId: p.mandateId,
  scheduledFor: p.scheduledFor.toISOString(),
  state: p.state,
  stateReason: p.stateReason,
  holdReasons: HoldReasons.parse(p.holdReasons ?? null) ?? [],
  remotePostId: p.remotePostId,
  remoteUrl: p.remoteUrl,
  fencingToken: p.fencingToken,
  claimedAt: p.claimedAt ? p.claimedAt.toISOString() : null,
  scheduledByKind: p.scheduledByKind,
  scheduledById: p.scheduledById,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  version: p.version,
});

export const toAttemptDto = (a: AttemptRow) => ({
  id: a.id,
  publicationId: a.publicationId,
  attemptNumber: a.attemptNumber,
  fencingToken: a.fencingToken,
  requestFingerprint: a.requestFingerprint,
  providerIdempotencyKey: a.providerIdempotencyKey,
  startedAt: a.startedAt.toISOString(),
  sentAt: a.sentAt ? a.sentAt.toISOString() : null,
  finishedAt: a.finishedAt ? a.finishedAt.toISOString() : null,
  /** The recorded outcome; `unknown` with no finishedAt means the attempt is still open. */
  outcome: a.finishedAt ? a.outcome : null,
  errorCode: a.errorCode,
  errorDetail: a.errorDetail,
  remoteJobId: a.remoteJobId,
  remotePostId: a.remotePostId,
});

/**
 * A requested remote change with no outcome after this long is stale: its workflow bounds itself to well under it
 * (five attempts with backoff), so it was lost. The remote change sweeper closes it; a new request closes it too.
 */
export const REMOTE_CHANGE_STALE_MS = 6 * 3600 * 1000;
/** Failure codes of a change closed as stale; a platform confirmation that arrives afterwards is still recorded. */
export const STALE_CLOSURE_CODES = ['superseded_stale', 'stale_no_outcome'] as const;
export const isStaleRequest = (
  c: Pick<RemoteChangeRow, 'state' | 'requestedAt'>,
  now = Date.now(),
): boolean => c.state === 'requested' && now - c.requestedAt.getTime() >= REMOTE_CHANGE_STALE_MS;

/** The request and its outcome; the text of an edit is returned only as the publication's current text. */
export const toRemoteChangeDto = (c: RemoteChangeRow) => ({
  id: c.id,
  publicationId: c.publicationId,
  kind: c.kind,
  state: c.state,
  reason: c.reason,
  textHash: c.textHash,
  requestedByKind: c.requestedByKind,
  requestedById: c.requestedById,
  requestedAt: c.requestedAt.toISOString(),
  finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
  errorCode: c.errorCode,
  errorDetail: c.errorDetail,
  /** Requested, but no outcome was recorded in time: it no longer blocks a new request (which closes it). */
  stale: isStaleRequest(c),
});

export const toEvidenceDto = (e: EvidenceRow) => ({
  id: e.id,
  publicationId: e.publicationId,
  attemptId: e.attemptId,
  kind: e.kind,
  remotePostId: e.remotePostId,
  remoteUrl: e.remoteUrl,
  payload: e.payload,
  payloadHash: e.payloadHash,
  capturedAt: e.capturedAt.toISOString(),
});

/** The publication as the release evaluator sees it (spec 13.4): references only, from the live row. */
export const forRelease = (p: PublicationRow): PublicationForRelease => ({
  id: p.id,
  tenantId: p.tenantId,
  brandId: p.brandId,
  contentPackageId: p.contentPackageId,
  contentRevisionId: p.contentRevisionId,
  channelVariantId: p.channelVariantId,
  channelConnectionId: p.channelConnectionId,
  authority: p.authority,
  approvalId: p.approvalId,
  mandateId: p.mandateId,
  scheduledFor: p.scheduledFor.toISOString(),
  state: p.state,
});
