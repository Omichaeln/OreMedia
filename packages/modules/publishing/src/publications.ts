import type { z } from 'zod';
import {
  ApprovalInvalidError,
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import {
  CancelCommand,
  PublicationDeleteRemote,
  PublicationEditRemote,
  PublicationEvidence,
  PublicationGet,
  PublicationHoldRestored,
  PublicationList,
  PublicationUnpublishRemote,
  PublicationValidateRendered,
  ReconcileCommand,
  RescheduleCommand,
  ScheduleCommand,
  type CancelResult,
  type PublicationForRelease,
  type PublicationState,
} from '@oremedia/contracts/publishing';
import { articleFirstParagraph, renderedValidationOk } from '@oremedia/contracts/article';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, type Tx } from '@oremedia/db';
import { hashCanonical, hashText } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { PublicationEvent } from '@oremedia/domain/state-machines/publication';
import { policy } from '@oremedia/module-access';
import { audit, outbox } from '@oremedia/module-operations';
import {
  actorRef,
  forRelease,
  isStaleRequest,
  publicationResource,
  publicationWorkflowId,
  reconcileWorkflowId,
  remoteChangeWorkflowId,
  targetIdOf,
  toAttemptDto,
  toEvidenceDto,
  toPublicationDto,
  toRemoteChangeDto,
  transition,
  workflowIdOf,
  type PublicationRow,
} from './common';
import { channelService } from './channels';
import { approvals, assertBrandExists, destinations, review, revisions, variants } from './hooks';
import { registry } from './providers';
import {
  ChannelConnectionRepository,
  PublicationAttemptRepository,
  PublicationRemoteChangeRepository,
  PublicationRepository,
  RemoteEvidenceRepository,
} from './repositories';

/** A window's bound (UX-14): the calendar pages by day and the rollups cap their own subjects at 200. */
const CALENDAR_RANGE_MAX = 1000;
const publicationsRepo = new PublicationRepository();
const attemptsRepo = new PublicationAttemptRepository();
const evidenceRepo = new RemoteEvidenceRepository();
const connectionsRepo = new ChannelConnectionRepository();
const changesRepo = new PublicationRemoteChangeRepository();

/** The portfolio summary's upcoming window. */
const UPCOMING_DAYS = 7;

/** Policy options the caller may pass through (spec 5.5 step 7): the agent runtime supplies the run's autonomy mode. */
export interface ActorOptions {
  autonomyMode?: AutonomyMode;
}

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};

/** Spec 17.6 restore rule: the state (and hold) reason of a publication moved by holdRestored. */
const RESTORED_FROM_BACKUP = 'restored_from_backup';

/** In-flight states (spec 13.5): a cancel cannot be honoured by the row; the workflow is signalled instead. */
const IN_FLIGHT: ReadonlySet<PublicationState> = new Set(['dispatching', 'processing', 'outcome_unknown']);

const isDuplicateKeyError = (err: unknown): boolean =>
  (err as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY' ||
  (err as { cause?: { code?: string } } | undefined)?.cause?.code === 'ER_DUP_ENTRY';

function scheduledByOf(actor: ResolvedActor): 'user' | 'service_principal' {
  if (actor.kind === 'user' || actor.kind === 'service_principal') return actor.kind;
  throw new PolicyDeniedError(
    'actor_kind_cannot_schedule',
    'Only members and agents can schedule publications',
  );
}

/** Spec 5.5: an agent below managed_autopublish carries the requires_approval obligation, so a mandate is refused. */
function assertAuthorityAllowed(decision: Decision, authority: 'approval' | 'mandate'): void {
  if (authority === 'mandate' && decision.obligations?.some((o) => o.type === 'requires_approval'))
    throw new PolicyDeniedError('approval_required', 'This actor may only schedule with a valid approval');
}

async function recordStateChange(
  actor: ResolvedActor,
  action: string,
  row: PublicationRow,
  toState: PublicationState,
  reason: string | null,
  tx: Tx,
): Promise<void> {
  await audit.record(actorRef(actor), action, { type: 'publication', id: row.id }, 'allowed', tx, {
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
}

/** A re-release (held/retry_eligible → scheduled) starts a new workflow generation (see publicationWorkflowId). */
async function release(
  actor: ResolvedActor,
  row: PublicationRow,
  event: PublicationEvent,
  scheduledFor: Date,
  tx: Tx,
) {
  const toState = transition(row.state, event, 'publicationId');
  const pre = await review.evaluateRelease(
    { ...forRelease(row), scheduledFor: scheduledFor.toISOString() },
    scheduledFor,
    tx,
  );
  if (!pre.allow) throw new ApprovalInvalidError(pre.reasons);
  const workflowId = publicationWorkflowId(row.id, row.version + 1);
  await publicationsRepo.update(
    row.id,
    row.version,
    {
      state: toState,
      scheduledFor,
      stateReason: null,
      holdReasons: null,
      claimant: workflowId,
      claimedAt: null,
    },
    tx,
  );
  await recordStateChange(actor, 'publication.reschedule', row, toState, 're-released', tx);
  await outbox.add(
    'publication.scheduled',
    { type: 'publication', id: row.id, version: row.version + 1 },
    {
      publicationId: row.id,
      scheduledFor: scheduledFor.toISOString(),
      workflowId,
      rerelease: true,
      actorKind: actor.kind,
      actorId: actor.id,
    },
    tx,
    { brandId: row.brandId },
  );
}

/**
 * Spec 8.2: scheduled rows that fail the release check at their scheduled time move to `held` through the
 * publication machine with the failed checks as reasons; the rest are left as they are. The actor is the tenant
 * context's (the brand publisher the workflow carries, spec 5.2).
 */
async function holdWhereReleaseFails(rows: PublicationRow[], reason: string, tx: Tx) {
  const held: string[] = [];
  const unchanged: string[] = [];
  for (const row of rows) {
    const decision = await review.evaluateRelease(forRelease(row), row.scheduledFor, tx);
    if (decision.allow) {
      unchanged.push(row.id);
      continue;
    }
    const toState = transition(row.state, 'dependency_revoked', 'publicationId');
    await publicationsRepo.update(
      row.id,
      row.version,
      { state: toState, stateReason: reason.slice(0, 120), holdReasons: decision.reasons },
      tx,
    );
    await audit.record(
      requireTenant().actor,
      'publication.hold',
      { type: 'publication', id: row.id },
      'allowed',
      tx,
      {
        brandId: row.brandId,
        publicationId: row.id,
        fromState: row.state,
        toState,
        reason: decision.reasons.join(','),
      },
    );
    await outbox.add(
      'publication.state_changed',
      { type: 'publication', id: row.id, version: row.version + 1 },
      { publicationId: row.id, fromState: row.state, toState, reason },
      tx,
      { brandId: row.brandId },
    );
    held.push(row.id);
  }
  return { held, unchanged };
}

/**
 * A variant's target as a publication records it (R2-3): the channel connection, or the brand destination, of the
 * variant's brand; a foreign or other-brand target is NOT_FOUND / refused without naming it. `providerKey` is what
 * names the activity queue: the channel's provider key or the destination's kind.
 */
async function targetOfVariant(
  variant: { brandId: string; channelConnectionId: string | null; destinationId: string | null },
  path: string,
  tx: Tx,
) {
  if (variant.destinationId) {
    const destination = await destinations.describe(variant.destinationId, tx);
    if (!destination) throw new NotFoundError('Destination', variant.destinationId);
    if (destination.brandId !== variant.brandId)
      throw new ValidationFailedError(
        [{ path, issue: 'destination_belongs_to_another_brand' }],
        'The variant targets a destination of another brand',
      );
    return {
      channelConnectionId: null,
      destinationId: destination.id,
      providerKey: destination.kind,
      resource: { channelId: undefined as string | undefined },
    };
  }
  const connection = await connectionsRepo.getById(variant.channelConnectionId ?? '', tx); // foreign → NOT_FOUND
  if (connection.brandId !== variant.brandId)
    throw new ValidationFailedError(
      [{ path, issue: 'channel_belongs_to_another_brand' }],
      'The variant targets a channel of another brand',
    );
  return {
    channelConnectionId: connection.id,
    destinationId: null,
    providerKey: connection.providerKey,
    resource: { channelId: connection.id as string | undefined },
  };
}

/** What a target allows on a live post: the channel capability's edit/delete, or the destination's actions (R2-3). */
async function remoteActionsOf(row: PublicationRow, tx?: Tx) {
  if (row.destinationId) {
    const d = await destinations.describe(row.destinationId, tx);
    return d ? { ...d.actions, providerKey: d.kind } : null;
  }
  const connection = await connectionsRepo.getById(row.channelConnectionId ?? '', tx);
  const cap = registry().capability(connection.providerKey);
  return {
    edit: cap?.edit ?? false,
    delete: cap?.delete ?? false,
    unpublish: false,
    providerKey: connection.providerKey,
  };
}

/**
 * The preconditions of changing a live post (publication.edit_remote / delete_remote / unpublish), under the
 * publication row lock: published with a remote id, the target allows the change, and no other change of this post
 * is still waiting on the platform (so an edit never races a delete, and a delete is never requested twice).
 */
async function assertRemoteChangeAllowed(row: PublicationRow, kind: 'edit' | 'delete' | 'unpublish', tx: Tx) {
  if (row.state !== 'published' || !row.remotePostId)
    throw new ValidationFailedError(
      [{ path: 'publicationId', issue: 'not_published' }],
      `Only a published post with a remote id can be ${kind === 'edit' ? 'edited' : kind === 'delete' ? 'deleted' : 'reverted'} remotely`,
    );
  const actions = await remoteActionsOf(row, tx);
  if (!actions?.[kind])
    throw new CapabilityUnsupportedError([{ path: 'providerKey', issue: `${kind}_not_supported` }]);
  const open = await changesRepo.findOpenForPublication(row.id, tx);
  if (open && !isStaleRequest(open))
    throw new ValidationFailedError(
      [{ path: 'publicationId', issue: 'remote_change_in_progress' }],
      'Another edit or deletion of this post is still being carried out on the channel',
    );
  // A request its workflow never recorded is closed, so it cannot block this post: its activity checks the change
  // is still requested before sending, and a confirmation that still arrives is recorded (recordRemoteChangeOutcome).
  if (open) {
    await changesRepo.recordOutcome(
      open.id,
      { state: 'failed', errorCode: 'superseded_stale', errorDetail: 'no outcome was recorded in time' },
      new Date(),
      tx,
    );
    await audit.record(
      requireTenant().actor,
      `publication.${open.kind}_remote_failed`,
      { type: 'publication', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, publicationId: row.id, reason: 'superseded_stale' },
    );
  }
  return { providerKey: actions.providerKey, remotePostId: row.remotePostId };
}

/**
 * A delete (spec 13.5) or an unpublish (R2-3) of a live post: recorded as a remote change, audited under its own
 * action and emitted as publication.delete_remote_requested, which starts publicationRemoteDeleteWorkflowV1 on the
 * target's queue. The v1 payload is kept as it was; the change, provider key and workflow id are appended (additive).
 */
async function requestRemoval(
  actor: ResolvedActor,
  row: PublicationRow,
  kind: 'delete' | 'unpublish',
  reason: string,
  tx: Tx,
) {
  const { providerKey, remotePostId } = await assertRemoteChangeAllowed(row, kind, tx);
  const changeId = newId('publicationRemoteChange');
  await changesRepo.create(
    {
      id: changeId,
      brandId: row.brandId,
      publicationId: row.id,
      kind,
      state: 'requested',
      reason,
      requestedByKind: scheduledByOf(actor),
      requestedById: actor.id,
      requestedAt: new Date(),
    },
    tx,
  );
  await audit.record(
    actorRef(actor),
    kind === 'delete' ? 'publication.delete_remote' : 'publication.unpublish_remote',
    { type: 'publication', id: row.id },
    'allowed',
    tx,
    {
      brandId: row.brandId,
      publicationId: row.id,
      ...(row.channelConnectionId ? { channelConnectionId: row.channelConnectionId } : {}),
      ...(row.destinationId ? { destinationId: row.destinationId } : {}),
      reason,
    },
  );
  await outbox.add(
    'publication.delete_remote_requested',
    { type: 'publication', id: row.id, version: row.version },
    {
      publicationId: row.id,
      remotePostId,
      requestedByKind: actor.kind,
      requestedById: actor.id,
      changeId,
      providerKey,
      workflowId: remoteChangeWorkflowId(row.id, changeId),
    },
    tx,
    { brandId: row.brandId },
  );
  return { accepted: true, publicationId: row.id, remotePostId, changeId };
}

export const publicationService = {
  /**
   * Spec 14.1 schedulePublication, literally: variant through the content hook, policy, fail-fast release
   * pre-check, occurrence key unique per tenant (a repeat is CONFLICT, never a second row), the row in `scheduled`,
   * the outbox event and the audit event in the caller's (idempotent) transaction.
   */
  async schedule(
    actor: ResolvedActor,
    input: z.infer<typeof ScheduleCommand>,
    tx: Tx,
    opts: ActorOptions = {},
  ) {
    const cmd = ScheduleCommand.parse(input);
    const { tenantId } = requireTenant();
    const variant = await variants.get(cmd.channelVariantId, tx);
    if (variant.tenantId !== tenantId) throw new NotFoundError('ChannelVariant', cmd.channelVariantId);
    const target = await targetOfVariant(variant, 'channelVariantId', tx);
    const decision = await policy.assert(
      actor,
      'publication.schedule',
      {
        type: 'channel_variant',
        tenantId,
        brandId: variant.brandId,
        id: variant.id,
        ...(target.resource.channelId ? { channelId: target.resource.channelId } : {}),
      },
      opts,
      tx,
    );
    assertAuthorityAllowed(decision, cmd.authority);
    if (cmd.authority === 'approval' && !cmd.approvalId)
      throw new ValidationFailedError([{ path: 'approvalId', issue: 'required_for_approval_authority' }]);
    if (cmd.authority === 'mandate' && !cmd.mandateId)
      throw new ValidationFailedError([{ path: 'mandateId', issue: 'required_for_mandate_authority' }]);
    const scheduledFor = new Date(cmd.scheduledFor);
    const preview: PublicationForRelease = {
      id: 'preview',
      tenantId,
      brandId: variant.brandId,
      contentPackageId: variant.contentPackageId,
      contentRevisionId: variant.contentRevisionId,
      channelVariantId: variant.id,
      channelConnectionId: target.channelConnectionId,
      destinationId: target.destinationId,
      authority: cmd.authority,
      approvalId: cmd.approvalId ?? null,
      mandateId: cmd.mandateId ?? null,
      scheduledFor: scheduledFor.toISOString(),
      state: 'scheduled',
    };
    const pre = await review.evaluateRelease(preview, scheduledFor, tx); // fail fast for UX; dispatch re-evaluates
    if (!pre.allow) throw new ApprovalInvalidError(pre.reasons);

    const occurrenceKey = `${variant.contentRevisionId}:${targetIdOf(target)}:${cmd.occurrence ?? 'once'}`;
    const existing = await publicationsRepo.findByOccurrenceKey(occurrenceKey, tx);
    if (existing) throw new ConflictError('Publication', existing.id, existing.version);
    const id = newId('publication');
    const workflowId = publicationWorkflowId(id, 0);
    try {
      await publicationsRepo.create(
        {
          id,
          brandId: variant.brandId,
          contentPackageId: variant.contentPackageId,
          contentRevisionId: variant.contentRevisionId,
          channelVariantId: variant.id,
          channelConnectionId: target.channelConnectionId,
          destinationId: target.destinationId,
          occurrenceKey,
          authority: cmd.authority,
          approvalId: cmd.approvalId ?? null,
          mandateId: cmd.mandateId ?? null,
          scheduledFor,
          state: 'scheduled',
          claimant: workflowId,
          scheduledByKind: scheduledByOf(actor),
          scheduledById: actor.id,
        },
        tx,
      );
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('Publication', occurrenceKey, 0); // lost the race
      throw err;
    }
    await outbox.add(
      'publication.scheduled',
      { type: 'publication', id, version: 1 },
      {
        publicationId: id,
        scheduledFor: scheduledFor.toISOString(),
        workflowId,
        rerelease: false,
        actorKind: actor.kind,
        actorId: actor.id,
      },
      tx,
      { brandId: variant.brandId },
    );
    await audit.record(actorRef(actor), 'publication.schedule', { type: 'publication', id }, 'allowed', tx, {
      brandId: variant.brandId,
      publicationId: id,
      ...(target.channelConnectionId ? { channelConnectionId: target.channelConnectionId } : {}),
      ...(target.destinationId ? { destinationId: target.destinationId } : {}),
      toState: 'scheduled',
    });
    return toPublicationDto(await publicationsRepo.getById(id, tx));
  },

  /**
   * Spec 12.4 publications.proposeSchedule: checks a proposed slot without writing anything. The revision (through
   * the content hook) and every channel connection must belong to the brand (a foreign or other-brand id is
   * NOT_FOUND), the revision must be approved, the slot in the future, each channel must carry a variant of the
   * revision and the actor must hold publication.schedule on it. Returns the publications.schedule commands a
   * person completes with a valid approval; no publication row, outbox event or workflow comes from here.
   */
  async proposeSchedule(
    actor: ResolvedActor,
    input: {
      brandId: string;
      contentRevisionId: string;
      channelConnectionIds: string[];
      scheduledFor: string;
    },
    tx: Tx,
    opts: ActorOptions = {},
  ) {
    const { tenantId } = requireTenant();
    const revision = await revisions.withVariants(input.contentRevisionId, tx);
    if (revision.brandId !== input.brandId)
      throw new NotFoundError('ContentRevision', input.contentRevisionId);
    const scheduledFor = new Date(input.scheduledFor);
    const details = [];
    if (revision.state !== 'approved')
      details.push({ path: 'contentRevisionId', issue: `revision is ${revision.state}, not approved` });
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now())
      details.push({ path: 'proposedAt', issue: 'must be in the future' });
    const entries = [];
    for (const [i, channelConnectionId] of [...new Set(input.channelConnectionIds)].entries()) {
      const connection = await connectionsRepo.getById(channelConnectionId, tx); // foreign → NOT_FOUND
      if (connection.brandId !== revision.brandId)
        throw new NotFoundError('ChannelConnection', channelConnectionId); // never reveal another brand's channel
      const variant = revision.variants.find((v) => v.channelConnectionId === connection.id);
      if (!variant) {
        details.push({ path: `channelConnectionIds.${i}`, issue: 'no_channel_variant' });
        continue;
      }
      await policy.assert(
        actor,
        'publication.schedule',
        {
          type: 'channel_variant',
          tenantId,
          brandId: revision.brandId,
          id: variant.id,
          channelId: connection.id,
        },
        opts,
        tx,
      );
      entries.push({
        channelConnectionId: connection.id,
        channelVariantId: variant.id,
        scheduledFor: scheduledFor.toISOString(),
      });
    }
    if (details.length) throw new ValidationFailedError(details, 'The proposed slot cannot be scheduled');
    return { contentRevisionId: revision.id, entries };
  },

  /**
   * Spec 8.2 brand change impact (brandChangeImpactWorkflowV1): every scheduled publication of the brand is
   * re-evaluated against the release policy at its scheduled time; one that no longer passes moves to `held`
   * with the failed checks as reasons (the machine's dependency_revoked), audited and announced as the tenant
   * context's actor. Idempotent: a held publication is no longer scheduled and is not visited again.
   */
  async reevaluateScheduledForBrand(brandId: string, reason: string, tx: Tx) {
    const rows = await publicationsRepo.listScheduledForBrand(brandId, tx);
    return holdWhereReleaseFails(rows, reason, tx);
  },

  /** UX-20: the scheduled publications reevaluateScheduledForBrand would re-check now, read without locking. */
  async scheduledForBrand(brandId: string, tx?: Tx) {
    return (await publicationsRepo.listScheduledForBrandRead(brandId, tx)).map((p) => ({
      publicationId: p.id,
      contentPackageId: p.contentPackageId,
      contentRevisionId: p.contentRevisionId,
      channelConnectionId: p.channelConnectionId,
      destinationId: p.destinationId,
      scheduledFor: p.scheduledFor.toISOString(),
    }));
  },

  /**
   * Spec 8.2 brand.fact_revoked: the scheduled publications whose content revision cites the fact. With `hold`
   * (policy holdOnDependencyRevocation, the default) each one that fails the release check moves to `held`;
   * without it each is flagged for attention (audit + publication.needs_attention) and keeps its state.
   */
  async applyFactRevocation(
    input: { brandId: string; contentRevisionIds: readonly string[]; factId: string; hold: boolean },
    tx: Tx,
  ) {
    const citing = new Set(input.contentRevisionIds);
    const rows = (await publicationsRepo.listScheduledForBrand(input.brandId, tx)).filter((p) =>
      citing.has(p.contentRevisionId),
    );
    const reason = `fact_revoked:${input.factId}`;
    if (input.hold) return { ...(await holdWhereReleaseFails(rows, reason, tx)), flagged: [] as string[] };
    const flagged: string[] = [];
    for (const row of rows) {
      await audit.record(
        requireTenant().actor,
        'publication.needs_attention',
        { type: 'publication', id: row.id },
        'allowed',
        tx,
        { brandId: row.brandId, publicationId: row.id, revisionId: row.contentRevisionId, reason },
      );
      await outbox.add(
        'publication.needs_attention',
        { type: 'publication', id: row.id, version: row.version },
        { publicationId: row.id, contentRevisionId: row.contentRevisionId, state: row.state, reason },
        tx,
        { brandId: row.brandId },
      );
      flagged.push(row.id);
    }
    return { held: [] as string[], flagged, unchanged: [] as string[] };
  },

  /**
   * Spec 17.6 restore rule (runbook "restore a single tenant", step 5): the tenant's (or one brand's) restored
   * in-flight publications stop before anything fires from restored state, and each is reconciled against remote
   * history before it is released. A tenant admin's command (billing.manage, like the kill switch; never an agent),
   * audited and announced per row as the other holds and outcome moves are.
   *
   * Per row, through the machine: `scheduled`, or `dispatching` whose current attempt has no sentAt (never sent,
   * spec 14.3), → `held` (restored_from_backup) for a person to release or cancel. `processing`, or `dispatching`
   * with sentAt (it may be live on the channel), → `outcome_unknown` (poll_unknown / ambiguous_failure, the moves
   * worker loss takes) with a reconcile request, so the reconciliation workflow finds it (→ published) or proves it
   * absent (→ retry_eligible, released only by a person) or hands it to a person (→ held), and
   * publishing.publications.reconcile can confirm it either way. The attempt is read with a lock after the row lock
   * (the pre-send fence's order), so a sentAt the fence committed while this waited is seen.
   *
   * A claimed row's fencing token is bumped. The run still holding the old claim is refused with VALIDATION_FAILED
   * (stale_fencing_token) wherever it presents the token (evaluateRelease, openAttempt, publishOnce and its pre-send
   * fence, so sentAt never commits and nothing is sent, checkStatus, finalize). markProcessing, markPublished and
   * markOutcomeUnknown carry no token: on a held row they fail with VALIDATION_FAILED because held has no matching
   * transition (markFailed returns the row unchanged); the activity layer turns VALIDATION_FAILED into a
   * non-retryable failure, so that run's workflow fails once, without retries, and leaves the row as set here. On an
   * outcome_unknown row, a late accepted response is still recorded (reconcile_found). A waiting run re-reads a row
   * that is no longer scheduled and ends.
   *
   * Bounded: one call moves at most `limit` rows in its (the caller's) transaction and reports them; `hasMore` asks
   * for another call. Idempotent: a moved row is no longer in flight, so a repeat, or a re-run after a partial one,
   * moves only what is still (or newly) in flight.
   */
  async holdRestored(actor: ResolvedActor, input: z.input<typeof PublicationHoldRestored>, tx: Tx) {
    const cmd = PublicationHoldRestored.parse(input);
    const { tenantId } = requireTenant();
    await policy.assert(actor, 'billing.manage', { type: 'tenant', tenantId, id: tenantId }, {}, tx);
    if (cmd.brandId) await assertBrandExists(cmd.brandId, tx); // foreign or unknown → NOT_FOUND
    const rows = await publicationsRepo.lockInFlightForRestore(cmd.brandId, cmd.limit + 1, tx);
    const held: string[] = [];
    const outcomeUnknown: string[] = [];
    for (const row of rows.slice(0, cmd.limit)) {
      const claimed = row.state !== 'scheduled';
      const attempt = claimed ? await attemptsRepo.lockByFence(row.id, row.fencingToken, tx) : null;
      const fence = claimed ? { fencingToken: row.fencingToken + 1 } : {};
      if (row.state === 'processing' || attempt?.sentAt) {
        const toState = transition(
          row.state,
          row.state === 'processing' ? 'poll_unknown' : 'ambiguous_failure',
          'publicationId',
        );
        if (attempt && !attempt.finishedAt)
          await attemptsRepo.recordOutcome(
            attempt.id,
            {
              outcome: 'unknown',
              errorCode: RESTORED_FROM_BACKUP,
              errorDetail: null,
              remoteJobId: null,
              remotePostId: null,
              pendingState: null,
            },
            new Date(),
            tx,
          );
        await publicationsRepo.update(
          row.id,
          row.version,
          { state: toState, stateReason: RESTORED_FROM_BACKUP, ...fence },
          tx,
        );
        await recordStateChange(actor, 'publication.outcome_unknown', row, toState, RESTORED_FROM_BACKUP, tx);
        const actions = await remoteActionsOf(row, tx);
        await outbox.add(
          'publication.reconcile_requested',
          { type: 'publication', id: row.id, version: row.version + 1 },
          {
            publicationId: row.id,
            attemptId: attempt?.id ?? null,
            providerKey: actions?.providerKey ?? '',
            workflowId: reconcileWorkflowId(row.id, row.version + 1),
            actorKind: row.scheduledByKind,
            actorId: row.scheduledById,
          },
          tx,
          { brandId: row.brandId },
        );
        outcomeUnknown.push(row.id);
        continue;
      }
      const toState = transition(row.state, 'restored_from_backup', 'publicationId');
      await publicationsRepo.update(
        row.id,
        row.version,
        { state: toState, stateReason: RESTORED_FROM_BACKUP, holdReasons: [RESTORED_FROM_BACKUP], ...fence },
        tx,
      );
      await recordStateChange(actor, 'publication.hold', row, toState, RESTORED_FROM_BACKUP, tx);
      held.push(row.id);
    }
    return { held, outcomeUnknown, hasMore: rows.length > cmd.limit };
  },

  /**
   * Spec 13.5: scheduled → cancelled with the expected version (held resolves to cancelled the same way). Once
   * dispatch started, the row cannot prevent it: the workflow receives a cancel signal through the outbox relay
   * and the outcome is reconciled. Deleting a live remote post is deleteRemote, never an automatic rollback.
   */
  async cancel(actor: ResolvedActor, input: z.infer<typeof CancelCommand>, tx: Tx): Promise<CancelResult> {
    const cmd = CancelCommand.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.cancel', publicationResource(row), {}, tx);
    if (IN_FLIGHT.has(row.state)) {
      await outbox.add(
        'publication.cancel_requested',
        { type: 'publication', id: row.id, version: row.version },
        {
          publicationId: row.id,
          workflowId: workflowIdOf(row),
          requestedByKind: actor.kind,
          requestedById: actor.id,
        },
        tx,
        { brandId: row.brandId },
      );
      await audit.record(
        actorRef(actor),
        'publication.cancel_requested',
        { type: 'publication', id: row.id },
        'allowed',
        tx,
        { brandId: row.brandId, publicationId: row.id, fromState: row.state, reason: 'dispatch_in_progress' },
      );
      return {
        prevented: false,
        state: row.state,
        message: 'Dispatch in progress; outcome will be reconciled',
      };
    }
    if (row.version !== cmd.expectedVersion)
      throw new ConflictError('Publication', row.id, cmd.expectedVersion);
    const event: PublicationEvent = row.state === 'held' ? 'hold_resolved_cancel' : 'user_cancel';
    const toState = transition(row.state, event, 'publicationId');
    await publicationsRepo.update(row.id, row.version, { state: toState, stateReason: 'user_cancel' }, tx);
    await recordStateChange(actor, 'publication.cancel', row, toState, 'user_cancel', tx);
    return { prevented: true, state: toState, version: row.version + 1 };
  },

  /**
   * Spec 14.3: rescheduling updates the row and signals the waiting workflow; it never terminates one. A held or
   * retry_eligible publication is re-released the same way (a new attempt, the same occurrence).
   */
  async reschedule(actor: ResolvedActor, input: z.infer<typeof RescheduleCommand>, tx: Tx) {
    const cmd = RescheduleCommand.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.schedule', publicationResource(row), {}, tx);
    if (row.version !== cmd.expectedVersion)
      throw new ConflictError('Publication', row.id, cmd.expectedVersion);
    const scheduledFor = new Date(cmd.scheduledFor);
    switch (row.state) {
      case 'scheduled': {
        await publicationsRepo.update(row.id, row.version, { scheduledFor }, tx);
        await audit.record(
          actorRef(actor),
          'publication.reschedule',
          { type: 'publication', id: row.id },
          'allowed',
          tx,
          { brandId: row.brandId, publicationId: row.id, fromState: row.state, toState: row.state },
        );
        await outbox.add(
          'publication.rescheduled',
          { type: 'publication', id: row.id, version: row.version + 1 },
          { publicationId: row.id, scheduledFor: scheduledFor.toISOString(), workflowId: workflowIdOf(row) },
          tx,
          { brandId: row.brandId },
        );
        break;
      }
      case 'held':
        await release(actor, row, 'hold_resolved_schedule', scheduledFor, tx);
        break;
      case 'retry_eligible':
        await release(actor, row, 'reschedule', scheduledFor, tx);
        break;
      default:
        throw new ValidationFailedError(
          [{ path: 'publicationId', issue: `reschedule_not_allowed_in_state:${row.state}` }],
          'This publication cannot be rescheduled in its current state',
        );
    }
    return toPublicationDto(await publicationsRepo.getById(row.id, tx));
  },

  async get(actor: ResolvedActor, input: z.infer<typeof PublicationGet>, tx?: Tx) {
    const parsed = PublicationGet.parse(input);
    const row = await publicationsRepo.getById(parsed.publicationId, tx);
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    const attempts = await attemptsRepo.listForPublication(row.id, tx);
    const changes = await changesRepo.listForPublication(row.id, tx);
    const actions = await remoteActionsOf(row, tx);
    const cap = row.channelConnectionId ? registry().capability(actions?.providerKey ?? '') : undefined;
    const readback = row.destinationId
      ? await evidenceRepo.latestOfKind(row.id, 'remote_readback', tx)
      : null;
    const validation = row.destinationId
      ? await evidenceRepo.latestOfKind(row.id, 'rendered_validation', tx)
      : null;
    const unpublished = row.destinationId
      ? await evidenceRepo.latestOfKind(row.id, 'remote_unpublish', tx)
      : null;
    return {
      ...toPublicationDto(row),
      attempts: attempts.map(toAttemptDto),
      /** Changing the live post: what the target allows, the current text after an edit, the recent requests. */
      remote: {
        edit: actions?.edit ?? false,
        delete: actions?.delete ?? false,
        /** R2-3: a live article can be set back to a draft on its website (the rollback of a publish). */
        unpublish: actions?.unpublish ?? false,
        /** Whether this caller holds the permissions (brand-level grants included); the commands re-check. */
        allowed: {
          edit: policy.allows(actor, 'publication.edit_remote', publicationResource(row)),
          delete: policy.allows(actor, 'publication.delete_remote', publicationResource(row)),
          unpublish: policy.allows(actor, 'publication.delete_remote', publicationResource(row)),
        },
        textMaxLength: cap?.text.maxLength ?? null,
        textWeighted: cap?.text.weighted ?? false,
        /**
         * R2-3 (destination publications only): the latest read-back of the remote article, the latest rendered
         * validation and whether the article was reverted to a draft since, each as its evidence payload.
         */
        article: row.destinationId
          ? {
              readback: readback ? toEvidenceDto(readback) : null,
              validation: validation ? toEvidenceDto(validation) : null,
              unpublished: unpublished ? toEvidenceDto(unpublished) : null,
            }
          : null,
        /** The text of the latest edit that went through; null while the post shows the variant's text. */
        currentText: (await changesRepo.latestSucceededEdit(row.id, tx))?.text ?? null,
        changes: changes.map(toRemoteChangeDto),
      },
    };
  },

  async list(actor: ResolvedActor, input: z.infer<typeof PublicationList>, tx?: Tx) {
    const parsed = PublicationList.parse(input);
    await assertBrandExists(parsed.brandId, tx);
    await policy.assert(actor, 'brand.read', brandResource(parsed.brandId), {}, tx);
    const page = await publicationsRepo.listForBrand(parsed.brandId, parsed.state, parsed.page, tx);
    return { items: page.items.map(toPublicationDto), nextCursor: page.nextCursor };
  },

  /**
   * Portfolio summary, per brand the actor may see: publications that need a person (failed, outcome unknown,
   * held) and publications scheduled in the next seven days.
   */
  async attentionByBrand(actor: ResolvedActor, now: Date, tx?: Tx) {
    const ctx = requireTenant();
    await policy.assert(
      actor,
      'brand.read',
      { type: 'tenant', tenantId: ctx.tenantId, id: ctx.tenantId },
      {},
      tx,
    );
    const until = new Date(now.getTime() + UPCOMING_DAYS * 24 * 3600 * 1000);
    const brands = await publicationsRepo.countAttentionByBrand(
      ctx.brandIds === 'all' ? 'all' : [...ctx.brandIds],
      now,
      until,
      tx,
    );
    return { upcomingDays: UPCOMING_DAYS, brands };
  },

  async evidence(actor: ResolvedActor, input: z.infer<typeof PublicationEvidence>, tx?: Tx) {
    const parsed = PublicationEvidence.parse(input);
    const row = await publicationsRepo.getById(parsed.publicationId, tx);
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    return (await evidenceRepo.listForPublication(row.id, tx)).map(toEvidenceDto);
  },

  /**
   * Runbook "reconcile an outcome_unknown publication": the human resolution. confirm_published records
   * human_confirmation evidence (outcome_unknown → published, spending a release approval); confirm_absent proves
   * absence (→ retry_eligible); cancel closes a held row. confirm_published is refused on a held row: the machine
   * has no held → published move, and recording a confirmation that leaves the row held would misreport it.
   */
  async reconcile(actor: ResolvedActor, input: z.infer<typeof ReconcileCommand>, tx: Tx) {
    const cmd = ReconcileCommand.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.schedule', publicationResource(row), {}, tx);
    if (row.state !== 'outcome_unknown' && row.state !== 'held')
      throw new ValidationFailedError(
        [{ path: 'publicationId', issue: `reconcile_not_allowed_in_state:${row.state}` }],
        'Only outcome_unknown or held publications can be reconciled by hand',
      );
    const attempts = await attemptsRepo.listForPublication(row.id, tx);
    const last = attempts.at(-1) ?? null;
    switch (cmd.resolution) {
      case 'confirm_published': {
        if (row.state !== 'outcome_unknown')
          throw new ValidationFailedError(
            [{ path: 'resolution', issue: `confirm_published_not_allowed_in_state:${row.state}` }],
            'A publication can be confirmed as published only while its outcome is unknown (state outcome_unknown)',
          );
        if (!cmd.remotePostId)
          throw new ValidationFailedError([
            { path: 'remotePostId', issue: 'required_for_confirm_published' },
          ]);
        const payload = {
          remotePostId: cmd.remotePostId,
          remoteUrl: cmd.remoteUrl ?? null,
          note: cmd.note ?? null,
          attemptId: last?.id ?? null,
        };
        await evidenceRepo.create(
          {
            id: newId('remoteEvidence'),
            publicationId: row.id,
            attemptId: last?.id ?? null,
            kind: 'human_confirmation',
            remotePostId: cmd.remotePostId,
            remoteUrl: cmd.remoteUrl ?? null,
            payload,
            payloadHash: hashCanonical(payload),
            capturedAt: new Date(),
          },
          tx,
        );
        if (last && !last.remotePostId) await attemptsRepo.attachRemotePost(last.id, cmd.remotePostId, tx);
        const toState = transition(row.state, 'reconcile_found', 'publicationId');
        await publicationsRepo.update(
          row.id,
          row.version,
          {
            state: toState,
            remotePostId: cmd.remotePostId,
            remoteUrl: cmd.remoteUrl ?? null,
            stateReason: 'human_confirmed',
          },
          tx,
        );
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
        await recordStateChange(actor, 'publication.reconcile', row, toState, 'confirm_published', tx);
        break;
      }
      case 'confirm_absent': {
        const toState = transition(row.state, 'reconcile_absent', 'publicationId');
        await publicationsRepo.update(
          row.id,
          row.version,
          { state: toState, stateReason: 'human_confirmed_absent' },
          tx,
        );
        await recordStateChange(actor, 'publication.reconcile', row, toState, 'confirm_absent', tx);
        break;
      }
      case 'cancel': {
        const toState = transition(row.state, 'hold_resolved_cancel', 'publicationId');
        await publicationsRepo.update(
          row.id,
          row.version,
          { state: toState, stateReason: 'human_cancelled' },
          tx,
        );
        await recordStateChange(actor, 'publication.reconcile', row, toState, 'cancel', tx);
        break;
      }
    }
    return toPublicationDto(await publicationsRepo.getById(row.id, tx));
  },

  /**
   * Spec 13.5: deleting a live remote post is its own action (publication.delete_remote), never automatic. The
   * request is recorded as a remote change and emitted; publicationRemoteDeleteWorkflowV1 carries it out on the
   * provider's queue and records the outcome (published → removed, or the failure reason on the change).
   */
  async deleteRemote(actor: ResolvedActor, input: z.infer<typeof PublicationDeleteRemote>, tx: Tx) {
    const cmd = PublicationDeleteRemote.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.delete_remote', publicationResource(row), {}, tx);
    return requestRemoval(actor, row, 'delete', cmd.reason, tx);
  },

  /**
   * R2-3 rollback (publication.delete_remote): a published article is set back to a draft on its website. The
   * request is a remote change of kind `unpublish`, carried out by publicationRemoteDeleteWorkflowV1 on the
   * destination's queue (the same converging call shape as a delete); the publication stays published and the
   * website's confirmation is recorded as `remote_unpublish` evidence.
   */
  async unpublishRemote(actor: ResolvedActor, input: z.infer<typeof PublicationUnpublishRemote>, tx: Tx) {
    const cmd = PublicationUnpublishRemote.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.delete_remote', publicationResource(row), {}, tx);
    return requestRemoval(actor, row, 'unpublish', cmd.reason, tx);
  },

  /**
   * R2-3 on-demand validation (brand.read): the published page is fetched again, checked and the result stored as
   * `rendered_validation` evidence. No credential is used (the page is public), so the API process runs it.
   */
  async validateRendered(actor: ResolvedActor, input: PublicationValidateRendered, tx: Tx) {
    const parsed = PublicationValidateRendered.parse(input);
    const row = await publicationsRepo.getById(parsed.publicationId, tx);
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    if (!row.destinationId || row.state !== 'published' || !row.remoteUrl)
      throw new ValidationFailedError(
        [{ path: 'publicationId', issue: 'not_a_published_article' }],
        'Only a published article with a page address can be validated',
      );
    const variant = await variants.get(row.channelVariantId, tx);
    if (!variant.article)
      throw new ValidationFailedError([{ path: 'publicationId', issue: 'article_missing' }]);
    const readback = await evidenceRepo.latestOfKind(row.id, 'remote_readback', tx);
    const draft = readback ? readback.payload['status'] !== 'publish' : true;
    const result = await destinations.validateRendered({
      tenantId: row.tenantId,
      destinationId: row.destinationId,
      url: row.remoteUrl,
      title: variant.article.title,
      firstParagraph: articleFirstParagraph(variant.article),
      draft,
    });
    const payload = { ...result, checks: result.checks };
    await evidenceRepo.create(
      {
        id: newId('remoteEvidence'),
        publicationId: row.id,
        attemptId: null,
        kind: 'rendered_validation',
        remotePostId: row.remotePostId,
        remoteUrl: row.remoteUrl,
        payload,
        payloadHash: hashCanonical(payload),
        capturedAt: new Date(),
      },
      tx,
    );
    await audit.record(
      actorRef(actor),
      'publication.validate_rendered',
      { type: 'publication', id: row.id },
      renderedValidationOk(result.checks) ? 'allowed' : 'denied',
      tx,
      {
        brandId: row.brandId,
        publicationId: row.id,
        destinationId: row.destinationId,
        reason:
          result.checks
            .filter((c) => !c.ok)
            .map((c) => c.key)
            .join(',') || null,
      },
    );
    return result;
  },

  /**
   * publication.edit_remote: new text for a live post on a channel whose capability allows edits. The text passes
   * the same capability check as a variant; it is stored on the remote change (never over the variant or the
   * release evidence) and publicationRemoteEditWorkflowV1 carries it out and records the outcome.
   */
  async editRemote(actor: ResolvedActor, input: z.infer<typeof PublicationEditRemote>, tx: Tx) {
    const cmd = PublicationEditRemote.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.edit_remote', publicationResource(row), {}, tx);
    const { providerKey } = await assertRemoteChangeAllowed(row, 'edit', tx);
    if (cmd.text.trim() === '')
      throw new ValidationFailedError([{ path: 'text', issue: 'text_empty' }], 'The new text is empty');
    const current =
      (await changesRepo.latestSucceededEdit(row.id, tx))?.text ??
      (await variants.get(row.channelVariantId, tx)).text;
    if (hashText(current) === hashText(cmd.text))
      throw new ValidationFailedError(
        [{ path: 'text', issue: 'text_unchanged' }],
        'The new text is the same as the live text',
      );
    // For an article (R2-3) the text is the new body: the destination's rules apply (sanitised at send).
    const check = await channelService.validateVariantDetailed(row.channelVariantId, tx, { text: cmd.text });
    const textIssues = check.issues.filter((i) => i.path === 'text');
    if (textIssues.length > 0)
      throw new ValidationFailedError(textIssues, 'The new text does not pass the channel capability check');
    const changeId = newId('publicationRemoteChange');
    const textHash = hashText(cmd.text);
    await changesRepo.create(
      {
        id: changeId,
        brandId: row.brandId,
        publicationId: row.id,
        kind: 'edit',
        state: 'requested',
        text: cmd.text,
        textHash,
        reason: cmd.reason ?? null,
        requestedByKind: scheduledByOf(actor),
        requestedById: actor.id,
        requestedAt: new Date(),
      },
      tx,
    );
    await audit.record(
      actorRef(actor),
      'publication.edit_remote',
      { type: 'publication', id: row.id },
      'allowed',
      tx,
      {
        brandId: row.brandId,
        publicationId: row.id,
        ...(row.channelConnectionId ? { channelConnectionId: row.channelConnectionId } : {}),
        ...(row.destinationId ? { destinationId: row.destinationId } : {}),
        reason: cmd.reason ?? null,
      },
    );
    await outbox.add(
      'publication.edit_remote_requested',
      { type: 'publication', id: row.id, version: row.version },
      {
        publicationId: row.id,
        changeId,
        textHash,
        providerKey,
        workflowId: remoteChangeWorkflowId(row.id, changeId),
        requestedByKind: actor.kind,
        requestedById: actor.id,
      },
      tx,
      { brandId: row.brandId },
    );
    return { accepted: true, publicationId: row.id, changeId };
  },

  /** Review module release checker (spec 13.4 mandate_daily_quota). */
  countForMandateOnDay: (mandateId: string, at: Date, tx?: Tx) =>
    publicationsRepo.countForMandateOnDay(mandateId, at, tx),
  /** Release check owned here (spec 13.1 single use per target): another published publication on this channel under the approval. */
  publishedElsewhereForApprovalChannel: (
    approvalId: string,
    channelConnectionId: string,
    exceptPublicationId: string,
    tx?: Tx,
  ) =>
    publicationsRepo.publishedElsewhereForApprovalChannel(
      approvalId,
      channelConnectionId,
      exceptPublicationId,
      tx,
    ),

  /**
   * Content module calendar source (spec 7.5 content.calendar.range): publications of a brand in a window, newest
   * first, the window applied in the query so an old window is read as it was (never the newest rows filtered).
   */
  async calendarRange(brandId: string, from: Date, to: Date, tx?: Tx) {
    const rows = await publicationsRepo.listScheduledBetween(brandId, from, to, CALENDAR_RANGE_MAX, tx);
    return rows.map((p) => ({
      publicationId: p.id,
      contentPackageId: p.contentPackageId,
      contentRevisionId: p.contentRevisionId,
      channelVariantId: p.channelVariantId,
      channelConnectionId: p.channelConnectionId,
      destinationId: p.destinationId,
      scheduledFor: p.scheduledFor.toISOString(),
      state: p.state,
    }));
  },
};
