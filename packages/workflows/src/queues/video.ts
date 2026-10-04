// Workflow entry for task queue `video` (STU-2a: video and audio ingest on worker-render, ffmpeg + ffprobe in the
// render image; long jobs on their own queue and concurrency so they never starve `render` or `media`). Bundled at
// build time by apps/worker-render (bundleWorkflowCode) into dist/workflows.video.js.
export { videoIngestWorkflowV1 } from '../video-ingest.workflow.v1';
