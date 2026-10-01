import {
  BudgetRead,
  BudgetSetLimit,
  RoutingPolicySet,
  RunApproveProposal,
  RunCancel,
  RunGet,
  RunList,
  RunStart,
  RunSteps,
} from '@oremedia/contracts/agents';
import { agentsService } from '@oremedia/module-agents';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 agents router (spec 12: runs start through the outbox; decisions and cancels are relayed to the workflow). */
export const agentsRouter = router({
  runs: router({
    start: tenantMutation
      .input(RunStart)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.runs.start(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery.input(RunGet).query(({ ctx, input }) => agentsService.runs.get(ctx.tenant.actor, input)),
    list: tenantQuery
      .input(RunList)
      .query(({ ctx, input }) => agentsService.runs.list(ctx.tenant.actor, input)),
    cancel: tenantMutation
      .input(RunCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.runs.cancel(ctx.tenant.actor, input, tx)),
      ),
    steps: tenantQuery
      .input(RunSteps)
      .query(({ ctx, input }) => agentsService.runs.steps(ctx.tenant.actor, input)),
    approveProposal: tenantMutation
      .input(RunApproveProposal)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.runs.approveProposal(ctx.tenant.actor, input, tx)),
      ),
  }),
  /** UX-16: spend position and limits, owners and admins (billing.manage). */
  budgets: router({
    read: tenantQuery
      .input(BudgetRead)
      .query(({ ctx, input }) => agentsService.budgets.read(ctx.tenant.actor, input)),
    setLimit: tenantMutation
      .input(BudgetSetLimit)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.budgets.setLimit(ctx.tenant.actor, input, tx)),
      ),
  }),
  /** Spec 12.7 tenant model-routing policy: read and replaced by a tenant administrator (billing.manage). */
  routingPolicy: router({
    get: tenantQuery.query(({ ctx }) => agentsService.routingPolicy.get(ctx.tenant.actor)),
    set: tenantMutation
      .input(RoutingPolicySet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.routingPolicy.set(ctx.tenant.actor, input, tx)),
      ),
  }),
});
