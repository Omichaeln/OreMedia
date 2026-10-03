import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  ACCEPTED_AUDIO_CODECS,
  ACCEPTED_VIDEO_CODECS,
  PERSON_MEDIA_LIMITS,
  type DerivativePurpose,
  type IngestRejectionReason,
} from '@oremedia/contracts/assets';
import {
  MediaProbeV1,
  STRIP_FRAMES,
  WAVEFORM_PEAKS_PER_SECOND,
  type MediaAudioStream,
  type MediaVideoStream,
  type StripMapV1,
  type WaveformV1,
} from '@oremedia/contracts/media';
import type { TempDir } from '../temp-disk';

/**
 * STU-2a video and audio ingest: ffprobe inspection and ffmpeg derivatives (poster, thumbnail strip, editing proxy,
 * waveform peaks). Everything works on files in a TempDir (the caller streams the object there); nothing here holds
 * a whole source in memory. Tools run as child processes with a timeout, bounded output and progress callbacks, and
 * a rejection is a value with a reason code and a short user-safe detail (never raw tool output).
 */

export interface MediaRejection {
  ok: false;
  reason: IngestRejectionReason;
  detail: string;
}
const rejection = (reason: IngestRejectionReason, detail: string): MediaRejection => ({
  ok: false,
  reason,
  detail: detail.slice(0, 280),
});

// ---- process runner -------------------------------------------------------------------------------------------

export const ffmpegPath = (): string => process.env['FFMPEG_PATH'] ?? 'ffmpeg';
export const ffprobePath = (): string => process.env['FFPROBE_PATH'] ?? 'ffprobe';

export class MediaToolError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'MediaToolError';
  }
}

export interface RunOptions {
  timeoutMs: number;
  /** stdout is collected up to this many bytes (more is an error) unless `onStdout` consumes it. */
  maxStdoutBytes?: number;
  onStdout?: (chunk: Buffer) => void;
  /** Called with each complete stdout line (ffmpeg `-progress pipe:1`). */
  onLine?: (line: string) => void;
}

/** Runs a tool to completion; stderr keeps its last 16 KiB for diagnostics. Never uses a shell. */
export function runTool(
  cmd: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let lineBuffer = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (opts.onStdout) return opts.onStdout(chunk);
      if (opts.onLine) {
        lineBuffer += chunk.toString('utf8');
        let at = lineBuffer.indexOf('\n');
        while (at >= 0) {
          opts.onLine(lineBuffer.slice(0, at).trim());
          lineBuffer = lineBuffer.slice(at + 1);
          at = lineBuffer.indexOf('\n');
        }
        return;
      }
      outBytes += chunk.length;
      if (outBytes > (opts.maxStdoutBytes ?? 4 * 1024 * 1024)) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-16_384);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new MediaToolError(`${cmd} could not start: ${e.message}`, ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut)
        return reject(new MediaToolError(`${cmd} timed out after ${opts.timeoutMs} ms`, err, true));
      if (overflow) return reject(new MediaToolError(`${cmd} wrote more output than allowed`, err));
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/** True when ffmpeg and ffprobe can be run (tests skip the media suites without them). */
export async function mediaToolsAvailable(): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      runTool(ffmpegPath(), ['-hide_banner', '-version'], { timeoutMs: 10_000 }),
      runTool(ffprobePath(), ['-hide_banner', '-version'], { timeoutMs: 10_000 }),
    ]);
    return a.code === 0 && b.code === 0;
  } catch {
    return false;
  }
}

// ---- ffprobe ---------------------------------------------------------------------------------------------------

interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
  channels?: number;
  sample_rate?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}
export interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string; size?: string };
}

/** "30000/1001" → 29.97; "0/0" or garbage → 0. */
export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (n === undefined || !Number.isFinite(n)) return 0;
  if (d === undefined) return n;
  return d > 0 && Number.isFinite(d) ? n / d : 0;
}

const int = (v: string | number | undefined): number | null => {
  const n = typeof v === 'number' ? v : v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/** Clockwise rotation a player applies: the display matrix (counter-clockwise degrees) or the legacy rotate tag. */
export function rotationOf(s: RawStream): number {
  const matrix = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const clockwise = matrix !== undefined ? -matrix : Number(s.tags?.['rotate'] ?? 0);
  const r = (((Math.round(clockwise / 90) * 90) % 360) + 360) % 360;
  return Number.isFinite(r) ? r : 0;
}

/**
 * The probe as stored (MediaProbeV1). Cover art (an attached picture in an MP3 or M4A) is not a video stream. Null
 * when ffprobe found no container duration and no stream with one.
 */
export function parseProbe(raw: RawProbe, bytes: number): MediaProbeV1 | null {
  const streams = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio: MediaAudioStream[] = streams
    .filter((s) => s.codec_type === 'audio')
    .slice(0, 16)
    .map((s) => ({
      codec: (s.codec_name ?? 'unknown').slice(0, 40),
      channels: s.channels ?? 0,
      sampleRate: int(s.sample_rate) ?? 0,
      bitRate: int(s.bit_rate),
    }));
  const durations = [Number(raw.format?.duration), ...streams.map((s) => Number(s.duration))].filter(
    (d) => Number.isFinite(d) && d > 0,
  );
  if (durations.length === 0) return null;
  const durationMs = Math.round(
    (Number(raw.format?.duration) > 0 ? Number(raw.format?.duration) : Math.max(...durations)) * 1000,
  );
  let video: MediaVideoStream | null = null;
  if (v && v.width && v.height) {
    const rotation = rotationOf(v);
    const sar = parseRate(v.sample_aspect_ratio?.replace(':', '/'));
    const displayCodedWidth = sar > 0 && Math.abs(sar - 1) > 1e-3 ? Math.round(v.width * sar) : v.width;
    const swap = rotation === 90 || rotation === 270;
    const fps = parseRate(v.avg_frame_rate);
    const nominal = parseRate(v.r_frame_rate);
    const nominalFps = nominal > 0 ? nominal : fps;
    video = {
      codec: (v.codec_name ?? 'unknown').slice(0, 40),
      profile: v.profile ? v.profile.slice(0, 60) : null,
      pixelFormat: v.pix_fmt ? v.pix_fmt.slice(0, 40) : null,
      codedWidth: v.width,
      codedHeight: v.height,
      width: swap ? v.height : displayCodedWidth,
      height: swap ? displayCodedWidth : v.height,
      rotation,
      fps: Math.round((fps > 0 ? fps : nominalFps) * 1000) / 1000 || 0.001,
      nominalFps: Math.round(nominalFps * 1000) / 1000 || 0.001,
      variableFrameRate: fps > 0 && nominal > 0 && Math.abs(nominal / fps - 1) > 0.01,
      bitRate: int(v.bit_rate),
    };
  }
  return MediaProbeV1.parse({
    schemaVersion: 1,
    container: (raw.format?.format_name ?? 'unknown').slice(0, 80),
    durationMs,
    bitRate: int(raw.format?.bit_rate),
    bytes,
    video,
    audio,
  });
}

/** Runs ffprobe on a file; a file ffprobe cannot read at all is `media_malformed`. */
export async function probeFile(path: string, bytes: number): Promise<MediaProbeV1 | MediaRejection> {
  const r = await runTool(
    ffprobePath(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 60_000, maxStdoutBytes: 1024 * 1024 },
  );
  if (r.code !== 0)
    return rejection('media_malformed', firstToolLine(r.stderr) ?? 'the file could not be read');
  let raw: RawProbe;
  try {
    raw = JSON.parse(r.stdout.toString('utf8')) as RawProbe;
  } catch {
    return rejection('media_malformed', 'the file could not be read');
  }
  return (
    parseProbe(raw, bytes) ?? rejection('media_malformed', 'no duration: the file has no playable content')
  );
}

/** The first meaningful line a tool printed, without paths (user-safe detail). */
export function firstToolLine(stderr: string): string | null {
  const line = stderr
    .split('\n')
    .map((l) =>
      l
        .replace(/\/[^\s:]+/g, '')
        .replace(/^\[[^\]]+\]\s*/, '')
        .trim(),
    )
    .find((l) => l.length > 0);
  return line ? line.slice(0, 200) : null;
}

// ---- limits ----------------------------------------------------------------------------------------------------

export interface MediaLimits {
  maxDurationSeconds: number;
}

const fmtSeconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** The architecture's v1 limits, checked on the probe; null when the source is acceptable. */
export function checkProbe(
  probe: MediaProbeV1,
  group: 'video' | 'audio',
  limits: MediaLimits,
): MediaRejection | null {
  const L = PERSON_MEDIA_LIMITS;
  if (probe.durationMs <= 0) return rejection('media_malformed', 'the file has no playable content');
  if (probe.durationMs > limits.maxDurationSeconds * 1000)
    return rejection(
      'duration_exceeds_cap',
      `${fmtSeconds(probe.durationMs)} is longer than the ${limits.maxDurationSeconds / 60} minute limit; trim it and upload again`,
    );
  const firstAudio = probe.audio[0];
  if (firstAudio && !ACCEPTED_AUDIO_CODECS.includes(firstAudio.codec))
    return rejection(
      'media_codec_unsupported',
      `audio codec ${firstAudio.codec} is not supported; use AAC, MP3, Opus, FLAC or PCM`,
    );
  if (group === 'audio') {
    if (!firstAudio) return rejection('media_no_audio_stream', 'the file has no audio stream');
    return null;
  }
  const v = probe.video;
  if (!v) return rejection('media_no_video_stream', 'the file has no video stream');
  if (!ACCEPTED_VIDEO_CODECS.includes(v.codec))
    return rejection(
      'media_codec_unsupported',
      `video codec ${v.codec} is not supported; use H.264, H.265, VP9, AV1 or ProRes`,
    );
  if (Math.max(v.width, v.height) > L.maxDimension || Math.min(v.width, v.height) < L.minDimension)
    return rejection(
      'media_dimensions_unsupported',
      `${v.width}×${v.height} is outside ${L.minDimension}–${L.maxDimension} pixels per side`,
    );
  if (v.fps < L.minFps || v.fps > L.maxFps)
    return rejection('media_frame_rate_unsupported', `${v.fps} fps is outside ${L.minFps}–${L.maxFps} fps`);
  if (v.variableFrameRate && v.nominalFps <= L.maxFps && v.nominalFps / v.fps > L.maxVfrRatio)
    return rejection(
      'media_frame_rate_unsupported',
      `the frame rate varies too much (${v.fps} fps average, ${v.nominalFps} fps nominal); re-export at a constant frame rate`,
    );
  return null;
}

/** Decodes the first two seconds of every selected stream: catches a codec ffmpeg names but cannot decode. */
export async function decodeCheck(path: string, group: 'video' | 'audio'): Promise<MediaRejection | null> {
  const r = await runTool(
    ffmpegPath(),
    [
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-t',
      '2',
      '-i',
      path,
      ...(group === 'video' ? ['-map', '0:v:0'] : ['-map', '0:a:0']),
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 120_000 },
  );
  if (r.code === 0) return null;
  return rejection('media_undecodable', firstToolLine(r.stderr) ?? 'the stream could not be decoded');
}

// ---- derivatives -----------------------------------------------------------------------------------------------

export interface MediaDerivativeFile {
  purpose: DerivativePurpose;
  /** File name inside the TempDir. */
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  transform: Record<string, string | number | boolean>;
}

export interface MediaDerivativeOptions {
  /** Called with a short phase name and a fraction of the whole job (heartbeats). */
  onProgress?: (phase: string, fraction: number) => void;
  proxyTimeoutMs?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Fits a displayed frame inside a box, never upscaling; even dimensions (H.264 4:2:0). */
export function fitInside(width: number, height: number, maxLong: number, maxShort: number) {
  const landscape = width >= height;
  const boxW = landscape ? maxLong : maxShort;
  const boxH = landscape ? maxShort : maxLong;
  const scale = Math.min(1, boxW / width, boxH / height);
  return { width: even(width * scale), height: even(height * scale) };
}

/** Where the poster frame is taken: 10% in, at most 3 s, inside the clip. */
export const posterTimeMs = (durationMs: number): number =>
  Math.max(0, Math.min(Math.round(durationMs * 0.1), 3_000, durationMs - 1));

/** The times of the thumbnail strip's frames: the centres of STRIP_FRAMES equal slices. */
export const stripTimesMs = (durationMs: number, frames = STRIP_FRAMES): number[] =>
  Array.from({ length: frames }, (_, i) => Math.floor(((i + 0.5) * durationMs) / frames));

/** One frame as PNG, fitted inside maxSide; falls back to the first frame when seeking past the end gives none. */
async function extractFrame(dir: TempDir, input: string, atMs: number, name: string, maxSide: number) {
  const out = dir.file(name);
  const run = (ms: number) =>
    runTool(
      ffmpegPath(),
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-ss',
        (ms / 1000).toFixed(3),
        '-i',
        input,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        // Fitted inside maxSide, never upscaled (commas inside expressions are escaped for the filter parser).
        '-vf',
        `scale=w=min(iw\\,${maxSide}):h=min(ih\\,${maxSide}):force_original_aspect_ratio=decrease:force_divisible_by=2`,
        '-c:v',
        'png',
        '-f',
        'image2',
        out,
      ],
      { timeoutMs: 60_000 },
    );
  let r = await run(atMs);
  if (r.code !== 0 || !(await stat(out).catch(() => null))?.size) r = await run(0);
  if (r.code !== 0 || !(await stat(out).catch(() => null))?.size)
    throw new MediaToolError('frame extraction failed', r.stderr);
  return out;
}

/** WebP renditions of the poster frame (and the thumbnail and preview the library and pickers show). */
async function posterDerivatives(dir: TempDir, framePath: string): Promise<MediaDerivativeFile[]> {
  const specs: Array<{ purpose: DerivativePurpose; maxSide: number; quality: number }> = [
    { purpose: 'thumbnail', maxSide: 256, quality: 80 },
    { purpose: 'preview', maxSide: 1024, quality: 85 },
    { purpose: 'poster', maxSide: 1920, quality: 85 },
  ];
  const out: MediaDerivativeFile[] = [];
  for (const spec of specs) {
    const name = `${spec.purpose}.webp`;
    const info = await sharp(framePath)
      .resize({ width: spec.maxSide, height: spec.maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: spec.quality })
      .toFile(dir.file(name));
    out.push({
      purpose: spec.purpose,
      name,
      mime: 'image/webp',
      width: info.width,
      height: info.height,
      transform: { op: 'frame', fit: 'inside', maxSide: spec.maxSide, format: 'webp', quality: spec.quality },
    });
  }
  return out;
}

const STRIP_FRAME_WIDTH = 160;

/** The thumbnail strip: STRIP_FRAMES frames side by side in one WebP sprite, with a JSON map of their times. */
async function thumbnailStrip(
  dir: TempDir,
  input: string,
  probe: MediaProbeV1,
): Promise<MediaDerivativeFile[]> {
  const v = probe.video as MediaVideoStream;
  const frame = fitInside(v.width, v.height, STRIP_FRAME_WIDTH, STRIP_FRAME_WIDTH);
  const times = stripTimesMs(probe.durationMs);
  const tiles: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const [i, t] of times.entries()) {
    const png = await extractFrame(dir, input, t, `strip-${i}.png`, STRIP_FRAME_WIDTH);
    const tile = await sharp(png)
      .resize({ width: frame.width, height: frame.height, fit: 'cover' })
      .png()
      .toBuffer();
    tiles.push({ input: tile, left: i * frame.width, top: 0 });
  }
  const info = await sharp({
    create: { width: frame.width * times.length, height: frame.height, channels: 3, background: '#000000' },
  })
    .composite(tiles)
    .webp({ quality: 75 })
    .toFile(dir.file('strip.webp'));
  const map: StripMapV1 = {
    schemaVersion: 1,
    frameWidth: frame.width,
    frameHeight: frame.height,
    columns: times.length,
    frames: times.map((timeMs, index) => ({ index, timeMs })),
  };
  await writeJson(dir, 'strip_map.json', map);
  return [
    {
      purpose: 'strip',
      name: 'strip.webp',
      mime: 'image/webp',
      width: info.width,
      height: info.height,
      transform: { op: 'strip', frames: times.length, frameWidth: frame.width, format: 'webp', quality: 75 },
    },
    {
      purpose: 'strip_map',
      name: 'strip_map.json',
      mime: 'application/json',
      width: null,
      height: null,
      transform: { op: 'strip_map', frames: times.length },
    },
  ];
}

async function writeJson(dir: TempDir, name: string, value: unknown) {
  await writeFile(dir.file(name), JSON.stringify(value));
}

/** Errors ffmpeg prints for a damaged source (truncated data, broken packets). */
const CORRUPTION =
  /partial file|invalid data found|corrupt|error while decoding|invalid nal|moov atom not found|truncat/i;

export const PROXY_MAX_LONG = 1280;
export const PROXY_MAX_SHORT = 720;
export const PROXY_MAX_FPS = 30;

/** ffmpeg arguments of the editing proxy (exported for tests and the runbook). */
export function proxyArgs(input: string, output: string, probe: MediaProbeV1, maxBytes: number): string[] {
  const common = ['-v', 'error', '-nostdin', '-y', '-i', input];
  const tail = [
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    '-fs',
    String(maxBytes),
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];
  const audio = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
  if (!probe.video) return [...common, '-map', '0:a:0', '-vn', ...audio, ...tail];
  const size = fitInside(probe.video.width, probe.video.height, PROXY_MAX_LONG, PROXY_MAX_SHORT);
  const fps = Math.min(PROXY_MAX_FPS, Math.max(1, Math.round(probe.video.fps)));
  return [
    ...common,
    '-map',
    '0:v:0',
    ...(probe.audio.length ? ['-map', '0:a:0'] : []),
    '-vf',
    `scale=${size.width}:${size.height}:flags=bicubic,setsar=1,format=yuv420p`,
    '-fps_mode',
    'cfr',
    '-r',
    String(fps),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-profile:v',
    'high',
    '-g',
    String(fps * 2),
    ...(probe.audio.length ? audio : []),
    ...tail,
  ];
}

/** The 720p H.264/AAC faststart editing proxy (video) or the 128k AAC proxy (audio); progress from `-progress`. */
async function proxy(
  dir: TempDir,
  input: string,
  probe: MediaProbeV1,
  opts: MediaDerivativeOptions,
): Promise<{ ok: true; file: MediaDerivativeFile } | MediaRejection> {
  const name = probe.video ? 'proxy.mp4' : 'proxy.m4a';
  // Room is kept for the waveform and images that follow the proxy.
  const remaining = await dir.remaining();
  const maxBytes = Math.max(1, remaining - Math.min(64 * 1024 * 1024, Math.floor(remaining / 4)));
  const r = await runTool(ffmpegPath(), proxyArgs(input, dir.file(name), probe, maxBytes), {
    timeoutMs: opts.proxyTimeoutMs ?? 30 * 60_000,
    onLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && probe.durationMs > 0)
        opts.onProgress?.('proxy', Math.min(1, Number(m[1]) / 1000 / probe.durationMs));
    },
  });
  if (r.code !== 0 || CORRUPTION.test(r.stderr))
    return CORRUPTION.test(r.stderr)
      ? rejection('media_malformed', firstToolLine(r.stderr) ?? 'the file is damaged')
      : rejection(
          'media_processing_failed',
          firstToolLine(r.stderr) ?? 'the editing proxy could not be made',
        );
  const written = (await stat(dir.file(name))).size;
  if (written >= maxBytes)
    return rejection('media_processing_failed', 'the editing proxy exceeded its size budget');
  if (!probe.video)
    return {
      ok: true,
      file: {
        purpose: 'proxy',
        name,
        mime: 'audio/mp4',
        width: null,
        height: null,
        transform: {
          op: 'proxy',
          codec: 'aac',
          bitrate: '128k',
          channels: 2,
          sampleRate: 48000,
          faststart: true,
        },
      },
    };
  const size = fitInside(probe.video.width, probe.video.height, PROXY_MAX_LONG, PROXY_MAX_SHORT);
  const file: MediaDerivativeFile = {
    purpose: 'proxy',
    name,
    mime: 'video/mp4',
    width: size.width,
    height: size.height,
    transform: {
      op: 'proxy',
      codec: 'h264',
      profile: 'high',
      crf: 23,
      fps: Math.min(PROXY_MAX_FPS, Math.max(1, Math.round(probe.video.fps))),
      audio: probe.audio.length > 0 ? 'aac-128k' : 'none',
      faststart: true,
    },
  };
  return { ok: true, file };
}

/**
 * Waveform peaks from 16-bit little-endian mono PCM, one peak per `samplesPerPeak` samples, bounded to `maxPeaks`.
 * Pure and streaming: chunks may split a sample.
 */
export class PeakAccumulator {
  private readonly peaks: number[] = [];
  private current = 0;
  private inWindow = 0;
  private carry: number | null = null;

  constructor(
    private readonly samplesPerPeak: number,
    private readonly maxPeaks: number,
  ) {}

  push(chunk: Buffer): void {
    let i = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.sample(((chunk[0] as number) << 8) | this.carry);
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk.readInt16LE(i));
    if (i < chunk.length) this.carry = chunk[i] as number;
  }

  private sample(raw: number): void {
    if (this.peaks.length >= this.maxPeaks) return;
    const value = raw > 0x7fff ? raw - 0x10000 : raw; // a sample joined across chunks arrives unsigned
    const abs = Math.abs(value);
    if (abs > this.current) this.current = abs;
    this.inWindow += 1;
    if (this.inWindow === this.samplesPerPeak) this.flush();
  }

  private flush(): void {
    this.peaks.push(Math.min(1000, Math.round((this.current / 32768) * 1000)));
    this.current = 0;
    this.inWindow = 0;
  }

  finish(): number[] {
    if (this.inWindow > 0 && this.peaks.length < this.maxPeaks) this.flush();
    return this.peaks;
  }
}

const WAVEFORM_SAMPLE_RATE = 8_000;

/** Peaks JSON (WAVEFORM_PEAKS_PER_SECOND per second) of the first audio stream, decoded to 8 kHz mono PCM. */
async function waveform(
  dir: TempDir,
  input: string,
  probe: MediaProbeV1,
  maxDurationSeconds: number,
): Promise<{ file: MediaDerivativeFile; peaks: number[] }> {
  const acc = new PeakAccumulator(
    WAVEFORM_SAMPLE_RATE / WAVEFORM_PEAKS_PER_SECOND,
    WAVEFORM_PEAKS_PER_SECOND * maxDurationSeconds + 1,
  );
  const r = await runTool(
    ffmpegPath(),
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      input,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      String(WAVEFORM_SAMPLE_RATE),
      '-f',
      's16le',
      '-',
    ],
    { timeoutMs: 10 * 60_000, onStdout: (chunk) => acc.push(chunk) },
  );
  if (r.code !== 0) throw new MediaToolError('waveform decode failed', r.stderr);
  const peaks = acc.finish();
  const body: WaveformV1 = {
    schemaVersion: 1,
    peaksPerSecond: WAVEFORM_PEAKS_PER_SECOND,
    durationMs: probe.durationMs,
    peaks,
  };
  await writeJson(dir, 'waveform.json', body);
  return {
    peaks,
    file: {
      purpose: 'waveform',
      name: 'waveform.json',
      mime: 'application/json',
      width: null,
      height: null,
      transform: {
        op: 'waveform',
        peaksPerSecond: WAVEFORM_PEAKS_PER_SECOND,
        sampleRate: WAVEFORM_SAMPLE_RATE,
      },
    },
  };
}

/** The waveform drawn as bars (SVG), for an audio asset's thumbnail and preview. */
export function waveformSvg(peaks: readonly number[], width: number, height: number): string {
  const bars = Math.max(1, Math.floor(width / 4));
  const per = Math.max(1, Math.ceil(peaks.length / bars));
  const rects: string[] = [];
  for (let b = 0; b < bars; b++) {
    const slice = peaks.slice(b * per, (b + 1) * per);
    const peak = slice.length ? Math.max(...slice) / 1000 : 0;
    const h = Math.max(2, Math.round(peak * (height - 8)));
    rects.push(`<rect x="${b * 4 + 1}" y="${Math.round((height - h) / 2)}" width="2" height="${h}" rx="1"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f4f4f5"/><g fill="#3f3f46">${rects.join('')}</g></svg>`;
}

async function waveformImages(dir: TempDir, peaks: readonly number[]): Promise<MediaDerivativeFile[]> {
  const specs: Array<{ purpose: DerivativePurpose; width: number; height: number }> = [
    { purpose: 'thumbnail', width: 256, height: 256 },
    { purpose: 'preview', width: 1024, height: 256 },
  ];
  const out: MediaDerivativeFile[] = [];
  for (const s of specs) {
    const name = `${s.purpose}.webp`;
    const info = await sharp(Buffer.from(waveformSvg(peaks, s.width, s.height)))
      .webp({ quality: 85 })
      .toFile(dir.file(name));
    out.push({
      purpose: s.purpose,
      name,
      mime: 'image/webp',
      width: info.width,
      height: info.height,
      transform: { op: 'waveform_image', width: s.width, height: s.height, format: 'webp' },
    });
  }
  return out;
}

/**
 * Every derivative of a video or audio source, as files in `dir`: video gets thumbnail, preview and poster (WebP
 * poster frame), strip + strip_map, proxy (720p H.264/AAC faststart) and, when it has sound, waveform; audio gets
 * proxy (128k AAC), waveform and the waveform drawn as thumbnail and preview.
 */
export async function buildMediaDerivatives(
  dir: TempDir,
  input: string,
  probe: MediaProbeV1,
  group: 'video' | 'audio',
  limits: MediaLimits,
  opts: MediaDerivativeOptions = {},
): Promise<{ ok: true; files: MediaDerivativeFile[] } | MediaRejection> {
  const files: MediaDerivativeFile[] = [];
  try {
    if (group === 'video') {
      // The poster comes from the source at full quality (one seek).
      opts.onProgress?.('poster', 0);
      const frame = await extractFrame(dir, input, posterTimeMs(probe.durationMs), 'poster-frame.png', 1920);
      files.push(...(await posterDerivatives(dir, frame)));
    }
    const proxied = await proxy(dir, input, probe, {
      ...opts,
      onProgress: (phase, f) => opts.onProgress?.(phase, 0.03 + f * 0.85),
    });
    if (!proxied.ok) return proxied;
    files.push(proxied.file);
    if (group === 'video') {
      // The strip's small frames come from the proxy: upright already, keyframes every two seconds, so ten seeks
      // stay cheap whatever GOP the source was encoded with.
      opts.onProgress?.('strip', 0.89);
      files.push(...(await thumbnailStrip(dir, dir.file(proxied.file.name), probe)));
    }
    if (probe.audio.length > 0) {
      opts.onProgress?.('waveform', 0.92);
      const w = await waveform(dir, input, probe, limits.maxDurationSeconds);
      files.push(w.file);
      if (group === 'audio') files.push(...(await waveformImages(dir, w.peaks)));
    }
    await dir.assertWithinBudget();
  } catch (err) {
    if (err instanceof MediaToolError && !err.timedOut && CORRUPTION.test(err.stderr))
      return rejection('media_malformed', firstToolLine(err.stderr) ?? 'the file is damaged');
    throw err;
  }
  opts.onProgress?.('done', 1);
  return { ok: true, files };
}

/** Reads a small JSON derivative back (tests and the export validation). */
export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
