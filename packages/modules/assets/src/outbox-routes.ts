import { AssetIngestInputV1 } from '@oremedia/contracts/assets';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Task queue for untrusted-input parsing (spec 4.4: worker-render hosts `render` and `media`). */
export const MEDIA_TASK_QUEUE = 'media';
/**
 * Task queue for video and audio processing (STU-2a): ffprobe/ffmpeg jobs that run for minutes, served by
 * worker-render with its own concurrency (VIDEO_CONCURRENCY) so they never starve still renders or image ingest.
 */
export const VIDEO_TASK_QUEUE = 'video';

/** Kinds whose uploads are processed by videoIngestWorkflowV1. */
const VIDEO_INGEST_KINDS = new Set(['video', 'audio']);

/**
 * Spec 9.1: complete(intentId) → assetIngestWorkflowV1. The outbox row is the dedupe authority; the workflow id is
 * stable per upload intent so a redelivered event joins the running workflow instead of starting a second one.
 * STU-2a: a video or audio intent (the event's `kind`) goes to videoIngestWorkflowV1 on task queue `video` under the
 * same workflow id; an event written before `kind` was recorded keeps going to assetIngestWorkflowV1, which is what
 * started it (only generated media could be video or audio then, and v1 still checks those structurally).
 */
export function registerAssetOutboxRoutes(): void {
  registerOutboxRoute('asset.upload_completed', (evt) => {
    const p = evt.payload;
    const input = AssetIngestInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      intentId: p['uploadIntentId'],
      brandId: p['brandId'],
    });
    const video = typeof p['kind'] === 'string' && VIDEO_INGEST_KINDS.has(p['kind']);
    return {
      workflowType: video ? 'videoIngestWorkflowV1' : 'assetIngestWorkflowV1',
      taskQueue: video ? VIDEO_TASK_QUEUE : MEDIA_TASK_QUEUE,
      workflowId: `ingest:${input.intentId}`,
      args: [input],
    };
  });
}
