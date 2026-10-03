import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaProbeV1 } from '@oremedia/contracts/media';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { MemoryStorageProvider, mediaToolsAvailable, probeFile, runTool } from '@oremedia/module-assets';
import {
  checkVideoExport,
  topLevelBoxes,
  videoExportDedupeKey,
  videoExportStorageKeys,
} from './video-export';

/** STU-2a video export store helpers: keys, the dedupe key, faststart detection by ranged reads, export checks. */
const T = 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ctx: TenantContext = {
  tenantId: T,
  actor: { kind: 'user', id: 'usr_1' },
  brandIds: 'all',
  correlationId: 'c',
};
const hasTools = await mediaToolsAvailable();
if (!hasTools) console.error('video-export.test.ts: ffmpeg/ffprobe not found; the ffmpeg suite is skipped');

const expected = {
  pageId: 'pg_1',
  formatKey: 'ig_reel_9x16',
  storageKey: `assets/${T}/brd_1/exports/rev_1/rj_1/pg_1-ig_reel_9x16.mp4`,
  contentHash: 'a'.repeat(64),
  bytes: 1000,
  width: 1080,
  height: 1920,
  durationMs: 15_000,
  fps: 30,
  posterStorageKey: `assets/${T}/brd_1/exports/rev_1/rj_1/pg_1-ig_reel_9x16.poster.webp`,
  posterContentHash: 'b'.repeat(64),
};
const probe = (
  over: Partial<NonNullable<MediaProbeV1['video']>> = {},
  durationMs = 15_010,
): MediaProbeV1 => ({
  schemaVersion: 1,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs,
  bitRate: null,
  bytes: 1000,
  video: {
    codec: 'h264',
    profile: 'High',
    pixelFormat: 'yuv420p',
    codedWidth: 1080,
    codedHeight: 1920,
    width: 1080,
    height: 1920,
    rotation: 0,
    fps: 30,
    nominalFps: 30,
    variableFrameRate: false,
    bitRate: null,
    ...over,
  },
  audio: [{ codec: 'aac', channels: 2, sampleRate: 48_000, bitRate: 128_000 }],
});

describe('video export keys and dedupe', () => {
  it('keeps the export, poster and captions beside each other under the brand exports prefix', () => {
    const k = videoExportStorageKeys(T, 'brd_1', 'rev_1', 'rj_1', 'pg 1', 'ig/reel');
    expect(k.video).toBe(`assets/${T}/brd_1/exports/rev_1/rj_1/pg_1-ig_reel.mp4`);
    expect(k.poster).toBe(`assets/${T}/brd_1/exports/rev_1/rj_1/pg_1-ig_reel.poster.webp`);
    expect(k.captions).toBe(`assets/${T}/brd_1/exports/rev_1/rj_1/pg_1-ig_reel.vtt`);
  });
  it('is the same for the same inputs whatever the asset order, and differs when anything changes', () => {
    const base = {
      projectContentHash: 'p',
      rendererVersion: 'r1',
      formatKey: 'f',
      fps: 30,
      assetContentHashes: ['x', 'y'],
    };
    const key = videoExportDedupeKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(videoExportDedupeKey({ ...base, assetContentHashes: ['y', 'x', 'x'] })).toBe(key);
    expect(videoExportDedupeKey({ ...base, fps: 25 })).not.toBe(key);
    expect(videoExportDedupeKey({ ...base, rendererVersion: 'r2' })).not.toBe(key);
    expect(videoExportDedupeKey({ ...base, assetContentHashes: ['x'] })).not.toBe(key);
  });
});

describe('checkVideoExport', () => {
  it('accepts an H.264/AAC faststart export of the recorded size, rate and duration', () => {
    expect(checkVideoExport(probe(), ['ftyp', 'moov', 'mdat'], expected)).toEqual([]);
  });
  it('names each way an export can be wrong', () => {
    const issues = checkVideoExport(
      {
        ...probe({ codec: 'hevc', fps: 29.97, width: 720 }, 16_000),
        audio: [{ codec: 'mp3', channels: 2, sampleRate: 44_100, bitRate: null }],
      },
      ['ftyp', 'mdat', 'moov'],
      expected,
    ).map((i) => i.issue);
    expect(issues).toEqual(
      expect.arrayContaining([
        'video_codec_hevc',
        'audio_codec_mp3',
        'dimensions_720x1920',
        'fps_29.97',
        'duration_16000',
        'not_faststart',
      ]),
    );
    expect(checkVideoExport({ ...probe(), video: null }, ['moov'], expected)).toEqual([
      { path: 'storageKey', issue: 'no_video_stream' },
    ]);
  });
});

describe.skipIf(!hasTools)('faststart detection by ranged reads on real MP4s', { timeout: 120_000 }, () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'video-export-'));
    const r = await runTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        join(dir, 'plain.mp4'),
      ],
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) throw new Error(r.stderr);
    await runTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        join(dir, 'plain.mp4'),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        join(dir, 'fast.mp4'),
      ],
      {
        timeoutMs: 60_000,
      },
    );
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds moov after mdat in a plain file and before it in a faststart file', async () => {
    const s = new MemoryStorageProvider();
    await runInTenant(ctx, async () => {
      for (const name of ['plain.mp4', 'fast.mp4']) {
        const key = `assets/${T}/brd_1/exports/rev_1/rj_1/${name}`;
        await s.putObject(key, await readFile(join(dir, name)), { contentType: 'video/mp4' });
        const boxes = await topLevelBoxes(s, key, (await stat(join(dir, name))).size);
        const p = (await probeFile(join(dir, name), 1, { mime: 'video/mp4' })) as MediaProbeV1;
        const issues = checkVideoExport(p, boxes, {
          ...expected,
          width: 320,
          height: 240,
          durationMs: p.durationMs,
        });
        if (name === 'fast.mp4') expect(issues).toEqual([]);
        else expect(issues.map((i) => i.issue)).toEqual(['not_faststart']);
      }
    });
  });
});
