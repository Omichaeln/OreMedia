import {
  AudioItem as AudioItemSchema,
  VIDEO_MAX_TRACKS,
  VIDEO_MIN_ITEM_MS,
  VIDEO_PROJECT_MAX_DURATION_MS,
  VideoClipItem as VideoClipItemSchema,
  VideoProjectV1 as VideoProjectSchema,
  type AudioItem,
  type CaptionItem,
  type OverlayItem,
  type Track,
  type TrackItem,
  type VideoClipItem,
  type VideoMediaInfo,
  type VideoOperation,
  type VideoOperationBatch,
  type VideoProjectV1,
  type VideoScene,
} from '@oremedia/contracts/video';
import {
  allItemIds,
  contentEndMs,
  findItem,
  isTimedTrack,
  lengthOf,
  previousAdjacent,
  sortByStart,
  spanOf,
  type TimedItem,
} from './time';

/** A rejected video operation: stable code plus a sentence a person can act on. */
export class VideoOperationError extends Error {
  readonly code: string;
  readonly op: VideoOperation['op'];
  constructor(code: string, op: VideoOperation['op'], message?: string) {
    super(message ?? `${op}: ${code}`);
    this.name = 'VideoOperationError';
    this.code = code;
    this.op = op;
  }
}

/** What the reducer knows about sources (the service resolves it from asset versions; the editor from the library). */
export type VideoMediaLookup = Readonly<
  Record<string, Pick<VideoMediaInfo, 'kind' | 'durationMs' | 'hasAudio'>>
>;

export interface VideoReduceContext {
  media?: VideoMediaLookup;
  /** Server: a source the lookup does not know is an error. The editor checks only what it knows. */
  strictMedia?: boolean;
}

type Op = VideoOperation;
type Fail = (code: string, message: string) => never;

const failer =
  (op: Op['op']): Fail =>
  (code, message) => {
    throw new VideoOperationError(code, op, message);
  };

function trackOf(project: VideoProjectV1, trackId: string, fail: Fail): Track {
  const t = project.tracks.find((x) => x.id === trackId);
  if (!t) return fail('track_not_found', `There is no track ${trackId}`);
  return t;
}

function itemOf(track: Track, itemId: string, fail: Fail): { item: TrackItem; index: number } {
  const index = (track.items as TrackItem[]).findIndex((i) => i.id === itemId);
  if (index < 0) return fail('item_not_found', `There is no item ${itemId} on ${track.name}`);
  return { item: track.items[index] as TrackItem, index };
}

const assertTrackUnlocked = (track: Track, fail: Fail) => {
  if (track.locked) fail('track_locked', `${track.name} is locked; unlock the track to change it`);
};
const assertItemUnlocked = (track: Track, item: TrackItem, fail: Fail) => {
  assertTrackUnlocked(track, fail);
  if (item.locked) fail('item_locked', 'This item is locked; unlock it to change it');
};

const describe = (item: TrackItem): string => ('name' in item && item.name ? `"${item.name}"` : 'item');

/** Sets the track's items (kept sorted by start time). Mutates `track` of the cloned project. */
function setItems(track: Track, items: TrackItem[]): void {
  (track as { items: TrackItem[] }).items = sortByStart(items);
}

/** Ripple: every item starting at or after `fromMs` (except `exceptId`) moves by `delta`; locked items refuse it. */
function shiftFrom(track: Track, fromMs: number, delta: number, exceptId: string | null, fail: Fail): void {
  if (delta === 0) return;
  const items = (track.items as TrackItem[]).map((i) => {
    if (i.id === exceptId || i.startMs < fromMs) return i;
    if (i.locked)
      fail('locked_item_would_move', `A locked ${describe(i)} would move; unlock it or edit without ripple`);
    const startMs = i.startMs + delta;
    if (startMs < 0) fail('before_zero', 'An item would move before the start of the timeline');
    return 'endMs' in i ? { ...i, startMs, endMs: i.endMs + delta } : { ...i, startMs };
  });
  setItems(track, items);
}

/** Grows the project to fit what was placed past its end (never shrinks; setDuration does that). */
function fitDuration(project: VideoProjectV1, fail: Fail): void {
  const end = contentEndMs(project);
  if (end > VIDEO_PROJECT_MAX_DURATION_MS)
    fail(
      'duration_exceeds_max',
      `The project would last ${(end / 1000).toFixed(1)} s; a video lasts at most ${VIDEO_PROJECT_MAX_DURATION_MS / 1000} s`,
    );
  if (end > project.durationMs) project.durationMs = end;
}

/** A source the item may use: a video track takes video or image, an audio track audio (or a video's sound). */
function checkSource(track: Track, item: TimedItem, ctx: VideoReduceContext, fail: Fail): void {
  if (item.sourceOutMs <= item.sourceInMs)
    fail('source_range_empty', 'The clip must end after it starts (source out after source in)');
  if (lengthOf(item) < VIDEO_MIN_ITEM_MS)
    fail('item_too_short', `An item lasts at least ${VIDEO_MIN_ITEM_MS} ms`);
  const media = ctx.media?.[item.assetVersionId];
  if (!media) {
    if (ctx.strictMedia) fail('media_unknown', 'The clip source is not an asset this brand can use');
    return;
  }
  if (track.kind === 'video' && media.kind === 'audio')
    fail('source_kind_mismatch', 'An audio file goes on an audio track, not the video track');
  if (track.kind === 'audio' && media.kind === 'image')
    fail('source_kind_mismatch', 'An image goes on the video track, not an audio track');
  if (track.kind === 'audio' && media.kind === 'video' && !media.hasAudio)
    fail('source_has_no_audio', 'That video has no sound to use on an audio track');
  if (media.kind !== 'image' && media.durationMs !== null && item.sourceOutMs > media.durationMs)
    fail(
      'beyond_source',
      `The clip ends at ${(item.sourceOutMs / 1000).toFixed(2)} s but the source lasts ${(media.durationMs / 1000).toFixed(2)} s`,
    );
}

/**
 * The track invariants after an operation: items inside the project and not too short; no overlap on video and
 * audio tracks; transitions at most half of the clip and of the clip before it; audio fades within the item.
 */
function checkTrack(project: VideoProjectV1, track: Track, fail: Fail): void {
  const items = track.items as TrackItem[];
  for (const i of items) {
    const s = spanOf(i);
    if (s.endMs - s.startMs < VIDEO_MIN_ITEM_MS)
      fail('item_too_short', `An item lasts at least ${VIDEO_MIN_ITEM_MS} ms`);
    if (s.endMs > project.durationMs) fail('beyond_duration', 'An item would end after the end of the video');
  }
  if (isTimedTrack(track)) {
    const sorted = sortByStart(items as TimedItem[]);
    for (let k = 1; k < sorted.length; k++) {
      const prev = sorted[k - 1] as TimedItem;
      const cur = sorted[k] as TimedItem;
      if (prev.startMs + lengthOf(prev) > cur.startMs)
        fail(
          'overlap',
          `Items cannot overlap on ${track.name}; move it to free time, or use ripple to push later items`,
        );
    }
  }
  if (track.kind === 'video')
    for (const clip of track.items) {
      const t = clip.transitionIn;
      if (!t || t.kind === 'cut' || t.durationMs === 0) continue;
      const prev = previousAdjacent(track.items, clip);
      const limit = Math.min(lengthOf(clip), prev ? lengthOf(prev) : Infinity) / 2;
      if (t.durationMs > limit)
        fail(
          'transition_too_long',
          `A transition lasts at most half of each clip it joins (${Math.floor(limit)} ms here); shorten it first`,
        );
    }
  if (track.kind === 'audio')
    for (const a of track.items)
      if (a.fadeInMs + a.fadeOutMs > lengthOf(a))
        fail('fades_too_long', 'Fade in and fade out together must fit in the item');
  if (track.kind === 'overlay')
    for (const o of track.items) {
      const anim =
        (o.enter?.kind === 'none' ? 0 : (o.enter?.durationMs ?? 0)) +
        (o.exit?.kind === 'none' ? 0 : (o.exit?.durationMs ?? 0));
      if (anim > o.endMs - o.startMs)
        fail('animation_too_long', 'The enter and exit animations must fit in the overlay');
    }
}

function checkScenes(project: VideoProjectV1, fail: Fail): void {
  const sorted = [...project.scenes].sort((a, b) => a.startMs - b.startMs);
  for (const [k, s] of sorted.entries()) {
    if (s.endMs <= s.startMs) fail('scene_empty', 'A scene must end after it starts');
    if (s.endMs > project.durationMs) fail('scene_beyond_duration', 'A scene would end after the video');
    const prev = sorted[k - 1];
    if (prev && prev.endMs > s.startMs) fail('scene_overlap', 'Scenes cannot overlap');
  }
  project.scenes = sorted;
}

/** Item shapes by track kind: an insert names the track; the item is read as that track's item. */
function asTrackItem(track: Track, raw: unknown, fail: Fail): TimedItem {
  if (track.kind === 'video') return VideoClipItemSchema.parse(raw);
  if (track.kind === 'audio') return AudioItemSchema.parse(raw);
  return fail('track_kind_mismatch', `Clips go on the video or an audio track, not on ${track.name}`);
}

const uniqueId = (project: VideoProjectV1, id: string, fail: Fail) => {
  if (allItemIds(project).includes(id)) fail('duplicate_item_id', `Item id ${id} is already used`);
};

/** Places an item on a track: ripple pushes later items right by its length; without ripple it must fit. */
function place(track: Track, item: TrackItem, ripple: boolean, fail: Fail): void {
  if (ripple && isTimedTrack(track)) {
    const len = spanOf(item).endMs - spanOf(item).startMs;
    shiftFrom(track, item.startMs, len, null, fail);
  }
  setItems(track, [...(track.items as TrackItem[]), item]);
}

/** Takes an item off its track; ripple pulls later items left by its length. */
function lift(track: Track, item: TrackItem, ripple: boolean, fail: Fail): void {
  setItems(
    track,
    (track.items as TrackItem[]).filter((i) => i.id !== item.id),
  );
  if (ripple && isTimedTrack(track)) {
    const s = spanOf(item);
    shiftFrom(track, s.endMs, -(s.endMs - s.startMs), null, fail);
  }
}

/**
 * The pure timeline reducer: `next = reduceVideo(project, op)`. Never mutates its input; throws
 * VideoOperationError with a stable code when the operation is not possible on this project.
 */
export function reduceVideo(
  project: VideoProjectV1,
  op: VideoOperation,
  ctx: VideoReduceContext = {},
): VideoProjectV1 {
  const next: VideoProjectV1 = structuredClone(project);
  const fail: Fail = failer(op.op);
  const touched = new Set<string>();
  const sources: Array<{ track: Track; item: TimedItem }> = [];
  const finish = () => {
    for (const s of sources) checkSource(s.track, s.item, ctx, fail);
    fitDuration(next, fail);
    for (const t of next.tracks) if (touched.has(t.id)) checkTrack(next, t, fail);
    checkScenes(next, fail);
    return next;
  };

  switch (op.op) {
    case 'insertClip': {
      const track = trackOf(next, op.trackId, fail);
      assertTrackUnlocked(track, fail);
      const item = asTrackItem(track, op.item, fail);
      uniqueId(next, item.id, fail);
      place(track, item, op.ripple ?? false, fail);
      touched.add(track.id);
      sources.push({ track, item });
      return finish();
    }
    case 'moveClip': {
      const from = trackOf(next, op.trackId, fail);
      const { item } = itemOf(from, op.itemId, fail);
      assertItemUnlocked(from, item, fail);
      const to = op.toTrackId ? trackOf(next, op.toTrackId, fail) : from;
      if (to.kind !== from.kind)
        fail('track_kind_mismatch', `A ${from.kind} item can only move to another ${from.kind} track`);
      assertTrackUnlocked(to, fail);
      const ripple = (op.ripple ?? false) && isTimedTrack(from);
      const s = spanOf(item);
      lift(from, item, ripple, fail);
      const moved: TrackItem =
        'endMs' in item
          ? { ...item, startMs: op.startMs, endMs: op.startMs + (s.endMs - s.startMs) }
          : { ...item, startMs: op.startMs };
      place(to, moved, ripple, fail);
      touched.add(from.id).add(to.id);
      if (to.id !== from.id && isTimedTrack(to)) sources.push({ track: to, item: moved as TimedItem });
      return finish();
    }
    case 'trimClip': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      if (!isTimedTrack(track) || !('sourceInMs' in item))
        fail('not_a_clip', 'Only clips and audio are trimmed; change an overlay or caption by its times');
      assertItemUnlocked(track, item, fail);
      const clip = item as TimedItem;
      const oldEnd = clip.startMs + lengthOf(clip);
      const trimmed: TimedItem = {
        ...clip,
        sourceInMs: op.sourceInMs,
        sourceOutMs: op.sourceOutMs,
        startMs: op.ripple ? clip.startMs : clip.startMs + (op.sourceInMs - clip.sourceInMs),
      };
      if (trimmed.startMs < 0)
        fail('before_zero', 'Trimming the start this far would move the clip before the start of the video');
      setItems(
        track,
        (track.items as TrackItem[]).map((i) => (i.id === clip.id ? trimmed : i)),
      );
      if (op.ripple) shiftFrom(track, oldEnd, lengthOf(trimmed) - lengthOf(clip), clip.id, fail);
      touched.add(track.id);
      sources.push({ track, item: trimmed });
      return finish();
    }
    case 'splitClip': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      if (!isTimedTrack(track) || !('sourceInMs' in item))
        fail('not_a_clip', 'Only clips and audio can be split');
      assertItemUnlocked(track, item, fail);
      uniqueId(next, op.newItemId, fail);
      const clip = item as TimedItem;
      const end = clip.startMs + lengthOf(clip);
      if (op.atMs < clip.startMs + VIDEO_MIN_ITEM_MS || op.atMs > end - VIDEO_MIN_ITEM_MS)
        fail(
          'split_outside_clip',
          `Split at least ${VIDEO_MIN_ITEM_MS} ms inside the clip (move the playhead onto it)`,
        );
      const cut = clip.sourceInMs + (op.atMs - clip.startMs);
      let first: TimedItem = { ...clip, sourceOutMs: cut };
      let second: TimedItem = { ...clip, id: op.newItemId, startMs: op.atMs, sourceInMs: cut };
      if ('transitionIn' in second) {
        const { transitionIn: _t, ...rest } = second as VideoClipItem;
        second = rest as VideoClipItem;
      }
      if ('fadeOutMs' in first && 'fadeInMs' in second) {
        first = { ...first, fadeOutMs: 0 } as AudioItem;
        second = { ...second, fadeInMs: 0 } as AudioItem;
      }
      setItems(track, [...(track.items as TrackItem[]).filter((i) => i.id !== clip.id), first, second]);
      touched.add(track.id);
      return finish();
    }
    case 'duplicateClip': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      assertTrackUnlocked(track, fail);
      uniqueId(next, op.newItemId, fail);
      const s = spanOf(item);
      const copy: TrackItem =
        'endMs' in item
          ? {
              ...structuredClone(item),
              id: op.newItemId,
              startMs: s.endMs,
              endMs: s.endMs + (s.endMs - s.startMs),
              locked: false,
            }
          : { ...structuredClone(item), id: op.newItemId, startMs: s.endMs, locked: false };
      if ('transitionIn' in copy) delete (copy as Partial<VideoClipItem>).transitionIn;
      place(track, copy, op.ripple ?? false, fail);
      touched.add(track.id);
      return finish();
    }
    case 'removeClip':
    case 'removeCaption':
    case 'removeOverlay': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      if (op.op === 'removeCaption' && track.kind !== 'caption')
        fail('track_kind_mismatch', 'removeCaption works on a caption track');
      if (op.op === 'removeOverlay' && track.kind !== 'overlay')
        fail('track_kind_mismatch', 'removeOverlay works on an overlay track');
      assertItemUnlocked(track, item, fail);
      lift(track, item, op.op === 'removeClip' && (op.ripple ?? false), fail);
      touched.add(track.id);
      return finish();
    }
    case 'replaceClipSource': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      if (!isTimedTrack(track) || !('sourceInMs' in item))
        fail('not_a_clip', 'Only clips and audio have a source to replace');
      assertItemUnlocked(track, item, fail);
      const clip = item as TimedItem;
      const inMs = op.sourceInMs ?? 0;
      const replaced: TimedItem = {
        ...clip,
        assetVersionId: op.assetVersionId,
        sourceInMs: inMs,
        sourceOutMs: inMs + lengthOf(clip),
      };
      setItems(
        track,
        (track.items as TrackItem[]).map((i) => (i.id === clip.id ? replaced : i)),
      );
      touched.add(track.id);
      sources.push({ track, item: replaced });
      return finish();
    }
    case 'setClipFrame': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      if (track.kind !== 'video') fail('not_a_video_clip', 'Framing applies to clips on the video track');
      assertItemUnlocked(track, item, fail);
      setItems(
        track,
        (track.items as TrackItem[]).map((i) => (i.id === item.id ? { ...i, frame: op.frame } : i)),
      );
      return finish();
    }
    case 'setTransition': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      if (track.kind !== 'video') fail('not_a_video_clip', 'Transitions join clips on the video track');
      assertItemUnlocked(track, item, fail);
      const clip = { ...(item as VideoClipItem) };
      if (!op.transition || op.transition.kind === 'cut' || op.transition.durationMs === 0)
        delete clip.transitionIn;
      else {
        if (!previousAdjacent(track.items, clip))
          fail(
            'transition_without_neighbour',
            'A transition joins this clip to the clip that ends where it starts; there is none',
          );
        clip.transitionIn = op.transition;
      }
      setItems(
        track,
        (track.items as TrackItem[]).map((i) => (i.id === clip.id ? clip : i)),
      );
      touched.add(track.id);
      return finish();
    }
    case 'setAudio': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      if (!isTimedTrack(track)) fail('not_a_clip', 'Sound settings apply to clips and audio');
      assertItemUnlocked(track, item, fail);
      if (track.kind === 'video' && (op.fadeInMs !== undefined || op.fadeOutMs !== undefined))
        fail('fades_on_audio_items_only', 'Fades apply to items on audio tracks');
      const patch = Object.fromEntries(
        (['gainDb', 'muted', 'fadeInMs', 'fadeOutMs'] as const)
          .filter((k) => op[k] !== undefined)
          .map((k) => [k, op[k]]),
      );
      setItems(
        track,
        (track.items as TrackItem[]).map((i) => (i.id === item.id ? { ...i, ...patch } : i)),
      );
      touched.add(track.id);
      return finish();
    }
    case 'upsertCaption': {
      const track = trackOf(next, op.trackId, fail);
      if (track.kind !== 'caption') fail('track_kind_mismatch', 'Captions go on a caption track');
      assertTrackUnlocked(track, fail);
      const existing = (track.items as CaptionItem[]).find((c) => c.id === op.caption.id);
      if (existing) {
        if (existing.locked) fail('item_locked', 'This caption is locked; unlock it to change it');
        if (op.caption.locked !== existing.locked)
          fail('lock_by_lock_op', 'Lock or unlock a caption with the lock control');
      } else uniqueId(next, op.caption.id, fail);
      if (op.caption.endMs <= op.caption.startMs) fail('item_empty', 'A caption must end after it starts');
      setItems(track, [...(track.items as CaptionItem[]).filter((c) => c.id !== op.caption.id), op.caption]);
      touched.add(track.id);
      return finish();
    }
    case 'setCaptionStyle': {
      const track = trackOf(next, op.trackId, fail);
      if (track.kind !== 'caption') fail('track_kind_mismatch', 'Caption style belongs to a caption track');
      assertTrackUnlocked(track, fail);
      track.style = op.style;
      return finish();
    }
    case 'setOverlay': {
      const track = trackOf(next, op.trackId, fail);
      if (track.kind !== 'overlay') fail('track_kind_mismatch', 'Overlays go on an overlay track');
      assertTrackUnlocked(track, fail);
      const existing = (track.items as OverlayItem[]).find((o) => o.id === op.overlay.id);
      if (existing) {
        if (existing.locked) fail('item_locked', 'This overlay is locked; unlock it to change it');
        if (op.overlay.locked !== existing.locked)
          fail('lock_by_lock_op', 'Lock or unlock an overlay with the lock control');
      } else uniqueId(next, op.overlay.id, fail);
      if (op.overlay.endMs <= op.overlay.startMs) fail('item_empty', 'An overlay must end after it starts');
      setItems(track, [...(track.items as OverlayItem[]).filter((o) => o.id !== op.overlay.id), op.overlay]);
      touched.add(track.id);
      return finish();
    }
    case 'setTrackLock': {
      const track = trackOf(next, op.trackId, fail);
      track.locked = op.locked;
      return finish();
    }
    case 'setTrackMute': {
      const track = trackOf(next, op.trackId, fail);
      if (!isTimedTrack(track))
        fail('not_a_sound_track', 'Only the video and audio tracks have sound to mute');
      assertTrackUnlocked(track, fail);
      track.muted = op.muted;
      return finish();
    }
    case 'setItemLock': {
      const track = trackOf(next, op.trackId, fail);
      const { item } = itemOf(track, op.itemId, fail);
      assertTrackUnlocked(track, fail);
      setItems(
        track,
        (track.items as TrackItem[]).map((i) => (i.id === item.id ? { ...i, locked: op.locked } : i)),
      );
      return finish();
    }
    case 'setDuration': {
      const end = Math.max(contentEndMs(next), ...next.scenes.map((s) => s.endMs));
      if (op.durationMs < end)
        fail(
          'content_beyond_duration',
          `Items run until ${(end / 1000).toFixed(2)} s; trim or remove them before shortening the video`,
        );
      next.durationMs = op.durationMs;
      return finish();
    }
    case 'setScene': {
      const others = next.scenes.filter((s) => s.id !== op.scene.id);
      if (others.length === next.scenes.length && next.scenes.length >= 30)
        fail('too_many_scenes', 'A video has at most 30 scenes');
      next.scenes = [...others, op.scene];
      return finish();
    }
    case 'removeScene': {
      if (!next.scenes.some((s) => s.id === op.sceneId))
        fail('scene_not_found', `There is no scene ${op.sceneId}`);
      next.scenes = next.scenes.filter((s) => s.id !== op.sceneId);
      return finish();
    }
    case 'reorderScenes':
      reorderScenes(next, op.order, fail);
      for (const t of next.tracks) touched.add(t.id);
      return finish();
    case 'addTrack': {
      if (next.tracks.length >= VIDEO_MAX_TRACKS)
        fail('too_many_tracks', `A video has at most ${VIDEO_MAX_TRACKS} tracks`);
      if (next.tracks.some((t) => t.id === op.track.id))
        fail('duplicate_track_id', `Track id ${op.track.id} is already used`);
      if (op.track.kind === 'video' && next.tracks.some((t) => t.kind === 'video'))
        fail('one_video_track', 'A video has one picture track; add clips to it');
      const track = structuredClone(op.track);
      for (const i of track.items as TrackItem[]) uniqueId(next, i.id, fail);
      const ids = (track.items as TrackItem[]).map((i) => i.id);
      if (new Set(ids).size !== ids.length) fail('duplicate_item_id', 'Item ids must be unique');
      setItems(track, track.items as TrackItem[]);
      const index = op.index === undefined ? next.tracks.length : Math.min(op.index, next.tracks.length);
      next.tracks.splice(index, 0, track);
      touched.add(track.id);
      if (isTimedTrack(track)) for (const i of track.items) sources.push({ track, item: i });
      return finish();
    }
    case 'removeTrack': {
      const track = trackOf(next, op.trackId, fail);
      assertTrackUnlocked(track, fail);
      if (track.kind === 'video') fail('video_track_required', 'The picture track cannot be removed');
      if ((track.items as TrackItem[]).some((i) => i.locked))
        fail('item_locked', 'The track holds locked items; unlock them first');
      next.tracks = next.tracks.filter((t) => t.id !== track.id);
      return finish();
    }
  }
}

/**
 * Scenes are rearranged back to back, in the new order, from where the first scene starts; every item that lies in a
 * scene moves with it. The scenes must be contiguous and no item may straddle a scene boundary.
 */
function reorderScenes(project: VideoProjectV1, order: string[], fail: Fail): void {
  const sorted = [...project.scenes].sort((a, b) => a.startMs - b.startMs);
  const byId = new Map(sorted.map((s) => [s.id, s]));
  if (
    order.length !== sorted.length ||
    new Set(order).size !== order.length ||
    order.some((id) => !byId.has(id))
  )
    fail('scene_order_mismatch', 'Name every scene exactly once');
  for (let k = 1; k < sorted.length; k++)
    if ((sorted[k - 1] as VideoScene).endMs !== (sorted[k] as VideoScene).startMs)
      fail('scenes_not_contiguous', 'Scenes can be reordered when each starts where the previous ends');
  const origin = sorted[0]?.startMs ?? 0;
  const deltas = new Map<string, number>();
  let at = origin;
  for (const id of order) {
    const s = byId.get(id) as VideoScene;
    deltas.set(id, at - s.startMs);
    at += s.endMs - s.startMs;
  }
  const sceneOf = (startMs: number, endMs: number): VideoScene | null => {
    for (const s of sorted) {
      if (startMs >= s.startMs && endMs <= s.endMs) return s;
      if (startMs < s.endMs && endMs > s.startMs)
        fail('item_crosses_scene', 'An item crosses a scene boundary; split or move it first');
    }
    return null;
  };
  for (const track of project.tracks) {
    const items = (track.items as TrackItem[]).map((i) => {
      const span = spanOf(i);
      const scene = sceneOf(span.startMs, span.endMs);
      const delta = scene ? (deltas.get(scene.id) ?? 0) : 0;
      if (delta === 0) return i;
      if (i.locked || track.locked)
        fail('locked_item_would_move', `A locked ${describe(i)} would move; unlock it first`);
      return 'endMs' in i
        ? { ...i, startMs: i.startMs + delta, endMs: i.endMs + delta }
        : { ...i, startMs: i.startMs + delta };
    });
    setItems(track, items);
  }
  project.scenes = order.map((id) => {
    const s = byId.get(id) as VideoScene;
    const d = deltas.get(id) ?? 0;
    return { ...s, startMs: s.startMs + d, endMs: s.endMs + d };
  });
}

/** Applies a batch in order and checks the schema bounds of the result (the service also parses it). */
export function applyVideoBatch(
  project: VideoProjectV1,
  batch: Pick<VideoOperationBatch, 'operations'>,
  ctx: VideoReduceContext = {},
): VideoProjectV1 {
  let next = project;
  for (const op of batch.operations) next = reduceVideo(next, op, ctx);
  return VideoProjectSchema.parse(next);
}

/** Item ids an operation changes (for rebasing and for highlighting pending edits). */
export function videoOpItemIds(op: VideoOperation): string[] {
  switch (op.op) {
    case 'insertClip':
      return [op.item.id];
    case 'splitClip':
    case 'duplicateClip':
      return [op.itemId, op.newItemId];
    case 'upsertCaption':
      return [op.caption.id];
    case 'setOverlay':
      return [op.overlay.id];
    case 'addTrack':
      return (op.track.items as TrackItem[]).map((i) => i.id);
    default:
      return 'itemId' in op ? [op.itemId] : [];
  }
}

export { findItem };
