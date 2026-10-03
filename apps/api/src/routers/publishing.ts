import {
  CancelCommand,
  ChannelConnectCancel,
  ChannelConnectComplete,
  ChannelConnectSelect,
  ChannelConnectStart,
  ChannelDisconnect,
  ChannelLimitsList,
  ChannelList,
  PublicationDeleteRemote,
  PublicationEditRemote,
  PublicationUnpublishRemote,
  PublicationValidateRendered,
  PublicationEvidence,
  PublicationGet,
  PublicationHoldRestored,
  PublicationList,
  ReconcileCommand,
  RescheduleCommand,
  ScheduleCommand,
} from '@oremedia/contracts/publishing';
import { channelService, publicationService } from '@oremedia/module-publishing';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

/** Spec 7.3: publication commands keep their idempotency record for 72 hours. */
const mutationCtx = (ctx: MutationCtx, ttlHours?: number) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
  ...(ttlHours ? { ttlHours } : {}),
});

/** Spec 7.5 publishing router (spec 14.1 scheduling joins the idempotent transaction; 13.5 cancel; 14.7 channels). */
export const publishingRouter = router({
  channels: router({
    connect: router({
      start: tenantMutation
        .input(ChannelConnectStart)
        .mutation(({ ctx, input }) =>
          idempotent(mutationCtx(ctx), (tx) => channelService.connect.start(ctx.tenant.actor, input, tx)),
        ),
      complete: tenantMutation
        .input(ChannelConnectComplete)
        .mutation(({ ctx, input }) =>
          idempotent(mutationCtx(ctx), (tx) => channelService.connect.complete(ctx.tenant.actor, input, tx)),
        ),
      select: tenantMutation
        .input(ChannelConnectSelect)
        .mutation(({ ctx, input }) =>
          idempotent(mutationCtx(ctx), (tx) => channelService.connect.select(ctx.tenant.actor, input, tx)),
        ),
      cancel: tenantMutation
        .input(ChannelConnectCancel)
        .mutation(({ ctx, input }) =>
          idempotent(mutationCtx(ctx), (tx) => channelService.connect.cancel(ctx.tenant.actor, input, tx)),
        ),
    }),
    list: tenantQuery
      .input(ChannelList)
      .query(({ ctx, input }) => channelService.list(ctx.tenant.actor, input)),
    /** BSC-1: the channel providers' platform limits, read-only beside the brand's channel guidance. */
    limits: tenantQuery
      .input(ChannelLimitsList)
      .query(({ ctx, input }) => channelService.limits(ctx.tenant.actor, input)),
    disconnect: tenantMutation
      .input(ChannelDisconnect)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => channelService.disconnect(ctx.tenant.actor, input, tx)),
      ),
  }),
  publications: router({
    schedule: tenantMutation
      .input(ScheduleCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.schedule(ctx.tenant.actor, input, tx)),
      ),
    cancel: tenantMutation
      .input(CancelCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.cancel(ctx.tenant.actor, input, tx)),
      ),
    reschedule: tenantMutation
      .input(RescheduleCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.reschedule(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(PublicationGet)
      .query(({ ctx, input }) => publicationService.get(ctx.tenant.actor, input)),
    list: tenantQuery
      .input(PublicationList)
      .query(({ ctx, input }) => publicationService.list(ctx.tenant.actor, input)),
    evidence: tenantQuery
      .input(PublicationEvidence)
      .query(({ ctx, input }) => publicationService.evidence(ctx.tenant.actor, input)),
    reconcile: tenantMutation
      .input(ReconcileCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.reconcile(ctx.tenant.actor, input, tx)),
      ),
    /**
     * Runbook "restore a single tenant", step 5 (spec 17.6): the restored tenant's (or one brand's) in-flight
     * publications are held, or handed to reconciliation when their attempt was sent; a tenant admin's command, one
     * bounded batch per call (repeat while hasMore).
     */
    holdRestored: tenantMutation
      .input(PublicationHoldRestored)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) =>
          publicationService.holdRestored(ctx.tenant.actor, input, tx),
        ),
      ),
    deleteRemote: tenantMutation
      .input(PublicationDeleteRemote)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) =>
          publicationService.deleteRemote(ctx.tenant.actor, input, tx),
        ),
      ),
    /** New text for a live post where the channel allows edits (publication.edit_remote); carried out by a workflow. */
    editRemote: tenantMutation
      .input(PublicationEditRemote)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.editRemote(ctx.tenant.actor, input, tx)),
      ),
    /** R2-3 rollback: a published article set back to a draft on its website (publication.delete_remote). */
    unpublishRemote: tenantMutation
      .input(PublicationUnpublishRemote)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) =>
          publicationService.unpublishRemote(ctx.tenant.actor, input, tx),
        ),
      ),
    /** R2-3: the published page fetched again and checked; the result is recorded as publication evidence. */
    validateRendered: tenantMutation
      .input(PublicationValidateRendered)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          publicationService.validateRendered(ctx.tenant.actor, input, tx),
        ),
      ),
  }),
});
