import { RenderJobInputV1, VideoRenderSignalV1 } from '@oremedia/contracts/render';
import { StudioVideoJobInputV1, StudioVideoJobSignalV1 } from '@oremedia/contracts/video-ai';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Task queue for isolated rendering (spec 4.4: worker-render hosts `render` and `media`). */
export const RENDER_TASK_QUEUE = 'render';
/** STU-2b: video renders run on worker-render's `video` queue (ffmpeg + Chromium, minutes long, own concurrency). */
export const VIDEO_RENDER_TASK_QUEUE = 'video';
export const VIDEO_RENDER_WORKFLOW_TYPE = 'videoRenderJobWorkflowV1';
export const VIDEO_RENDER_SIGNAL_WORKFLOW_TYPE = 'videoRenderSignalRelayV1';

const renderWorkflowId = (renderJobId: string) => `render:${renderJobId}`;
/** STU-3: studio video AI jobs make model calls, so they run beside agent runs on worker-core's `agents` queue. */
export const VIDEO_AI_TASK_QUEUE = 'agents';
export const STUDIO_VIDEO_JOB_WORKFLOW_TYPE = 'studioVideoJobWorkflowV1';
export const STUDIO_VIDEO_JOB_SIGNAL_RELAY_WORKFLOW_TYPE = 'studioVideoJobSignalRelayV1';
const videoJobWorkflowId = (jobId: string, attempt: number) => `studio-video:${jobId}:${attempt}`;

/**
 * Spec 11.5: creative.renders.request → renderJobWorkflowV1. The workflow id is stable per render job so a
 * redelivered event joins the running workflow; the outbox row is the dedupe authority (spec 14.2). STU-2b: a video
 * document's job (the event's `kind`) goes to videoRenderJobWorkflowV1 on task queue `video` under the same id; a
 * cancellation of it is relayed as a signal by a short relay workflow after the cancel committed (the API needs no
 * Temporal client), like agent run cancellations.
 */
export function registerCreativeOutboxRoutes(): void {
  registerOutboxRoute('creative.render_requested', (evt) => {
    const p = evt.payload;
    const input = RenderJobInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      renderJobId: p['renderJobId'],
    });
    const video = p['kind'] === 'video';
    return {
      workflowType: video ? VIDEO_RENDER_WORKFLOW_TYPE : 'renderJobWorkflowV1',
      taskQueue: video ? VIDEO_RENDER_TASK_QUEUE : RENDER_TASK_QUEUE,
      workflowId: renderWorkflowId(input.renderJobId),
      args: [input],
    };
  });
  registerOutboxRoute('creative.render_cancel_requested', (evt) => {
    const signal = VideoRenderSignalV1.parse({
      workflowId: renderWorkflowId(String(evt.payload['renderJobId'])),
      signal: 'cancelRender',
    });
    return {
      workflowType: VIDEO_RENDER_SIGNAL_WORKFLOW_TYPE,
      taskQueue: VIDEO_RENDER_TASK_QUEUE,
      workflowId: `${signal.workflowId}:signal:${evt.id}`,
      args: [signal],
    };
  });
  // STU-3: start and retry → studioVideoJobWorkflowV1 (one workflow per attempt); cancel → a relay that signals it.
  registerOutboxRoute('creative.video_job_requested', (evt) => {
    const p = evt.payload;
    const input = StudioVideoJobInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      jobId: p['jobId'],
      attempt: Number(p['attempt']),
    });
    return {
      workflowType: STUDIO_VIDEO_JOB_WORKFLOW_TYPE,
      taskQueue: VIDEO_AI_TASK_QUEUE,
      workflowId: videoJobWorkflowId(input.jobId, input.attempt),
      args: [input],
    };
  });
  registerOutboxRoute('creative.video_job_cancel_requested', (evt) => {
    const signal = StudioVideoJobSignalV1.parse({
      workflowId: videoJobWorkflowId(String(evt.payload['jobId']), Number(evt.payload['attempt'])),
      signal: 'cancel',
    });
    return {
      workflowType: STUDIO_VIDEO_JOB_SIGNAL_RELAY_WORKFLOW_TYPE,
      taskQueue: VIDEO_AI_TASK_QUEUE,
      workflowId: `${signal.workflowId}:signal:${evt.id}`,
      args: [signal],
    };
  });
}
