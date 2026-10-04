import {
  VIDEO_MIN_ITEM_MS,
  type AudioItem,
  type Track,
  type TrackItem,
  type VideoClipItem,
  type VideoMediaInfo,
  type VideoProjectV1,
} from '@oremedia/contracts/video';
import { lengthOf, spanOf } from '@oremedia/editor';
import { newElementId } from '../../../lib/ids';
import { timecode } from './timecode';
import type { VideoIntent } from './video-state';

/**
 * The timeline studio's edits as operation intents (the timeline, the inspector, the list editor and the keyboard
 * all build them here, so every path makes the same operation). Item ids are minted like element ids.
 */
export const newItemId = (): string => newElementId();

export function itemLabel(item: TrackItem): string {
  if ('text' in item) return `Caption “${item.text.length > 24 ? `${item.text.slice(0, 23)}…` : item.text}”`;
  if ('element' in item)
    return item.element.type === 'text'
      ? `Title “${item.element.text.slice(0, 24)}”`
      : item.element.name || 'Overlay';
  return item.name ?? ('fadeInMs' in item ? 'Audio' : 'Clip');
}

/** Split at the playhead, or null when the playhead is not far enough inside a clip or audio item. */
export function splitIntent(track: Track, item: TrackItem, atMs: number): VideoIntent | null {
  if (!('sourceInMs' in item)) return null;
  const s = spanOf(item);
  if (atMs < s.startMs + VIDEO_MIN_ITEM_MS || atMs > s.endMs - VIDEO_MIN_ITEM_MS) return null;
  return {
    operations: [
      { op: 'splitClip', trackId: track.id, itemId: item.id, atMs: Math.round(atMs), newItemId: newItemId() },
    ],
    summary: `Split ${itemLabel(item)} at ${timecode(atMs)}`,
  };
}

/** A copy right after the item; clips and audio push later items along (ripple). */
export const duplicateIntent = (track: Track, item: TrackItem): VideoIntent => ({
  operations: [
    {
      op: 'duplicateClip',
      trackId: track.id,
      itemId: item.id,
      newItemId: newItemId(),
      ripple: 'sourceInMs' in item,
    },
  ],
  summary: `Duplicate ${itemLabel(item)}`,
});

export function removeIntent(track: Track, item: TrackItem, ripple: boolean): VideoIntent {
  const op =
    track.kind === 'caption'
      ? ({ op: 'removeCaption', trackId: track.id, itemId: item.id } as const)
      : track.kind === 'overlay'
        ? ({ op: 'removeOverlay', trackId: track.id, itemId: item.id } as const)
        : ({ op: 'removeClip', trackId: track.id, itemId: item.id, ripple } as const);
  return { operations: [op], summary: `Remove ${itemLabel(item)}${ripple ? ' and close the gap' : ''}` };
}

/** Where a new item of `lengthMs` goes on a track: at the playhead when that time is free, else after the last item. */
export function placeOnTrack(track: Track, playheadMs: number, lengthMs: number): number {
  const items = track.items as TrackItem[];
  const free = (start: number) =>
    items.every((i) => {
      const s = spanOf(i);
      return start + lengthMs <= s.startMs || start >= s.endMs;
    });
  if (free(playheadMs)) return playheadMs;
  return items.reduce((end, i) => Math.max(end, spanOf(i).endMs), 0);
}

/** Default length of a still image placed as a clip. */
export const STILL_MS = 3_000;

/** Adds a library asset where it belongs: video and stills to the picture track, audio to the first audio track. */
export function addAssetIntent(
  project: VideoProjectV1,
  asset: Pick<VideoMediaInfo, 'assetVersionId' | 'kind' | 'durationMs'> & { name: string },
  playheadMs: number,
): VideoIntent | { error: string } {
  const room = 180_000;
  if (asset.kind === 'audio') {
    const track = project.tracks.find((t) => t.kind === 'audio');
    if (!track) return { error: 'Add an audio track first' };
    const len = Math.min(asset.durationMs ?? STILL_MS, room);
    const item: AudioItem = {
      id: newItemId(),
      name: asset.name.slice(0, 80),
      assetVersionId: asset.assetVersionId,
      sourceInMs: 0,
      sourceOutMs: len,
      startMs: placeOnTrack(track, playheadMs, len),
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      muted: false,
      locked: false,
    };
    return {
      operations: [{ op: 'insertClip', trackId: track.id, item }],
      summary: `Add ${item.name ?? 'audio'}`,
    };
  }
  const track = project.tracks.find((t) => t.kind === 'video');
  if (!track) return { error: 'The video has no picture track' };
  const len = asset.kind === 'image' ? STILL_MS : Math.min(asset.durationMs ?? STILL_MS, room);
  const item: VideoClipItem = {
    id: newItemId(),
    name: asset.name.slice(0, 80),
    assetVersionId: asset.assetVersionId,
    sourceInMs: 0,
    sourceOutMs: len,
    startMs: placeOnTrack(track, playheadMs, len),
    frame: { fit: 'fill', focalX: 0.5, focalY: 0.5, zoom: 1 },
    gainDb: 0,
    muted: false,
    locked: false,
  };
  return {
    operations: [{ op: 'insertClip', trackId: track.id, item }],
    summary: `Add ${item.name ?? 'clip'}`,
  };
}

/** A new caption at the playhead (2.5 s, or what fits before the end), with words to replace. */
export function addCaptionIntent(
  project: VideoProjectV1,
  playheadMs: number,
): VideoIntent | { error: string } {
  const track = project.tracks.find((t) => t.kind === 'caption');
  if (!track) return { error: 'This video has no caption track (the brand has no caption font)' };
  const startMs = Math.min(playheadMs, project.durationMs - VIDEO_MIN_ITEM_MS);
  const endMs = Math.min(project.durationMs, startMs + 2_500);
  return {
    operations: [
      {
        op: 'upsertCaption',
        trackId: track.id,
        caption: { id: newItemId(), startMs, endMs, text: 'New caption', locked: false },
      },
    ],
    summary: 'Add a caption',
  };
}

/** A title overlay at the playhead in the caption font and colour (a starting point to restyle in the inspector). */
export function addTitleIntent(project: VideoProjectV1, playheadMs: number): VideoIntent | { error: string } {
  const track = project.tracks.find((t) => t.kind === 'overlay');
  const captions = project.tracks.find((t) => t.kind === 'caption');
  if (!track) return { error: 'Add an overlay track first' };
  if (!captions || captions.kind !== 'caption') return { error: 'The brand has no font to set a title in' };
  const W = project.format.width;
  const startMs = Math.min(playheadMs, project.durationMs - VIDEO_MIN_ITEM_MS);
  return {
    operations: [
      {
        op: 'setOverlay',
        trackId: track.id,
        overlay: {
          id: newItemId(),
          startMs,
          endMs: Math.min(project.durationMs, startMs + 3_000),
          enter: { kind: 'fade', durationMs: 300 },
          locked: false,
          element: {
            id: newElementId(),
            name: 'Title',
            type: 'text',
            locked: false,
            visible: true,
            opacity: 1,
            protected: false,
            semanticRole: 'headline',
            transform: {
              x: Math.round(W * 0.08),
              y: Math.round(project.format.height * 0.18),
              width: Math.round(W * 0.84),
              height: Math.round(project.format.height * 0.12),
              rotation: 0,
            },
            text: 'Your title',
            factRefs: [],
            style: {
              typeRole: 'heading',
              fontAssetVersionId: captions.style.fontAssetVersionId,
              weight: 700,
              sizePx: Math.round(W * 0.07),
              lineHeight: 1.1,
              tracking: 0,
              ...(captions.style.colourToken
                ? { colourToken: captions.style.colourToken }
                : { colourValue: captions.style.colourValue ?? '#ffffff' }),
              align: 'center',
              overflow: 'shrink_to_fit',
            },
          },
        },
      },
    ],
    summary: 'Add a title',
  };
}

/** Why a transition cannot be set on a clip, or null when it can. */
export function transitionBlocked(track: Track, item: TrackItem): string | null {
  if (track.kind !== 'video' || !('sourceInMs' in item)) return 'Transitions join clips on the video track';
  const prev = (track.items as VideoClipItem[]).find(
    (o) => o.id !== item.id && o.startMs + lengthOf(o) === item.startMs,
  );
  if (!prev) return 'No clip ends where this one starts; move it against the previous clip first';
  return null;
}
