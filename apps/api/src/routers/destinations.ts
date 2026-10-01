import {
  DestinationDisconnect,
  DestinationGet,
  DestinationList,
  DestinationRegister,
  DestinationSetHealth,
  SourceUseCheck,
  SourceUsePolicyList,
  SourceUsePolicySet,
} from '@oremedia/contracts/destinations';
import { destinationService, sourceUsePolicyService } from '@oremedia/module-destinations';
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
