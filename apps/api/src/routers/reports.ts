import {
  ReportAsk,
  ReportDelivery,
  ReportDraftSummary,
  ReportFigures,
  ReportGet,
  ReportList,
  ReportMarkSent,
  ReportPreferencesGet,
  ReportPreferencesSet,
  ReportSave,
} from '@oremedia/contracts/reports';
import { idempotent } from '@oremedia/module-operations';
import { reportsService } from '@oremedia/module-reports';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/**
 * D-29 reports router: the brand's reports and the month's builder state, the figures composed from the
 * measurement module, the model-drafted summary and assistant (mutations: they spend budget and replay under their
 * idempotency key), the deployment's delivery state, the send record and the per-brand preference.
 */
export const reportsRouter = router({
  list: tenantQuery.input(ReportList).query(({ ctx, input }) => reportsService.list(ctx.tenant.actor, input)),
  get: tenantQuery.input(ReportGet).query(({ ctx, input }) => reportsService.get(ctx.tenant.actor, input)),
  figures: tenantQuery
    .input(ReportFigures)
    .query(({ ctx, input }) => reportsService.figures(ctx.tenant.actor, input)),
  delivery: tenantQuery
    .input(ReportDelivery)
    .query(({ ctx, input }) => reportsService.delivery(ctx.tenant.actor, input)),
  save: tenantMutation
    .input(ReportSave)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => reportsService.save(ctx.tenant.actor, input, tx)),
    ),
  markSent: tenantMutation
    .input(ReportMarkSent)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => reportsService.markSent(ctx.tenant.actor, input, tx)),
    ),
  draftSummary: tenantMutation
    .input(ReportDraftSummary)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => reportsService.draftSummary(ctx.tenant.actor, input, tx)),
    ),
  ask: tenantMutation
    .input(ReportAsk)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => reportsService.ask(ctx.tenant.actor, input, tx)),
    ),
  preferences: router({
    get: tenantQuery
      .input(ReportPreferencesGet)
      .query(({ ctx, input }) => reportsService.preferences.get(ctx.tenant.actor, input)),
    set: tenantMutation
      .input(ReportPreferencesSet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => reportsService.preferences.set(ctx.tenant.actor, input, tx)),
      ),
  }),
});
