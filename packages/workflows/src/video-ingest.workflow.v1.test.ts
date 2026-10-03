import { describe, expect, it } from 'vitest';
import type { AssetIngestInputV1, IngestDerivativeRef } from '@oremedia/contracts/assets';
import type { MediaProbeV1, VideoIngestActivitiesV1 } from '@oremedia/contracts/media';
import { runVideoIngest } from './video-ingest.workflow.v1';

const input: AssetIngestInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_wf',
  intentId: 'ui_1',
  brandId: 'brd_1',
};

const probe: MediaProbeV1 = {
  schemaVersion: 1,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs: 12_000,
  bitRate: 2_000_000,
  bytes: 3_000_000,
  video: {
    codec: 'h264',
    profile: 'High',
    pixelFormat: 'yuv420p',
    codedWidth: 1920,
    codedHeight: 1080,
    width: 1080,
    height: 1920,
    rotation: 90,
    fps: 30,
    nominalFps: 30,
    variableFrameRate: false,
    bitRate: 1_900_000,
  },
  audio: [{ codec: 'aac', channels: 2, sampleRate: 48_000, bitRate: 128_000 }],
};

const ref = (purpose: IngestDerivativeRef['purpose'], mime: string): IngestDerivativeRef => ({
  purpose,
  key: `quarantine/ten_A/ui_1/derivative-${purpose}`,
  mime,
  width: null,
  height: null,
  bytes: 100,
  contentHash: 'c'.repeat(64),
  transform: { op: purpose },
});
const derivatives = [
  ref('poster', 'image/webp'),
  ref('proxy', 'video/mp4'),
  ref('waveform', 'application/json'),
];

/** Fake activities: every step succeeds unless overridden; every call is recorded in order. */
function fakes(overrides: Partial<VideoIngestActivitiesV1> = {}) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const base: VideoIngestActivitiesV1 = {
    beginIngest: async () => ({
      intentId: 'ui_1',
      brandId: 'brd_1',
      kind: 'video',
      declaredMime: 'video/mp4',
      maxBytes: 1 << 30,
      storageKey: 'quarantine/ten_A/ui_1',
    }),
    verifyUpload: async () => ({ ok: true, bytes: 3_000_000 }),
    sniffUpload: async () => ({ ok: true, mime: 'video/mp4', group: 'video' }),
    scanMediaUpload: async () => ({ ok: true, engine: 'fake' }),
    inspectMediaUpload: async () => ({ ok: true, contentHash: 'b'.repeat(64), probe }),
    buildMediaDerivatives: async () => ({ ok: true, derivatives }),
    moveToImmutable: async (i) => ({
      assetId: 'ast_1',
      assetVersionId: 'av_1',
      originalKey: 'assets/ten_A/brd_1/ast_1/av_1/original',
      derivatives: i.derivatives.map((d) => ({ ...d, key: `assets/ten_A/brd_1/ast_1/av_1/${d.purpose}` })),
    }),
    catalogueMediaAsset: async () => ({ assetId: 'ast_1', assetVersionId: 'av_1', state: 'approved' }),
    finaliseMediaUpload: async () => undefined,
  };
  const merged = { ...base, ...overrides } as VideoIngestActivitiesV1;
  const acts = Object.fromEntries(
    (Object.keys(merged) as Array<keyof VideoIngestActivitiesV1>).map((k) => [
      k,
      async (arg: never) => {
        calls.push({ name: k, input: arg });
        return (merged[k] as (a: never) => unknown)(arg);
      },
    ]),
  ) as unknown as VideoIngestActivitiesV1;
  const inputOf = (name: string) => calls.find((c) => c.name === name)?.input as Record<string, unknown>;
  return { acts, calls, names: () => calls.map((c) => c.name), inputOf };
}

describe('videoIngestWorkflowV1 orchestration (STU-2a)', () => {
  it('verifies, sniffs, scans, inspects, builds derivatives, moves, catalogues with the probe and finalises', async () => {
    const f = fakes();
    const r = await runVideoIngest(f.acts, input);
    expect(r).toEqual({ outcome: 'accepted', assetId: 'ast_1', assetVersionId: 'av_1', state: 'approved' });
    expect(f.names()).toEqual([
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
    expect(f.inputOf('inspectMediaUpload')).toMatchObject({ mime: 'video/mp4', group: 'video' });
    expect(f.inputOf('buildMediaDerivatives')).toMatchObject({ group: 'video', probe });
    // The upload is the original: move copies it as is, and the quarantine key is cleaned up.
    expect(f.inputOf('moveToImmutable')).toMatchObject({ sanitisedKey: 'quarantine/ten_A/ui_1' });
    expect(f.inputOf('catalogueMediaAsset')).toMatchObject({
      contentHash: 'b'.repeat(64),
      bytes: 3_000_000,
      width: 1080,
      height: 1920,
      sanitised: false,
      probe,
    });
    expect(f.inputOf('finaliseMediaUpload')).toMatchObject({
      outcome: 'accepted',
      cleanupKeys: ['quarantine/ten_A/ui_1', ...derivatives.map((d) => d.key)],
    });
  });

  it('a rejected inspection ends the run with its reason and detail, cleaning up the upload', async () => {
    const f = fakes({
      inspectMediaUpload: async () => ({
        ok: false,
        reason: 'duration_exceeds_cap',
        detail: '612.0 s is longer than the 10 minute limit; trim it and upload again',
      }),
    });
    expect(await runVideoIngest(f.acts, input)).toEqual({
      outcome: 'rejected',
      reason: 'duration_exceeds_cap',
    });
    expect(f.names()).not.toContain('buildMediaDerivatives');
    expect(f.inputOf('finaliseMediaUpload')).toMatchObject({
      outcome: 'rejected',
      reason: 'duration_exceeds_cap',
      detail: expect.stringContaining('10 minute'),
      cleanupKeys: ['quarantine/ten_A/ui_1'],
    });
  });

  it('a damaged source found while transcoding is rejected; derivative keys made so far are not catalogued', async () => {
    const f = fakes({
      buildMediaDerivatives: async () => ({ ok: false, reason: 'media_malformed', detail: 'partial file' }),
    });
    expect(await runVideoIngest(f.acts, input)).toEqual({ outcome: 'rejected', reason: 'media_malformed' });
    expect(f.names()).not.toContain('moveToImmutable');
  });

  it('a duplicate names the existing asset', async () => {
    const f = fakes({
      inspectMediaUpload: async () => ({ ok: false, reason: 'duplicate_of', duplicateOfAssetId: 'ast_0' }),
    });
    expect(await runVideoIngest(f.acts, input)).toEqual({
      outcome: 'rejected',
      reason: 'duplicate_of',
      duplicateOfAssetId: 'ast_0',
    });
  });

  it('content that is not video or audio is a type mismatch', async () => {
    const f = fakes({ sniffUpload: async () => ({ ok: true, mime: 'image/png', group: 'image' }) });
    expect(await runVideoIngest(f.acts, input)).toEqual({ outcome: 'rejected', reason: 'type_mismatch' });
    expect(f.names()).not.toContain('scanMediaUpload');
  });

  it('a scanner with no verdict holds the upload in quarantine', async () => {
    const failure = Object.assign(new Error('activity failed'), {
      cause: { type: 'ScannerUnavailableError', message: 'clamd down' },
    });
    const f = fakes({
      scanMediaUpload: async () => {
        throw failure;
      },
    });
    expect(await runVideoIngest(f.acts, input)).toEqual({
      outcome: 'quarantined',
      reason: 'scanner_unavailable',
    });
    expect(f.inputOf('finaliseMediaUpload')).toMatchObject({ outcome: 'quarantined' });
  });

  it('malware is rejected', async () => {
    const f = fakes({
      scanMediaUpload: async () => ({ ok: false, reason: 'malware_detected', detail: 'Eicar' }),
    });
    expect(await runVideoIngest(f.acts, input)).toEqual({ outcome: 'rejected', reason: 'malware_detected' });
  });

  it('audio goes through the same steps with group audio and no frame size', async () => {
    const audioProbe: MediaProbeV1 = { ...probe, video: null };
    const f = fakes({
      sniffUpload: async () => ({ ok: true, mime: 'audio/mpeg', group: 'audio' }),
      inspectMediaUpload: async () => ({ ok: true, contentHash: 'd'.repeat(64), probe: audioProbe }),
    });
    expect((await runVideoIngest(f.acts, input)).outcome).toBe('accepted');
    expect(f.inputOf('buildMediaDerivatives')).toMatchObject({ group: 'audio' });
    expect(f.inputOf('catalogueMediaAsset')).toMatchObject({ width: null, height: null, mime: 'audio/mpeg' });
  });
});
