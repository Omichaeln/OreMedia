import type {
  AudioItem,
  CaptionItem,
  OverlayItem,
  Track,
  TrackItem,
  VideoClipItem,
  VideoProjectV1,
} from '@oremedia/contracts/video';

/**
 * Timeline arithmetic shared by the reducer, the validator, the preview player and the compositor, so the editor
 * and the export agree on every boundary. Timeline times are integer milliseconds; renders snap them to the frame
 * grid with frameOf (round half up), so a boundary always lands on the same frame whatever precedes it.
 */

/** The frame a timeline time falls on at `fps` (nearest frame; ties go up). */
export const frameOf = (ms: number, fps: number): number => Math.floor((ms * fps) / 1000 + 0.5);
/** The time of a frame at `fps`, in (fractional) milliseconds. */
export const msOfFrame = (frame: number, fps: number): number => (frame * 1000) / fps;
/** One frame, rounded to whole milliseconds (the keyboard nudge of the timeline). */
export const frameMs = (fps: number): number => Math.round(1000 / fps);

export type TimedItem = VideoClipItem | AudioItem;
export const isTimedTrack = (t: Track): t is Extract<Track, { kind: 'video' | 'audio' }> =>
  t.kind === 'video' || t.kind === 'audio';

/** Length on the timeline of a source-trimmed item. */
export const lengthOf = (item: TimedItem): number => item.sourceOutMs - item.sourceInMs;

/** [start, end) of any item. */
export function spanOf(item: TrackItem): { startMs: number; endMs: number } {
  if ('sourceInMs' in item) return { startMs: item.startMs, endMs: item.startMs + lengthOf(item) };
  return { startMs: item.startMs, endMs: item.endMs };
}

/** End of the last item on any track (0 for an empty project). */
export function contentEndMs(project: VideoProjectV1): number {
  let end = 0;
  for (const t of project.tracks)
    for (const i of t.items as TrackItem[]) end = Math.max(end, spanOf(i).endMs);
  return end;
}

export const findTrack = (project: VideoProjectV1, trackId: string): Track | undefined =>
  project.tracks.find((t) => t.id === trackId);

export function findItem(
  project: VideoProjectV1,
  itemId: string,
): { track: Track; item: TrackItem; index: number } | null {
  for (const track of project.tracks) {
    const index = (track.items as TrackItem[]).findIndex((i) => i.id === itemId);
    if (index >= 0) return { track, item: track.items[index] as TrackItem, index };
  }
  return null;
}

/** Every item id in the project (ids are unique across tracks). */
export function allItemIds(project: VideoProjectV1): string[] {
  return project.tracks.flatMap((t) => (t.items as TrackItem[]).map((i) => i.id));
}

/** The clip on a video track that ends exactly where `item` starts (the outgoing side of its transition). */
export function previousAdjacent(items: readonly VideoClipItem[], item: VideoClipItem): VideoClipItem | null {
  return items.find((o) => o.id !== item.id && o.startMs + lengthOf(o) === item.startMs) ?? null;
}

/** The clip on a video track that starts exactly where `item` ends. */
export function nextAdjacent(items: readonly VideoClipItem[], item: VideoClipItem): VideoClipItem | null {
  const end = item.startMs + lengthOf(item);
  return items.find((o) => o.id !== item.id && o.startMs === end) ?? null;
}

/** Items of a track active at `ms` ([start, end)). */
export function activeAt<I extends TrackItem>(items: readonly I[], ms: number): I[] {
  return items.filter((i) => {
    const s = spanOf(i);
    return s.startMs <= ms && ms < s.endMs;
  });
}

export const sortByStart = <I extends TrackItem>(items: I[]): I[] =>
  [...items].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

export type OverlayLike = OverlayItem | CaptionItem;
