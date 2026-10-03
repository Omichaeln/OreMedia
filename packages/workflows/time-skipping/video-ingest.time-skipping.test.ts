import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type { AssetIngestInputV1 } from '@oremedia/contracts/assets';
import type { MediaProbeV1, VideoIngestActivitiesV1 } from '@oremedia/contracts/media';
import { VIDEO_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * videoIngestWorkflowV1 (STU-2a) on a real Temporal server: the media steps run on task queue `video` in order; a
 * transcode that fails transiently is retried after its backoff (skipped time) and the asset is catalogued once; a
 * domain refusal (TempDiskBudgetExceededError) is not retried; the histories replay. Activities are recording fakes.
 */
const QUEUE = 'video-time-skipping';

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: VIDEO_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

const probe: MediaProbeV1 = {
  schemaVersion: 1,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs: 30_000,
  bitRate: 8_000_000,
  bytes: 30_000_000,
  video: {
    codec: 'h264',
    profile: 'High',
    pixelFormat: 'yuv420p',
    codedWidth: 1920,
    codedHeight: 1080,
    width: 1920,
    height: 1080,
    rotation: 0,
    fps: 30,
    nominalFps: 30,
    variableFrameRate: false,
    bitRate: 7_800_000,
  },
  audio: [{ codec: 'aac', channels: 2, sampleRate: 48_000, bitRate: 128_000 }],
};

function fakes(derivativeFailures: Array<'transient' | 'budget'> = []) {
  const calls: string[] = [];
  let attempts = 0;
  const rec =
    <I, R>(name: string, fn: (i: I) => R) =>
    async (i: I): Promise<Awaited<R>> => {
      calls.push(name);
      return fn(i) as Awaited<R>;
    };
  const acts: VideoIngestActivitiesV1 = {
    beginIngest: rec('beginIngest', () => ({
      intentId: 'ui_ts',
      brandId: 'brd_ts',
      kind: 'video' as const,
      declaredMime: 'video/mp4',
      maxBytes: 1 << 30,
      storageKey: 'quarantine/ten_ts/ui_ts',
    })),
    verifyUpload: rec('verifyUpload', () => ({ ok: true as const, bytes: 30_000_000 })),
    sniffUpload: rec('sniffUpload', () => ({
      ok: true as const,
      mime: 'video/mp4',
      group: 'video' as const,
    })),
    scanMediaUpload: rec('scanMediaUpload', () => ({ ok: true as const, engine: 'fake' })),
    inspectMediaUpload: rec('inspectMediaUpload', () => ({
      ok: true as const,
      contentHash: 'a'.repeat(64),
      probe,
    })),
    buildMediaDerivatives: rec('buildMediaDerivatives', () => {
      const failure = derivativeFailures[attempts++];
      if (failure === 'transient') throw new Error('ffmpeg was killed (worker restart)');
      if (failure === 'budget')
        throw ApplicationFailure.create({
          type: 'TempDiskBudgetExceededError',
          message: 'temp disk budget exceeded',
        });
      return {
        ok: true as const,
        derivatives: [
          {
            purpose: 'proxy' as const,
            key: 'quarantine/ten_ts/ui_ts/derivative-proxy',
            mime: 'video/mp4',
            width: 1280,
            height: 720,
            bytes: 9_000_000,
            contentHash: 'b'.repeat(64),
            transform: { op: 'proxy' },
          },
        ],
      };
    }),
    moveToImmutable: rec('moveToImmutable', (i: { derivatives: unknown[] }) => ({
      assetId: 'ast_ts',
      assetVersionId: 'av_ts',
      originalKey: 'assets/ten_ts/brd_ts/ast_ts/av_ts/original',
      derivatives: i.derivatives as never,
    })),
    catalogueMediaAsset: rec('catalogueMediaAsset', () => ({
      assetId: 'ast_ts',
      assetVersionId: 'av_ts',
      state: 'pending_review' as const,
    })),
    finaliseMediaUpload: rec('finaliseMediaUpload', () => undefined),
  };
  return { acts, calls, count: (n: string) => calls.filter((c) => c === n).length };
}

let seq = 0;
const input = (): AssetIngestInputV1 => ({
  tenantId: 'ten_ts',
  actor: { kind: 'user', id: 'usr_ts' },
  correlationId: `corr_video_${++seq}`,
  intentId: `ui_ts_${seq}`,
  brandId: 'brd_ts',
});
const run = async (f: ReturnType<typeof fakes>) => {
  const worker = await Worker.create({
    connection: t.env.nativeConnection,
    taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: f.acts,
  });
  return worker.runUntil(async () => {
    const i = input();
    const h = await t.env.client.workflow.start('videoIngestWorkflowV1', {
      taskQueue: QUEUE,
      workflowId: `ingest:${i.intentId}`,
      args: [i],
    });
    return { result: await h.result().catch((e: unknown) => e), history: await h.fetchHistory() };
  });
};
type History = Awaited<ReturnType<typeof run>>['history'];
const histories: History[] = [];

describe('videoIngestWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('runs the media steps in order and catalogues the asset', async () => {
    const f = fakes();
    const { result, history } = await run(f);
    expect(result).toEqual({
      outcome: 'accepted',
      assetId: 'ast_ts',
      assetVersionId: 'av_ts',
      state: 'pending_review',
    });
    expect(f.calls).toEqual([
      'beginIngest',
      'verifyUpload',
      'sniffUpload',
      'scanMediaUpload',
      'inspectMediaUpload',
      'buildMediaDerivatives',
      'moveToImmutable',
      'catalogueMediaAsset',
      'finaliseMediaUpload',
    ]);
    histories.push(history);
  }, 300_000);

  it('retries a transcode that failed transiently after its backoff, cataloguing once', async () => {
    const begin = await t.now();
    const f = fakes(['transient']);
    const { result, history } = await run(f);
    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(f.count('buildMediaDerivatives')).toBe(2);
    expect(f.count('catalogueMediaAsset')).toBe(1);
    // The transcode retry waits 30 s of workflow time (scaled with the environment's day when not time-skipping).
    expect(await t.now()).toBeGreaterThanOrEqual(begin + Math.min(30_000, (t.day / 86_400_000) * 30_000));
    histories.push(history);
  }, 300_000);

  it('does not retry a temp disk budget refusal', async () => {
    const f = fakes(['budget']);
    const { result } = await run(f);
    expect(result).toBeInstanceOf(Error);
    expect(f.count('buildMediaDerivatives')).toBe(1);
    expect(f.count('catalogueMediaAsset')).toBe(0);
  }, 300_000);

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(2);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'video-ingest-replay');
  }, 300_000);
});
