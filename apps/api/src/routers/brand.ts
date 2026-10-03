import { z } from 'zod';
import {
  BrandClassify,
  BrandCompleteSetup,
  BrandCreate,
  BrandGuidelinesImport,
  BrandVersionCreateDraft,
  BrandVersionGet,
  BrandVersionImpact,
  BrandVersionList,
  BrandVersionPublish,
  BrandVersionSubmit,
  BrandVersionUpdate,
  FactApprove,
  FactCorrect,
  FactList,
  FactMarkReviewed,
  FactMerge,
  FactPropose,
  FactResolveConflict,
  FactRevoke,
  FactUpdate,
  FactWithdraw,
  ObjectiveList,
  ObjectiveSet,
  OnboardingStart,
  PolicyGet,
  PolicyVersionActivate,
  PolicyVersionCreate,
  BrandSystemSave,
  BrandProposalDiscard,
} from '@oremedia/contracts/brand';
import {
  BrandAssistAnswer,
  BrandAssistCancel,
  BrandAssistGet,
  BrandAssistList,
  BrandAssistRequest,
  BrandHistoryCompare,
  BrandHistoryList,
  BrandHistoryRestore,
  BrandSourceAdd,
  BrandSourceGet,
  BrandSourceList,
  BrandSourceRemove,
  BrandSuggestionAccept,
  BrandSuggestionAcceptAll,
  BrandSuggestionEdit,
  BrandSuggestionList,
  BrandSuggestionReject,
  BrandSuggestionUndo,
} from '@oremedia/contracts/brand-assist';
import { brandAssistService, brandService } from '@oremedia/module-brand';
import { idempotent } from '@oremedia/module-operations';
import { publicationService } from '@oremedia/module-publishing';
import { reviewService } from '@oremedia/module-review';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 brand router: brands, versions, facts, objectives, policy versions and the onboarding run (Phase 4 stub). */
export const brandRouter = router({
  create: tenantMutation
    .input(BrandCreate)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => brandService.create(ctx.tenant.actor, input, tx)),
    ),
  /** D-11: client or internal; decides whether a distinct approver is needed when no release policy says. */
  classify: tenantMutation
    .input(BrandClassify)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => brandService.classify(ctx.tenant.actor, input, tx)),
    ),
  completeSetup: tenantMutation
    .input(BrandCompleteSetup)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => brandService.completeSetup(ctx.tenant.actor, input, tx)),
    ),
  list: tenantQuery.query(({ ctx }) => brandService.list(ctx.tenant.actor)),
  get: tenantQuery
    .input(z.object({ brandId: z.string() }))
    .query(({ ctx, input }) => brandService.get(ctx.tenant.actor, input.brandId)),
  /**
   * The company page and portfolio: per brand the actor may see, open review requests past their due time,
   * publications that need a person (failed, outcome unknown, held) and publications due in the upcoming window.
   */
  summary: tenantQuery.query(async ({ ctx }) => {
    const now = new Date();
    const [brands, overdue, attention] = await Promise.all([
      brandService.list(ctx.tenant.actor),
      reviewService.inbox.overdueByBrand(ctx.tenant.actor, now),
      publicationService.attentionByBrand(ctx.tenant.actor, now),
    ]);
    const overdueOf = new Map(overdue.map((o) => [o.brandId, o.count]));
    const attentionOf = new Map(attention.brands.map((a) => [a.brandId, a]));
    return {
      upcomingDays: attention.upcomingDays,
      brands: brands.map((b) => ({
        brandId: b.id,
        overdueApprovals: overdueOf.get(b.id) ?? 0,
        publicationsNeedingPerson: attentionOf.get(b.id)?.needsPerson ?? 0,
        upcomingPublications: attentionOf.get(b.id)?.upcoming ?? 0,
      })),
    };
  }),

  versions: router({
    createDraft: tenantMutation
      .input(BrandVersionCreateDraft)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.versions.createDraft(ctx.tenant.actor, input, tx)),
      ),
    update: tenantMutation
      .input(BrandVersionUpdate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.versions.update(ctx.tenant.actor, input, tx)),
      ),
    submitForReview: tenantMutation
      .input(BrandVersionSubmit)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          brandService.versions.submitForReview(ctx.tenant.actor, input, tx),
        ),
      ),
    publish: tenantMutation
      .input(BrandVersionPublish)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.versions.publish(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(BrandVersionList)
      .query(({ ctx, input }) => brandService.versions.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(BrandVersionGet)
      .query(({ ctx, input }) => brandService.versions.get(ctx.tenant.actor, input)),
    impact: tenantQuery
      .input(BrandVersionImpact)
      .query(({ ctx, input }) => brandService.versions.impact(ctx.tenant.actor, input)),
  }),

  /** D-22: one brand system, edited and saved in place; proposals are applied by a save or discarded. */
  system: router({
    save: tenantMutation
      .input(BrandSystemSave)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.system.save(ctx.tenant.actor, input, tx)),
      ),
    discardProposal: tenantMutation
      .input(BrandProposalDiscard)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          brandService.system.discardProposal(ctx.tenant.actor, input, tx),
        ),
      ),
  }),

  facts: router({
    propose: tenantMutation
      .input(FactPropose)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.propose(ctx.tenant.actor, input, tx)),
      ),
    approve: tenantMutation
      .input(FactApprove)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.approve(ctx.tenant.actor, input, tx)),
      ),
    revoke: tenantMutation
      .input(FactRevoke)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.revoke(ctx.tenant.actor, input, tx)),
      ),
    /** BSC-3: edit a proposed fact. */
    update: tenantMutation
      .input(FactUpdate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.update(ctx.tenant.actor, input, tx)),
      ),
    /** BSC-3: revoke with a required reason. */
    withdraw: tenantMutation
      .input(FactWithdraw)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.withdraw(ctx.tenant.actor, input, tx)),
      ),
    /** BSC-3: a proposed correction that supersedes the approved fact once approved. */
    correct: tenantMutation
      .input(FactCorrect)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.correct(ctx.tenant.actor, input, tx)),
      ),
    /** BSC-3: keep one fact; the others become superseded by it. */
    merge: tenantMutation
      .input(FactMerge)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.merge(ctx.tenant.actor, input, tx)),
      ),
    markReviewed: tenantMutation
      .input(FactMarkReviewed)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.markReviewed(ctx.tenant.actor, input, tx)),
      ),
    resolveConflict: tenantMutation
      .input(FactResolveConflict)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.facts.resolveConflict(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(FactList)
      .query(({ ctx, input }) => brandService.facts.list(ctx.tenant.actor, input)),
  }),

  objectives: router({
    set: tenantMutation
      .input(ObjectiveSet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.objectives.set(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(ObjectiveList)
      .query(({ ctx, input }) => brandService.objectives.list(ctx.tenant.actor, input)),
  }),

  policy: router({
    createVersion: tenantMutation
      .input(PolicyVersionCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.policy.createVersion(ctx.tenant.actor, input, tx)),
      ),
    activate: tenantMutation
      .input(PolicyVersionActivate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.policy.activate(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(PolicyGet)
      .query(({ ctx, input }) => brandService.policy.get(ctx.tenant.actor, input)),
  }),

  guidelines: router({
    /** Imports a brand skill as a new draft version carrying its guidelines and palette (people only). */
    import: tenantMutation
      .input(BrandGuidelinesImport)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.guidelines.import(ctx.tenant.actor, input, tx)),
      ),
  }),

  /** BSC-4: material supplied for AI-assisted setup (websites, documents, pasted text, the brand's own assets). */
  sources: router({
    add: tenantMutation
      .input(BrandSourceAdd)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandAssistService.sources.add(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(BrandSourceList)
      .query(({ ctx, input }) => brandAssistService.sources.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(BrandSourceGet)
      .query(({ ctx, input }) => brandAssistService.sources.get(ctx.tenant.actor, input)),
    remove: tenantMutation
      .input(BrandSourceRemove)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandAssistService.sources.remove(ctx.tenant.actor, input, tx)),
      ),
  }),

  /** BSC-4 / BSC-5: AI assist jobs (guided setup, the section and overall assistants); they only ever suggest. */
  assist: router({
    estimate: tenantQuery
      .input(BrandAssistRequest)
      .query(({ ctx, input }) => brandAssistService.assist.estimate(ctx.tenant.actor, input)),
    start: tenantMutation
      .input(BrandAssistRequest)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandAssistService.assist.start(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(BrandAssistGet)
      .query(({ ctx, input }) => brandAssistService.assist.get(ctx.tenant.actor, input)),
    list: tenantQuery
      .input(BrandAssistList)
      .query(({ ctx, input }) => brandAssistService.assist.list(ctx.tenant.actor, input)),
    cancel: tenantMutation
      .input(BrandAssistCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandAssistService.assist.cancel(ctx.tenant.actor, input, tx)),
      ),
    answer: tenantMutation
      .input(BrandAssistAnswer)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandAssistService.assist.answer(ctx.tenant.actor, input, tx)),
      ),
  }),

  /** BSC-4: a person accepts, edits or rejects each suggestion; accepted ones land in the pending proposal. */
  suggestions: router({
    list: tenantQuery
      .input(BrandSuggestionList)
      .query(({ ctx, input }) => brandAssistService.suggestions.list(ctx.tenant.actor, input)),
    accept: tenantMutation
      .input(BrandSuggestionAccept)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          brandAssistService.suggestions.accept(ctx.tenant.actor, input, tx),
        ),
      ),
    edit: tenantMutation
      .input(BrandSuggestionEdit)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          brandAssistService.suggestions.edit(ctx.tenant.actor, input, tx),
        ),
      ),
    reject: tenantMutation
      .input(BrandSuggestionReject)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          brandAssistService.suggestions.reject(ctx.tenant.actor, input, tx),
        ),
      ),
    acceptAll: tenantMutation
      .input(BrandSuggestionAcceptAll)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          brandAssistService.suggestions.acceptAll(ctx.tenant.actor, input, tx),
        ),
      ),
    undo: tenantMutation
      .input(BrandSuggestionUndo)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          brandAssistService.suggestions.undo(ctx.tenant.actor, input, tx),
        ),
      ),
  }),

  /** BSC-5: the applied versions, compared with the brand system now and restored through a normal save. */
  history: router({
    list: tenantQuery
      .input(BrandHistoryList)
      .query(({ ctx, input }) => brandAssistService.history.list(ctx.tenant.actor, input)),
    compare: tenantQuery
      .input(BrandHistoryCompare)
      .query(({ ctx, input }) => brandAssistService.history.compare(ctx.tenant.actor, input)),
    restore: tenantMutation
      .input(BrandHistoryRestore)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandAssistService.history.restore(ctx.tenant.actor, input, tx)),
      ),
  }),

  onboarding: router({
    /** Spec 8.2: an agent run (Phase 4). Until the agent runtime exists the service refuses with not_available_yet. */
    start: tenantMutation
      .input(OnboardingStart)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => brandService.startOnboarding(ctx.tenant.actor, input, tx)),
      ),
  }),
});
