import type { WaveformV1 } from '@oremedia/contracts/media';
import {
  VIDEO_FORMATS,
  VIDEO_MIN_DURATION_MS,
  VIDEO_MIN_ITEM_MS,
  VIDEO_SOURCE_MAX_MS,
  type CaptionItem,
  type OverlayItem,
  type TrackItem,
  type VideoClipItem,
  type VideoOperation,
  type VideoProjectV1,
  type VideoTrack,
} from '@oremedia/contracts/video';
import type {
  RecutAction,
  VideoAiScope,
  VideoConflict,
  VideoProposalGroup,
  VideoVersionPlan,
} from '@oremedia/contracts/video-ai';
import {
  WorkingProject,
  brandCaptionTrack,
  idMinter,
  textOverlay,
  timedCaptions,
  trackOfKind,
  type VideoCompileContext,
} from './compile-support';
import { videoTimelineDiff } from './diff';
import { guardVideoAgentScoped, guardVideoScopeChange, videoScopeOf, type VideoScopeState } from './guard';
import { videoFormatOf } from './overlays';
import { contentEndMs, lengthOf, previousAdjacent, sortByStart, spanOf, type TimedItem } from './time';

/**
 * STU-3 recut planning: the model chooses edit actions (reorder scenes, fit a duration, tighten pauses, keep or
 * remove clips, replace a shot, captions from the script, a call to action, transitions, a vertical version); these
 * deterministic planners turn each into timeline operations against the current project. Every operation is reduced
 * as it is planned and checked by the agent guard with the request's scope, so a plan never holds an operation the
 * server would refuse; what cannot be done (locked material, out of scope, nothing to cut) is a reported conflict.
 */

export interface RecutContext extends VideoCompileContext {
  waveforms: Readonly<Record<string, WaveformV1 | undefined>>;
  eligibleAssetIds: ReadonlySet<string>;
  effectiveFactIds: ReadonlySet<string>;
  scope: VideoAiScope | null;
  /** The document's script by scene (its storyboard): captions are made from it, never from the model's words. */
  script: ReadonlyArray<{ sceneId: string | null; narration: string }>;
  /** Calls to action that may be placed: the person's own (the request) and the brand's CTA conventions. */
  approvedCtas: readonly string[];
}

/** A span of the timeline to remove (clip content inside it is cut out and later items close up). */
export interface TimeCut {
  startMs: number;
  endMs: number;
}

/** Duration fitting never shortens a clip below this. */
export const FIT_MIN_CLIP_MS = 1_000;
/** Silence trimming keeps this much quiet on each side of a removed pause. */
export const PAUSE_KEEP_MS = 150;
/** A pause shorter than this is left alone. */
export const DEFAULT_MIN_PAUSE_MS = 500;
/** Peaks under max(this, 12 % of the clip's 90th percentile peak) count as quiet (peaks are 0..1000). */
export const SILENCE_FLOOR = 30;
const SILENCE_RATIO = 0.12;
/** A clip keeps at least this much after silence trimming. */
const MIN_KEPT_MS = 500;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const nameOf = (i: TrackItem) => ('name' in i && i.name ? `“${i.name}”` : i.id);

export function mergeCuts(cuts: readonly TimeCut[]): TimeCut[] {
  const sorted = cuts
    .filter((c) => c.endMs - c.startMs >= 1)
    .map((c) => ({ startMs: Math.round(c.startMs), endMs: Math.round(c.endMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: TimeCut[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.startMs <= last.endMs) last.endMs = Math.max(last.endMs, c.endMs);
    else out.push({ ...c });
  }
  return out;
}

/** Where a time lands once `cuts` are removed (a time inside a cut lands on the cut's start). */
export function timeMapper(cuts: readonly TimeCut[]): (t: number) => number {
  const merged = mergeCuts(cuts);
  return (t) => {
    let removed = 0;
    for (const c of merged) {
      if (t >= c.endMs) removed += c.endMs - c.startMs;
      else if (t > c.startMs) return c.startMs - removed;
      else break;
    }
    return t - removed;
  };
}

const inScope = (scope: VideoScopeState | null, id: string) => !scope || scope.ids.has(id);
const videoTrackOf = (p: VideoProjectV1): VideoTrack | undefined => trackOfKind(p, 'video');

interface Piece {
  clipId: string;
  a: number;
  b: number;
}

/** Transitions shortened (or removed) so they still fit once `clip` is `newLength` long and its neighbours change. */
function fitTransitions(
  work: WorkingProject,
  track: VideoTrack,
  clip: VideoClipItem,
  lengths: { self: number | null; nextPrev: number | null },
  groupId: string,
): void {
  const set = (c: VideoClipItem, limit: number) => {
    const t = c.transitionIn;
    if (!t || t.kind === 'cut' || t.durationMs <= limit) return;
    const durationMs = Math.floor(limit);
    work.apply(
      {
        op: 'setTransition',
        trackId: track.id,
        itemId: c.id,
        transition: durationMs >= 50 ? { kind: t.kind, durationMs } : null,
      },
      groupId,
    );
  };
  const prev = previousAdjacent(track.items, clip);
  if (lengths.self !== null) set(clip, Math.min(lengths.self, prev ? lengthOf(prev) : Infinity) / 2);
  const end = clip.startMs + lengthOf(clip);
  const next = track.items.find((o) => o.startMs === end && o.id !== clip.id);
  if (next && lengths.nextPrev !== null) set(next, Math.min(lengthOf(next), lengths.nextPrev) / 2);
}

/** Music beds follow a shorter picture by ending earlier; any other sound (narration, a voice) is cut with it. */
export const isMusicTrack = (t: { kind: string; id: string; name: string }): boolean =>
  t.kind === 'audio' && (t.id === 'trk_music' || /music/i.test(t.name));

/**
 * Removes `cuts` from the picture track (clips trimmed, split or removed with ripple, latest cut first so earlier
 * times never move), cuts every non-music sound track at the same spans (so narration stays in sync), then retimes
 * everything else through the same time map: titles and captions move and shrink, the music bed is shortened and
 * moved, scenes follow and the project gets shorter. Locked items never move or change (a cut that would move one is
 * refused and reported); out-of-scope items only move.
 */
export function applyCuts(
  work: WorkingProject,
  cuts: readonly TimeCut[],
  opts: { scope: VideoScopeState | null; mint: () => string; groupId: string; targetMs?: number },
): TimeCut[] {
  const start = work.project;
  const v = videoTrackOf(start);
  if (!v || !cuts.length) return [];
  const applied = cutTimedTrack(work, v.id, mergeCuts(cuts), opts);
  if (applied.length)
    for (const t of start.tracks)
      if (t.kind === 'audio' && !isMusicTrack(t)) {
        const sound = cutTimedTrack(work, t.id, applied, opts);
        const missing = overlapOn(t.items, applied) - overlapOn(t.items, sound);
        if (missing > 0)
          work.conflict({
            code: 'sound_out_of_sync',
            message: `${t.name} could not be cut where the picture was; it is out of sync by up to ${seconds(missing)}`,
            groupId: opts.groupId,
            itemIds: t.items.map((i) => i.id),
          });
      }
  retimeOthers(work, start, applied, opts);
  return applied;
}

/** How much of `cuts` falls on the items (the sound a cut list removes from a track). */
const overlapOn = (items: readonly TimedItem[], cuts: readonly TimeCut[]): number =>
  cuts.reduce(
    (n, c) =>
      n +
      items.reduce(
        (m, i) =>
          m + Math.max(0, Math.min(c.endMs, i.startMs + lengthOf(i)) - Math.max(c.startMs, i.startMs)),
        0,
      ),
    0,
  );

/**
 * Cuts the spans out of one picture or sound track with ripple, latest first. On the picture track a cut that would
 * move a locked item is refused; picture transitions are shortened to fit. Only the parts of the spans that fall on
 * items are cut (the picture's effective cuts are what the sound tracks then take).
 */
function cutTimedTrack(
  work: WorkingProject,
  trackId: string,
  cuts: readonly TimeCut[],
  opts: { scope: VideoScopeState | null; mint: () => string; groupId: string },
): TimeCut[] {
  const track0 = work.project.tracks.find((t) => t.id === trackId);
  if (!track0 || (track0.kind !== 'video' && track0.kind !== 'audio')) return [];
  if (track0.locked) {
    work.conflict({
      code: 'track_locked',
      message: `${track0.name} is locked; nothing on it can be cut`,
      groupId: opts.groupId,
      itemIds: [],
    });
    return [];
  }
  const items = sortByStart(track0.items as TimedItem[]);
  const byItem = new Map<string, Piece[]>();
  for (const cut of cuts)
    for (const c of items) {
      const s = c.startMs;
      const e = s + lengthOf(c);
      const a = Math.max(cut.startMs, s);
      const b = Math.min(cut.endMs, e);
      if (b - a < 1) continue;
      const refuse = (code: string, message: string, ids: string[]) => {
        work.conflict({ code, message, groupId: opts.groupId, itemIds: ids });
      };
      if (!inScope(opts.scope, c.id)) {
        refuse(
          'out_of_scope',
          `${nameOf(c)} is outside ${opts.scope?.label ?? 'the scope'}; it was not changed`,
          [c.id],
        );
        continue;
      }
      if (c.locked) {
        refuse('item_locked', `${nameOf(c)} is locked; it was not shortened`, [c.id]);
        continue;
      }
      const pinned = items.find((o) => o.locked && o.startMs >= e);
      if (pinned) {
        refuse(
          'locked_item_would_move',
          `Shortening ${nameOf(c)} would move the locked ${nameOf(pinned)}; unlock it to cut before it`,
          [c.id, pinned.id],
        );
        continue;
      }
      byItem.set(c.id, [...(byItem.get(c.id) ?? []), { clipId: c.id, a, b }]);
    }
  // Pieces of one item: remnants shorter than an item may be are cut too (never a sliver left behind).
  const pieces: Piece[] = [];
  for (const [id, list] of byItem) {
    const c = items.find((x) => x.id === id) as TimedItem;
    const s = c.startMs;
    const e = s + lengthOf(c);
    const merged: Piece[] = [];
    for (const p of list.sort((x, y) => x.a - y.a)) {
      const last = merged[merged.length - 1];
      if (last && p.a - last.b < VIDEO_MIN_ITEM_MS) last.b = Math.max(last.b, p.b);
      else merged.push({ ...p });
    }
    for (const p of merged) {
      if (p.a - s > 0 && p.a - s < VIDEO_MIN_ITEM_MS) p.a = s;
      if (e - p.b > 0 && e - p.b < VIDEO_MIN_ITEM_MS) p.b = e;
    }
    pieces.push(...merged);
  }
  pieces.sort((x, y) => y.a - x.a);
  const applied: TimeCut[] = [];
  for (const p of pieces) {
    const track = work.project.tracks.find((t) => t.id === trackId);
    if (!track || (track.kind !== 'video' && track.kind !== 'audio')) break;
    const list = track.items as TimedItem[];
    const clip = list.find((i) => i.startMs <= p.a && p.b <= i.startMs + lengthOf(i));
    if (!clip) continue;
    const s = clip.startMs;
    const e = s + lengthOf(clip);
    const len = p.b - p.a;
    const picture = track.kind === 'video' ? (track as VideoTrack) : null;
    const fit = (lengths: { self: number | null; nextPrev: number | null }) => {
      if (picture) fitTransitions(work, picture, clip as VideoClipItem, lengths, opts.groupId);
    };
    const fresh = () =>
      ((work.project.tracks.find((t) => t.id === trackId)?.items ?? []) as TimedItem[]).find(
        (i) => i.id === clip.id,
      ) ?? clip;
    let ok: boolean;
    if (p.a <= s && p.b >= e) {
      const prev = picture ? previousAdjacent(picture.items, clip as VideoClipItem) : null;
      fit({ self: null, nextPrev: prev ? lengthOf(prev) : null });
      ok = work.apply({ op: 'removeClip', trackId, itemId: clip.id, ripple: true }, opts.groupId);
    } else if (p.b >= e || p.a <= s) {
      fit({ self: e - s - len, nextPrev: e - s - len });
      const f = fresh();
      if ('fadeInMs' in f && f.fadeInMs + f.fadeOutMs > e - s - len)
        work.apply({ op: 'setAudio', trackId, itemId: f.id, fadeInMs: 0, fadeOutMs: 0 }, opts.groupId);
      ok = work.apply(
        {
          op: 'trimClip',
          trackId,
          itemId: clip.id,
          sourceInMs: p.a <= s ? f.sourceInMs + len : f.sourceInMs,
          sourceOutMs: p.a <= s ? f.sourceOutMs : f.sourceOutMs - len,
          ripple: true,
        },
        opts.groupId,
      );
    } else {
      fit({ self: p.a - s, nextPrev: e - p.b });
      const f = fresh();
      const id = opts.mint();
      ok =
        work.apply({ op: 'splitClip', trackId, itemId: clip.id, atMs: p.a, newItemId: id }, opts.groupId) &&
        work.apply(
          {
            op: 'trimClip',
            trackId,
            itemId: id,
            sourceInMs: f.sourceInMs + (p.b - s),
            sourceOutMs: f.sourceOutMs,
            ripple: true,
          },
          opts.groupId,
        );
    }
    if (ok) applied.push({ startMs: p.a, endMs: p.b });
  }
  return mergeCuts(applied);
}

function retimeOthers(
  work: WorkingProject,
  start: VideoProjectV1,
  applied: readonly TimeCut[],
  opts: { scope: VideoScopeState | null; groupId: string; targetMs?: number },
): void {
  const map = timeMapper(applied);
  const keep = (code: string, item: TrackItem, why: string) =>
    work.conflict({ code, message: `${nameOf(item)} ${why}`, groupId: opts.groupId, itemIds: [item.id] });
  if (applied.length)
    for (const track of start.tracks) {
      if (track.kind === 'video' || (track.kind === 'audio' && !isMusicTrack(track))) continue;
      const items = sortByStart(track.items as TrackItem[]);
      for (const item of items) {
        const s = spanOf(item);
        const ns = map(s.startMs);
        const ne = map(s.endMs);
        if (ns === s.startMs && ne === s.endMs) continue;
        const resized = ne - ns !== s.endMs - s.startMs;
        if (track.locked || item.locked) {
          keep('locked_item_kept', item, 'is locked and keeps its place');
          continue;
        }
        if (resized && !inScope(opts.scope, item.id)) {
          keep('out_of_scope_kept', item, 'is outside the scope and keeps its length');
          continue;
        }
        if (track.kind === 'audio' && 'sourceInMs' in item) {
          if (ne - ns < VIDEO_MIN_ITEM_MS) {
            work.apply({ op: 'removeClip', trackId: track.id, itemId: item.id }, opts.groupId);
            continue;
          }
          const a = item as Extract<TrackItem, { fadeInMs: number }>;
          const length = ne - ns;
          if (a.fadeInMs + a.fadeOutMs > length) {
            const scale = length / (a.fadeInMs + a.fadeOutMs);
            work.apply(
              {
                op: 'setAudio',
                trackId: track.id,
                itemId: a.id,
                fadeInMs: Math.floor(a.fadeInMs * scale),
                fadeOutMs: Math.floor(a.fadeOutMs * scale),
              },
              opts.groupId,
            );
          }
          if (resized)
            work.apply(
              {
                op: 'trimClip',
                trackId: track.id,
                itemId: a.id,
                sourceInMs: a.sourceInMs,
                sourceOutMs: a.sourceInMs + length,
              },
              opts.groupId,
            );
          if (ns !== s.startMs)
            work.apply({ op: 'moveClip', trackId: track.id, itemId: a.id, startMs: ns }, opts.groupId);
          continue;
        }
        if (ne - ns < VIDEO_MIN_ITEM_MS) {
          work.apply(
            {
              op: track.kind === 'caption' ? 'removeCaption' : 'removeOverlay',
              trackId: track.id,
              itemId: item.id,
            },
            opts.groupId,
          );
          continue;
        }
        if (track.kind === 'caption')
          work.apply(
            {
              op: 'upsertCaption',
              trackId: track.id,
              caption: { ...(item as CaptionItem), startMs: ns, endMs: ne },
            },
            opts.groupId,
          );
        else if (track.kind === 'overlay')
          work.apply(
            {
              op: 'setOverlay',
              trackId: track.id,
              overlay: fitAnimations({ ...(item as OverlayItem), startMs: ns, endMs: ne }),
            },
            opts.groupId,
          );
      }
    }
  if (applied.length)
    for (const scene of [...start.scenes].sort((a, b) => a.startMs - b.startMs)) {
      const ns = map(scene.startMs);
      const ne = map(scene.endMs);
      if (ns === scene.startMs && ne === scene.endMs) continue;
      if (ne - ns < VIDEO_MIN_ITEM_MS) work.apply({ op: 'removeScene', sceneId: scene.id }, opts.groupId);
      else work.apply({ op: 'setScene', scene: { ...scene, startMs: ns, endMs: ne } }, opts.groupId);
    }
  const p = work.project;
  const floor = Math.max(contentEndMs(p), ...p.scenes.map((s) => s.endMs), VIDEO_MIN_DURATION_MS);
  const wanted = opts.targetMs ?? map(start.durationMs);
  const durationMs = Math.max(wanted, floor);
  if (durationMs < p.durationMs) work.apply({ op: 'setDuration', durationMs }, opts.groupId);
}

/** Enter and exit animations shortened (or dropped) so they fit an overlay's new length. */
function fitAnimations(o: OverlayItem): OverlayItem {
  const length = o.endMs - o.startMs;
  const total = (o.enter?.durationMs ?? 0) + (o.exit?.durationMs ?? 0);
  if (total <= length) return o;
  const { enter: _e, exit: _x, ...rest } = o;
  return rest;
}

// ---- planners ---------------------------------------------------------------------------------------------------

/**
 * Cuts that bring the project to `targetMs`: black after the content first, then the tails of the clips in scope
 * that are free to change, in proportion to how much each can give (each keeps FIT_MIN_CLIP_MS). When locked or
 * out-of-scope material makes the target unreachable, nothing is cut and the conflict says by how much.
 */
export function planDurationFit(
  project: VideoProjectV1,
  targetMs: number,
  scope: VideoScopeState | null,
): { cuts: TimeCut[]; conflict: VideoConflict | null; note: string | null } {
  const total = project.durationMs;
  if (total <= targetMs)
    return {
      cuts: [],
      conflict: null,
      note: `The video already lasts ${seconds(total)}, within ${seconds(targetMs)}`,
    };
  const v = videoTrackOf(project);
  const tail = total - contentEndMs(project);
  const need = total - targetMs - Math.max(0, tail);
  if (need <= 0) return { cuts: [], conflict: null, note: null };
  const clips = v ? sortByStart(v.items) : [];
  const free = clips.filter(
    (c) =>
      !v?.locked &&
      !c.locked &&
      inScope(scope, c.id) &&
      !clips.some((o) => o.locked && o.startMs >= c.startMs + lengthOf(c)),
  );
  const give = free.map((c) => Math.max(0, lengthOf(c) - FIT_MIN_CLIP_MS));
  const available = give.reduce((s, g) => s + g, 0);
  if (available < need) {
    const lockedMs = clips.filter((c) => c.locked || v?.locked).reduce((s, c) => s + lengthOf(c), 0);
    const shortest = total - Math.max(0, tail) - available;
    const reason =
      lockedMs > 0
        ? `locked material (${seconds(lockedMs)}) and the clips that may change, each kept at ${seconds(FIT_MIN_CLIP_MS)}`
        : `the clips in scope, each kept at ${seconds(FIT_MIN_CLIP_MS)}`;
    return {
      cuts: [],
      note: null,
      conflict: {
        code: lockedMs > 0 ? 'locked_exceeds_target' : 'target_too_short',
        message: `The video cannot be shortened to ${seconds(targetMs)}: with ${reason} it lasts at least ${seconds(shortest)}. Unlock clips or widen the scope.`,
        itemIds: clips.filter((c) => c.locked).map((c) => c.id),
      },
    };
  }
  const shares = give.map((g) => Math.floor((need * g) / available));
  let rest = need - shares.reduce((s, x) => s + x, 0);
  for (const k of [...give.keys()].sort((a, b) => (give[b] ?? 0) - (give[a] ?? 0))) {
    if (rest <= 0) break;
    if ((shares[k] ?? 0) < (give[k] ?? 0)) {
      shares[k] = (shares[k] ?? 0) + 1;
      rest--;
    }
  }
  const cuts = free
    .map((c, k) => {
      const end = c.startMs + lengthOf(c);
      return { startMs: end - (shares[k] ?? 0), endMs: end };
    })
    .filter((c) => c.endMs > c.startMs);
  return { cuts, conflict: null, note: null };
}

function percentile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/**
 * Pauses inside the clips in scope, from each source's waveform peaks (STU-2a derivative): runs of peaks below the
 * clip's quiet threshold lasting at least `minPauseMs`, removed except PAUSE_KEEP_MS of quiet next to the sound (a
 * pause at a clip's edge is removed entirely). Stills and clips without a waveform are named and left alone.
 */
export function planSilenceTrim(
  project: VideoProjectV1,
  ctx: Pick<RecutContext, 'media' | 'waveforms'>,
  scope: VideoScopeState | null,
  minPauseMs = DEFAULT_MIN_PAUSE_MS,
): { cuts: TimeCut[]; skipped: string[] } {
  const v = videoTrackOf(project);
  const cuts: TimeCut[] = [];
  const skipped: string[] = [];
  for (const c of v ? sortByStart(v.items) : []) {
    if (!inScope(scope, c.id) || c.locked) continue;
    const media = ctx.media[c.assetVersionId];
    if (media?.kind !== 'video') continue;
    const wf = ctx.waveforms[c.assetVersionId];
    if (!wf || !media.hasAudio) {
      skipped.push(c.name ?? c.id);
      continue;
    }
    const msPer = 1000 / wf.peaksPerSecond;
    const i0 = Math.floor(c.sourceInMs / msPer);
    const i1 = Math.min(wf.peaks.length, Math.ceil(c.sourceOutMs / msPer));
    const window = wf.peaks.slice(i0, i1);
    const threshold = Math.max(SILENCE_FLOOR, Math.round(percentile(window, 0.9) * SILENCE_RATIO));
    const own: TimeCut[] = [];
    let run: number | null = null;
    for (let i = i0; i <= i1; i++) {
      const quiet = i < i1 && (wf.peaks[i] ?? 0) < threshold;
      if (quiet && run === null) run = i;
      if (!quiet && run !== null) {
        const srcA = Math.max(c.sourceInMs, run * msPer);
        const srcB = Math.min(c.sourceOutMs, i * msPer);
        run = null;
        if (srcB - srcA < minPauseMs) continue;
        const cutA = srcA <= c.sourceInMs ? srcA : srcA + PAUSE_KEEP_MS;
        const cutB = srcB >= c.sourceOutMs ? srcB : srcB - PAUSE_KEEP_MS;
        if (cutB - cutA < VIDEO_MIN_ITEM_MS) continue;
        own.push({
          startMs: Math.round(c.startMs + (cutA - c.sourceInMs)),
          endMs: Math.round(c.startMs + (cutB - c.sourceInMs)),
        });
      }
    }
    const removed = own.reduce((s, x) => s + x.endMs - x.startMs, 0);
    if (lengthOf(c) - removed < MIN_KEPT_MS) {
      skipped.push(`${c.name ?? c.id} (almost entirely quiet)`);
      continue;
    }
    cuts.push(...own);
  }
  return { cuts, skipped };
}

// ---- the compile ------------------------------------------------------------------------------------------------

export interface RecutCompile {
  groups: Array<VideoProposalGroup & { operations: VideoOperation[] }>;
  operations: VideoOperation[];
  /** Operation counts a part of a large commit may end on: whole actions only. */
  cutPoints: number[];
  project: VideoProjectV1;
  conflicts: VideoConflict[];
  /** A new document in another format (the original is untouched); its changes are against the original. */
  version: VideoVersionPlan | null;
  assetVersionIds: string[];
  factIds: string[];
}

const ACTION_LABELS: Record<RecutAction['kind'], string> = {
  reorder_scenes: 'Reorder scenes',
  move_clip: 'Move a clip',
  fit_duration: 'Fit the length',
  tighten: 'Remove pauses',
  keep_only: 'Keep only the chosen clips',
  remove_items: 'Remove items',
  replace_source: 'Replace a shot',
  trim_clip: 'Change a clip’s length',
  add_captions: 'Captions from the script',
  add_cta: 'Call to action',
  set_transitions: 'Transitions',
  vertical_version: 'New format version',
};

/**
 * Compiles the model's actions in order against `project` (each sees the result of the ones before). `only` limits
 * the compile to some groups (`a1`, `a2`... by action position), which is how a partial accept is recompiled.
 */
export function compileRecut(
  project: VideoProjectV1,
  actions: readonly RecutAction[],
  ctx: RecutContext,
  only?: ReadonlySet<string>,
): RecutCompile {
  const scope = videoScopeOf(project, ctx.scope);
  const media = ctx.media as Record<string, NonNullable<RecutContext['media'][string]>>;
  const work = new WorkingProject(project, { media, strictMedia: false }, (before, op, after) => {
    guardVideoAgentScoped(before, op, 'agent', scope);
    guardVideoScopeChange(before, after, op, scope);
  });
  const mint = idMinter(project, ctx.idPrefix);
  const groups: RecutCompile['groups'] = [];
  const assetVersionIds = new Set<string>();
  const factIds = new Set<string>();
  let version: VideoVersionPlan | null = null;
  actions.forEach((action, index) => {
    const groupId = `a${index + 1}`;
    if (only && !only.has(groupId)) return;
    const before = work.project;
    const opsBefore = work.operations.length;
    const label = labelFor(action, before);
    if (action.kind === 'vertical_version') {
      // A new document from the project as it is now (never from the proposal's other changes, which the person has
      // not accepted); the remaining actions still make a proposal for this video.
      const framed = reframeProject(project, action.formatKey, action.focus);
      for (const c of framed.conflicts) work.conflict({ ...c, groupId });
      version = {
        formatKey: action.formatKey,
        label: `${VIDEO_FORMATS[action.formatKey].label} version`,
        project: framed.project,
        changes: videoTimelineDiff(project, framed.project),
      };
      return;
    }
    planAction(work, action, { ctx, scope, mint, groupId, assetVersionIds, factIds });
    work.mark();
    const operations = work.operations.slice(opsBefore);
    if (!operations.length) return;
    groups.push({
      id: groupId,
      label,
      operationCount: operations.length,
      operations,
      changes: videoTimelineDiff(before, work.project),
    });
  });
  return {
    groups,
    operations: [...work.operations],
    cutPoints: [...work.cutPoints],
    project: work.project,
    conflicts: work.conflicts,
    version,
    assetVersionIds: [...assetVersionIds],
    factIds: [...factIds],
  };
}

function labelFor(action: RecutAction, project: VideoProjectV1): string {
  const base = ACTION_LABELS[action.kind];
  switch (action.kind) {
    case 'fit_duration':
      return `${base}: ${seconds(action.targetMs)}`;
    case 'reorder_scenes':
      return `${base}: ${action.order
        .map((id) => project.scenes.find((s) => s.id === id)?.title ?? id)
        .join(', ')}`.slice(0, 120);
    case 'vertical_version':
      return `${VIDEO_FORMATS[action.formatKey].label} version (new document)`;
    default:
      return base;
  }
}

interface PlanEnv {
  ctx: RecutContext;
  scope: VideoScopeState | null;
  mint: () => string;
  groupId: string;
  assetVersionIds: Set<string>;
  factIds: Set<string>;
}

function planAction(work: WorkingProject, action: RecutAction, env: PlanEnv): void {
  const { scope, mint, groupId, ctx } = env;
  const conflict = (code: string, message: string, itemIds: string[] = []) =>
    work.conflict({ code, message, groupId, itemIds });
  const p = work.project;
  const v = videoTrackOf(p);
  const clipOf = (id: string) => v?.items.find((i) => i.id === id);
  switch (action.kind) {
    case 'reorder_scenes':
      work.apply({ op: 'reorderScenes', order: action.order }, groupId);
      return;
    case 'move_clip':
      return moveClip(work, action.itemId, action.beforeItemId, env);
    case 'fit_duration': {
      const plan = planDurationFit(p, action.targetMs, scope);
      if (plan.conflict) {
        work.conflict({ ...plan.conflict, groupId });
        return;
      }
      if (plan.note) {
        conflict('already_within_target', plan.note);
        return;
      }
      applyCuts(work, plan.cuts, { scope, mint, groupId, targetMs: action.targetMs });
      if (work.project.durationMs > action.targetMs)
        conflict(
          'target_not_reached',
          `The video lasts ${seconds(work.project.durationMs)} after the change; locked or out-of-scope items keep it longer than ${seconds(action.targetMs)}`,
        );
      return;
    }
    case 'tighten': {
      const plan = planSilenceTrim(p, ctx, scope, action.minPauseMs);
      if (plan.skipped.length)
        conflict(
          'no_waveform',
          `No pauses were looked for in ${plan.skipped.join(', ')}: stills, silent clips and clips without a waveform are left as they are`,
        );
      if (!plan.cuts.length) {
        conflict('no_pauses', 'No pauses long enough to remove were found in the clips in scope');
        return;
      }
      applyCuts(work, plan.cuts, { scope, mint, groupId });
      return;
    }
    case 'keep_only':
    case 'remove_items': {
      const named = new Set(action.itemIds);
      const unknown = action.itemIds.filter(
        (id) =>
          !p.tracks.some((t) =>
            (t.items as TrackItem[]).some(
              (i) => i.id === id || ('assetVersionId' in i && i.assetVersionId === id),
            ),
          ),
      );
      if (unknown.length) conflict('unknown_item', `Not on the timeline: ${unknown.join(', ')}`, unknown);
      const matches = (c: VideoClipItem) => named.has(c.id) || named.has(c.assetVersionId);
      const clips = (v?.items ?? []).filter((c) => (action.kind === 'keep_only' ? !matches(c) : matches(c)));
      if (action.kind === 'keep_only' && v && !(v.items ?? []).some(matches)) {
        conflict('nothing_to_keep', 'None of the clips to keep is on the timeline; nothing was removed');
        return;
      }
      applyCuts(
        work,
        clips.map((c) => ({ startMs: c.startMs, endMs: c.startMs + lengthOf(c) })),
        { scope, mint, groupId },
      );
      if (action.kind === 'remove_items')
        for (const track of work.project.tracks) {
          if (track.kind === 'video') continue;
          for (const item of track.items as TrackItem[])
            if (named.has(item.id))
              work.apply(
                track.kind === 'audio'
                  ? { op: 'removeClip', trackId: track.id, itemId: item.id }
                  : track.kind === 'caption'
                    ? { op: 'removeCaption', trackId: track.id, itemId: item.id }
                    : { op: 'removeOverlay', trackId: track.id, itemId: item.id },
                groupId,
              );
        }
      return;
    }
    case 'replace_source': {
      const clip = clipOf(action.itemId);
      if (!clip || !v)
        return conflict('unknown_item', `${action.itemId} is not a clip on the picture track`, [
          action.itemId,
        ]);
      if (!ctx.eligibleAssetIds.has(action.assetVersionId))
        return conflict(
          'asset_not_eligible',
          `${action.assetVersionId} is not an asset this brand may use here; pick one from the library`,
          [clip.id],
        );
      const m = ctx.media[action.assetVersionId];
      if (!m || m.kind === 'audio')
        return conflict('asset_kind', `${action.assetVersionId} is not a video or a still`, [clip.id]);
      const inMs = action.sourceInMs ?? 0;
      const available =
        m.kind === 'video' && m.durationMs !== null ? m.durationMs - inMs : VIDEO_SOURCE_MAX_MS;
      if (available < VIDEO_MIN_ITEM_MS)
        return conflict('source_too_short', `The new source has nothing after ${seconds(inMs)}`, [clip.id]);
      if (available < lengthOf(clip)) {
        applyCuts(work, [{ startMs: clip.startMs + available, endMs: clip.startMs + lengthOf(clip) }], {
          scope,
          mint,
          groupId,
        });
        conflict(
          'shortened_to_source',
          `The new shot lasts ${seconds(available)}, so ${nameOf(clip)} was shortened to fit it`,
          [clip.id],
        );
      }
      if (
        work.apply(
          {
            op: 'replaceClipSource',
            trackId: v.id,
            itemId: clip.id,
            assetVersionId: action.assetVersionId,
            sourceInMs: inMs,
          },
          groupId,
        )
      )
        env.assetVersionIds.add(action.assetVersionId);
      return;
    }
    case 'trim_clip': {
      const clip = clipOf(action.itemId);
      if (!clip || !v)
        return conflict('unknown_item', `${action.itemId} is not a clip on the picture track`, [
          action.itemId,
        ]);
      const len = lengthOf(clip);
      if (action.durationMs < len) {
        applyCuts(work, [{ startMs: clip.startMs + action.durationMs, endMs: clip.startMs + len }], {
          scope,
          mint,
          groupId,
        });
        return;
      }
      const m = ctx.media[clip.assetVersionId];
      const sourceOutMs = clip.sourceInMs + action.durationMs;
      if (m?.kind === 'video' && m.durationMs !== null && sourceOutMs > m.durationMs)
        return conflict(
          'beyond_source',
          `${nameOf(clip)} can last at most ${seconds(m.durationMs - clip.sourceInMs)} from where it starts`,
          [clip.id],
        );
      work.apply(
        {
          op: 'trimClip',
          trackId: v.id,
          itemId: clip.id,
          sourceInMs: clip.sourceInMs,
          sourceOutMs,
          ripple: true,
        },
        groupId,
      );
      return;
    }
    case 'add_captions': {
      // The words are the storyboard's script (checked when the storyboard was made), never the model's.
      const wanted = action.sceneIds ? new Set(action.sceneIds) : null;
      const missing = [...(wanted ?? [])].filter((id) => !ctx.script.some((l) => l.sceneId === id));
      for (const id of missing)
        conflict('required_messaging_missing', `Scene ${id} has no script in the storyboard to caption`);
      const byScene = ctx.script.filter((l) => l.sceneId !== null && (!wanted || wanted.has(l.sceneId)));
      const unplaced = ctx.script.filter((l) => l.sceneId === null).map((l) => l.narration);
      const lines =
        byScene.length || wanted
          ? byScene.map((l) => ({ sceneId: l.sceneId, text: l.narration }))
          : unplaced.length
            ? [{ sceneId: null, text: unplaced.join(' ') }]
            : [];
      if (!lines.length && missing.length) return;
      return addCaptions(work, lines, env);
    }
    case 'add_cta':
      return addCta(work, action.text, action.factIds, env);
    case 'set_transitions': {
      if (!v) return;
      for (const clip of sortByStart(v.items)) {
        if (!inScope(scope, clip.id) || clip.locked) continue;
        const cur = videoTrackOf(work.project)?.items.find((i) => i.id === clip.id);
        if (!cur) continue;
        const prev = previousAdjacent(videoTrackOf(work.project)?.items ?? [], cur);
        if (!prev) continue;
        const limit = Math.floor(Math.min(lengthOf(cur), lengthOf(prev)) / 2);
        const durationMs = Math.min(action.durationMs, limit);
        work.apply(
          {
            op: 'setTransition',
            trackId: v.id,
            itemId: clip.id,
            transition:
              action.transition === 'cut' || durationMs < 50 ? null : { kind: action.transition, durationMs },
          },
          groupId,
        );
      }
      return;
    }
    case 'vertical_version':
      return;
  }
}

/**
 * Moves a picture clip before another (or to the end) with ripple; titles and captions lying wholly inside the moved
 * clip or the clips it jumps over move with them. A clip that is exactly one scene moving to a scene start is a
 * scene reorder, so the scenes follow too.
 */
function moveClip(work: WorkingProject, itemId: string, beforeId: string | null, env: PlanEnv): void {
  const { groupId } = env;
  const p = work.project;
  const v = videoTrackOf(p);
  const clip = v?.items.find((i) => i.id === itemId);
  if (!v || !clip) {
    work.conflict({
      code: 'unknown_item',
      message: `${itemId} is not a clip on the picture track`,
      groupId,
      itemIds: [itemId],
    });
    return;
  }
  const s = clip.startMs;
  const len = lengthOf(clip);
  const e = s + len;
  const before = beforeId ? v.items.find((i) => i.id === beforeId) : null;
  if (beforeId && !before) {
    work.conflict({
      code: 'unknown_item',
      message: `${beforeId} is not a clip on the picture track`,
      groupId,
      itemIds: [beforeId],
    });
    return;
  }
  const sceneOf = (a: number, b: number) => p.scenes.find((x) => x.startMs === a && x.endMs === b);
  const own = sceneOf(s, e);
  const targetScene = before ? p.scenes.find((x) => x.startMs === before.startMs) : null;
  if (own && (targetScene || !before) && p.scenes.length > 1) {
    const order = [...p.scenes]
      .sort((a, b) => a.startMs - b.startMs)
      .map((x) => x.id)
      .filter((id) => id !== own.id);
    const at = targetScene ? order.indexOf(targetScene.id) : order.length;
    order.splice(at < 0 ? order.length : at, 0, own.id);
    work.apply({ op: 'reorderScenes', order }, groupId);
    return;
  }
  const lastEnd = Math.max(...v.items.map((i) => i.startMs + lengthOf(i)));
  const target = before ? (before.startMs >= e ? before.startMs - len : before.startMs) : lastEnd - len;
  if (target === s) return;
  if (!work.apply({ op: 'moveClip', trackId: v.id, itemId: clip.id, startMs: target, ripple: true }, groupId))
    return;
  // The segments that moved: the clip itself, and what it jumped over (shifted by its length the other way).
  const segments =
    target < s
      ? [
          { from: s, to: e, delta: target - s },
          { from: target, to: s, delta: len },
        ]
      : [
          { from: s, to: e, delta: target - s },
          { from: e, to: target + len, delta: -len },
        ];
  for (const track of p.tracks) {
    if (track.kind !== 'overlay' && track.kind !== 'caption') continue;
    for (const item of track.items as Array<OverlayItem | CaptionItem>) {
      const seg = segments.find((g) => item.startMs >= g.from && item.endMs <= g.to);
      if (!seg || track.locked || item.locked) continue;
      const moved = { ...item, startMs: item.startMs + seg.delta, endMs: item.endMs + seg.delta };
      work.apply(
        track.kind === 'caption'
          ? { op: 'upsertCaption', trackId: track.id, caption: moved as CaptionItem }
          : { op: 'setOverlay', trackId: track.id, overlay: moved as OverlayItem },
        groupId,
      );
    }
  }
}

/** Captions from script lines, timed across their scene (or the whole video), replacing unlocked captions there. */
function addCaptions(
  work: WorkingProject,
  lines: ReadonlyArray<{ sceneId: string | null; text: string }>,
  env: PlanEnv,
): void {
  const { groupId, mint } = env;
  if (!lines.length) {
    work.conflict({
      code: 'required_messaging_missing',
      message: 'There is no script text to caption; write the narration in the storyboard or in the request',
      groupId,
      itemIds: [],
    });
    return;
  }
  let track = trackOfKind(work.project, 'caption');
  if (!track) {
    const made = brandCaptionTrack(mint(), env.ctx.bindings);
    if (!made) {
      work.conflict({
        code: 'no_caption_font',
        message: 'The brand system has no caption or body font, so captions cannot be added',
        groupId,
        itemIds: [],
      });
      return;
    }
    if (!work.apply({ op: 'addTrack', track: made }, groupId)) return;
    track = trackOfKind(work.project, 'caption');
  }
  if (!track) return;
  const end = Math.max(contentEndMs(work.project), VIDEO_MIN_DURATION_MS);
  for (const line of lines) {
    const scene = line.sceneId ? work.project.scenes.find((s) => s.id === line.sceneId) : null;
    if (line.sceneId && !scene) {
      work.conflict({
        code: 'unknown_scene',
        message: `There is no scene ${line.sceneId}`,
        groupId,
        itemIds: [],
      });
      continue;
    }
    const span = scene ? { startMs: scene.startMs, endMs: scene.endMs } : { startMs: 0, endMs: end };
    const current = trackOfKind(work.project, 'caption');
    if (!current) return;
    const overlapping = current.items.filter((c) => c.startMs < span.endMs && c.endMs > span.startMs);
    if (overlapping.some((c) => c.locked)) {
      work.conflict({
        code: 'locked_item_kept',
        message: 'Locked captions already cover this part; they were kept and no captions were added here',
        groupId,
        itemIds: overlapping.filter((c) => c.locked).map((c) => c.id),
      });
      continue;
    }
    for (const c of overlapping)
      work.apply({ op: 'removeCaption', trackId: current.id, itemId: c.id }, groupId);
    for (const caption of timedCaptions(line.text, span.startMs, span.endMs, mint))
      work.apply({ op: 'upsertCaption', trackId: current.id, caption }, groupId);
  }
}

/** The approved call to action as a title over the last three seconds (claims only with effective facts). */
function addCta(work: WorkingProject, text: string, factIds: readonly string[], env: PlanEnv): void {
  const { groupId, mint, ctx } = env;
  const clean = text.trim();
  const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!clean || ctx.approvedCtas.length === 0) {
    work.conflict({
      code: 'required_messaging_missing',
      message:
        'No approved call to action was given and the brand guidance names none; write it in the request',
      groupId,
      itemIds: [],
    });
    return;
  }
  // Never the model's own words: only the person's call to action or a brand CTA convention is placed.
  if (!ctx.approvedCtas.some((c) => norm(c) === norm(clean))) {
    work.conflict({
      code: 'cta_not_approved',
      message: `“${clean}” is not an approved call to action (${ctx.approvedCtas.map((c) => `“${c}”`).join(', ')}); nothing was added`,
      groupId,
      itemIds: [],
    });
    return;
  }
  const unsupported = factIds.filter((id) => !ctx.effectiveFactIds.has(id));
  if (unsupported.length) {
    work.conflict({
      code: 'claim_without_fact',
      message: `The call to action cites facts that are not approved and in force (${unsupported.join(', ')}); it was not added`,
      groupId,
      itemIds: [],
    });
    return;
  }
  let track = trackOfKind(work.project, 'overlay');
  if (!track) {
    if (
      !work.apply(
        { op: 'addTrack', track: { id: mint(), kind: 'overlay', name: 'Titles', locked: false, items: [] } },
        groupId,
      )
    )
      return;
    track = trackOfKind(work.project, 'overlay');
  }
  if (!track) return;
  const end = Math.max(contentEndMs(work.project), Math.min(work.project.durationMs, VIDEO_MIN_DURATION_MS));
  const overlay = textOverlay(work.project, ctx, {
    id: mint(),
    text: clean,
    startMs: Math.max(0, end - 3_000),
    endMs: end,
    band: 'lower',
    role: 'cta',
    factRefs: [...factIds],
  });
  if (!overlay) {
    work.conflict({
      code: 'no_title_font',
      message: 'The brand system has no heading font for the call to action',
      groupId,
      itemIds: [],
    });
    return;
  }
  if (work.apply({ op: 'setOverlay', trackId: track.id, overlay }, groupId))
    for (const id of factIds) env.factIds.add(id);
}

/**
 * The project in another output format (a vertical version): clips fill the new frame around their focal point
 * (the model's focus where it gave one, keeping the product in view, else the clip's own), titles keep their size
 * and relative height within the new safe width, logos and images scale to fit. A new project; the original is
 * never changed.
 */
export function reframeProject(
  project: VideoProjectV1,
  formatKey: VideoVersionPlan['formatKey'],
  focus: ReadonlyArray<{ itemId: string; focalX: number; focalY: number }> = [],
): { project: VideoProjectV1; conflicts: VideoConflict[] } {
  const conflicts: VideoConflict[] = [];
  const kept = (id: string, what: string) =>
    conflicts.push({
      code: 'locked_item_kept',
      message: `${what} is locked and keeps its framing in the new version; check it there`,
      itemIds: [id],
    });
  const preset = VIDEO_FORMATS[formatKey];
  const next = structuredClone(project);
  const w1 = project.format.width;
  const h1 = project.format.height;
  next.format = { key: formatKey, width: preset.width, height: preset.height, fps: project.format.fps };
  const f2 = videoFormatOf(next);
  const s = Math.min(f2.width / w1, f2.height / h1);
  const focal = new Map(focus.map((x) => [x.itemId, x]));
  for (const track of next.tracks) {
    if (track.kind === 'video')
      track.items = track.items.map((c) => {
        if (c.locked || track.locked) {
          kept(c.id, `Clip ${nameOf(c)}`);
          return c;
        }
        const at = focal.get(c.id);
        return {
          ...c,
          frame: {
            ...c.frame,
            fit: 'fill' as const,
            ...(at ? { focalX: at.focalX, focalY: at.focalY } : {}),
          },
        };
      });
    if (track.kind === 'overlay')
      track.items = track.items.map((o) => {
        const t = o.element.transform;
        if (o.locked || track.locked) {
          kept(o.id, nameOf(o));
          return o;
        }
        const safeWidth = f2.width - f2.safeArea.left - f2.safeArea.right;
        if (o.element.type === 'text') {
          const width = Math.min(t.width, safeWidth);
          const cy = ((t.y + t.height / 2) / h1) * f2.height;
          const y = Math.min(
            Math.max(f2.safeArea.top, cy - t.height / 2),
            f2.height - f2.safeArea.bottom - t.height,
          );
          return {
            ...o,
            element: {
              ...o.element,
              transform: {
                ...t,
                x: Math.round((f2.width - width) / 2),
                y: Math.round(y),
                width: Math.round(width),
              },
            },
          };
        }
        // A logo or other protected element keeps its size (its minimum width and proportions are the brand's rule);
        // only its position follows the new frame. Other images and shapes scale with the frame.
        const keepSize = o.element.protected || o.element.type === 'logo';
        const width = keepSize ? t.width : t.width * s;
        const height = keepSize ? t.height : t.height * s;
        const cx = ((t.x + t.width / 2) / w1) * f2.width;
        const cy = ((t.y + t.height / 2) / h1) * f2.height;
        // Kept inside the new safe area (a logo near an edge of the wide frame stays clear of the platform's chrome).
        const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
        const x = clamp(cx - width / 2, f2.safeArea.left, f2.width - f2.safeArea.right - width);
        const y = clamp(cy - height / 2, f2.safeArea.top, f2.height - f2.safeArea.bottom - height);
        return {
          ...o,
          element: {
            ...o.element,
            transform: {
              ...t,
              x: Math.round(x),
              y: Math.round(y),
              width: Math.round(width),
              height: Math.round(height),
            },
          },
        };
      });
  }
  return { project: next, conflicts };
}
