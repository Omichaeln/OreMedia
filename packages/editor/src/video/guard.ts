import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type { OverlayItem, Track, VideoOperation, VideoProjectV1 } from '@oremedia/contracts/video';
import { findItem } from './time';

const isProtected = (o: OverlayItem): boolean => o.element.protected || o.element.type === 'logo';
const holdsProtected = (track: Track | undefined): boolean =>
  track?.kind === 'overlay' && track.items.some(isProtected);

/** The scenes a reorder moves (their start changes), as the reducer lays them out from the earliest start. */
function movedScenes(project: VideoProjectV1, order: readonly string[]): Set<string> {
  const sorted = [...project.scenes].sort((a, b) => a.startMs - b.startMs);
  const byId = new Map(sorted.map((s) => [s.id, s]));
  const moved = new Set<string>();
  let at = sorted[0]?.startMs ?? 0;
  for (const id of order) {
    const s = byId.get(id);
    if (!s) continue; // the reducer refuses an order that does not name every scene once
    if (s.startMs !== at) moved.add(id);
    at += s.endMs - s.startMs;
  }
  return moved;
}

/**
 * Agent guards for timelines (architecture principle 2): locks bind everyone through the reducer, and an agent may
 * never lock or unlock anything (locks are a person's decision); protected overlays (logos, `protected` elements)
 * cannot be changed, moved or removed by an agent, and agents cannot add logo overlays (logos are placed from
 * approved assets by a person). That covers edits that would move them as a side effect: a scene reorder that moves a
 * scene holding one, and a ripple edit on an overlay track holding one. People are not limited here.
 */
export function guardVideoAgent(project: VideoProjectV1, op: VideoOperation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  if (op.op === 'setTrackLock' || op.op === 'setItemLock')
    throw new PolicyDeniedError('agent_lock_change', 'Agents cannot lock or unlock tracks or items');
  if (op.op === 'setOverlay' && op.overlay.element.type === 'logo') {
    const existing = findItem(project, op.overlay.id);
    if (!existing)
      throw new PolicyDeniedError(
        'agent_logo_insert',
        'Agents cannot add logo overlays; logos are placed from approved assets by a person',
      );
  }
  const id = op.op === 'setOverlay' ? op.overlay.id : 'itemId' in op ? op.itemId : null;
  if (id) {
    const found = findItem(project, id);
    if (found && 'element' in found.item && isProtected(found.item as OverlayItem))
      throw new PolicyDeniedError('protected_element', `Agents cannot change protected overlay ${id}`);
  }
  if (op.op === 'reorderScenes') {
    const movedIds = movedScenes(project, op.order);
    const moved = project.scenes.filter((s) => movedIds.has(s.id));
    const hit = project.tracks
      .flatMap((t) => (t.kind === 'overlay' ? t.items.filter(isProtected) : []))
      .find((o) => moved.some((s) => o.startMs < s.endMs && o.endMs > s.startMs));
    if (hit)
      throw new PolicyDeniedError(
        'protected_element',
        `Agents cannot reorder scenes that would move protected overlay ${hit.id}`,
      );
  }
  if ('ripple' in op && op.ripple && 'trackId' in op) {
    const tracks = [op.trackId, ...('toTrackId' in op && op.toTrackId ? [op.toTrackId] : [])];
    if (tracks.some((id) => holdsProtected(project.tracks.find((t) => t.id === id))))
      throw new PolicyDeniedError(
        'protected_element',
        'Agents cannot make ripple edits on a track holding protected overlays',
      );
  }
  if (op.op === 'removeTrack') {
    const track = project.tracks.find((t) => t.id === op.trackId);
    if (holdsProtected(track))
      throw new PolicyDeniedError(
        'protected_element',
        'Agents cannot remove a track holding protected overlays',
      );
  }
}
