import {
  CommentAdd,
  CommentList,
  CommentResolve,
  DocumentCreate,
  DocumentDuplicate,
  DocumentGet,
  DocumentList,
  DocumentRename,
  OperationsApply,
  OperationsPropose,
  RenderCancel,
  RenderGet,
  RenderRequest,
  RevisionGet,
  RevisionList,
  TemplateApprove,
  TemplateCreate,
  TemplateGet,
  TemplateList,
  TemplateListCurrent,
  TemplateRetire,
  TemplateVersionCreate,
} from '@oremedia/contracts/creative';
import {
  GenerationActive,
  GenerationCancel,
  GenerationGet,
  GenerationPreflight,
  GenerationRetry,
  GenerationStart,
} from '@oremedia/contracts/generation';
import { VideoOperationsApply, VideoOperationsPropose, VideoTemplateList } from '@oremedia/contracts/video';
import {
  VideoAiAccept,
  VideoAiActive,
  VideoAiAssemble,
  VideoAiCancel,
  VideoAiGet,
  VideoAiPreflight,
  VideoAiRetry,
  VideoAiSaveDraft,
  VideoAiStart,
} from '@oremedia/contracts/video-ai';
import { creativeService, generationService, videoAiService } from '@oremedia/module-creative';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 creative router (spec 11: documents, revisions, the operation engine, renders, comments, templates). */
export const creativeRouter = router({
  documents: router({
    create: tenantMutation
      .input(DocumentCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.documents.create(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(DocumentGet)
      .query(({ ctx, input }) => creativeService.documents.get(ctx.tenant.actor, input)),
    list: tenantQuery
      .input(DocumentList)
      .query(({ ctx, input }) => creativeService.documents.list(ctx.tenant.actor, input)),
    /** STU-1a: a copy whose revision 1 is the source's current revision (provenance in the audit). */
    duplicate: tenantMutation
      .input(DocumentDuplicate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          creativeService.documents.duplicate(ctx.tenant.actor, input, tx),
        ),
      ),
    rename: tenantMutation
      .input(DocumentRename)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.documents.rename(ctx.tenant.actor, input, tx)),
      ),
  }),

  revisions: router({
    list: tenantQuery
      .input(RevisionList)
      .query(({ ctx, input }) => creativeService.revisions.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(RevisionGet)
      .query(({ ctx, input }) => creativeService.revisions.get(ctx.tenant.actor, input)),
  }),

  operations: router({
    /** Spec 7.5 names this operations.apply; tRPC reserves `apply` as a router key, so the procedure is applyBatch. */
    applyBatch: tenantMutation
      .input(OperationsApply)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.operations.apply(ctx.tenant.actor, input, tx)),
      ),
    /** Agent preview (spec 11.4): the same guards and validation as a dry run; nothing is committed. */
    propose: tenantMutation
      .input(OperationsPropose)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.operations.propose(ctx.tenant.actor, input, tx)),
      ),
    /** STU-2b: timeline operations on a video document (same flow as applyBatch). */
    applyVideo: tenantMutation
      .input(VideoOperationsApply)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          creativeService.videoOperations.apply(ctx.tenant.actor, input, tx),
        ),
      ),
    /** STU-2b: the dry run of timeline operations; nothing is committed. */
    proposeVideo: tenantMutation
      .input(VideoOperationsPropose)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          creativeService.videoOperations.propose(ctx.tenant.actor, input, tx),
        ),
      ),
  }),

  renders: router({
    request: tenantMutation
      .input(RenderRequest)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.renders.request(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(RenderGet)
      .query(({ ctx, input }) => creativeService.renders.get(ctx.tenant.actor, input)),
    /** STU-2b: signed URLs of a ready job's exports (video, poster, captions) to play or download. */
    exportMedia: tenantQuery
      .input(RenderGet)
      .query(({ ctx, input }) => creativeService.renders.exportMedia(ctx.tenant.actor, input)),
    /** STU-2a/2b: stop a pending or rendering job; a running video render is signalled and ffmpeg stops. */
    cancel: tenantMutation
      .input(RenderCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.renders.cancel(ctx.tenant.actor, input, tx)),
      ),
  }),

  /** STU-2b: the built-in starter video templates (the creation screen lists them). */
  videoTemplates: router({
    list: tenantQuery
      .input(VideoTemplateList)
      .query(({ ctx, input }) => creativeService.videoTemplates.list(ctx.tenant.actor, input)),
  }),

  /**
   * STU-3: AI storyboards and recuts of a video document as durable jobs (preflight, start, reattach, cancel, retry),
   * assembly of a storyboard into the timeline, and accept of a proposal per change group.
   */
  videoAi: router({
    preflight: tenantQuery
      .input(VideoAiPreflight)
      .query(({ ctx, input }) => videoAiService.preflight(ctx.tenant.actor, input)),
    start: tenantMutation
      .input(VideoAiStart)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => videoAiService.start(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery.input(VideoAiGet).query(({ ctx, input }) => videoAiService.get(ctx.tenant.actor, input)),
    active: tenantQuery
      .input(VideoAiActive)
      .query(({ ctx, input }) => videoAiService.active(ctx.tenant.actor, input)),
    cancel: tenantMutation
      .input(VideoAiCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => videoAiService.cancel(ctx.tenant.actor, input, tx)),
      ),
    retry: tenantMutation
      .input(VideoAiRetry)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => videoAiService.retry(ctx.tenant.actor, input, tx)),
      ),
    saveDraft: tenantMutation
      .input(VideoAiSaveDraft)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => videoAiService.saveDraft(ctx.tenant.actor, input, tx)),
      ),
    assemble: tenantMutation
      .input(VideoAiAssemble)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => videoAiService.assemble(ctx.tenant.actor, input, tx)),
      ),
    accept: tenantMutation
      .input(VideoAiAccept)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => videoAiService.accept(ctx.tenant.actor, input, tx)),
      ),
  }),

  comments: router({
    add: tenantMutation
      .input(CommentAdd)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.comments.add(ctx.tenant.actor, input, tx)),
      ),
    resolve: tenantMutation
      .input(CommentResolve)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.comments.resolve(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(CommentList)
      .query(({ ctx, input }) => creativeService.comments.list(ctx.tenant.actor, input)),
  }),

  templates: router({
    create: tenantMutation
      .input(TemplateCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.templates.create(ctx.tenant.actor, input, tx)),
      ),
    createVersion: tenantMutation
      .input(TemplateVersionCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          creativeService.templates.createVersion(ctx.tenant.actor, input, tx),
        ),
      ),
    approve: tenantMutation
      .input(TemplateApprove)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.templates.approve(ctx.tenant.actor, input, tx)),
      ),
    retire: tenantMutation
      .input(TemplateRetire)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.templates.retire(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(TemplateList)
      .query(({ ctx, input }) => creativeService.templates.list(ctx.tenant.actor, input)),
    listCurrent: tenantQuery
      .input(TemplateListCurrent)
      .query(({ ctx, input }) => creativeService.templates.listCurrent(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(TemplateGet)
      .query(({ ctx, input }) => creativeService.templates.get(ctx.tenant.actor, input)),
  }),

  /** STU-1b: generation and targeted refinement as durable jobs (studioGenerationWorkflowV1). */
  generation: router({
    /** Inputs, constraints, issues and cost of a request; nothing is written. */
    preflight: tenantQuery
      .input(GenerationPreflight)
      .query(({ ctx, input }) => generationService.preflight(ctx.tenant.actor, input)),
    start: tenantMutation
      .input(GenerationStart)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => generationService.start(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(GenerationGet)
      .query(({ ctx, input }) => generationService.get(ctx.tenant.actor, input)),
    /** The document's live jobs and its last finished one: the studio reattaches after a reload. */
    active: tenantQuery
      .input(GenerationActive)
      .query(({ ctx, input }) => generationService.active(ctx.tenant.actor, input)),
    cancel: tenantMutation
      .input(GenerationCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => generationService.cancel(ctx.tenant.actor, input, tx)),
      ),
    retry: tenantMutation
      .input(GenerationRetry)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => generationService.retry(ctx.tenant.actor, input, tx)),
      ),
  }),
});
