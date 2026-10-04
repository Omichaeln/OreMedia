import type {
  CaptionItem,
  OverlayItem,
  Track,
  VideoClipItem,
  VideoOperation,
  VideoProjectV1,
} from '@oremedia/contracts/video';
import { frameMs, lengthOf, previousAdjacent, sortByStart } from './time';

/**
 * What the editor's preview shows at a timeline time, with the compositor's semantics (filter-graph.ts): the picture
 * layers (the clip, or both clips inside a transition window with their opacity and slide offset, frozen at their
 * edge frames past their cut), and the overlays and captions active then. Pure, so the preview and its tests share
 * one statement of the timing rules.
 */
export interface PictureLayer {
  clip: VideoClipItem;
  /** Time in the source to show (ms). */
  sourceMs: number;
  opacity: number;
  /** Horizontal offset as a fraction of the frame width (slide transitions). */
  offsetX: number;
}

const halfMs = (durationMs: number) => durationMs / 2;

/** Bottom to top: the layers to draw at `ms` (empty: black). */
export function pictureLayersAt(project: VideoProjectV1, ms: number): PictureLayer[] {
  const track = project.tracks.find((t): t is Extract<Track, { kind: 'video' }> => t.kind === 'video');
  if (!track) return [];
  const clips = sortByStart(track.items);
  const lastFrame = frameMs(project.format.fps);
  const own = (c: VideoClipItem, t: number): number =>
    Math.min(c.sourceOutMs - lastFrame, Math.max(c.sourceInMs, c.sourceInMs + (t - c.startMs)));
  for (const [k, clip] of clips.entries()) {
    const start = clip.startMs;
    const end = start + lengthOf(clip);
    const next = clips[k + 1];
    const tIn = clip.transitionIn && previousAdjacent(clips, clip) ? clip.transitionIn : undefined;
    const tOut = next?.transitionIn && previousAdjacent(clips, next) === clip ? next.transitionIn : undefined;
    // Inside the transition window into `next` (centred on the cut at `end`).
    if (tOut && tOut.kind !== 'cut' && tOut.durationMs > 0 && next) {
      const h = halfMs(tOut.durationMs);
      if (ms >= end - h && ms < end + h) {
        const p = (ms - (end - h)) / (2 * h);
        if (tOut.kind === 'fade_black') {
          return ms < end
            ? [{ clip, sourceMs: own(clip, ms), opacity: Math.max(0, (end - ms) / h), offsetX: 0 }]
            : [{ clip: next, sourceMs: own(next, ms), opacity: Math.min(1, (ms - end) / h), offsetX: 0 }];
        }
        if (tOut.kind === 'slide')
          return [
            { clip, sourceMs: own(clip, ms), opacity: 1, offsetX: -p },
            { clip: next, sourceMs: own(next, ms), opacity: 1, offsetX: 1 - p },
          ];
        return [
          { clip: next, sourceMs: own(next, ms), opacity: 1, offsetX: 0 },
          { clip, sourceMs: own(clip, ms), opacity: 1 - p, offsetX: 0 },
        ];
      }
    }
    if (ms >= start && ms < end) {
      // The incoming half of this clip's own transition is handled above (as the previous clip's outgoing side).
      if (tIn && tIn.kind !== 'cut' && ms < start + halfMs(tIn.durationMs)) continue;
      return [{ clip, sourceMs: own(clip, ms), opacity: 1, offsetX: 0 }];
    }
  }
  return [];
}

export function activeOverlays(project: VideoProjectV1, ms: number): OverlayItem[] {
  return project.tracks.flatMap((t) =>
    t.kind === 'overlay' ? t.items.filter((o) => o.element.visible && o.startMs <= ms && ms < o.endMs) : [],
  );
}

export function activeCaptions(
  project: VideoProjectV1,
  ms: number,
): Array<{ track: Extract<Track, { kind: 'caption' }>; caption: CaptionItem }> {
  return project.tracks.flatMap((t) =>
    t.kind === 'caption'
      ? t.items.filter((c) => c.startMs <= ms && ms < c.endMs).map((caption) => ({ track: t, caption }))
      : [],
  );
}

/** Operations in one applyVideo batch (contracts VideoOperationBatch). */
const BATCH_MAX = 100;

/**
 * The operations that turn `current` into `target` (restoring an earlier revision as a new one): the picture track's
 * items are replaced, every other track is removed and re-added, the scenes replaced and the duration set. Locked
 * items or tracks cannot be replaced, so a restore over them is refused with the reason (null operations). A large
 * restore is split into `batches` of at most 100 operations, committed in order (each state between them is valid).
 */
export function restoreVideoOps(
  current: VideoProjectV1,
  target: VideoProjectV1,
): { ok: true; operations: VideoOperation[]; batches: VideoOperation[][] } | { ok: false; reason: string } {
  if (current.format.key !== target.format.key || current.format.fps !== target.format.fps)
    return { ok: false, reason: 'The revision has another format; it cannot be restored here' };
  const locked = current.tracks.some(
    (t) => t.locked || (t.items as Array<{ locked: boolean }>).some((i) => i.locked),
  );
  if (locked) return { ok: false, reason: 'Unlock the locked tracks and items first' };
  const ops: VideoOperation[] = [];
  const video = current.tracks.find((t) => t.kind === 'video');
  const targetVideo = target.tracks.find((t) => t.kind === 'video');
  if (!video || !targetVideo || video.kind !== 'video' || targetVideo.kind !== 'video')
    return { ok: false, reason: 'The picture track is missing' };
  for (const c of video.items) ops.push({ op: 'removeClip', trackId: video.id, itemId: c.id });
  for (const t of current.tracks) if (t.kind !== 'video') ops.push({ op: 'removeTrack', trackId: t.id });
  for (const s of current.scenes) ops.push({ op: 'removeScene', sceneId: s.id });
  ops.push({ op: 'setDuration', durationMs: target.durationMs });
  const lockedLater: VideoOperation[] = [];
  for (const c of targetVideo.items) {
    ops.push({ op: 'insertClip', trackId: video.id, item: { ...structuredClone(c), locked: false } });
    if (c.locked) lockedLater.push({ op: 'setItemLock', trackId: video.id, itemId: c.id, locked: true });
  }
  target.tracks.forEach((t, index) => {
    if (t.kind === 'video') return;
    const items = (t.items as Array<{ id: string; locked: boolean }>).map((i) => ({ ...i, locked: false }));
    ops.push({ op: 'addTrack', track: { ...structuredClone(t), locked: false, items } as Track, index });
    for (const i of t.items as Array<{ id: string; locked: boolean }>)
      if (i.locked) lockedLater.push({ op: 'setItemLock', trackId: t.id, itemId: i.id, locked: true });
    if (t.locked) lockedLater.push({ op: 'setTrackLock', trackId: t.id, locked: true });
  });
  if (targetVideo.locked) lockedLater.push({ op: 'setTrackLock', trackId: video.id, locked: true });
  for (const s of target.scenes) ops.push({ op: 'setScene', scene: structuredClone(s) });
  const operations = [...ops, ...lockedLater];
  const batches: VideoOperation[][] = [];
  for (let at = 0; at < operations.length; at += BATCH_MAX)
    batches.push(operations.slice(at, at + BATCH_MAX));
  return { ok: true, operations, batches };
}
