import { describe, expect, it } from 'vitest';
import type { VideoProjectV1 } from '@oremedia/contracts/video';
import { dbToGain, gainAt, scheduleGain, soundWindows, type GainAutomation, type SoundWindow } from './audio';
import { fixtureVideoProject, VIDEO_FIXTURE_MEDIA } from './fixtures';

const hasSound = (id: string) => {
  const m = VIDEO_FIXTURE_MEDIA[id];
  return !!m && m.kind !== 'image' && m.hasAudio;
};
const windowOf = (p: VideoProjectV1, itemId: string): SoundWindow => {
  const w = soundWindows(p, hasSound).find((x) => x.itemId === itemId);
  if (!w) throw new Error(`no window for ${itemId}`);
  return w;
};
const music = (over: Partial<SoundWindow> = {}): SoundWindow => ({
  itemId: 'aud',
  trackId: 'trk',
  kind: 'audio',
  assetVersionId: 'av',
  startMs: 1_000,
  endMs: 5_000,
  sourceInMs: 0,
  gainDb: 0,
  fadeInMs: 1_000,
  fadeOutMs: 2_000,
  muted: false,
  ...over,
});

describe('gainAt (the export sound, as linear amplitude)', () => {
  it('converts decibels to amplitude in both directions, above 1 for positive gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.9953, 4);
    expect(dbToGain(12)).toBeCloseTo(3.9811, 4);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 4);
    expect(dbToGain(-60)).toBeCloseTo(0.001, 6);
    const w = music({ gainDb: 6, fadeInMs: 0, fadeOutMs: 0 });
    expect(gainAt(w, 3_000)).toBeCloseTo(1.9953, 4);
    expect(gainAt(music({ gainDb: -12, fadeInMs: 0, fadeOutMs: 0 }), 3_000)).toBeCloseTo(0.2512, 4);
  });

  it('fades in linearly from 0 at the window start to the gain at its end (start, midpoint, end)', () => {
    const w = music({ gainDb: 6 });
    const g = dbToGain(6);
    expect(gainAt(w, 999)).toBe(0); // before the window
    expect(gainAt(w, 1_000)).toBe(0);
    expect(gainAt(w, 1_250)).toBeCloseTo(0.25 * g, 9);
    expect(gainAt(w, 1_500)).toBeCloseTo(0.5 * g, 9);
    expect(gainAt(w, 2_000)).toBeCloseTo(g, 9);
  });

  it('fades out linearly from the gain to 0 at the window end, then is silent', () => {
    const w = music({ gainDb: -6 });
    const g = dbToGain(-6);
    expect(gainAt(w, 3_000)).toBeCloseTo(g, 9);
    expect(gainAt(w, 4_000)).toBeCloseTo(0.5 * g, 9);
    expect(gainAt(w, 4_999)).toBeCloseTo(0.0005 * g, 6);
    expect(gainAt(w, 5_000)).toBe(0);
  });

  it('is silent when muted, whatever the gain or fades', () => {
    for (const ms of [1_000, 1_500, 3_000, 4_500])
      expect(gainAt(music({ muted: true, gainDb: 12 }), ms)).toBe(0);
  });

  it('follows trims: the window is startMs plus the trimmed length, and a fade out ends at the trimmed end', () => {
    const p = fixtureVideoProject();
    const track = p.tracks.find((t) => t.kind === 'audio');
    if (track?.kind !== 'audio') throw new Error('no audio track');
    track.items[0] = { ...track.items[0]!, startMs: 2_000, sourceInMs: 1_500, sourceOutMs: 6_000 };
    const w = windowOf(p, 'aud_1');
    expect(w).toMatchObject({
      startMs: 2_000,
      endMs: 6_500,
      sourceInMs: 1_500,
      fadeInMs: 500,
      fadeOutMs: 1_000,
    });
    const g = dbToGain(-6);
    expect(gainAt(w, 2_250)).toBeCloseTo(0.5 * g, 9);
    expect(gainAt(w, 6_000)).toBeCloseTo(0.5 * g, 9);
    expect(gainAt(w, 6_500)).toBe(0);
  });

  it("puts a clip's sound on its frame grid and fades it over its half of each transition, never overlapping", () => {
    const p = fixtureVideoProject();
    const video = p.tracks[0];
    if (video?.kind !== 'video') throw new Error('no video track');
    video.items[1] = { ...video.items[1]!, assetVersionId: 'av_clip_a', gainDb: 3 };
    const a = windowOf(p, 'clip_a');
    const b = windowOf(p, 'clip_b');
    // The 1 s crossfade at 4 s: A fades out over 3.5-4 s, B fades in over 4-4.5 s.
    expect(a).toMatchObject({ startMs: 0, endMs: 4_000, fadeInMs: 0, fadeOutMs: 500 });
    expect(b).toMatchObject({ startMs: 4_000, endMs: 7_000, fadeInMs: 500, fadeOutMs: 0 });
    expect(gainAt(a, 3_750)).toBeCloseTo(0.5, 9);
    expect(gainAt(a, 4_000)).toBe(0);
    expect(gainAt(b, 3_999)).toBe(0);
    expect(gainAt(b, 4_250)).toBeCloseTo(0.5 * dbToGain(3), 9);
    // A still (clip_c) has no sound; a cut has no fade.
    expect(soundWindows(p, hasSound).map((w) => w.itemId)).toEqual(['clip_a', 'clip_b', 'aud_1']);
    video.items[1]!.transitionIn = { kind: 'cut', durationMs: 0 };
    expect(windowOf(p, 'clip_a').fadeOutMs).toBe(0);
    // At 24 fps a 1 s transition is 12 frames each side (500 ms) and boundaries snap to frames.
    p.format.fps = 24;
    video.items[1]!.transitionIn = { kind: 'fade_black', durationMs: 1_000 };
    video.items[1]!.startMs = 4_000;
    expect(windowOf(p, 'clip_b')).toMatchObject({ startMs: 4_000, fadeInMs: 500 });
  });

  it('marks a muted item or track muted (silent) and leaves sources without sound out', () => {
    const p = fixtureVideoProject();
    const video = p.tracks[0];
    if (video?.kind !== 'video') throw new Error('no video track');
    video.muted = true;
    expect(windowOf(p, 'clip_a').muted).toBe(true);
    expect(gainAt(windowOf(p, 'clip_a'), 1_000)).toBe(0);
    const audio = p.tracks.find((t) => t.kind === 'audio');
    if (audio?.kind !== 'audio') throw new Error('no audio track');
    audio.items[0]!.muted = true;
    expect(windowOf(p, 'aud_1').muted).toBe(true);
    expect(soundWindows(p, () => false)).toEqual([]);
  });
});

/** Records automation like an AudioParam and evaluates it the way Web Audio does (set holds, ramps are linear). */
class ParamRecorder implements GainAutomation {
  events: Array<{ kind: 'set' | 'ramp'; value: number; time: number }> = [];
  calls: string[] = [];
  cancelScheduledValues(startTime: number) {
    this.calls.push(`cancel(${startTime})`);
    this.events = this.events.filter((e) => e.time < startTime);
  }
  setValueAtTime(value: number, time: number) {
    this.calls.push('set');
    this.events.push({ kind: 'set', value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.calls.push('ramp');
    this.events.push({ kind: 'ramp', value, time });
  }
  valueAt(t: number): number {
    // Stable by time: events at the same time keep their insertion order (Web Audio's rule).
    const ev = this.events.map((e, i) => ({ ...e, i })).sort((a, b) => a.time - b.time || a.i - b.i);
    let value = 0;
    let prev: { value: number; time: number } | null = null;
    for (const e of ev) {
      if (e.kind === 'ramp' && prev && t < e.time) {
        if (t < prev.time) return value;
        return prev.value + ((e.value - prev.value) * (t - prev.time)) / (e.time - prev.time);
      }
      if (e.time > t) return value;
      value = e.value;
      prev = { value: e.value, time: e.time };
    }
    return value;
  }
}

describe('scheduleGain (the preview plays gainAt on a Web Audio gain)', () => {
  const g = dbToGain(6);
  const w = music({ gainDb: 6 });
  /** The scheduled value at timeline time `ms` when timeline `atMs` was scheduled at context time `now`. */
  const at = (r: ParamRecorder, ms: number, atMs: number, now: number) => r.valueAt(now + (ms - atMs) / 1000);
  const probes = [
    0, 999, 1_000, 1_250, 1_500, 1_999, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 4_999, 5_000, 6_000,
  ];

  it('playing from 0, the scheduled envelope equals gainAt at fade start, midpoint and end, above 1 for +6 dB', () => {
    const r = new ParamRecorder();
    scheduleGain(r, w, { atMs: 0, now: 10, playing: true });
    for (const ms of probes) expect(at(r, ms, 0, 10), `at ${ms} ms`).toBeCloseTo(gainAt(w, ms), 6);
    expect(at(r, 1_500, 0, 10)).toBeCloseTo(0.5 * g, 6);
    expect(at(r, 3_000, 0, 10)).toBeCloseTo(g, 6);
    expect(at(r, 3_000, 0, 10)).toBeGreaterThan(1);
  });

  it('after a seek into the middle of a fade, starts at that point of the fade with no stale ramps', () => {
    const r = new ParamRecorder();
    scheduleGain(r, w, { atMs: 0, now: 10, playing: true });
    // Seek to 1.5 s (half way through the fade in) at context time 50.
    scheduleGain(r, w, { atMs: 1_500, now: 50, playing: true });
    expect(r.calls.filter((c) => c.startsWith('cancel')).at(-1)).toBe('cancel(0)');
    expect(r.events.every((e) => e.time >= 50)).toBe(true);
    expect(r.valueAt(50)).toBeCloseTo(0.5 * g, 6);
    for (const ms of probes.filter((m) => m >= 1_500))
      expect(at(r, ms, 1_500, 50), `at ${ms} ms`).toBeCloseTo(gainAt(w, ms), 6);
    // Into the fade out: 4 s is half way down.
    scheduleGain(r, w, { atMs: 4_000, now: 80, playing: true });
    expect(r.valueAt(80)).toBeCloseTo(0.5 * g, 6);
    expect(at(r, 4_500, 4_000, 80)).toBeCloseTo(gainAt(w, 4_500), 6);
    expect(at(r, 5_000, 4_000, 80)).toBe(0);
  });

  it('paused, holds the value at the playhead and schedules nothing ahead', () => {
    const r = new ParamRecorder();
    scheduleGain(r, w, { atMs: 1_250, now: 5, playing: false });
    expect(r.events).toEqual([{ kind: 'set', value: gainAt(w, 1_250), time: 5 }]);
    expect(r.valueAt(100)).toBeCloseTo(0.25 * g, 6);
  });

  it('muting mid-play silences at once and unmuting resumes the envelope where the playhead is', () => {
    const r = new ParamRecorder();
    scheduleGain(r, w, { atMs: 0, now: 0, playing: true });
    scheduleGain(r, { ...w, muted: true }, { atMs: 1_500, now: 1.5, playing: true });
    for (const ms of [1_500, 2_000, 3_000, 4_500]) expect(at(r, ms, 1_500, 1.5)).toBe(0);
    scheduleGain(r, w, { atMs: 2_500, now: 2.5, playing: true });
    for (const ms of [2_500, 3_000, 4_000, 4_999, 5_000])
      expect(at(r, ms, 2_500, 2.5), `at ${ms} ms`).toBeCloseTo(gainAt(w, ms), 6);
  });

  it('steps in and out of a window without fades, and matches overlapping fades closely', () => {
    const flat = music({ gainDb: -6, fadeInMs: 0, fadeOutMs: 0 });
    const r = new ParamRecorder();
    scheduleGain(r, flat, { atMs: 0, now: 0, playing: true });
    for (const ms of [0, 999, 1_000, 3_000, 4_999, 5_000, 5_500])
      expect(at(r, ms, 0, 0), `at ${ms} ms`).toBeCloseTo(gainAt(flat, ms), 6);
    const overlap = music({ fadeInMs: 3_000, fadeOutMs: 3_000 });
    const o = new ParamRecorder();
    scheduleGain(o, overlap, { atMs: 0, now: 0, playing: true });
    for (let ms = 1_000; ms < 5_000; ms += 137)
      expect(Math.abs(at(o, ms, 0, 0) - gainAt(overlap, ms)), `at ${ms} ms`).toBeLessThan(0.005);
  });

  it('no window (a source without sound) is silence', () => {
    const r = new ParamRecorder();
    scheduleGain(r, null, { atMs: 1_000, now: 3, playing: true });
    expect(r.events).toEqual([{ kind: 'set', value: 0, time: 3 }]);
  });
});
