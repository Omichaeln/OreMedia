import {
  DestinationConnectCancel,
  DestinationConnectComplete,
  DestinationConnectSelect,
  DestinationConnectStart,
  DestinationConnectWithSecret,
  DestinationDisconnect,
  DestinationGet,
  DestinationList,
  DestinationRegister,
  DestinationReportOpportunities,
  DestinationReportRows,
  DestinationReportSummary,
  DestinationSetHealth,
  SourceUseCheck,
  SourceUsePolicyList,
  SourceUsePolicySet,
} from '@oremedia/contracts/destinations';
import {
  destinationReportService,
  destinationService,
  sourceUsePolicyService,
} from '@oremedia/module-destinations';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/**
 * Brand destinations (R2-0): the non-social places a brand reads from or writes to, registered, health-checked and
 * disconnected by the people who hold destination.connect / destination.manage; and the source-use policy (D-17)
 * per destination kind and data type, set by an admin (source_use.manage) and asked before any ingestion or write.
 * R2-1: the connect flow that attaches a Google grant (start / complete / select / cancel, as the channel flow) and
 * the sources this deployment can connect; part B: the read model over the stored GA4 and Search Console reports
 * (summary, drill-down rows, opportunities), a restricted view under the brand's source-use policy (brand.read).
 */
export const destinationsRouter = router({
  list: tenantQuery
    .input(DestinationList)
    .query(({ ctx, input }) => destinationService.list(ctx.tenant.actor, input)),
  get: tenantQuery
    .input(DestinationGet)
    .query(({ ctx, input }) => destinationService.get(ctx.tenant.actor, input)),
  register: tenantMutation
    .input(DestinationRegister)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => destinationService.register(ctx.tenant.actor, input, tx)),
    ),
  setHealth: tenantMutation
    .input(DestinationSetHealth)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => destinationService.setHealth(ctx.tenant.actor, input, tx)),
    ),
  disconnect: tenantMutation
    .input(DestinationDisconnect)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => destinationService.disconnect(ctx.tenant.actor, input, tx)),
    ),
  sources: router({
    list: tenantQuery.query(() => destinationService.sources.list()),
  }),
  connect: router({
    start: tenantMutation
      .input(DestinationConnectStart)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => destinationService.connect.start(ctx.tenant.actor, input, tx)),
      ),
    complete: tenantMutation
      .input(DestinationConnectComplete)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          destinationService.connect.complete(ctx.tenant.actor, input, tx),
        ),
      ),
    select: tenantMutation
      .input(DestinationConnectSelect)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => destinationService.connect.select(ctx.tenant.actor, input, tx)),
      ),
    cancel: tenantMutation
      .input(DestinationConnectCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => destinationService.connect.cancel(ctx.tenant.actor, input, tx)),
      ),
    /** R2-3: a website connected with its integration identity and secret, sealed here and verified by the worker. */
    withSecret: tenantMutation
      .input(DestinationConnectWithSecret)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          destinationService.connect.withSecret(ctx.tenant.actor, input, tx),
        ),
      ),
  }),
  reports: router({
    summary: tenantQuery
      .input(DestinationReportSummary)
      .query(({ ctx, input }) => destinationReportService.summary(ctx.tenant.actor, input)),
    rows: tenantQuery
      .input(DestinationReportRows)
      .query(({ ctx, input }) => destinationReportService.rows(ctx.tenant.actor, input)),
    opportunities: tenantQuery
      .input(DestinationReportOpportunities)
      .query(({ ctx, input }) => destinationReportService.opportunities(ctx.tenant.actor, input)),
  }),
  sourceUse: router({
    list: tenantQuery
      .input(SourceUsePolicyList)
      .query(({ ctx, input }) => sourceUsePolicyService.list(ctx.tenant.actor, input)),
    set: tenantMutation
      .input(SourceUsePolicySet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => sourceUsePolicyService.set(ctx.tenant.actor, input, tx)),
      ),
    check: tenantQuery
      .input(SourceUseCheck)
      .query(({ ctx, input }) => sourceUsePolicyService.check(ctx.tenant.actor, input)),
  }),
});
