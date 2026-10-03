import {
  CancellationScope,
  defineSignal,
  getExternalWorkflowHandle,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  RenderFailureReason,
  RenderJobInputV1,
  VideoRenderJobActivitiesV1,
  VideoRenderResultV1,
  VideoRenderSignalV1,
} from '@oremedia/contracts/render';
import { failureReason, isFailureOfType } from './render-job.workflow.v1';

/**
 * STU-2b: creative.renders.request on a video document → videoRenderJobWorkflowV1 on task queue `video`
 * (worker-render: ffmpeg 6.1 and the Chromium scene renderer; workflow id `render:<renderJobId>`). Begin (job →
 * rendering), resolve the pinned inputs (original sources, never proxies; fonts and overlay images; the dedupe key),
 * then either record the identical export that already exists, or draw the overlay and caption frames, compose and
 * encode the MP4 with ffmpeg, verify it (storeVideoExport, STU-2a) and complete. A person's cancel arrives as the
 * `cancelRender` signal (relayed from the outbox) and cancels the running step, which kills ffmpeg; the job is
 * already `cancelled` by then. Once deployed this file is immutable; changes ship as v2.
 */
export const cancelRender = defineSignal('cancelRender');

const NON_RETRYABLE_ERROR_TYPES = [
  'PolicyDeniedError',
  'NotFoundError',
  'ValidationFailedError',
  'ConflictError',
  'TenantContextMissingError',
  'IllegalTransitionError',
  'RightsIneligibleError',
  'RenderIntegrityError',
  'TempDiskBudgetExceededError',
  'RenderCancelledError',
];

type Phase = 'begin' | 'resolve' | 'render' | 'store' | 'complete';

export interface VideoRenderControl {
  /** Runs a step that a cancel signal stops (the activity is cancelled and its process killed). */
  cancellable<T>(fn: () => Promise<T>): Promise<T>;
  cancelled(): boolean;
}

const wasCancelled = (err: unknown, control: VideoRenderControl): boolean =>
  control.cancelled() || isCancellation(err) || isFailureOfType(err, 'RenderCancelledError');

/** The orchestration, separated from the activity proxies so it can be exercised with fakes. */
export async function runVideoRender(
  acts: VideoRenderJobActivitiesV1,
  input: RenderJobInputV1,
  control: VideoRenderControl,
): Promise<VideoRenderResultV1> {
  const fail = async (reason: RenderFailureReason, detail?: string): Promise<VideoRenderResultV1> => {
    await acts.failVideoRender({ ...input, reason, ...(detail ? { detail: detail.slice(0, 1500) } : {}) });
    return { outcome: 'failed', reason };
  };
  let phase: Phase = 'begin';
  try {
    const begun = await acts.beginVideoRender(input);
    phase = 'resolve';
    const resolved = await acts.resolveVideoRender({ ...input, ...begun });
    if (!resolved.ok) return await fail(resolved.reason, resolved.detail);
    const refs = {
      ...input,
      revisionId: begun.revisionId,
      documentId: begun.documentId,
      brandId: begun.brandId,
    };

    let produced: {
      pageId: string;
      formatKey: string;
      storageKey: string;
      contentHash: string;
      bytes: number;
      width: number;
      height: number;
      durationMs: number;
      fps: number;
      posterStorageKey: string;
      posterContentHash?: string;
      captionsStorageKey?: string;
    };
    let findings = resolved.findings;
    if (resolved.reuse) {
      // The same project, renderer, format and source bytes were rendered before: the file is reused.
      produced = { pageId: 'timeline', formatKey: resolved.formatKey, ...resolved.reuse };
    } else {
      phase = 'render';
      const overlays = await control.cancellable(() =>
        acts.renderVideoOverlays({
          ...refs,
          brandVersionId: resolved.brandVersionId,
          fonts: resolved.fonts,
          assets: resolved.assets,
          rendererVersion: resolved.rendererVersion,
        }),
      );
      findings = [...findings, ...overlays.findings];
      const composed = await control.cancellable(() =>
        acts.composeVideo({
          ...refs,
          sources: resolved.sources,
          frames: overlays.frames,
          dedupeKey: resolved.dedupeKey,
          tempBudgetBytes: resolved.tempBudgetBytes,
        }),
      );
      produced = composed;
    }
    if (control.cancelled()) return { outcome: 'cancelled' };

    phase = 'store';
    const stored = await control.cancellable(async () => {
      if (produced.posterContentHash !== undefined)
        return acts.storeVideoExport({
          ...input,
          brandId: begun.brandId,
          export: {
            pageId: produced.pageId,
            formatKey: produced.formatKey,
            storageKey: produced.storageKey,
            contentHash: produced.contentHash,
            bytes: produced.bytes,
            width: produced.width,
            height: produced.height,
            durationMs: produced.durationMs,
            fps: produced.fps,
            posterStorageKey: produced.posterStorageKey,
            posterContentHash: produced.posterContentHash,
            ...(produced.captionsStorageKey ? { captionsStorageKey: produced.captionsStorageKey } : {}),
          },
        });
      return produced; // a reused export was verified when it was first recorded
    });

    phase = 'complete';
    const completed = await acts.completeVideoRender({
      ...input,
      rendererVersion: resolved.rendererVersion,
      manifest: resolved.manifest,
      dedupeKey: resolved.dedupeKey,
      findings,
      export: {
        pageId: produced.pageId,
        formatKey: produced.formatKey,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        bytes: stored.bytes,
        width: produced.width,
        height: produced.height,
        durationMs: stored.durationMs,
        fps: stored.fps,
        posterStorageKey: stored.posterStorageKey,
        ...(stored.captionsStorageKey ? { captionsStorageKey: stored.captionsStorageKey } : {}),
      },
    });
    return { outcome: 'ready', exportIds: completed.exportIds, reused: resolved.reuse !== null };
  } catch (err) {
    if (wasCancelled(err, control)) return { outcome: 'cancelled' };
    // Retries are exhausted (or the error was non-retryable): the job must not stay in `rendering`.
    return fail(
      isFailureOfType(err, 'TempDiskBudgetExceededError') ? 'too_large' : failureReason(err, phase),
      detailOf(err),
    );
  }
}

function detailOf(err: unknown): string {
  let current: unknown = err;
  let last = '';
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (typeof e.message === 'string' && e.message) last = e.message;
    current = e.cause;
  }
  return last.slice(0, 500);
}

export async function videoRenderJobWorkflowV1(input: RenderJobInputV1): Promise<VideoRenderResultV1> {
  const fast = proxyActivities<VideoRenderJobActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '2s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Overlays: one Chromium page per overlay or caption (a 180 s project holds a few hundred at most).
  const overlays = proxyActivities<VideoRenderJobActivitiesV1>({
    startToCloseTimeout: '15 minutes',
    heartbeatTimeout: '1 minute',
    retry: {
      initialInterval: '10s',
      maximumInterval: '2 minutes',
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Compose downloads up to a few GiB of originals and encodes up to 180 s at 1080p; ffmpeg progress heartbeats
  // every few seconds (and at least every 30 s), so a lost worker is noticed in a minute.
  const compose = proxyActivities<VideoRenderJobActivitiesV1>({
    startToCloseTimeout: '60 minutes',
    heartbeatTimeout: '1 minute',
    cancellationType: 'WAIT_CANCELLATION_COMPLETED',
    retry: {
      initialInterval: '30s',
      maximumInterval: '5 minutes',
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Verifying streams the MP4 back through a hash and probes it.
  const store = proxyActivities<VideoRenderJobActivitiesV1>({
    startToCloseTimeout: '15 minutes',
    heartbeatTimeout: '2 minutes',
    retry: {
      initialInterval: '5s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });

  let cancelled = false;
  const scope = new CancellationScope();
  setHandler(cancelRender, () => {
    cancelled = true;
    scope.cancel();
  });
  return runVideoRender(
    {
      beginVideoRender: fast.beginVideoRender,
      resolveVideoRender: fast.resolveVideoRender,
      renderVideoOverlays: overlays.renderVideoOverlays,
      composeVideo: compose.composeVideo,
      storeVideoExport: store.storeVideoExport,
      completeVideoRender: fast.completeVideoRender,
      failVideoRender: fast.failVideoRender,
    },
    input,
    {
      cancellable: (fn) => scope.run(fn),
      cancelled: () => cancelled,
    },
  );
}

/**
 * Relays a cancellation from the outbox to the running video render. The API writes the event in the cancel's
 * transaction; the relay signals only after that commit. A render that already ended ignores it (the workflow is
 * gone and the signal fails harmlessly).
 */
export async function videoRenderSignalRelayV1(input: VideoRenderSignalV1): Promise<void> {
  try {
    await getExternalWorkflowHandle(input.workflowId).signal(cancelRender);
  } catch {
    // Not running any more: nothing to stop.
  }
}
