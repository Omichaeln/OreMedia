import { describe, expect, it } from 'vitest';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type {
  RenderJobInputV1,
  VideoComposeResult,
  VideoRenderJobActivitiesV1,
  VideoRenderResolveSuccess,
} from '@oremedia/contracts/render';
import { runVideoRender, type VideoRenderControl } from './video-render.workflow.v1';

const input: RenderJobInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_video',
  renderJobId: 'rj_1',
};
const H = (c: string) => c.repeat(64);

const resolved = (over: Partial<VideoRenderResolveSuccess> = {}): VideoRenderResolveSuccess => ({
  ok: true,
  rendererVersion: '1.0.0+video.1',
  brandVersionId: 'bv_1',
  revisionContentHash: H('c'),
  formatKey: 'video_9x16',
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 15_000,
  dedupeKey: H('d'),
  reuse: null,
  sources: [
    {
      assetVersionId: 'av_clip',
      storageKey: 'assets/ten_A/brd_1/ast_c/av_clip/original',
      contentHash: H('a'),
      mime: 'video/mp4',
      kind: 'video',
      bytes: 1_000_000,
      durationMs: 20_000,
      hasAudio: true,
    },
  ],
  fonts: [],
  assets: [],
  manifest: {
    rendererVersion: '1.0.0+video.1',
    fonts: [],
    assets: [{ assetVersionId: 'av_clip', contentHash: H('a') }],
    brandVersionId: 'bv_1',
    revisionContentHash: H('c'),
  },
  tempBudgetBytes: 1_000_000_000,
  overlayFrameCount: 1,
  findings: [],
  ...over,
});

const composed: VideoComposeResult = {
  pageId: 'timeline',
  formatKey: 'video_9x16',
  storageKey: 'assets/ten_A/brd_1/exports/rev_1/rj_1/timeline-video_9x16.mp4',
  contentHash: H('e'),
  bytes: 5_000_000,
  width: 1080,
  height: 1920,
  durationMs: 15_000,
  fps: 30,
  posterStorageKey: 'assets/ten_A/brd_1/exports/rev_1/rj_1/timeline-video_9x16.poster.webp',
  posterContentHash: H('f'),
  captionsStorageKey: 'assets/ten_A/brd_1/exports/rev_1/rj_1/timeline-video_9x16.vtt',
  encodeMs: 12_000,
};

function fakes(
  o: {
    resolve?: Awaited<ReturnType<VideoRenderJobActivitiesV1['resolveVideoRender']>>;
    compose?: () => Promise<VideoComposeResult>;
  } = {},
) {
  const calls: string[] = [];
  const seen: Record<string, unknown> = {};
  const rec =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R | Promise<R>) =>
    async (...a: A): Promise<R> => {
      calls.push(name);
      seen[name] = a[0];
      return fn(...a);
    };
  const acts: VideoRenderJobActivitiesV1 = {
    beginVideoRender: rec('begin', () => ({
      renderJobId: 'rj_1',
      revisionId: 'rev_1',
      documentId: 'doc_1',
      brandId: 'brd_1',
      formatKeys: ['video_9x16'],
    })),
    resolveVideoRender: rec('resolve', () => o.resolve ?? resolved()),
    renderVideoOverlays: rec('overlays', () => ({
      frames: [
        {
          itemId: 'cap_1',
          kind: 'caption' as const,
          storageKey: 'k',
          contentHash: H('b'),
          startMs: 0,
          endMs: 1_000,
        },
      ],
      findings: [{ code: 'possible_overflow', severity: 'warning' as const, message: 'm' }],
    })),
    composeVideo: rec('compose', () => (o.compose ? o.compose() : Promise.resolve(composed))),
    storeVideoExport: rec(
      'store',
      (i: {
        export: {
          storageKey: string;
          contentHash: string;
          bytes: number;
          durationMs: number;
          fps: number;
          posterStorageKey: string;
          captionsStorageKey?: string;
        };
      }) => ({
        storageKey: i.export.storageKey,
        contentHash: i.export.contentHash,
        bytes: i.export.bytes,
        durationMs: i.export.durationMs,
        fps: i.export.fps,
        posterStorageKey: i.export.posterStorageKey,
        ...(i.export.captionsStorageKey ? { captionsStorageKey: i.export.captionsStorageKey } : {}),
      }),
    ),
    completeVideoRender: rec('complete', () => ({ exportIds: ['exp_1'] })),
    failVideoRender: rec('fail', () => undefined),
    discardVideoRenderWork: rec('discard', () => ({ deleted: 2 })),
  };
  return { acts, calls, seen };
}
const control = (cancelled = () => false): VideoRenderControl => ({
  cancellable: (fn) => fn(),
  shielded: (fn) => fn(),
  cancelled,
});

describe('runVideoRender (videoRenderJobWorkflowV1 orchestration)', () => {
  it('begins, resolves, draws overlays, composes, verifies and completes with the dedupe key and all findings', async () => {
    const f = fakes();
    expect(await runVideoRender(f.acts, input, control())).toEqual({
      outcome: 'ready',
      exportIds: ['exp_1'],
      reused: false,
    });
    expect(f.calls).toEqual(['begin', 'resolve', 'overlays', 'compose', 'store', 'complete']);
    expect(f.seen['compose']).toMatchObject({
      revisionId: 'rev_1',
      brandId: 'brd_1',
      dedupeKey: H('d'),
      tempBudgetBytes: 1_000_000_000,
    });
    expect(f.seen['store']).toMatchObject({
      brandId: 'brd_1',
      export: { posterContentHash: H('f'), captionsStorageKey: composed.captionsStorageKey },
    });
    expect(f.seen['complete']).toMatchObject({
      dedupeKey: H('d'),
      findings: [{ code: 'possible_overflow' }],
      export: { pageId: 'timeline', durationMs: 15_000, fps: 30 },
    });
  });

  it('reuses an identical export (same dedupe key): no overlays, no encode, no re-verification', async () => {
    const reuse = {
      storageKey: 'assets/ten_A/brd_1/exports/rev_0/rj_0/timeline-video_9x16.mp4',
      contentHash: H('9'),
      bytes: 4_000,
      width: 1080,
      height: 1920,
      durationMs: 15_000,
      fps: 30,
      posterStorageKey: 'p',
    };
    const f = fakes({ resolve: resolved({ reuse }) });
    expect(await runVideoRender(f.acts, input, control())).toEqual({
      outcome: 'ready',
      exportIds: ['exp_1'],
      reused: true,
    });
    expect(f.calls).toEqual(['begin', 'resolve', 'complete']);
    expect(f.seen['complete']).toMatchObject({
      export: { storageKey: reuse.storageKey, contentHash: H('9') },
    });
  });

  it('a rejected resolve fails the job with its reason and detail', async () => {
    const f = fakes({
      resolve: { ok: false, reason: 'rights_ineligible', detail: 'av_clip: rights_expired' },
    });
    expect(await runVideoRender(f.acts, input, control())).toEqual({
      outcome: 'failed',
      reason: 'rights_ineligible',
    });
    expect(f.seen['fail']).toMatchObject({ reason: 'rights_ineligible', detail: 'av_clip: rights_expired' });
  });

  it('a cancel during the encode ends as cancelled without failing the (already cancelled) job', async () => {
    let cancelled = false;
    const f = fakes({
      compose: async () => {
        cancelled = true;
        throw new CancelledFailure('cancelled');
      },
    });
    expect(
      await runVideoRender(
        f.acts,
        input,
        control(() => cancelled),
      ),
    ).toEqual({ outcome: 'cancelled' });
    expect(f.calls).not.toContain('fail');
    expect(f.calls).not.toContain('complete');
    // Its working files (overlay frames, any uploaded MP4) are discarded.
    expect(f.calls.at(-1)).toBe('discard');
    expect(f.seen['discard']).toMatchObject({
      revisionId: 'rev_1',
      brandId: 'brd_1',
      documentId: expect.any(String),
    });
  });

  it('a job found cancelled by the activity (RenderCancelledError) also ends as cancelled', async () => {
    const f = fakes({
      compose: () => Promise.reject(ApplicationFailure.nonRetryable('cancelled', 'RenderCancelledError')),
    });
    expect(await runVideoRender(f.acts, input, control())).toEqual({ outcome: 'cancelled' });
  });

  it('exhausted failures fail the job: the temp budget as too_large, integrity and others by their type', async () => {
    const budget = fakes({
      compose: () => Promise.reject(ApplicationFailure.nonRetryable('over', 'TempDiskBudgetExceededError')),
    });
    expect(await runVideoRender(budget.acts, input, control())).toEqual({
      outcome: 'failed',
      reason: 'too_large',
    });
    const integrity = fakes({
      compose: () => Promise.reject(ApplicationFailure.nonRetryable('bad hash', 'RenderIntegrityError')),
    });
    expect(await runVideoRender(integrity.acts, input, control())).toEqual({
      outcome: 'failed',
      reason: 'export_integrity',
    });
    expect(integrity.calls.slice(-2)).toEqual(['discard', 'fail']);
    const crash = fakes({ compose: () => Promise.reject(new Error('ffmpeg failed (1): x')) });
    expect(await runVideoRender(crash.acts, input, control())).toEqual({
      outcome: 'failed',
      reason: 'render_failed',
    });
    expect(crash.seen['fail']).toMatchObject({ detail: 'ffmpeg failed (1): x' });
  });
});
