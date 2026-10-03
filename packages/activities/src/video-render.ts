import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, rename, statfs, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Context } from '@temporalio/activity';
import { IMAGE_CREATIVE_KINDS, type AssetKind } from '@oremedia/contracts/assets';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type {
  CreativePage,
  Finding,
  FormatDefinition,
  RenderExportInput,
  RenderJobState,
  RenderProgress,
} from '@oremedia/contracts/creative';
import {
  NotFoundError,
  OremediaError,
  RightsIneligibleError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { MediaProbeV1 } from '@oremedia/contracts/media';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type {
  RenderAssetRef,
  RenderFontRef,
  VideoExportReuse,
  VideoOverlayFrame,
  VideoRenderJobActivitiesV1,
  VideoRenderResolveResult,
  VideoSourceRef,
} from '@oremedia/contracts/render';
import type { VideoProjectV1 } from '@oremedia/contracts/video';
import { withTransaction, type Tx } from '@oremedia/db';
import { captionPage, captionsVtt, overlayPage, videoFormatOf } from '@oremedia/editor/video/overlays';
import { frameOf } from '@oremedia/editor/video/time';
import { validateVideoProject } from '@oremedia/editor/video/validate';
import {
  AssetDerivativeRepository,
  AssetVersionRepository,
  assetService,
  ffmpegPath,
  runTool,
  probeFile,
  withToolContext,
  renderFontFaces,
  storage,
  tempRoot,
  TempDiskBudgetExceededError,
  withTempDir,
  type StorageProvider,
  type TempDir,
} from '@oremedia/module-assets';
import { brandService } from '@oremedia/module-brand';
import { METRIC, count, logger, record } from '@oremedia/observability';
import { loadActorGrants, resolveActivityActor } from './actor';
import type { RenderJobStore } from './render-job';
import { RenderIntegrityError } from './render-job';
import { cancellationSignal, heartbeat, inTenant } from './tenant';
import {
  VIDEO_MAX_OVERLAY_FRAMES,
  VIDEO_MAX_OVERLAY_LANES,
  buildComposePlan,
  demuxerFor,
  overlayLanes,
  overlayWindows,
  posterArgs,
  type ComposeSourceFile,
} from './video-filter-graph';
import { createVideoExportActivities, videoExportDedupeKey, videoExportStorageKeys } from './video-export';

/**
 * STU-2b activities for videoRenderJobWorkflowV1 (task queue `video`, worker-render). Like the still render they
 * re-establish tenant context, pin every input through the modules (authoriseUse at the point of effect) and read
 * bytes only from the object store, re-hashed against the pins. The originals are composed, never the editing
 * proxies. Overlays and captions are drawn by the Chromium scene renderer the worker supplies (font and colour
 * parity with the editor); ffmpeg runs with input protocols limited to files and pipes, demuxers forced, threads
 * and output duration capped, inside a temp directory with a byte budget, heartbeating at least every 30 s and
 * killed when Temporal cancels the activity (a person's cancel) or the job row reads `cancelled`.
 */

/** The page id of a video's one export (creative.renders.markReady checks it). */
export const VIDEO_PAGE_ID = 'timeline';
/** Compositor version, recorded after the scene renderer's: bump when the filter graph changes pixels or sound. */
export const VIDEO_COMPOSITOR_VERSION = 'video.1';

/** A person's cancel seen by the activity (the job row is `cancelled`): never retried. */
export class RenderCancelledError extends OremediaError {
  constructor(renderJobId: string) {
    super('CONFLICT', `Render job ${renderJobId} was cancelled`);
  }
}

export interface VideoRenderStore extends RenderJobStore {
  getVideoRevision(
    actor: ResolvedActor,
    documentId: string,
    revisionId: string,
  ): Promise<{ project: VideoProjectV1; contentHash: string; brandVersionId: string }>;
  markProgress(renderJobId: string, progress: RenderProgress, tx: Tx): Promise<{ state: RenderJobState }>;
  findVideoExport(brandId: string, dedupeKey: string): Promise<VideoExportReuse | null>;
}

/** Draws one transparent page at the project's size with the shared scene renderer (worker-render: Chromium). */
export interface OverlayRenderer {
  renderFrame(input: {
    page: CreativePage;
    format: FormatDefinition;
    fonts: Array<{ family: string; mime: string; bytes: Buffer; unicodeRange?: string }>;
    assets: Array<{ assetVersionId: string; mime: string; bytes: Buffer }>;
    colours: Record<string, string>;
  }): Promise<{ png: Buffer }>;
}

export interface VideoRenderDeps {
  store: VideoRenderStore;
  overlays: OverlayRenderer;
  /** packages/editor RENDERER_VERSION (overlays); the compositor version is appended. */
  rendererVersion: string;
  storage?: StorageProvider;
  /**
   * Most temp disk one render may use (MEDIA_TMP_MAX_BYTES); default 10 GiB, and never more than the free space of
   * MEDIA_TMP_DIR less a 1 GiB margin, measured when the render is resolved and again before it composes.
   */
  tmpMaxBytes?: number;
  /** x264 settings; production uses `veryfast` / CRF 20 / 2 threads. */
  encoder?: { preset?: string; crf?: number; threads?: number };
  /** Hard limit for one ffmpeg run; default 50 minutes (a 180 s 1080p project encodes in a few minutes). */
  encodeTimeoutMs?: number;
}

const DEFAULT_TMP_MAX = 10 * 1024 ** 3;
/** Disk left free beside a render's temp directory (other jobs, logs, the OS). */
const TMP_FREE_MARGIN = 1024 ** 3;

/** The temp budget now: the configured cap, never more than the free space of the temp root less the margin. */
export async function tempBudget(configured: number, root?: string): Promise<number> {
  try {
    const fs = await statfs(tempRoot(root));
    return Math.max(0, Math.min(configured, fs.bavail * fs.bsize - TMP_FREE_MARGIN));
  } catch {
    return configured; // no statfs on this platform: the configured cap (and -fs) still bound the job
  }
}
const PICTURE_KINDS: readonly AssetKind[] = ['video', ...IMAGE_CREATIVE_KINDS];
const SOUND_KINDS: readonly AssetKind[] = ['audio', 'video'];
const HEARTBEAT_EVERY_MS = 30_000;
const PROGRESS_EVERY_MS = 3_000;

const workKey = (tenantId: string, brandId: string, revisionId: string, jobId: string, name: string) =>
  `assets/${tenantId}/${brandId}/exports/${revisionId}/${jobId}/work/${name}`;

const extensionFor = (mime: string) =>
  ({
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  })[mime.toLowerCase()] ?? 'bin';

/** Every font the overlays and captions use. */
function projectFontRefs(project: VideoProjectV1): string[] {
  const out = new Set<string>();
  for (const t of project.tracks) {
    if (t.kind === 'caption' && t.items.length) out.add(t.style.fontAssetVersionId);
    if (t.kind === 'overlay')
      for (const o of t.items) if (o.element.type === 'text') out.add(o.element.style.fontAssetVersionId);
  }
  return [...out];
}

function overlayImageRefs(project: VideoProjectV1): Array<{ id: string; purpose: 'creative' | 'logo' }> {
  const out = new Map<string, 'creative' | 'logo'>();
  for (const t of project.tracks)
    if (t.kind === 'overlay')
      for (const o of t.items) {
        if (o.element.type === 'image') out.set(o.element.assetVersionId, 'creative');
        if (o.element.type === 'logo') out.set(o.element.assetVersionId, 'logo');
      }
  return [...out].map(([id, purpose]) => ({ id, purpose }));
}

/**
 * Runs ffmpeg with progress lines on stdout, a hard timeout, a heartbeat at least every 30 s, and an abort signal
 * that kills the process (Temporal activity cancellation, or the job read as cancelled).
 */
export function runFfmpeg(
  args: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal; onProgressUs?: (outTimeUs: number) => void },
): Promise<{ code: number; stderr: string; cancelled: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buffer = '';
    let cancelled = false;
    let timedOut = false;
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const beat = setInterval(() => heartbeat('video:encode'), HEARTBEAT_EVERY_MS);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (m && opts.onProgressUs) opts.onProgressUs(Number(m[1]));
        at = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_384);
    });
    const done = () => {
      clearTimeout(timer);
      clearInterval(beat);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      done();
      reject(new Error(`ffmpeg could not start: ${e.message}`));
    });
    child.on('close', (code) => {
      done();
      if (timedOut) return reject(new Error(`ffmpeg timed out after ${opts.timeoutMs} ms`));
      resolve({ code: code ?? -1, stderr, cancelled });
    });
  });
}

export interface EncodeOptions {
  project: VideoProjectV1;
  sources: Readonly<Record<string, ComposeSourceFile>>;
  frames: Array<{ path: string; startMs: number; endMs: number; itemId: string }>;
  dir: TempDir;
  encoder: { preset: string; crf: number; threads: number };
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * The compositor proper (also driven directly by the real-ffmpeg tests): writes the filter script, encodes
 * `output.mp4` within the temp budget, then the poster frame and the WebVTT captions beside it.
 */
export async function encodeProject(o: EncodeOptions): Promise<{
  output: string;
  poster: string;
  captions: string | null;
  totalFrames: number;
  durationMs: number;
}> {
  const overlayById = new Map(
    o.project.tracks.flatMap((t) => (t.kind === 'overlay' ? t.items.map((i) => [i.id, i] as const) : [])),
  );
  const output = o.dir.file('output.mp4');
  const script = o.dir.file('graph.txt');
  const plan = buildComposePlan({
    project: o.project,
    sources: o.sources,
    frames: o.frames.map((f) => {
      const overlay = overlayById.get(f.itemId);
      return {
        path: f.path,
        startMs: f.startMs,
        endMs: f.endMs,
        ...(overlay ? { overlay: { enter: overlay.enter, exit: overlay.exit } } : {}),
      };
    }),
    blankFramePath: o.dir.file('blank.png'),
    lanePattern: (lane) => o.dir.file(`lane${lane}_00000.png`).replace('00000', '%05d'),
    filterScriptPath: script,
    outputPath: output,
    encoder: {
      preset: o.encoder.preset,
      crf: o.encoder.crf,
      threads: o.encoder.threads,
      audioBitrate: '160k',
      maxBytes: Math.max(1, (await o.dir.remaining()) - 64 * 1024 * 1024),
    },
  });
  await writeFile(script, plan.filterGraph);
  if (plan.stills.length) {
    // The lanes' image sequences: each frame file moves into place; gaps link the one transparent frame.
    const { width, height } = o.project.format;
    const blank = await runFfmpeg(
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=black@0:s=${width}x${height},format=rgba`,
        '-frames:v',
        '1',
        '-threads',
        '2',
        '-f',
        'image2',
        '-c:v',
        'png',
        o.dir.file('blank.png'),
      ],
      { timeoutMs: 60_000, ...(o.signal ? { signal: o.signal } : {}) },
    );
    if (blank.code !== 0) throw new Error(`blank frame failed: ${blank.stderr.trim().slice(-300)}`);
    const blankPath = o.dir.file('blank.png');
    const own = (path: string) => dirname(path) === o.dir.path;
    for (const still of plan.stills)
      if (still.from === blankPath) await link(still.from, still.path);
      else if (own(still.from)) await rename(still.from, still.path);
      else await copyFile(still.from, still.path);
  }
  const totalUs = plan.durationSeconds * 1_000_000;
  const run = await runFfmpeg(plan.args, {
    timeoutMs: o.timeoutMs,
    ...(o.signal ? { signal: o.signal } : {}),
    onProgressUs: (us) => o.onProgress?.(Math.min(1, us / totalUs)),
  });
  if (run.cancelled) throw new Error('encode cancelled');
  if (run.code !== 0)
    throw new Error(`ffmpeg failed (${run.code}): ${run.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  await o.dir.assertWithinBudget();
  const durationMs = Math.round((plan.totalFrames * 1000) / o.project.format.fps);
  const poster = o.dir.file('poster.webp');
  const p = await runFfmpeg(posterArgs(output, poster, Math.min(1000, Math.floor(durationMs / 2))), {
    timeoutMs: 120_000,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (p.code !== 0) throw new Error(`poster failed: ${p.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  const vtt = captionsVtt(o.project);
  let captions: string | null = null;
  if (vtt) {
    captions = o.dir.file('captions.vtt');
    await writeFile(captions, vtt);
  }
  await o.dir.assertWithinBudget();
  return { output, poster, captions, totalFrames: plan.totalFrames, durationMs };
}

export function createVideoRenderActivities(deps: VideoRenderDeps): VideoRenderJobActivitiesV1 {
  const store = () => deps.storage ?? storage();
  const versionsRepo = new AssetVersionRepository();
  const derivativesRepo = new AssetDerivativeRepository();
  const log = () => logger().child('video-render');
  const exportStore = createVideoExportActivities(deps.storage ? { storage: deps.storage } : {});
  const rendererVersion = `${deps.rendererVersion}+${VIDEO_COMPOSITOR_VERSION}`;
  const tmpMax = deps.tmpMaxBytes ?? DEFAULT_TMP_MAX;
  const encoder = {
    preset: deps.encoder?.preset ?? 'veryfast',
    crf: deps.encoder?.crf ?? 20,
    threads: deps.encoder?.threads ?? 2,
  };
  // What the encode depends on besides the project: x264 settings and the ffmpeg build (read once per worker).
  let encoderId: Promise<string> | null = null;
  const encoderFingerprint = () =>
    (encoderId ??= runTool(ffmpegPath(), ['-hide_banner', '-version'], { timeoutMs: 10_000 }).then(
      (r) =>
        `x264 ${encoder.preset} crf ${encoder.crf} threads ${encoder.threads}; ${r.stdout.toString().split('\n')[0]?.trim() ?? ''}`,
    ));

  const readPinned = async (ref: { storageKey: string; contentHash: string }): Promise<Buffer> => {
    const bytes = await store().getObject(ref.storageKey);
    if (!bytes) throw new NotFoundError('AssetObject', ref.storageKey);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== ref.contentHash) throw new RenderIntegrityError(ref.storageKey, ref.contentHash, actual);
    return bytes;
  };
  const pin = async (
    assetVersionId: string,
    purpose: 'font' | 'creative' | 'logo',
    brandId: string,
    kinds?: readonly AssetKind[],
  ) => {
    const authorised = await assetService.authoriseUse(assetVersionId, purpose, {
      brandId,
      ...(kinds ? { kinds } : {}),
    });
    const version = await versionsRepo.findInTenant(authorised.assetVersionId);
    if (!version) throw new NotFoundError('AssetVersion', assetVersionId);
    return version;
  };

  /** Throttled progress on the job row; tells the caller when the job was cancelled meanwhile. */
  const progressReporter = (renderJobId: string, phase: string, from: number, to: number) => {
    let last = 0;
    let pending: Promise<void> = Promise.resolve();
    let cancelled = false;
    return {
      report(fraction: number) {
        heartbeat(`${phase}:${Math.round(fraction * 100)}%`);
        const now = Date.now();
        if (now - last < PROGRESS_EVERY_MS) return;
        last = now;
        const value = Math.min(1, from + (to - from) * fraction);
        pending = pending.then(async () => {
          try {
            const r = await withTransaction((tx) =>
              deps.store.markProgress(renderJobId, { phase, fraction: value }, tx),
            );
            if (r.state === 'cancelled') cancelled = true;
          } catch (err) {
            log().warn({ renderJobId, err: String(err) }, 'progress not recorded');
          }
        });
      },
      cancelled: () => cancelled,
      flush: () => pending,
    };
  };

  return {
    beginVideoRender: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const { actor } = await resolveActivityActor(input);
        const job = await deps.store.getJob(actor, input.renderJobId);
        if (job.state === 'cancelled') throw new RenderCancelledError(job.renderJobId);
        await deps.store.getVideoRevision(actor, job.documentId, job.revisionId); // a video, readable by the actor
        if (job.state === 'pending')
          await withTransaction((tx) => deps.store.markRendering(job.renderJobId, tx));
        else if (job.state !== 'rendering')
          throw new ValidationFailedError(
            [{ path: 'renderJobId', issue: `render_job_${job.state}` }],
            `Render job is ${job.state}`,
          );
        return {
          renderJobId: job.renderJobId,
          revisionId: job.revisionId,
          documentId: job.documentId,
          brandId: job.brandId,
          formatKeys: job.formatKeys,
        };
      }),

    resolveVideoRender: (input) =>
      inTenant(input, loadActorGrants, async (): Promise<VideoRenderResolveResult> => {
        const { actor } = await resolveActivityActor(input);
        const revision = await deps.store.getVideoRevision(actor, input.documentId, input.revisionId);
        const project = revision.project;
        const snapshot = await brandService.resolveBrandSnapshot(actor, {
          brandId: input.brandId,
          versionId: project.brandVersionId,
        });
        if (input.formatKeys.length !== 1 || input.formatKeys[0] !== project.format.key)
          return {
            ok: false,
            reason: 'format_not_in_document',
            detail: `a video renders at its own format ${project.format.key}`,
          };
        const sources: VideoSourceRef[] = [];
        const fonts: RenderFontRef[] = [];
        const assets: RenderAssetRef[] = [];
        try {
          const timed = new Map<string, readonly AssetKind[]>();
          for (const t of project.tracks)
            if (t.kind === 'video' || t.kind === 'audio')
              for (const i of t.items)
                timed.set(i.assetVersionId, t.kind === 'video' ? PICTURE_KINDS : SOUND_KINDS);
          const summaries = new Map(
            (await assetService.mediaSummaries([...timed.keys()])).map((m) => [m.assetVersionId, m]),
          );
          for (const [id, kinds] of timed) {
            const v = await pin(id, 'creative', input.brandId, kinds);
            const m = summaries.get(id);
            if (!m) throw new NotFoundError('AssetVersion', id);
            // ffmpeg reads every source with a forced demuxer. A still it has none for (AVIF, HEIC, SVG…) is read
            // from its raster rendition (the SVG PNG, else the 2048 px WebP); without one the render is refused.
            let file: { storageKey: string; contentHash: string; mime: string; bytes: number } = v;
            if (m.kind === 'image' && !demuxerFor(v.mime)) {
              const raster =
                (await derivativesRepo.find(v.id, 'png')) ?? (await derivativesRepo.find(v.id, 'web'));
              if (!raster || !demuxerFor(raster.mime))
                return {
                  ok: false,
                  reason: 'unsupported_source',
                  detail: `${id}: ${v.mime} has no raster rendition the compositor can read`,
                };
              file = raster;
            }
            sources.push({
              assetVersionId: v.id,
              storageKey: file.storageKey,
              contentHash: file.contentHash,
              mime: file.mime,
              kind: m.kind,
              bytes: file.bytes,
              durationMs: m.durationMs,
              hasAudio: m.hasAudio,
            });
          }
          const pinnedFonts = new Set<string>();
          for (const id of projectFontRefs(project)) {
            const files = [id, ...(await assetService.fontFaceFiles(id)).slice(1)];
            for (const [n, fid] of files.entries()) {
              if (pinnedFonts.has(fid)) continue;
              try {
                const v = await pin(fid, 'font', input.brandId);
                pinnedFonts.add(v.id);
                fonts.push({
                  assetVersionId: v.id,
                  storageKey: v.storageKey,
                  contentHash: v.contentHash,
                  mime: v.mime,
                });
              } catch (err) {
                if (n === 0 || !(err instanceof RightsIneligibleError)) throw err;
              }
            }
          }
          for (const { id, purpose } of overlayImageRefs(project)) {
            const v = await pin(
              id,
              purpose,
              input.brandId,
              purpose === 'creative' ? IMAGE_CREATIVE_KINDS : undefined,
            );
            assets.push({
              assetVersionId: v.id,
              storageKey: v.storageKey,
              contentHash: v.contentHash,
              mime: v.mime,
              width: v.width,
              height: v.height,
            });
          }
          const findings: Finding[] = validateVideoProject(project, {
            media: Object.fromEntries(summaries),
            snapshot,
          });
          const dedupeKey = videoExportDedupeKey({
            projectContentHash: revision.contentHash,
            rendererVersion,
            formatKey: project.format.key,
            fps: project.format.fps,
            assetContentHashes: [...sources, ...fonts, ...assets].map((a) => a.contentHash),
            encoder: await encoderFingerprint(),
          });
          const previous = await deps.store.findVideoExport(input.brandId, dedupeKey);
          const reuse = previous && (await store().headObject(previous.storageKey)) ? previous : null;
          const W = project.format.width;
          const H = project.format.height;
          // Every lane of titles and captions is one ffmpeg input holding a frame or two: bound both.
          const windows = overlayWindows(project);
          const lanes = overlayLanes(
            windows,
            project.format.fps,
            frameOf(project.durationMs, project.format.fps),
          );
          if (!reuse && windows.length > VIDEO_MAX_OVERLAY_FRAMES)
            return {
              ok: false,
              reason: 'too_large',
              detail: `${windows.length} titles and captions; a video renders at most ${VIDEO_MAX_OVERLAY_FRAMES}`,
            };
          if (!reuse && lanes.length > VIDEO_MAX_OVERLAY_LANES)
            return {
              ok: false,
              reason: 'too_large',
              detail: `${lanes.length} titles and captions on screen at once; a video renders at most ${VIDEO_MAX_OVERLAY_LANES}`,
            };
          const overlayCount = windows.length;
          // Sources as stored, every overlay PNG at most an uncompressed frame, the MP4 at a generous 20 Mbit/s.
          const estimate =
            sources.reduce((n, s) => n + s.bytes, 0) +
            overlayCount * W * H * 4 +
            Math.ceil((project.durationMs / 1000) * 2.5 * 1024 * 1024) +
            256 * 1024 * 1024;
          const budget = await tempBudget(tmpMax);
          if (!reuse && estimate > budget)
            return {
              ok: false,
              reason: 'too_large',
              detail: `the sources and output need about ${Math.ceil(estimate / 1024 ** 2)} MiB of working disk; ${Math.floor(budget / 1024 ** 2)} MiB is available`,
            };
          return {
            ok: true,
            rendererVersion,
            brandVersionId: project.brandVersionId,
            revisionContentHash: revision.contentHash,
            formatKey: project.format.key,
            width: W,
            height: H,
            fps: project.format.fps,
            durationMs: project.durationMs,
            dedupeKey,
            reuse,
            sources,
            fonts,
            assets,
            manifest: {
              rendererVersion,
              fonts: fonts.map((f) => ({ assetVersionId: f.assetVersionId, contentHash: f.contentHash })),
              assets: [...sources, ...assets].map((a) => ({
                assetVersionId: a.assetVersionId,
                contentHash: a.contentHash,
              })),
              brandVersionId: project.brandVersionId,
              revisionContentHash: revision.contentHash,
            },
            tempBudgetBytes: Math.min(budget, Math.max(estimate, 512 * 1024 * 1024)),
            overlayFrameCount: windows.length,
            findings,
          };
        } catch (err) {
          if (err instanceof RightsIneligibleError)
            return {
              ok: false,
              reason: 'rights_ineligible',
              detail: err.details?.map((d) => `${d.path ?? ''}: ${d.issue}`).join('; ') ?? err.message,
            };
          throw err;
        }
      }),

    renderVideoOverlays: (input) =>
      inTenant(input, loadActorGrants, async () => {
        heartbeat('video:overlays');
        const { actor } = await resolveActivityActor(input);
        const { project } = await deps.store.getVideoRevision(actor, input.documentId, input.revisionId);
        const snapshot: BrandSnapshot = await brandService.resolveBrandSnapshot(actor, {
          brandId: input.brandId,
          versionId: input.brandVersionId,
        });
        const fontBytes = new Map<string, Buffer>();
        const pinnedFonts = [];
        for (const f of input.fonts) {
          fontBytes.set(f.assetVersionId, await readPinned(f));
          const v = await versionsRepo.findInTenant(f.assetVersionId);
          if (!v) throw new NotFoundError('AssetVersion', f.assetVersionId);
          pinnedFonts.push({ ref: f, assetVersionId: v.id, assetId: v.assetId, provenance: v.provenance });
        }
        const fonts = [];
        for (const face of renderFontFaces(projectFontRefs(project), pinnedFonts)) {
          const ref = pinnedFonts.find((p) => p.assetVersionId === face.assetVersionId)?.ref;
          const bytes = fontBytes.get(face.assetVersionId);
          if (!ref || !bytes) continue;
          fonts.push({
            family: face.family,
            mime: ref.mime,
            bytes,
            ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
          });
        }
        const assets = [];
        for (const a of input.assets)
          assets.push({ assetVersionId: a.assetVersionId, mime: a.mime, bytes: await readPinned(a) });
        const colours = Object.fromEntries(snapshot.document.tokens.colours.map((c) => [c.key, c.value]));
        const format = videoFormatOf(project);
        const overlayById = new Map(
          project.tracks.flatMap((t) => (t.kind === 'overlay' ? t.items.map((o) => [o.id, o] as const) : [])),
        );
        const captionById = new Map(
          project.tracks.flatMap((t) =>
            t.kind === 'caption' ? t.items.map((c) => [c.id, { track: t, item: c }] as const) : [],
          ),
        );
        const pages: Array<{
          page: CreativePage;
          frame: Omit<VideoOverlayFrame, 'storageKey' | 'contentHash'>;
        }> = [];
        for (const w of overlayWindows(project)) {
          const o = overlayById.get(w.itemId);
          const c = captionById.get(w.itemId);
          const page = o ? overlayPage(project, o) : c ? captionPage(project, c.track, c.item) : null;
          if (page) pages.push({ page, frame: w });
        }
        const frames: VideoOverlayFrame[] = [];
        const progress = progressReporter(input.renderJobId, 'overlays', 0.05, 0.15);
        const signal = cancellationSignal();
        try {
          for (const [n, p] of pages.entries()) {
            // Between frames: a cancelled activity (signal) or a job a person cancelled (state) stops here.
            if (signal?.aborted || progress.cancelled()) throw new RenderCancelledError(input.renderJobId);
            progress.report(n / Math.max(1, pages.length));
            const { png } = await deps.overlays.renderFrame({ page: p.page, format, fonts, assets, colours });
            const storageKey = workKey(
              input.tenantId,
              input.brandId,
              input.revisionId,
              input.renderJobId,
              `${p.frame.itemId}.png`,
            );
            await store().putObject(storageKey, png, { contentType: 'image/png' });
            frames.push({
              ...p.frame,
              storageKey,
              contentHash: createHash('sha256').update(png).digest('hex'),
            });
          }
        } finally {
          await progress.flush();
        }
        return { frames, findings: [] };
      }),

    composeVideo: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const { actor } = await resolveActivityActor(input);
        const { project } = await deps.store.getVideoRevision(actor, input.documentId, input.revisionId);
        const progress = progressReporter(input.renderJobId, 'encoding', 0.15, 0.95);
        let signal: AbortSignal | undefined;
        try {
          signal = Context.current().cancellationSignal;
        } catch {
          signal = undefined; // outside an activity (tests)
        }
        const abort = new AbortController();
        signal?.addEventListener('abort', () => abort.abort(), { once: true });
        const started = Date.now();
        // The disk may have filled since the job was resolved: refuse (too_large) before downloading anything.
        const budget = Math.min(input.tempBudgetBytes, await tempBudget(tmpMax));
        const needed = input.sources.reduce((n, s) => n + s.bytes, 0) + 64 * 1024 * 1024;
        if (needed > budget) throw new TempDiskBudgetExceededError(needed, budget);
        let result;
        try {
          result = await withTempDir({ maxBytes: budget }, async (dir) => {
            // Originals, streamed to disk and re-hashed against their pins (never the proxies).
            const files: Record<string, ComposeSourceFile> = {};
            const probes = new Map<string, MediaProbeV1>();
            for (const [n, s] of input.sources.entries()) {
              heartbeat(`video:download:${n + 1}/${input.sources.length}`);
              const local = await dir.download(store(), s.storageKey, `src${n}.${extensionFor(s.mime)}`, {
                onProgress: () => heartbeat('video:download'),
              });
              if (!local) throw new NotFoundError('AssetObject', s.storageKey);
              if (local.contentHash !== s.contentHash)
                throw new RenderIntegrityError(s.storageKey, s.contentHash, local.contentHash);
              let width: number | null = null;
              let height: number | null = null;
              if (s.kind === 'video') {
                const probe = await withToolContext(
                  { signal: abort.signal, tick: () => heartbeat('video:probe') },
                  () => probeFile(local.path, local.bytes, { mime: s.mime, maxSeconds: 601 }),
                );
                if ('ok' in probe)
                  throw new ValidationFailedError([{ path: s.assetVersionId, issue: probe.reason }]);
                probes.set(s.assetVersionId, probe);
                width = probe.video?.width ?? null;
                height = probe.video?.height ?? null;
              } else if (s.kind === 'image') {
                const v = await versionsRepo.findInTenant(s.assetVersionId);
                width = v?.width ?? null;
                height = v?.height ?? null;
              }
              files[s.assetVersionId] = {
                path: local.path,
                kind: s.kind,
                mime: s.mime,
                hasAudio: s.kind === 'audio' || (probes.get(s.assetVersionId)?.audio.length ?? 0) > 0,
                width,
                height,
              };
            }
            const frames = [];
            for (const [n, f] of input.frames.entries()) {
              const local = await dir.download(store(), f.storageKey, `frame${n}.png`);
              if (!local) throw new NotFoundError('OverlayFrame', f.storageKey);
              if (local.contentHash !== f.contentHash)
                throw new RenderIntegrityError(f.storageKey, f.contentHash, local.contentHash);
              frames.push({ path: local.path, startMs: f.startMs, endMs: f.endMs, itemId: f.itemId });
            }
            const checkCancelled = setInterval(() => {
              if (progress.cancelled()) abort.abort();
            }, 1_000);
            try {
              const out = await encodeProject({
                project,
                sources: files,
                frames,
                dir,
                encoder,
                timeoutMs: deps.encodeTimeoutMs ?? 50 * 60_000,
                signal: abort.signal,
                onProgress: (fraction) => progress.report(fraction),
              });
              heartbeat('video:upload');
              const keys = videoExportStorageKeys(
                input.tenantId,
                input.brandId,
                input.revisionId,
                input.renderJobId,
                VIDEO_PAGE_ID,
                project.format.key,
              );
              const video = await dir.upload(store(), keys.video, 'output.mp4', 'video/mp4');
              const poster = await dir.upload(store(), keys.poster, 'poster.webp', 'image/webp');
              if (out.captions) await dir.upload(store(), keys.captions, 'captions.vtt', 'text/vtt');
              return { out, keys, video, poster };
            } catch (err) {
              if (abort.signal.aborted) throw new RenderCancelledError(input.renderJobId);
              throw err;
            } finally {
              clearInterval(checkCancelled);
              await progress.flush();
            }
          });
        } finally {
          // The overlay frames are working files of this job, done with whether it encoded, failed or was cancelled.
          for (const f of input.frames)
            await store()
              .deleteObject(f.storageKey)
              .catch(() => undefined);
        }
        const encodeMs = Date.now() - started;
        record(METRIC.renderDurationMs, encodeMs, { formatKey: project.format.key });
        log().info(
          {
            renderJobId: input.renderJobId,
            brandId: input.brandId,
            durationMs: result.out.durationMs,
            encodeMs,
          },
          'video composed',
        );
        return {
          pageId: VIDEO_PAGE_ID,
          formatKey: project.format.key,
          storageKey: result.keys.video,
          contentHash: result.video.contentHash,
          bytes: result.video.bytes,
          width: project.format.width,
          height: project.format.height,
          durationMs: result.out.durationMs,
          fps: project.format.fps,
          posterStorageKey: result.keys.poster,
          posterContentHash: result.poster.contentHash,
          ...(result.out.captions ? { captionsStorageKey: result.keys.captions } : {}),
          encodeMs,
        };
      }),

    storeVideoExport: exportStore.storeVideoExport,

    completeVideoRender: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const e = input.export;
        const exports: RenderExportInput[] = [
          {
            pageId: e.pageId,
            formatKey: e.formatKey,
            mime: 'video/mp4',
            width: e.width,
            height: e.height,
            bytes: e.bytes,
            storageKey: e.storageKey,
            contentHash: e.contentHash,
            rendererVersion: input.rendererVersion,
            manifest: input.manifest,
            validation: {
              ok: !input.findings.some((f) => f.severity === 'blocking'),
              findings: input.findings,
            },
            durationMs: e.durationMs,
            fps: e.fps,
            posterStorageKey: e.posterStorageKey,
            ...(e.captionsStorageKey ? { captionsStorageKey: e.captionsStorageKey } : {}),
            dedupeKey: input.dedupeKey,
          },
        ];
        const ready = await withTransaction((tx) => deps.store.markReady(input.renderJobId, exports, tx));
        count(METRIC.renderJobs, 1, { result: 'ready' });
        return ready;
      }),

    discardVideoRenderWork: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const { actor } = await resolveActivityActor(input);
        const job = await deps.store.getJob(actor, input.renderJobId);
        const { project } = await deps.store.getVideoRevision(actor, input.documentId, input.revisionId);
        const keys = overlayWindows(project).map((w) =>
          workKey(input.tenantId, input.brandId, input.revisionId, input.renderJobId, `${w.itemId}.png`),
        );
        // A recorded export is evidence (insert-only); only a job that never became ready lost its files.
        if (job.state !== 'ready') {
          const out = videoExportStorageKeys(
            input.tenantId,
            input.brandId,
            input.revisionId,
            input.renderJobId,
            VIDEO_PAGE_ID,
            project.format.key,
          );
          keys.push(out.video, out.poster, out.captions);
        }
        let deleted = 0;
        for (const key of keys) {
          heartbeat('video:discard');
          if (await store().headObject(key)) {
            await store().deleteObject(key);
            deleted += 1;
          }
        }
        if (deleted) log().info({ renderJobId: input.renderJobId, deleted }, 'video render work discarded');
        return { deleted };
      }),

    failVideoRender: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const { actor } = await resolveActivityActor(input);
        const job = await deps.store.getJob(actor, input.renderJobId);
        if (job.state !== 'rendering') {
          log().warn(
            { renderJobId: job.renderJobId, state: job.state, reason: input.reason },
            'video render not failed',
          );
          return;
        }
        const error = input.detail ? `${input.reason}: ${input.detail}` : input.reason;
        await withTransaction((tx) => deps.store.markFailed(job.renderJobId, error.slice(0, 2000), tx));
        count(METRIC.renderFailures, 1, { reason: input.reason });
        count(METRIC.renderJobs, 1, { result: 'failed' });
      }),
  };
}
