import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type { OverlayItem, VideoOperation, VideoProjectV1 } from '@oremedia/contracts/video';
import { findItem } from './time';

/**
 * Agent guards for timelines (architecture principle 2): locks bind everyone through the reducer, and an agent may
 * never lock or unlock anything (locks are a person's decision); protected overlays (logos, `protected` elements)
 * cannot be changed, moved or removed by an agent, and agents cannot add logo overlays (logos are placed from
 * approved assets by a person). People are not limited here.
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
    if (found && 'element' in found.item) {
      const el = (found.item as OverlayItem).element;
      if (el.protected || el.type === 'logo')
        throw new PolicyDeniedError('protected_element', `Agents cannot change protected overlay ${id}`);
    }
  }
  if (op.op === 'removeTrack') {
    const track = project.tracks.find((t) => t.id === op.trackId);
    if (
      track?.kind === 'overlay' &&
      track.items.some((o) => o.element.protected || o.element.type === 'logo')
    )
      throw new PolicyDeniedError(
        'protected_element',
        'Agents cannot remove a track holding protected overlays',
      );
  }
}
