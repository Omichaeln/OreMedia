import type { VideoClipItem, VideoProjectV1, VideoTransition } from '@oremedia/contracts/video';
import { frameOf, lengthOf, msOfFrame, previousAdjacent } from './time';

/**
 * The sound of a project, stated once for the compositor (activities/video-filter-graph.ts writes it as ffmpeg
 * `volume` and `afade` filters) and for the editor preview (which schedules it on Web Audio gain nodes), so what the
 * editor plays and what the export contains cannot drift apart.
 *
 * - Gain is in decibels (-60 to +12 dB, contracts/video.ts) and applied as linear amplitude 10^(dB/20): +6 dB is
 *   about 2x, -6 dB about 0.5x. Above 0 dB it amplifies (no clamp to 1).
 * - Fades are linear in amplitude (ffmpeg afade's default `tri` curve): a fade in goes from 0 at the window start to
 *   the full gain `fadeInMs` later; a fade out from the full gain `fadeOutMs` before the window end to 0 at the end.
 *   Both multiply the gain. Outside its window an item is silent.
 * - An audio item sounds over [startMs, startMs + length) (length = sourceOutMs - sourceInMs, so a trim moves the
 *   window's end and where in the source it starts), with its own fades.
 * - A clip's own sound is on the frame grid of its picture: [frame(startMs), frame(startMs + length)) cut at the
 *   project's last frame. It has no fades of its own; inside a transition (any kind but `cut`) it fades out over
 *   the outgoing half and in over the incoming half (half = the transition's frames / 2, at least one frame), each
 *   inside its own frames, so the two clips' sounds never overlap.
 * - A muted item, a muted track or a source without sound is silent. Every sounding item is summed with unit
 *   weight (amix without normalisation): nothing is scaled down when items overlap.
 */
export interface SoundWindow {
  itemId: string;
  trackId: string;
  kind: 'clip' | 'audio';
  assetVersionId: string;
  /** Where the item sounds on the timeline, [startMs, endMs) in (fractional, for clips on the frame grid) ms. */
  startMs: number;
  endMs: number;
  /** Source time at startMs. */
  sourceInMs: number;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** The item or its track is muted: it is silent (the preview keeps its window so unmuting is immediate). */
  muted: boolean;
}

/** Linear amplitude of a gain in decibels. */
export const dbToGain = (db: number): number => 10 ** (db / 20);

/** Frames on each side of the cut a transition covers (0: a cut). */
export const transitionHalfFrames = (t: VideoTransition | undefined, fps: number): number =>
  t && t.kind !== 'cut' && t.durationMs > 0 ? Math.max(1, Math.round((t.durationMs * fps) / 2000)) : 0;

/** The transition into `clip` when a clip ends where it starts (otherwise none). */
export const transitionInOf = (
  clips: readonly VideoClipItem[],
  clip: VideoClipItem,
): VideoTransition | undefined =>
  clip.transitionIn && previousAdjacent(clips, clip) ? clip.transitionIn : undefined;

/**
 * Every item that can sound, in the compositor's order (the picture's clips by start, then audio tracks and items in
 * order). `hasSound` says whether a source carries sound (a video with an audio stream, or an audio file).
 */
export function soundWindows(
  project: VideoProjectV1,
  hasSound: (assetVersionId: string, kind: 'clip' | 'audio') => boolean,
): SoundWindow[] {
  const F = project.format.fps;
  const totalFrames = frameOf(project.durationMs, F);
  const out: SoundWindow[] = [];
  const videoTrack = project.tracks.find((t) => t.kind === 'video');
  if (videoTrack?.kind === 'video') {
    const clips = [...videoTrack.items].sort((a, b) => a.startMs - b.startMs);
    clips.forEach((clip, idx) => {
      const f0 = frameOf(clip.startMs, F);
      const f1 = Math.min(totalFrames, frameOf(clip.startMs + lengthOf(clip), F));
      if (f1 <= f0 || !hasSound(clip.assetVersionId, 'clip')) return;
      const next = clips[idx + 1];
      out.push({
        itemId: clip.id,
        trackId: videoTrack.id,
        kind: 'clip',
        assetVersionId: clip.assetVersionId,
        startMs: msOfFrame(f0, F),
        endMs: msOfFrame(f1, F),
        sourceInMs: clip.sourceInMs,
        gainDb: clip.gainDb,
        fadeInMs: msOfFrame(transitionHalfFrames(transitionInOf(clips, clip), F), F),
        fadeOutMs: next ? msOfFrame(transitionHalfFrames(transitionInOf(clips, next), F), F) : 0,
        muted: clip.muted || videoTrack.muted,
      });
    });
  }
  for (const track of project.tracks) {
    if (track.kind !== 'audio') continue;
    for (const item of track.items) {
      if (!hasSound(item.assetVersionId, 'audio')) continue;
      out.push({
        itemId: item.id,
        trackId: track.id,
        kind: 'audio',
        assetVersionId: item.assetVersionId,
        startMs: item.startMs,
        endMs: item.startMs + lengthOf(item),
        sourceInMs: item.sourceInMs,
        gainDb: item.gainDb,
        fadeInMs: item.fadeInMs,
        fadeOutMs: item.fadeOutMs,
        muted: item.muted || track.muted,
      });
    }
  }
  return out;
}

/** Linear amplitude of a window's sound at timeline time `ms` (what the export applies to that sample). */
export function gainAt(w: SoundWindow, ms: number): number {
  if (w.muted || ms < w.startMs || ms >= w.endMs) return 0;
  return gainWithin(w, ms);
}

/** The envelope inside the window (its limit from the left at the end). */
function gainWithin(w: SoundWindow, ms: number): number {
  const fadeIn = w.fadeInMs > 0 ? Math.min(1, Math.max(0, (ms - w.startMs) / w.fadeInMs)) : 1;
  const fadeOut = w.fadeOutMs > 0 ? Math.min(1, Math.max(0, (w.endMs - ms) / w.fadeOutMs)) : 1;
  return dbToGain(w.gainDb) * fadeIn * fadeOut;
}

/** The automation methods of a Web Audio AudioParam the preview uses (structural, so tests can record them). */
export interface GainAutomation {
  cancelScheduledValues(startTime: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
}

/** Steps a fade in and a fade out that overlap are drawn with (their product is a curve, not a line). */
const OVERLAP_STEPS = 16;

/**
 * Schedules a window's envelope on a gain AudioParam from timeline time `atMs`, which plays at context time `now`:
 * every earlier automation is cancelled (a seek, pause or edit never leaves a stale ramp), the value at the playhead
 * is set at once, and while playing the rest of the envelope follows as linear ramps that equal gainAt at their
 * ends (fades are linear, so a ramp is exact) with steps at the window's edges. Paused, only the value is set.
 * No window (a source without sound) is silence.
 */
export function scheduleGain(
  param: GainAutomation,
  w: SoundWindow | null,
  opts: { atMs: number; now: number; playing: boolean },
): void {
  const { atMs, now } = opts;
  param.cancelScheduledValues(0);
  param.setValueAtTime(w ? gainAt(w, atMs) : 0, now);
  if (!opts.playing || !w || w.muted || atMs >= w.endMs) return;
  const at = (ms: number) => now + (ms - atMs) / 1000;
  const inEnd = w.startMs + w.fadeInMs;
  const outStart = w.endMs - w.fadeOutMs;
  const points = new Set<number>([w.startMs, inEnd, outStart]);
  if (w.fadeInMs > 0 && w.fadeOutMs > 0 && outStart < inEnd)
    for (let k = 1; k < OVERLAP_STEPS; k++) points.add(outStart + ((inEnd - outStart) * k) / OVERLAP_STEPS);
  const inside = [...points].filter((p) => p >= w.startMs && p < w.endMs).sort((a, b) => a - b);
  for (const p of inside) {
    if (p <= atMs) continue;
    // The window opens with a step (to 0 under a fade in, else to the gain); later points end linear ramps.
    if (p === w.startMs) param.setValueAtTime(gainAt(w, p), at(p));
    else param.linearRampToValueAtTime(gainAt(w, p), at(p));
  }
  // Up to the end (to 0 under a fade out), then silence.
  param.linearRampToValueAtTime(gainWithin(w, w.endMs), at(w.endMs));
  param.setValueAtTime(0, at(w.endMs));
}
