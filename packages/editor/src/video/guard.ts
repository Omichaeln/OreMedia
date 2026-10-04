import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type {
  OverlayItem,
  Track,
  TrackItem,
  VideoOperation,
  VideoProjectV1,
} from '@oremedia/contracts/video';
import type { VideoAiScope } from '@oremedia/contracts/video-ai';
import { canonicalJson } from '@oremedia/domain/canonical-json';
import { videoFormatOf } from './overlays';
import { findItem, spanOf } from './time';

export interface VideoAgentGuardOptions {
  /**
   * STU-3 assembly: the brand's primary logo version and its minimum width (from the published logo rules). A
   * model-planned assembly may place it, protected, as the brand's rules say: at least that wide, inside the safe
   * area, and no other logo in the same scene. Any other logo, or this one placed otherwise, is still refused.
   */
  brandLogo?: { assetVersionId: string; minWidthPx: number };
}

/** The brand-logo exception's placement rules, enforced here (not left to validation findings). */
function assertBrandLogoPlacement(
  project: VideoProjectV1,
  overlay: OverlayItem,
  rule: NonNullable<VideoAgentGuardOptions['brandLogo']>,
): void {
  const { x, y, width, height, rotation } = overlay.element.transform;
  if (width < rule.minWidthPx)
    throw new PolicyDeniedError(
      'agent_logo_insert',
      `The brand's logo must be at least ${rule.minWidthPx} px wide (logo rules); it was not placed`,
    );
  const f = videoFormatOf(project);
  const safe = f.safeArea;
  if (
    rotation !== 0 ||
    x < safe.left ||
    y < safe.top ||
    x + width > f.width - safe.right ||
    y + height > f.height - safe.bottom
  )
    throw new PolicyDeniedError(
      'agent_logo_insert',
      "The brand's logo must sit upright inside the format's safe area; it was not placed",
    );
  const scene = project.scenes.find((sc) => overlay.startMs >= sc.startMs && overlay.startMs < sc.endMs);
  const span = scene ?? { startMs: overlay.startMs, endMs: overlay.endMs };
  const other = project.tracks
    .flatMap((t) => (t.kind === 'overlay' ? t.items : []))
    .find(
      (o) =>
        o.id !== overlay.id && o.element.type === 'logo' && o.startMs < span.endMs && o.endMs > span.startMs,
    );
  if (other)
    throw new PolicyDeniedError(
      'agent_logo_insert',
      `There is already a logo in ${scene ? `scene "${scene.title}"` : 'that time'} (${other.id}); one logo per scene`,
    );
}

/**
 * STU-3: the same protected overlay at another time: element, length and animations unchanged. A recut that
 * shortens the picture keeps the brand's end card on the last seconds this way; the logo itself (asset, placement,
 * size, appearance) is never touched, and an agent still cannot lengthen, shorten, remove or add it.
 */
function isRetime(existing: OverlayItem, next: OverlayItem): boolean {
  const strip = (o: OverlayItem) => {
    const { startMs: _s, endMs: _e, ...rest } = o;
    return canonicalJson(rest);
  };
  return existing.endMs - existing.startMs === next.endMs - next.startMs && strip(existing) === strip(next);
}

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
 * cannot be changed, resized, moved in the frame or removed by an agent (STU-3: they may be retimed, unchanged), and
 * agents cannot add logo overlays (logos are placed from approved assets by a person). That covers edits that would
 * move them as a side effect: a scene reorder that moves a scene holding one, and a ripple edit on an overlay track
 * holding one. People are not limited here.
 */
export function guardVideoAgent(
  project: VideoProjectV1,
  op: VideoOperation,
  origin: 'user' | 'agent',
  opts: VideoAgentGuardOptions = {},
): void {
  if (origin !== 'agent') return;
  if (op.op === 'setTrackLock' || op.op === 'setItemLock')
    throw new PolicyDeniedError('agent_lock_change', 'Agents cannot lock or unlock tracks or items');
  if (op.op === 'setOverlay' && op.overlay.element.type === 'logo') {
    const existing = findItem(project, op.overlay.id);
    const brandLogo =
      opts.brandLogo !== undefined &&
      op.overlay.element.assetVersionId === opts.brandLogo.assetVersionId &&
      op.overlay.element.protected;
    if (!existing && !brandLogo)
      throw new PolicyDeniedError(
        'agent_logo_insert',
        'Agents cannot add logo overlays; logos are placed from approved assets by a person',
      );
    if (!existing && opts.brandLogo) assertBrandLogoPlacement(project, op.overlay, opts.brandLogo);
  }
  const id = op.op === 'setOverlay' ? op.overlay.id : 'itemId' in op ? op.itemId : null;
  if (id) {
    const found = findItem(project, id);
    if (found && 'element' in found.item) {
      const existing = found.item as OverlayItem;
      if (isProtected(existing) && !(op.op === 'setOverlay' && isRetime(existing, op.overlay)))
        throw new PolicyDeniedError('protected_element', `Agents cannot change protected overlay ${id}`);
    }
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

// ---- STU-3: scope and lock respect for agent edits ------------------------------------------------------------

/**
 * The scope an agent batch is held to, resolved against the project the batch starts from: the item ids it may
 * change (grown by the items an in-scope operation creates, e.g. the second half of a split) and, for a scene, its
 * span (new items may be created inside it). `null` is the whole timeline.
 */
export interface VideoScopeState {
  label: string;
  ids: Set<string>;
  sceneId: string | null;
  span: { startMs: number; endMs: number } | null;
}

/** The scope as the guard reads it; unknown items or scenes are refused (the request named something absent). */
export function videoScopeOf(project: VideoProjectV1, scope: VideoAiScope | null): VideoScopeState | null {
  if (!scope || scope.kind === 'timeline') return null;
  if (scope.kind === 'items') {
    for (const id of scope.itemIds)
      if (!findItem(project, id))
        throw new PolicyDeniedError('out_of_scope', `The selected item ${id} is not on the timeline`);
    return { label: 'the selected items', ids: new Set(scope.itemIds), sceneId: null, span: null };
  }
  const scene = project.scenes.find((s) => s.id === scope.sceneId);
  if (!scene) throw new PolicyDeniedError('out_of_scope', `There is no scene ${scope.sceneId}`);
  const ids = new Set<string>();
  for (const t of project.tracks)
    for (const i of t.items as TrackItem[]) {
      const s = spanOf(i);
      if (s.startMs >= scene.startMs && s.endMs <= scene.endMs) ids.add(i.id);
    }
  return {
    label: `scene "${scene.title}"`,
    ids,
    sceneId: scene.id,
    span: { startMs: scene.startMs, endMs: scene.endMs },
  };
}

/** Operations that change a track or the scene order: only an agent working on the whole timeline may make them. */
const TIMELINE_ONLY: ReadonlySet<VideoOperation['op']> = new Set([
  'addTrack',
  'removeTrack',
  'setCaptionStyle',
  'setTrackMute',
  'reorderScenes',
]);

const lockedTarget = (project: VideoProjectV1, op: VideoOperation): string | null => {
  const trackId = 'trackId' in op ? op.trackId : null;
  const track = trackId ? project.tracks.find((t) => t.id === trackId) : undefined;
  if (track?.locked) return `track ${track.name}`;
  const id =
    op.op === 'upsertCaption'
      ? op.caption.id
      : op.op === 'setOverlay'
        ? op.overlay.id
        : 'itemId' in op
          ? op.itemId
          : null;
  const found = id ? findItem(project, id) : null;
  if (found?.item.locked) return `item ${id}`;
  if (op.op === 'moveClip' && op.toTrackId) {
    const to = project.tracks.find((t) => t.id === op.toTrackId);
    if (to?.locked) return `track ${to.name}`;
  }
  return null;
};

/**
 * guardVideoAgent plus the STU-3 scope rule, before the reducer: locks are binding for agents with a policy error
 * of their own (not only the reducer's), and track or scene-order changes need the whole timeline in scope.
 */
export function guardVideoAgentScoped(
  project: VideoProjectV1,
  op: VideoOperation,
  origin: 'user' | 'agent',
  scope: VideoScopeState | null,
  opts: VideoAgentGuardOptions = {},
): void {
  guardVideoAgent(project, op, origin, opts);
  if (origin !== 'agent') return;
  const locked = lockedTarget(project, op);
  if (locked)
    throw new PolicyDeniedError('locked', `The ${locked} is locked; agents never change locked work`);
  if (scope && TIMELINE_ONLY.has(op.op))
    throw new PolicyDeniedError(
      'out_of_scope',
      `${op.op} changes the whole timeline; the request is limited to ${scope.label}`,
    );
}

const sameExceptTime = (a: TrackItem, b: TrackItem): boolean => {
  const sa = spanOf(a);
  const sb = spanOf(b);
  if (sa.endMs - sa.startMs !== sb.endMs - sb.startMs) return false;
  const strip = (i: TrackItem) => {
    const { startMs: _s, ...rest } = i as TrackItem & { endMs?: number };
    if ('endMs' in rest) delete (rest as { endMs?: number }).endMs;
    return canonicalJson(rest);
  };
  return strip(a) === strip(b);
};

/**
 * After the reducer: every item the operation changed outside the scope must only have moved in time (a ripple
 * shift, same content and length); nothing outside it is removed or created, except inside the scoped scene and the
 * pieces of an in-scope split. Scene bounds may change for the scoped scene or a scene holding an in-scope item;
 * other scenes only shift. Items an in-scope operation creates join the scope.
 */
export function guardVideoScopeChange(
  before: VideoProjectV1,
  after: VideoProjectV1,
  op: VideoOperation,
  scope: VideoScopeState | null,
): void {
  if (!scope) return;
  const deny = (what: string): never => {
    throw new PolicyDeniedError('out_of_scope', `${what}; the request is limited to ${scope.label}`);
  };
  const items = (p: VideoProjectV1) =>
    new Map(p.tracks.flatMap((t) => (t.items as TrackItem[]).map((i) => [i.id, i] as const)));
  const trackOf = (p: VideoProjectV1) =>
    new Map(p.tracks.flatMap((t) => (t.items as TrackItem[]).map((i) => [i.id, t.id] as const)));
  const was = items(before);
  const now = items(after);
  const wasTrack = trackOf(before);
  const nowTrack = trackOf(after);
  if (op.op === 'splitClip' && scope.ids.has(op.itemId)) scope.ids.add(op.newItemId);
  for (const [id, item] of now) {
    const prev = was.get(id);
    if (!prev) {
      const s = spanOf(item);
      const inScene = scope.span && s.startMs >= scope.span.startMs && s.endMs <= scope.span.endMs;
      if (scope.ids.has(id) || inScene) scope.ids.add(id);
      else deny(`It would add ${id}`);
      continue;
    }
    if (scope.ids.has(id)) continue;
    if (wasTrack.get(id) !== nowTrack.get(id)) deny(`It would move ${id} to another track`);
    if (canonicalJson(prev) === canonicalJson(item)) continue;
    if (!sameExceptTime(prev, item)) deny(`It would change ${id}`);
  }
  for (const id of was.keys()) if (!now.has(id) && !scope.ids.has(id)) deny(`It would remove ${id}`);
  const scenesBefore = new Map(before.scenes.map((s) => [s.id, s]));
  for (const s of after.scenes) {
    const prev = scenesBefore.get(s.id);
    if (prev && prev.startMs === s.startMs && prev.endMs === s.endMs && prev.title === s.title) continue;
    if (s.id === scope.sceneId) continue;
    const holdsScoped = prev
      ? [...scope.ids].some((id) => {
          const i = was.get(id);
          if (!i) return false;
          const span = spanOf(i);
          return span.startMs >= prev.startMs && span.endMs <= prev.endMs;
        })
      : false;
    if (holdsScoped) continue;
    if (!prev || prev.title !== s.title || prev.endMs - prev.startMs !== s.endMs - s.startMs)
      deny(`It would change scene ${s.id}`);
  }
  for (const s of before.scenes)
    if (!after.scenes.some((x) => x.id === s.id) && s.id !== scope.sceneId)
      deny(`It would remove scene ${s.id}`);
}
