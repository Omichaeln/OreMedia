import type {
  AudioItem,
  OverlayItem,
  VideoClipItem,
  VideoProjectV1,
  VideoTransition,
} from '@oremedia/contracts/video';
import { framePlacement } from '@oremedia/editor/video/frame';
import { SLIDE_FRACTION } from '@oremedia/editor/video/overlays';
import { frameOf, lengthOf, previousAdjacent } from '@oremedia/editor/video/time';

/**
 * STU-2b compositor: a VideoProjectV1 as one ffmpeg invocation (inputs + a filter_complex script). Pure, so the graph
 * is unit-tested without ffmpeg and the same project always yields the same command.
 *
 * Picture: every boundary is snapped to the frame grid (frameOf), each clip is seeked accurately (`-ss` before its
 * input, decoded from the keyframe and trimmed to the exact frame count), converted to the project rate, scaled and
 * cropped/padded per its framing (framePlacement, shared with the preview), gaps are black. Transitions are centred
 * on the cut (contracts/video.ts): a crossfade or slide extends both sides by half the transition with a cloned edge
 * frame (tpad) and joins them with xfade; a fade through black fades the outgoing clip out over its last half and
 * the incoming one in over its first half. No clip moves and the length is unchanged. Overlays and captions are transparent
 * full-frame PNGs from the scene renderer, packed into a few lanes (overlayLanes: windows that overlap in time go to
 * separate lanes, in drawing order). Each lane is ONE image-sequence input (one PNG per window, a shared transparent
 * PNG for the gaps) retimed to its windows and held with fps, so ffmpeg decodes one frame per lane at a time however
 * many titles and captions there are; enter/exit animations use the formulas of overlayAnimationAt. Sound: clip sound and audio items are
 * resampled to 48 kHz stereo, trimmed, gained, faded and placed to the sample, then mixed without normalisation
 * and padded or cut to the exact duration.
 */

export const AUDIO_RATE = 48_000;

export interface ComposeSourceFile {
  path: string;
  kind: 'video' | 'audio' | 'image';
  mime: string;
  hasAudio: boolean;
  /** Displayed size (after rotation), for framing. */
  width: number | null;
  height: number | null;
}

export interface ComposeFrameFile {
  path: string;
  startMs: number;
  endMs: number;
  /** Overlays animate; captions do not. */
  overlay?: Pick<OverlayItem, 'enter' | 'exit'>;
}

export interface ComposePlanInput {
  project: VideoProjectV1;
  sources: Readonly<Record<string, ComposeSourceFile>>;
  /** In drawing order (later frames are drawn above earlier ones they overlap). */
  frames: readonly ComposeFrameFile[];
  /** A fully transparent PNG of the project size: the gaps between a lane's windows. */
  blankFramePath: string;
  /** Path of a lane's image sequence with `%05d` for its index (the caller places the files from `stills`). */
  lanePattern: (lane: number) => string;
  /** Path of the filter_complex script the caller writes `filterGraph` to. */
  filterScriptPath: string;
  outputPath: string;
  encoder: {
    preset: string;
    crf: number;
    threads: number;
    audioBitrate: string;
    /** -fs: the encoder stops before the output exceeds the temp budget. */
    maxBytes: number;
  };
}

export interface ComposePlan {
  args: string[];
  filterGraph: string;
  totalFrames: number;
  durationSeconds: number;
  inputCount: number;
  /** Files of the lane sequences: each `path` is `from` (a frame file, or the blank) moved or linked into place. */
  stills: Array<{ path: string; from: string }>;
}

/** Overlay and caption windows one render draws (each lane is one ffmpeg input, so this bounds its memory). */
export const VIDEO_MAX_OVERLAY_FRAMES = 400;
/** Overlays and captions on screen at the same moment (lanes). */
export const VIDEO_MAX_OVERLAY_LANES = 8;

/** The overlay and caption windows of a project in drawing order (tracks in order, items in order). */
export function overlayWindows(
  project: VideoProjectV1,
): Array<{ itemId: string; kind: 'overlay' | 'caption'; startMs: number; endMs: number }> {
  const out: Array<{ itemId: string; kind: 'overlay' | 'caption'; startMs: number; endMs: number }> = [];
  for (const t of project.tracks) {
    if (t.kind === 'overlay')
      for (const o of t.items)
        if (o.element.visible)
          out.push({ itemId: o.id, kind: 'overlay', startMs: o.startMs, endMs: o.endMs });
    if (t.kind === 'caption')
      for (const c of t.items)
        out.push({ itemId: c.id, kind: 'caption', startMs: c.startMs, endMs: c.endMs });
  }
  return out;
}

/**
 * Packs windows (in drawing order) into lanes, each a list of window indices sorted by start: a window goes to the
 * lowest lane above every earlier window it overlaps that is free over its frames, so drawing lanes bottom to top
 * keeps the drawing order wherever windows overlap. Windows shorter than a frame are left out.
 */
export function overlayLanes(
  windows: ReadonlyArray<{ startMs: number; endMs: number }>,
  fps: number,
  totalFrames: number,
): number[][] {
  const lanes: number[][] = [];
  const span = (j: number) => {
    const w = windows[j] as { startMs: number; endMs: number };
    return [frameOf(w.startMs, fps), Math.min(totalFrames, frameOf(w.endMs, fps))] as const;
  };
  const overlaps = (a: number, b: number) => {
    const [a0, a1] = span(a);
    const [b0, b1] = span(b);
    return a0 < b1 && b0 < a1;
  };
  const laneOf = new Map<number, number>();
  windows.forEach((_, j) => {
    const [s0, s1] = span(j);
    if (s1 <= s0) return;
    let lane = 0;
    for (const [k, l] of laneOf) if (l >= lane && overlaps(k, j)) lane = l + 1;
    while (lanes[lane]?.some((k) => overlaps(k, j))) lane++;
    (lanes[lane] ??= []).push(j);
    laneOf.set(j, lane);
  });
  return lanes.map((l) => [...l].sort((a, b) => span(a)[0] - span(b)[0]));
}

/** ffmpeg demuxer per accepted mime, forced so a file is never sniffed into another format (or protocol). */
export function demuxerFor(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m === 'video/mp4' || m === 'video/quicktime' || m === 'audio/mp4') return 'mov';
  if (m === 'video/webm') return 'matroska';
  if (m === 'audio/mpeg') return 'mp3';
  if (m === 'audio/wav') return 'wav';
  if (m === 'audio/aac') return 'aac';
  if (m === 'image/png') return 'png_pipe';
  if (m === 'image/jpeg') return 'jpeg_pipe';
  if (m === 'image/webp') return 'webp_pipe';
  return null;
}

const SAFE_INPUT = ['-protocol_whitelist', 'file,pipe'];
const sec = (frames: number, fps: number) => (frames / fps).toFixed(6);
const ms3 = (ms: number) => (ms / 1000).toFixed(3);

const XFADE: Record<Exclude<VideoTransition['kind'], 'cut'>, string> = {
  crossfade: 'fade',
  fade_black: 'fadeblack',
  slide: 'slideleft',
};

interface Segment {
  frames: number;
  label: string;
  /** Half-transition frames added before (cloned first frame) / after (cloned last frame). */
  padIn: number;
  padOut: number;
  transitionIn: VideoTransition['kind'] | null;
}

export function buildComposePlan(input: ComposePlanInput): ComposePlan {
  const { project } = input;
  const F = project.format.fps;
  const W = project.format.width;
  const H = project.format.height;
  const totalFrames = frameOf(project.durationMs, F);
  const args: string[] = ['-v', 'error', '-nostdin', '-y', '-hide_banner'];
  const graph: string[] = [];
  let inputs = 0;
  const addInput = (path: string, mime: string, opts: string[], forced?: string): number => {
    // Never sniffed: a file whose demuxer is not known is refused rather than probed.
    const demuxer = forced ?? demuxerFor(mime);
    if (!demuxer) throw new Error(`no forced demuxer for ${mime}`);
    args.push(...SAFE_INPUT, ...opts, '-f', demuxer, '-i', path);
    return inputs++;
  };

  // ---- picture ---------------------------------------------------------------------------------------------
  const videoTrack = project.tracks.find((t) => t.kind === 'video');
  const clips =
    videoTrack?.kind === 'video' ? [...videoTrack.items].sort((a, b) => a.startMs - b.startMs) : [];
  const pictureMuted = videoTrack?.kind === 'video' && videoTrack.muted;
  const segments: Segment[] = [];
  const audioLabels: string[] = [];
  const halfOf = (t: VideoTransition | undefined) =>
    t && t.kind !== 'cut' && t.durationMs > 0 ? Math.max(1, Math.round((t.durationMs * F) / 2000)) : 0;
  const transitionOf = (clip: VideoClipItem): VideoTransition | undefined =>
    clip.transitionIn && previousAdjacent(clips, clip) ? clip.transitionIn : undefined;
  let cursor = 0;
  clips.forEach((clip, idx) => {
    const f0 = frameOf(clip.startMs, F);
    const f1 = Math.min(totalFrames, frameOf(clip.startMs + lengthOf(clip), F));
    if (f1 <= f0) return;
    if (f0 > cursor) {
      const label = `gap${segments.length}`;
      graph.push(
        `color=c=black:s=${W}x${H}:r=${F},format=yuv420p,setsar=1,trim=end_frame=${f0 - cursor},settb=1/${F},setpts=N[${label}]`,
      );
      segments.push({ frames: f0 - cursor, label, padIn: 0, padOut: 0, transitionIn: null });
    }
    const source = input.sources[clip.assetVersionId];
    if (!source) throw new Error(`no source file for ${clip.assetVersionId}`);
    const n = f1 - f0;
    const tIn = transitionOf(clip);
    const next = clips[idx + 1];
    const tOut = next ? transitionOf(next) : undefined;
    const hIn = halfOf(tIn);
    const hOut = halfOf(tOut);
    // Crossfade and slide join the two clips with xfade over cloned edge frames; fade through black is a fade
    // out over the outgoing clip's last half and a fade in over the incoming clip's first half, joined by a cut.
    const padIn = tIn && tIn.kind !== 'fade_black' ? hIn : 0;
    const padOut = tOut && tOut.kind !== 'fade_black' ? hOut : 0;
    const blackIn = tIn?.kind === 'fade_black' ? hIn : 0;
    const blackOut = tOut?.kind === 'fade_black' ? hOut : 0;
    const k =
      source.kind === 'image'
        ? addInput(source.path, source.mime, ['-loop', '1', '-framerate', String(F), '-t', sec(n + 2, F)])
        : addInput(source.path, source.mime, ['-ss', ms3(clip.sourceInMs), '-t', sec(n + 2, F)]);
    const place = framePlacement(
      { width: source.width ?? W, height: source.height ?? H },
      { width: W, height: H },
      clip.frame,
    );
    const label = `seg${segments.length}`;
    const pads = [
      ...(place.cropWidth < place.scaledWidth || place.cropHeight < place.scaledHeight
        ? [`crop=${place.cropWidth}:${place.cropHeight}:${place.cropX}:${place.cropY}`]
        : []),
      ...(place.cropWidth < W || place.cropHeight < H
        ? [`pad=${W}:${H}:${place.padX}:${place.padY}:color=black`]
        : []),
    ];
    graph.push(
      [
        `[${k}:v]setpts=PTS-STARTPTS`,
        `fps=${F}`,
        `scale=${place.scaledWidth}:${place.scaledHeight}:flags=bicubic`,
        ...pads,
        'setsar=1',
        'format=yuv420p',
        `trim=end_frame=${n}`,
        `settb=1/${F},setpts=N`,
        ...(blackIn ? [`fade=t=in:s=0:n=${blackIn}`] : []),
        ...(blackOut ? [`fade=t=out:s=${n - blackOut}:n=${blackOut}`] : []),
        ...(padIn || padOut
          ? [`tpad=start=${padIn}:start_mode=clone:stop=${padOut}:stop_mode=clone`, `settb=1/${F},setpts=N`]
          : []),
      ].join(',') + `[${label}]`,
    );
    segments.push({ frames: n, label, padIn, padOut, transitionIn: padIn ? (tIn?.kind ?? null) : null });
    cursor = f1;

    // The clip's own sound, on the frame grid of its picture.
    if (source.kind === 'video' && source.hasAudio && !clip.muted && !pictureMuted) {
      const a = `ca${audioLabels.length}`;
      // The clip's sound fades over its half of any transition (inside its own frames).
      const fadeIn = hIn ? sec(hIn, F) : null;
      const fadeOut = hOut ? sec(hOut, F) : null;
      graph.push(
        [
          // Timestamps are kept (the seek point is 0): sound that starts after it (an edit list's empty edit,
          // encoder priming) is padded with silence from 0 instead of being pulled earlier.
          `[${k}:a]aresample=${AUDIO_RATE}:async=1:first_pts=0`,
          'aformat=sample_fmts=fltp:channel_layouts=stereo',
          `atrim=end_sample=${Math.round((n * AUDIO_RATE) / F)}`,
          `volume=${clip.gainDb}dB`,
          ...(fadeIn ? [`afade=t=in:st=0:d=${fadeIn}`] : []),
          ...(fadeOut ? [`afade=t=out:st=${sec(n - hOut, F)}:d=${fadeOut}`] : []),
          // Placed by timestamp (in samples) and padded with silence from 0: adelay's leading silence carries no
          // timestamps in ffmpeg 6.1, which the AAC path then drops (the sound would land early).
          `asetpts=PTS+${Math.round((f0 * AUDIO_RATE) / F)}`,
          `aresample=${AUDIO_RATE}:async=1:first_pts=0`,
        ].join(',') + `[${a}]`,
      );
      audioLabels.push(a);
    }
  });
  if (cursor < totalFrames) {
    const label = `gap${segments.length}`;
    graph.push(
      `color=c=black:s=${W}x${H}:r=${F},format=yuv420p,setsar=1,trim=end_frame=${totalFrames - cursor},settb=1/${F},setpts=N[${label}]`,
    );
    segments.push({ frames: totalFrames - cursor, label, padIn: 0, padOut: 0, transitionIn: null });
  }

  // Runs of cuts are concatenated in one filter; runs are joined by xfade at their transitions.
  let acc: string | null = null;
  let accFrames = 0;
  let run: Segment[] = [];
  let joined = 0;
  const flushRun = () => {
    if (!run.length) return;
    const first = run[0] as Segment;
    let label = first.label;
    let frames = run.reduce((n, s) => n + s.frames + s.padIn + s.padOut, 0);
    if (run.length > 1) {
      label = `run${joined}`;
      graph.push(
        `${run.map((s) => `[${s.label}]`).join('')}concat=n=${run.length}:v=1:a=0,settb=1/${F},setpts=N[${label}]`,
      );
    }
    if (acc === null) {
      acc = label;
      accFrames = frames;
    } else {
      const half = first.padIn;
      const out = `x${joined}`;
      graph.push(
        `[${acc}][${label}]xfade=transition=${XFADE[first.transitionIn as Exclude<VideoTransition['kind'], 'cut'>]}:duration=${sec(2 * half, F)}:offset=${sec(accFrames - 2 * half, F)},settb=1/${F},setpts=N[${out}]`,
      );
      acc = out;
      frames = accFrames + frames - 2 * half;
      accFrames = frames;
    }
    joined++;
    run = [];
  };
  for (const s of segments) {
    if (s.transitionIn && s.padIn > 0) flushRun();
    run.push(s);
  }
  flushRun();
  let picture = acc as string | null;
  if (!picture) throw new Error('empty project');

  // ---- overlays and captions ---------------------------------------------------------------------------------
  const stills: Array<{ path: string; from: string }> = [];
  overlayLanes(input.frames, F, totalFrames).forEach((lane, l) => {
    const pattern = input.lanePattern(l);
    const at: number[] = [];
    const place = (from: string, frame: number) => {
      stills.push({ path: pattern.replace('%05d', String(at.length).padStart(5, '0')), from });
      at.push(frame);
    };
    const anim: string[] = [];
    const ys: string[] = [];
    const enable: string[] = [];
    let cursor = 0;
    for (const j of lane) {
      const f = input.frames[j] as ComposeFrameFile;
      const s0 = frameOf(f.startMs, F);
      const s1 = Math.min(totalFrames, frameOf(f.endMs, F));
      if (s0 > cursor) place(input.blankFramePath, cursor);
      place(f.path, s0);
      cursor = s1;
      const start = sec(s0, F);
      const end = sec(s1, F);
      const shown = `between(t,${start},${(s1 / F - 0.5 / F).toFixed(6)})`;
      enable.push(shown);
      let y = '';
      const enter = f.overlay?.enter;
      const exit = f.overlay?.exit;
      if (enter && enter.kind !== 'none' && enter.durationMs > 0) {
        const d = ms3(enter.durationMs);
        if (enter.kind === 'fade') anim.push(`fade=t=in:st=${start}:d=${d}:alpha=1:enable='${shown}'`);
        else y = `if(lt(t,${start}+${d}),(1-(t-${start})/${d})*${SLIDE_FRACTION}*${H},0)`;
      }
      if (exit && exit.kind !== 'none' && exit.durationMs > 0) {
        const d = ms3(exit.durationMs);
        if (exit.kind === 'fade')
          anim.push(
            `fade=t=out:st=${(s1 / F - exit.durationMs / 1000).toFixed(6)}:d=${d}:alpha=1:enable='${shown}'`,
          );
        else y = `${y || '0'}-if(gt(t,${end}-${d}),(1-(${end}-t)/${d})*${SLIDE_FRACTION}*${H},0)`;
      }
      if (y) ys.push(`if(${shown},${y},0)`);
    }
    // The lane ends on a blank frame, so its last window is held to its end and nothing after it.
    place(input.blankFramePath, cursor);
    const k = addInput(
      pattern,
      'image/png',
      ['-framerate', String(F), '-start_number', '0', '-pattern_type', 'sequence'],
      'image2',
    );
    const retime = at.map((frame, n) => (n > 0 && frame > 0 ? `+eq(N,${n})*${frame}` : '')).join('');
    const ov = `ov${l}`;
    graph.push(
      [`[${k}:v]format=rgba`, `settb=1/${F}`, `setpts='0${retime}'`, `fps=${F}`, ...anim].join(',') +
        `[${ov}]`,
    );
    const out = `pic${l}`;
    graph.push(
      `[${picture}][${ov}]overlay=x=0:y='${ys.join('+') || '0'}':eof_action=pass:enable='${enable.join('+')}'[${out}]`,
    );
    picture = out;
  });
  graph.push(`[${picture}]trim=end_frame=${totalFrames},settb=1/${F},setpts=N,format=yuv420p[vout]`);

  // ---- sound -------------------------------------------------------------------------------------------------
  for (const track of project.tracks) {
    if (track.kind !== 'audio' || track.muted) continue;
    for (const item of track.items as AudioItem[]) {
      if (item.muted) continue;
      const source = input.sources[item.assetVersionId];
      if (!source || (source.kind === 'video' && !source.hasAudio) || source.kind === 'image') continue;
      const len = lengthOf(item);
      const k = addInput(source.path, source.mime, ['-ss', ms3(item.sourceInMs), '-t', ms3(len + 100)]);
      const a = `au${audioLabels.length}`;
      graph.push(
        [
          // Timestamps are kept (the seek point is 0): sound that starts after it (an edit list's empty edit,
          // encoder priming) is padded with silence from 0 instead of being pulled earlier.
          `[${k}:a]aresample=${AUDIO_RATE}:async=1:first_pts=0`,
          'aformat=sample_fmts=fltp:channel_layouts=stereo',
          `atrim=end_sample=${Math.round((len * AUDIO_RATE) / 1000)}`,
          `volume=${item.gainDb}dB`,
          ...(item.fadeInMs ? [`afade=t=in:st=0:d=${ms3(item.fadeInMs)}`] : []),
          ...(item.fadeOutMs ? [`afade=t=out:st=${ms3(len - item.fadeOutMs)}:d=${ms3(item.fadeOutMs)}`] : []),
          `asetpts=PTS+${Math.round((item.startMs * AUDIO_RATE) / 1000)}`,
          `aresample=${AUDIO_RATE}:async=1:first_pts=0`,
        ].join(',') + `[${a}]`,
      );
      audioLabels.push(a);
    }
  }
  const totalSamples = Math.round((totalFrames * AUDIO_RATE) / F);
  if (audioLabels.length === 0)
    graph.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${totalSamples}[aout]`);
  else
    graph.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}${
        audioLabels.length > 1
          ? `amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,`
          : ''
      }apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`,
    );

  const durationSeconds = totalFrames / F;
  args.push(
    '-filter_complex_script',
    input.filterScriptPath,
    '-filter_complex_threads',
    String(input.encoder.threads),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    input.encoder.preset,
    '-crf',
    String(input.encoder.crf),
    '-r',
    String(F),
    '-g',
    String(F * 2),
    '-threads',
    String(input.encoder.threads),
    '-flags:v',
    '+bitexact',
    '-c:a',
    'aac',
    '-b:a',
    input.encoder.audioBitrate,
    '-ar',
    String(AUDIO_RATE),
    '-ac',
    '2',
    '-flags:a',
    '+bitexact',
    '-t',
    durationSeconds.toFixed(6),
    '-movflags',
    '+faststart',
    '-fs',
    String(input.encoder.maxBytes),
    '-progress',
    'pipe:1',
    '-nostats',
    input.outputPath,
  );
  return { args, filterGraph: graph.join(';\n'), totalFrames, durationSeconds, inputCount: inputs, stills };
}

/** ffmpeg args of the poster frame (WebP, full size) taken from the rendered MP4. */
export function posterArgs(input: string, output: string, atMs: number): string[] {
  return [
    '-v',
    'error',
    '-nostdin',
    '-y',
    ...SAFE_INPUT,
    '-ss',
    ms3(atMs),
    '-f',
    'mov',
    '-i',
    input,
    '-frames:v',
    '1',
    '-threads',
    '2',
    '-c:v',
    'libwebp',
    '-quality',
    '85',
    '-f',
    'webp',
    output,
  ];
}
