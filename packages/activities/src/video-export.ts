import { VIDEO_EXPORT_FPS, VIDEO_EXPORT_MAX_DURATION_MS } from '@oremedia/contracts/creative';
import { ValidationFailedError, type ErrorDetail } from '@oremedia/contracts/errors';
import type { MediaProbeV1 } from '@oremedia/contracts/media';
import type { VideoExportActivitiesV1, VideoExportStoreInput } from '@oremedia/contracts/render';
import { hashCanonical } from '@oremedia/domain/hash';
import {
  hashStoredObject,
  parseStorageKey,
  probeFile,
  storage,
  withTempDir,
  type StorageProvider,
} from '@oremedia/module-assets';
import { loadActorGrants } from './actor';
import { RenderIntegrityError } from './render-job';
import { heartbeat, inTenant } from './tenant';

/**
 * STU-2a: the video export store path. The timeline compositor (STU-2b) renders an MP4 under the key below, writes its
 * poster frame (and a WebVTT captions sidecar), then calls storeVideoExport; a verified export is completed through
 * creative.renders.markReady like a still, carrying durationMs, fps and the poster key. Renders are deduplicated by
 * videoExportDedupeKey: the same project snapshot, renderer and pinned asset bytes always give the same key.
 */

const segment = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Where a video export and its sidecars live (beside still exports, keyed so a re-render never overwrites one). */
export function videoExportStorageKeys(
  tenantId: string,
  brandId: string,
  revisionId: string,
  renderJobId: string,
  pageId: string,
  formatKey: string,
): { video: string; poster: string; captions: string } {
  const base = `assets/${tenantId}/${brandId}/exports/${revisionId}/${renderJobId}/${segment(pageId)}-${segment(formatKey)}`;
  return { video: `${base}.mp4`, poster: `${base}.poster.webp`, captions: `${base}.vtt` };
}

/**
 * Content hash of everything a video render depends on: the project snapshot's hash, the renderer version, the
 * output format and frame rate, and the content hashes of every pinned asset (order-free). Two renders with the
 * same key produce the same file, so the compositor reuses an existing export instead of rendering again.
 */
export function videoExportDedupeKey(input: {
  projectContentHash: string;
  rendererVersion: string;
  formatKey: string;
  fps: number;
  assetContentHashes: readonly string[];
}): string {
  return hashCanonical({
    v: 1,
    project: input.projectContentHash,
    renderer: input.rendererVersion,
    format: input.formatKey,
    fps: input.fps,
    assets: [...new Set(input.assetContentHashes)].sort(),
  });
}

/** The types of an ISO BMFF file's top-level boxes, read with ranged reads (16 bytes per box, nothing else). */
export async function topLevelBoxes(
  store: StorageProvider,
  key: string,
  size: number,
  max = 64,
): Promise<string[]> {
  const types: string[] = [];
  let at = 0;
  while (at + 8 <= size && types.length < max) {
    const head = await store.getObject(key, { start: at, end: Math.min(size, at + 16) - 1 });
    if (!head || head.length < 8) break;
    let boxSize = head.readUInt32BE(0);
    types.push(head.toString('latin1', 4, 8));
    if (boxSize === 1) {
      if (head.length < 16) break;
      boxSize = Number(head.readBigUInt64BE(8));
    } else if (boxSize === 0) break; // extends to the end of the file
    if (boxSize < 8) break;
    at += boxSize;
  }
  return types;
}

/** What a stored video export must be (architecture: H.264 + AAC MP4, faststart, ≤ 1920 long edge, 24/25/30 fps). */
export function checkVideoExport(
  probe: MediaProbeV1,
  boxes: readonly string[],
  expected: VideoExportStoreInput['export'],
): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  const v = probe.video;
  if (!v) return [{ path: 'storageKey', issue: 'no_video_stream' }];
  if (v.codec !== 'h264') issues.push({ path: 'storageKey', issue: `video_codec_${v.codec}` });
  const audio = probe.audio[0];
  if (audio && audio.codec !== 'aac')
    issues.push({ path: 'storageKey', issue: `audio_codec_${audio.codec}` });
  if (v.width !== expected.width || v.height !== expected.height)
    issues.push({ path: 'width', issue: `dimensions_${v.width}x${v.height}` });
  if (Math.max(v.width, v.height) > 1920) issues.push({ path: 'width', issue: 'long_edge_over_1920' });
  if (
    !(VIDEO_EXPORT_FPS as readonly number[]).includes(expected.fps) ||
    Math.abs(v.fps - expected.fps) > 0.01
  )
    issues.push({ path: 'fps', issue: `fps_${v.fps}` });
  const frame = 1000 / expected.fps;
  if (Math.abs(probe.durationMs - expected.durationMs) > frame + 50)
    issues.push({ path: 'durationMs', issue: `duration_${probe.durationMs}` });
  if (expected.durationMs > VIDEO_EXPORT_MAX_DURATION_MS)
    issues.push({ path: 'durationMs', issue: 'over_180s' });
  const moov = boxes.indexOf('moov');
  const mdat = boxes.indexOf('mdat');
  if (moov < 0 || (mdat >= 0 && mdat < moov)) issues.push({ path: 'storageKey', issue: 'not_faststart' });
  return issues;
}

export function createVideoExportActivities(
  deps: { storage?: StorageProvider } = {},
): VideoExportActivitiesV1 {
  const store = () => deps.storage ?? storage();
  return {
    storeVideoExport: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const e = input.export;
        const exportsPrefix = `assets/${input.tenantId}/${input.brandId}/exports/`;
        for (const [path, key] of [
          ['storageKey', e.storageKey],
          ['posterStorageKey', e.posterStorageKey],
          ...(e.captionsStorageKey ? [['captionsStorageKey', e.captionsStorageKey]] : []),
        ] as const) {
          const parsed = parseStorageKey(key);
          if (!parsed || parsed.tenantId !== input.tenantId || !key.startsWith(exportsPrefix))
            throw new ValidationFailedError([{ path, issue: 'not_in_brand_exports' }]);
        }
        // The export row is evidence: the stored bytes must be the rendered ones (streamed, never held whole).
        heartbeat('video-export:hash');
        const stored = await hashStoredObject(store(), e.storageKey, () => heartbeat('video-export:hash'));
        if (!stored) throw new Error(`export object not readable yet: ${e.storageKey}`); // retried
        if (stored.contentHash !== e.contentHash || stored.bytes !== e.bytes)
          throw new RenderIntegrityError(e.storageKey, e.contentHash, stored.contentHash);
        const poster = await hashStoredObject(store(), e.posterStorageKey);
        if (!poster) throw new Error(`poster not readable yet: ${e.posterStorageKey}`); // retried
        if (poster.contentHash !== e.posterContentHash)
          throw new RenderIntegrityError(e.posterStorageKey, e.posterContentHash, poster.contentHash);
        if (e.captionsStorageKey && !(await store().headObject(e.captionsStorageKey)))
          throw new Error(`captions not readable yet: ${e.captionsStorageKey}`); // retried
        heartbeat('video-export:probe');
        const boxes = await topLevelBoxes(store(), e.storageKey, stored.bytes);
        const issues = await withTempDir({ maxBytes: stored.bytes + 16 * 1024 * 1024 }, async (dir) => {
          const local = await dir.download(store(), e.storageKey, 'export.mp4');
          if (!local) throw new Error(`export object not readable yet: ${e.storageKey}`);
          const probe = await probeFile(local.path, local.bytes);
          if ('ok' in probe) return [{ path: 'storageKey', issue: probe.reason }];
          return checkVideoExport(probe, boxes, e);
        });
        if (issues.length)
          throw new ValidationFailedError(issues, 'The rendered video is not a valid export');
        return {
          storageKey: e.storageKey,
          contentHash: stored.contentHash,
          bytes: stored.bytes,
          durationMs: e.durationMs,
          fps: e.fps,
          posterStorageKey: e.posterStorageKey,
          ...(e.captionsStorageKey ? { captionsStorageKey: e.captionsStorageKey } : {}),
        };
      }),
  };
}
