import type {
  CaptionItem,
  OverlayItem,
  TrackItem,
  VideoClipItem,
  VideoOperation,
  VideoOperationBatch,
  VideoProjectV1,
} from '@oremedia/contracts/video';
import { reduceVideo, type VideoReduceContext } from './reduce';
import { findItem, findTrack, spanOf } from './time';

/**
 * Undo for video is a new revision applying the inverse operations (spec 11.4), exactly like graphic documents.
 * Each operation is inverted against the project it was applied to; an operation that grew the project is followed
 * by a setDuration back to the old length. applyVideoBatch(applyVideoBatch(p, batch), inverse) deep-equals p.
 */
export type VideoInvertResult =
  { ok: true; operations: VideoOperation[] } | { ok: false; reason: string; op: VideoOperation['op'] };

const no = (op: VideoOperation['op'], reason: string): VideoInvertResult => ({ ok: false, reason, op });

/** Restores an item exactly: take the current one off (no ripple), put the old one back. */
const restoreItem = (trackId: string, before: TrackItem, currentId = before.id): VideoOperation[] => {
  if ('sourceInMs' in before)
    return [
      { op: 'removeClip', trackId, itemId: currentId },
      { op: 'insertClip', trackId, item: structuredClone(before) },
    ];
  if ('element' in before) return [{ op: 'setOverlay', trackId, overlay: structuredClone(before) }];
  return [{ op: 'upsertCaption', trackId, caption: structuredClone(before as CaptionItem) }];
};

function invertOne(p: VideoProjectV1, op: VideoOperation): VideoOperation[] | VideoInvertResult {
  const located = 'itemId' in op ? findItem(p, op.itemId) : null;
  const needItem = () => (located ? null : no(op.op, 'item_not_found'));
  switch (op.op) {
    case 'insertClip':
      return [{ op: 'removeClip', trackId: op.trackId, itemId: op.item.id, ripple: op.ripple ?? false }];
    case 'moveClip': {
      if (!located) return no(op.op, 'item_not_found');
      return [
        {
          op: 'moveClip',
          trackId: op.toTrackId ?? op.trackId,
          itemId: op.itemId,
          startMs: located.item.startMs,
          ...(op.toTrackId ? { toTrackId: op.trackId } : {}),
          ripple: op.ripple ?? false,
        },
      ];
    }
    case 'trimClip': {
      if (!located || !('sourceInMs' in located.item)) return no(op.op, 'item_not_found');
      const before = located.item;
      if (op.ripple)
        return [
          {
            op: 'trimClip',
            trackId: op.trackId,
            itemId: op.itemId,
            sourceInMs: before.sourceInMs,
            sourceOutMs: before.sourceOutMs,
            ripple: true,
          },
        ];
      return restoreItem(op.trackId, before);
    }
    case 'splitClip':
      if (!located) return no(op.op, 'item_not_found');
      return [
        { op: 'removeClip', trackId: op.trackId, itemId: op.newItemId },
        ...restoreItem(op.trackId, located.item),
      ];
    case 'duplicateClip':
      return [{ op: 'removeClip', trackId: op.trackId, itemId: op.newItemId, ripple: op.ripple ?? false }];
    case 'removeClip': {
      if (!located) return no(op.op, 'item_not_found');
      const before = located.item;
      if ('sourceInMs' in before)
        return [
          {
            op: 'insertClip',
            trackId: op.trackId,
            item: structuredClone(before),
            ripple: op.ripple ?? false,
          },
        ];
      return restoreItem(op.trackId, before);
    }
    case 'removeCaption':
    case 'removeOverlay':
    case 'replaceClipSource':
    case 'setClipFrame':
    case 'setTransition':
    case 'setAudio':
      return needItem() ?? restoreItem(op.trackId, (located as NonNullable<typeof located>).item);
    case 'upsertCaption': {
      const track = findTrack(p, op.trackId);
      const old = track?.kind === 'caption' ? track.items.find((c) => c.id === op.caption.id) : undefined;
      return old
        ? [{ op: 'upsertCaption', trackId: op.trackId, caption: structuredClone(old) }]
        : [{ op: 'removeCaption', trackId: op.trackId, itemId: op.caption.id }];
    }
    case 'setOverlay': {
      const track = findTrack(p, op.trackId);
      const old = track?.kind === 'overlay' ? track.items.find((o) => o.id === op.overlay.id) : undefined;
      return old
        ? [{ op: 'setOverlay', trackId: op.trackId, overlay: structuredClone(old as OverlayItem) }]
        : [{ op: 'removeOverlay', trackId: op.trackId, itemId: op.overlay.id }];
    }
    case 'setCaptionStyle': {
      const track = findTrack(p, op.trackId);
      if (track?.kind !== 'caption') return no(op.op, 'track_not_found');
      return [{ op: 'setCaptionStyle', trackId: op.trackId, style: structuredClone(track.style) }];
    }
    case 'setTrackLock': {
      const track = findTrack(p, op.trackId);
      if (!track) return no(op.op, 'track_not_found');
      return [{ op: 'setTrackLock', trackId: op.trackId, locked: track.locked }];
    }
    case 'setTrackMute': {
      const track = findTrack(p, op.trackId);
      if (!track || !('muted' in track)) return no(op.op, 'track_not_found');
      return [{ op: 'setTrackMute', trackId: op.trackId, muted: track.muted }];
    }
    case 'setItemLock':
      if (!located) return no(op.op, 'item_not_found');
      return [{ op: 'setItemLock', trackId: op.trackId, itemId: op.itemId, locked: located.item.locked }];
    case 'setDuration':
      return [{ op: 'setDuration', durationMs: p.durationMs }];
    case 'setScene': {
      const old = p.scenes.find((s) => s.id === op.scene.id);
      return old
        ? [{ op: 'setScene', scene: structuredClone(old) }]
        : [{ op: 'removeScene', sceneId: op.scene.id }];
    }
    case 'removeScene': {
      const old = p.scenes.find((s) => s.id === op.sceneId);
      if (!old) return no(op.op, 'scene_not_found');
      return [{ op: 'setScene', scene: structuredClone(old) }];
    }
    case 'reorderScenes':
      return [
        {
          op: 'reorderScenes',
          order: [...p.scenes].sort((a, b) => a.startMs - b.startMs).map((s) => s.id),
        },
      ];
    case 'addTrack':
      return [{ op: 'removeTrack', trackId: op.track.id }];
    case 'removeTrack': {
      const index = p.tracks.findIndex((t) => t.id === op.trackId);
      const track = p.tracks[index];
      if (!track) return no(op.op, 'track_not_found');
      return [{ op: 'addTrack', track: structuredClone(track), index }];
    }
  }
}

/** Inverse operations of a batch, in reverse order, each computed against the state it was applied to. */
export function invertVideoBatch(
  before: VideoProjectV1,
  batch: Pick<VideoOperationBatch, 'operations'>,
  ctx: VideoReduceContext = {},
): VideoInvertResult {
  const inverses: VideoOperation[][] = [];
  let current = before;
  for (const op of batch.operations) {
    const inv = invertOne(current, op);
    if (!Array.isArray(inv)) return inv;
    const next = reduceVideo(current, op, ctx);
    // A project that grew is shrunk back after its items are restored.
    inverses.push(
      next.durationMs !== current.durationMs && op.op !== 'setDuration'
        ? [...inv, { op: 'setDuration', durationMs: current.durationMs }]
        : inv,
    );
    current = next;
  }
  return { ok: true, operations: inverses.reverse().flat() };
}

/** The clip's span, exported for the editor's history descriptions. */
export const itemSpan = (item: VideoClipItem | TrackItem) => spanOf(item);
