import {
  BriefAccept,
  BriefCreate,
  BriefGet,
  BriefList,
  CalendarRange,
  CampaignClose,
  CampaignCreate,
  CampaignGet,
  CampaignList,
  CampaignUpdate,
  ChannelVariantGenerate,
  ChannelVariantGet,
  ChannelVariantUpdate,
  ContentPackageCreate,
  ContentPackageGet,
  ContentPackageList,
  ContentPackageListForDocument,
  ContentPackageRevise,
  ContentRevisionGet,
  PlanItemDrop,
  PlanItemList,
  PlanItemRestore,
  PlanItemUpdate,
  PlanItemsPropose,
} from '@oremedia/contracts/content';
import { contentService } from '@oremedia/module-content';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 content router: campaigns, briefs, packages with immutable revisions, channel variants, calendar. */
export const contentRouter = router({
  campaigns: router({
    create: tenantMutation
      .input(CampaignCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.campaigns.create(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(CampaignList)
      .query(({ ctx, input }) => contentService.campaigns.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(CampaignGet)
      .query(({ ctx, input }) => contentService.campaigns.get(ctx.tenant.actor, input)),
    /** G12: name, run dates and objective, version-checked. */
    update: tenantMutation
      .input(CampaignUpdate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.campaigns.update(ctx.tenant.actor, input, tx)),
      ),
    /** G12: draft or active → completed, version-checked and audited. */
    close: tenantMutation
      .input(CampaignClose)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.campaigns.close(ctx.tenant.actor, input, tx)),
      ),
  }),

  briefs: router({
    create: tenantMutation
      .input(BriefCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.briefs.create(ctx.tenant.actor, input, tx)),
      ),
    accept: tenantMutation
      .input(BriefAccept)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.briefs.accept(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(BriefList)
      .query(({ ctx, input }) => contentService.briefs.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(BriefGet)
      .query(({ ctx, input }) => contentService.briefs.get(ctx.tenant.actor, input)),
  }),

  /** UX-09 plan items: the calendar behind a brief; accepting the brief materialises them as packages. */
  planItems: router({
    propose: tenantMutation
      .input(PlanItemsPropose)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.planItems.propose(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(PlanItemList)
      .query(({ ctx, input }) => contentService.planItems.list(ctx.tenant.actor, input)),
    update: tenantMutation
      .input(PlanItemUpdate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.planItems.update(ctx.tenant.actor, input, tx)),
      ),
    drop: tenantMutation
      .input(PlanItemDrop)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.planItems.drop(ctx.tenant.actor, input, tx)),
      ),
    restore: tenantMutation
      .input(PlanItemRestore)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.planItems.restore(ctx.tenant.actor, input, tx)),
      ),
  }),

  packages: router({
    create: tenantMutation
      .input(ContentPackageCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.packages.create(ctx.tenant.actor, input, tx)),
      ),
    revise: tenantMutation
      .input(ContentPackageRevise)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.packages.revise(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(ContentPackageList)
      .query(({ ctx, input }) => contentService.packages.list(ctx.tenant.actor, input)),
    listForDocument: tenantQuery
      .input(ContentPackageListForDocument)
      .query(({ ctx, input }) => contentService.packages.listForDocument(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(ContentPackageGet)
      .query(({ ctx, input }) => contentService.packages.get(ctx.tenant.actor, input)),
  }),

  revisions: router({
    get: tenantQuery
      .input(ContentRevisionGet)
      .query(({ ctx, input }) => contentService.revisions.get(ctx.tenant.actor, input)),
  }),

  variants: router({
    generate: tenantMutation
      .input(ChannelVariantGenerate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.variants.generate(ctx.tenant.actor, input, tx)),
      ),
    update: tenantMutation
      .input(ChannelVariantUpdate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => contentService.variants.update(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(ChannelVariantGet)
      .query(({ ctx, input }) => contentService.variants.get(ctx.tenant.actor, input)),
  }),

  calendar: router({
    range: tenantQuery
      .input(CalendarRange)
      .query(({ ctx, input }) => contentService.calendar.range(ctx.tenant.actor, input)),
  }),
});
