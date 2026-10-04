import type { RenderJobStore, VideoRenderStore } from '@oremedia/activities';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import { CreativeRevisionRepository, RenderJobRepository, creativeService } from '@oremedia/module-creative';

/**
 * The creative module's render-job surface as the render activities need it (spec 11.5: the worker reports through
 * the module and the job moves only by the render job state machine). The job DTO does not yet carry brandId or
 * documentId, so those two fields are read from the module's public repositories (tenant- and brand-scoped).
 */
export function creativeRenderJobStore(): RenderJobStore & VideoRenderStore {
  const jobs = new RenderJobRepository();
  const revisions = new CreativeRevisionRepository();
  return {
    async getJob(actor, renderJobId) {
      const job = await creativeService.renders.get(actor, { renderJobId }); // re-checks creative.read
      const row = await jobs.getById(renderJobId);
      const revision = await revisions.getById(job.revisionId);
      return {
        renderJobId: job.id,
        state: job.state,
        revisionId: job.revisionId,
        documentId: revision.documentId,
        brandId: row.brandId,
        formatKeys: job.formatKeys,
      };
    },
    async getRevision(actor, documentId, revisionId, renderJobId) {
      // A preview job (spec 11.4) draws the proposed snapshot kept with it, never a committed revision's.
      const preview = renderJobId
        ? await creativeService.renders.previewSource(actor, { renderJobId })
        : null;
      if (preview) return { ...preview, preview: true };
      const r = await creativeService.revisions.get(actor, { documentId, revisionId });
      if (r.kind !== 'graphic')
        throw new ValidationFailedError([{ path: 'documentId', issue: 'document_is_video' }]);
      return {
        snapshot: r.snapshot,
        contentHash: r.contentHash,
        brandVersionId: r.brandVersionId,
        preview: false,
      };
    },
    async markRendering(renderJobId, tx) {
      await creativeService.renders.markRendering({ renderJobId }, tx);
    },
    async markReady(renderJobId, exports, tx) {
      const r = await creativeService.renders.markReady({ renderJobId, exports }, tx);
      return { exportIds: r.exportIds };
    },
    async markFailed(renderJobId, error, tx) {
      await creativeService.renders.markFailed({ renderJobId, error }, tx);
    },
    // STU-2b video renders: the timeline revision (re-checks creative.read), progress and the dedupe lookup.
    async getVideoRevision(actor, documentId, revisionId) {
      const r = await creativeService.revisions.get(actor, { documentId, revisionId });
      if (r.kind !== 'video')
        throw new ValidationFailedError([{ path: 'documentId', issue: 'document_is_graphic' }]);
      return { project: r.snapshot, contentHash: r.contentHash, brandVersionId: r.brandVersionId };
    },
    async markProgress(renderJobId, progress, tx) {
      const r = await creativeService.renders.markProgress({ renderJobId, progress }, tx);
      return { state: r.state };
    },
    async findVideoExport(brandId, dedupeKey) {
      const e = await creativeService.renders.findVideoExport(brandId, dedupeKey);
      if (!e || e.durationMs === null || e.fps === null || e.posterStorageKey === null) return null;
      return {
        storageKey: e.storageKey,
        contentHash: e.contentHash,
        bytes: e.bytes,
        width: e.width,
        height: e.height,
        durationMs: e.durationMs,
        fps: e.fps,
        posterStorageKey: e.posterStorageKey,
        ...(e.captionsStorageKey ? { captionsStorageKey: e.captionsStorageKey } : {}),
      };
    },
  };
}
