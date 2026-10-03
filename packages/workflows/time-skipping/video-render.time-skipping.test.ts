import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type {
  RenderJobInputV1,
  VideoComposeResult,
  VideoRenderJobActivitiesV1,
  VideoRenderResolveSuccess,
} from '@oremedia/contracts/render';
import { VIDEO_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * videoRenderJobWorkflowV1 (STU-2b) on a real Temporal server: the steps run on task queue `video` in order; a compose
 * that fails transiently is retried after its 30 s backoff (skipped time) and completes once; the `cancelRender`
 * signal relayed by videoRenderSignalRelayV1 cancels a running compose (the activity sees its cancellation signal,
 * as ffmpeg would be killed) and the run ends cancelled without failing the job; histories replay.
 */
const QUEUE = 'video-render-time-skipping';
const H = (c: string) => c.repeat(64);

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;
beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: VIDEO_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

const resolved: VideoRenderResolveSuccess = {
  ok: true,
  rendererVersion: '1.0.0+video.1',
  brandVersionId: 'bv_ts',
  revisionContentHash: H('c'),
  formatKey: 'video_16x9',
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 30_000,
  dedupeKey: H('d'),
  reuse: null,
  sources: [],
  fonts: [],
  assets: [],
  manifest: {
    rendererVersion: '1.0.0+video.1',
    fonts: [],
    assets: [],
    brandVersionId: 'bv_ts',
    revisionContentHash: H('c'),
  },
  tempBudgetBytes: 1 << 30,
  findings: [],
};
const composed: VideoComposeResult = {
  pageId: 'timeline',
  formatKey: 'video_16x9',
  storageKey: 'assets/ten_ts/brd_ts/exports/rev_ts/rj/timeline-video_16x9.mp4',
  contentHash: H('e'),
  bytes: 9_000_000,
  width: 1920,
  height: 1080,
  durationMs: 30_000,
  fps: 30,
  posterStorageKey: 'assets/ten_ts/brd_ts/exports/rev_ts/rj/timeline-video_16x9.poster.webp',
  posterContentHash: H('f'),
  encodeMs: 20_000,
};

function fakes(compose: 'ok' | 'transient' | 'hang') {
  const calls: string[] = [];
  let attempts = 0;
  let sawCancel = false;
  const rec =
    <I, R>(name: string, fn: (i: I) => R) =>
    async (i: I): Promise<Awaited<R>> => {
      calls.push(name);
      return fn(i) as Awaited<R>;
    };
  const acts: VideoRenderJobActivitiesV1 = {
    beginVideoRender: rec('begin', () => ({
      renderJobId: 'rj',
      revisionId: 'rev_ts',
      documentId: 'doc_ts',
      brandId: 'brd_ts',
      formatKeys: ['video_16x9'],
    })),
    resolveVideoRender: rec('resolve', () => resolved),
    renderVideoOverlays: rec('overlays', () => ({ frames: [], findings: [] })),
    composeVideo: async () => {
      calls.push('compose');
      if (compose === 'transient' && attempts++ === 0) throw new Error('worker restarted');
      if (compose === 'hang') {
        const ctx = Context.current();
        // Heartbeat like ffmpeg progress until cancelled (the activity sees the cancellation through heartbeats).
        for (;;) {
          ctx.heartbeat('encoding');
          try {
            await ctx.sleep(200);
          } catch (err) {
            sawCancel = true;
            throw err;
          }
        }
      }
      return composed;
    },
    storeVideoExport: rec('store', () => ({
      storageKey: composed.storageKey,
      contentHash: composed.contentHash,
      bytes: composed.bytes,
      durationMs: 30_000,
      fps: 30,
      posterStorageKey: composed.posterStorageKey,
    })),
    completeVideoRender: rec('complete', () => ({ exportIds: ['exp_ts'] })),
    failVideoRender: rec('fail', () => {
      throw ApplicationFailure.nonRetryable('must not fail a cancelled job', 'Unexpected');
    }),
  };
  return {
    acts,
    calls,
    sawCancel: () => sawCancel,
    count: (n: string) => calls.filter((c) => c === n).length,
  };
}

let seq = 0;
const input = (): RenderJobInputV1 => ({
  tenantId: 'ten_ts',
  actor: { kind: 'user', id: 'usr_ts' },
  correlationId: `corr_vr_${++seq}`,
  renderJobId: `rj_${seq}`,
});
const histories: unknown[] = [];

async function run(f: ReturnType<typeof fakes>, during?: (workflowId: string) => Promise<void>) {
  const worker = await Worker.create({
    connection: t.env.nativeConnection,
    taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: f.acts,
  });
  return worker.runUntil(async () => {
    const i = input();
    const workflowId = `render:${i.renderJobId}`;
    const h = await t.env.client.workflow.start('videoRenderJobWorkflowV1', {
      taskQueue: QUEUE,
      workflowId,
      args: [i],
    });
    if (during) await during(workflowId);
    return { result: await h.result().catch((e: unknown) => e), history: await h.fetchHistory() };
  });
}

describe('videoRenderJobWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('runs begin, resolve, overlays, compose, store and complete in order', async () => {
    const f = fakes('ok');
    const { result, history } = await run(f);
    expect(result).toEqual({ outcome: 'ready', exportIds: ['exp_ts'], reused: false });
    expect(f.calls).toEqual(['begin', 'resolve', 'overlays', 'compose', 'store', 'complete']);
    histories.push(history);
  }, 300_000);

  it('retries a compose that failed transiently after its backoff and completes once', async () => {
    const begin = await t.now();
    const f = fakes('transient');
    const { result, history } = await run(f);
    expect(result).toMatchObject({ outcome: 'ready' });
    expect(f.count('compose')).toBe(2);
    expect(f.count('complete')).toBe(1);
    expect(await t.now()).toBeGreaterThanOrEqual(begin + Math.min(30_000, (t.day / 86_400_000) * 30_000));
    histories.push(history);
  }, 300_000);

  it('a cancelRender signal (through the relay) cancels the running encode; the run ends cancelled', async () => {
    const f = fakes('hang');
    const { result, history } = await run(f, async (workflowId) => {
      while (f.count('compose') === 0) await new Promise((r) => setTimeout(r, 50));
      await t.env.client.workflow.execute('videoRenderSignalRelayV1', {
        taskQueue: QUEUE,
        workflowId: `${workflowId}:signal:evt_1`,
        args: [{ workflowId, signal: 'cancelRender' }],
      });
    });
    expect(result).toEqual({ outcome: 'cancelled' });
    expect(f.sawCancel()).toBe(true);
    expect(f.count('complete')).toBe(0);
    expect(f.count('fail')).toBe(0);
    histories.push(history);
  }, 300_000);

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(3);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history as never, 'video-render-replay');
  }, 300_000);
});
