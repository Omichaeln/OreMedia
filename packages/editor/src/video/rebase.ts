import type { VideoOperation } from '@oremedia/contracts/video';
import { videoOpItemIds } from './reduce';

/**
 * Spec 21.4 for timelines: on STALE_REVISION the editor re-applies its local operations to the new head when they do
 * not touch what the other side touched. Conflicts are: the same item; a ripple (or scene reorder, track add/remove)
 * on a track against anything on that track; and the same project-level setting (duration, scenes, a track's lock,
 * mute or caption style). Operations are intents, so a non-conflicting local operation applies unchanged.
 */
export interface VideoRebaseConflict {
  key: string;
  localOp: VideoOperation;
  remoteOp: VideoOperation;
}
export type VideoRebaseResult =
  { ok: true; operations: VideoOperation[] } | { ok: false; conflicts: VideoRebaseConflict[] };

interface Footprint {
  items: string[];
  /** Tracks the operation reshapes as a whole (ripple, reorder, track add/remove). */
  wholeTracks: string[];
  /** Tracks it touches at all. */
  tracks: string[];
  settings: string[];
}

function footprint(op: VideoOperation): Footprint {
  const items = videoOpItemIds(op);
  const tracks: string[] = [];
  if ('trackId' in op) tracks.push(op.trackId);
  if (op.op === 'moveClip' && op.toTrackId) tracks.push(op.toTrackId);
  if (op.op === 'addTrack') tracks.push(op.track.id);
  const ripple = 'ripple' in op && op.ripple === true;
  const wholeTracks =
    ripple || op.op === 'addTrack' || op.op === 'removeTrack'
      ? [...tracks]
      : op.op === 'reorderScenes'
        ? ['*']
        : [];
  const settings: string[] = [];
  if (op.op === 'setDuration') settings.push('duration');
  if (op.op === 'setScene' || op.op === 'removeScene' || op.op === 'reorderScenes') settings.push('scenes');
  if (op.op === 'setTrackLock') settings.push(`lock:${op.trackId}`);
  if (op.op === 'setTrackMute') settings.push(`mute:${op.trackId}`);
  if (op.op === 'setCaptionStyle') settings.push(`style:${op.trackId}`);
  return { items, wholeTracks, tracks, settings };
}

function clash(a: Footprint, b: Footprint): string | null {
  const item = a.items.find((id) => b.items.includes(id));
  if (item) return `item:${item}`;
  const setting = a.settings.find((s) => b.settings.includes(s));
  if (setting) return setting;
  const whole = (x: Footprint, y: Footprint) =>
    x.wholeTracks.includes('*')
      ? (y.tracks[0] ?? y.items[0] ?? null)
      : (x.wholeTracks.find((t) => y.tracks.includes(t)) ?? null);
  const t = whole(a, b) ?? whole(b, a);
  return t ? `track:${t}` : null;
}

export function rebaseVideoBatch(
  localOps: VideoOperation[],
  serverOpsSinceBase: VideoOperation[][],
): VideoRebaseResult {
  const remote = serverOpsSinceBase.flat().map((op) => ({ op, fp: footprint(op) }));
  const conflicts: VideoRebaseConflict[] = [];
  for (const localOp of localOps) {
    const fp = footprint(localOp);
    for (const r of remote) {
      const key = clash(fp, r.fp);
      if (key) {
        conflicts.push({ key, localOp, remoteOp: r.op });
        break;
      }
    }
  }
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, operations: localOps.map((op) => structuredClone(op)) };
}
