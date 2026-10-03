import type { TrackItem, VideoProjectV1 } from '@oremedia/contracts/video';
import type { TimelineChange } from '@oremedia/contracts/video-ai';
import { canonicalJson } from '@oremedia/domain/canonical-json';
import { spanOf } from './time';

/**
 * What changed between two timelines, item by item, for a proposal's diff (STU-3): items added, removed, moved
 * (same content and length, new time), trimmed (new length or source range) or otherwise changed (text, source,
 * framing, transition, sound), plus scene bounds, the project length and the output format. Pure and deterministic:
 * the server stores it with the proposal and the studio draws it.
 */
export function videoTimelineDiff(before: VideoProjectV1, after: VideoProjectV1): TimelineChange[] {
  const out: TimelineChange[] = [];
  const index = (p: VideoProjectV1) => {
    const m = new Map<string, { item: TrackItem; kind: TimelineChange['trackKind'] }>();
    for (const t of p.tracks) for (const i of t.items as TrackItem[]) m.set(i.id, { item: i, kind: t.kind });
    return m;
  };
  const was = index(before);
  const now = index(after);
  const span = (i: TrackItem) => spanOf(i);
  for (const [id, b] of was) {
    const a = now.get(id);
    if (!a) {
      out.push({
        kind: 'removed',
        target: 'item',
        id,
        trackKind: b.kind,
        label: labelOf(b.item, b.kind),
        before: span(b.item),
        after: null,
      });
      continue;
    }
    const kind = changeOf(b.item, a.item);
    if (kind)
      out.push({
        kind,
        target: 'item',
        id,
        trackKind: a.kind,
        label: labelOf(a.item, a.kind),
        before: span(b.item),
        after: span(a.item),
      });
  }
  for (const [id, a] of now)
    if (!was.has(id))
      out.push({
        kind: 'added',
        target: 'item',
        id,
        trackKind: a.kind,
        label: labelOf(a.item, a.kind),
        before: null,
        after: span(a.item),
      });
  const scenesBefore = new Map(before.scenes.map((s) => [s.id, s]));
  const scenesAfter = new Map(after.scenes.map((s) => [s.id, s]));
  for (const [id, s] of scenesBefore) {
    const n = scenesAfter.get(id);
    const was = { startMs: s.startMs, endMs: s.endMs };
    if (!n) out.push({ kind: 'removed', target: 'scene', id, label: s.title, before: was, after: null });
    else if (n.startMs !== s.startMs || n.endMs !== s.endMs || n.title !== s.title)
      out.push({
        kind:
          n.endMs - n.startMs !== s.endMs - s.startMs ? 'trimmed' : n.title !== s.title ? 'changed' : 'moved',
        target: 'scene',
        id,
        label: n.title,
        before: was,
        after: { startMs: n.startMs, endMs: n.endMs },
      });
  }
  for (const [id, n] of scenesAfter)
    if (!scenesBefore.has(id))
      out.push({
        kind: 'added',
        target: 'scene',
        id,
        label: n.title,
        before: null,
        after: { startMs: n.startMs, endMs: n.endMs },
      });
  for (const t of after.tracks)
    if (!before.tracks.some((x) => x.id === t.id))
      out.push({ kind: 'added', target: 'track', id: t.id, label: t.name, before: null, after: null });
  for (const t of before.tracks)
    if (!after.tracks.some((x) => x.id === t.id))
      out.push({ kind: 'removed', target: 'track', id: t.id, label: t.name, before: null, after: null });
  if (before.durationMs !== after.durationMs)
    out.push({
      kind: 'trimmed',
      target: 'duration',
      id: 'duration',
      label: `Length ${(before.durationMs / 1000).toFixed(1)} s → ${(after.durationMs / 1000).toFixed(1)} s`,
      before: { startMs: 0, endMs: before.durationMs },
      after: { startMs: 0, endMs: after.durationMs },
    });
  if (before.format.key !== after.format.key)
    out.push({
      kind: 'changed',
      target: 'format',
      id: 'format',
      label: `Format ${before.format.width}×${before.format.height} → ${after.format.width}×${after.format.height}`,
      before: null,
      after: null,
    });
  return out;
}

function changeOf(b: TrackItem, a: TrackItem): TimelineChange['kind'] | null {
  if (canonicalJson(b) === canonicalJson(a)) return null;
  const sb = spanOf(b);
  const sa = spanOf(a);
  const lengthChanged = sb.endMs - sb.startMs !== sa.endMs - sa.startMs;
  const sourceChanged =
    'sourceInMs' in b &&
    'sourceInMs' in a &&
    (b.sourceInMs !== a.sourceInMs || b.sourceOutMs !== a.sourceOutMs) &&
    b.assetVersionId === a.assetVersionId;
  if (lengthChanged || sourceChanged) return 'trimmed';
  const strip = (i: TrackItem) => {
    const copy = { ...i } as Record<string, unknown>;
    delete copy['startMs'];
    delete copy['endMs'];
    return canonicalJson(copy);
  };
  return strip(b) === strip(a) ? 'moved' : 'changed';
}

function labelOf(item: TrackItem, kind: TimelineChange['trackKind']): string {
  if ('name' in item && item.name) return item.name;
  if ('text' in item) return `Caption “${item.text.slice(0, 40)}”`;
  if ('element' in item) {
    const el = item.element;
    if (el.type === 'text') return `Title “${el.text.slice(0, 40)}”`;
    return el.name || (el.type === 'logo' ? 'Logo' : 'Overlay');
  }
  return kind === 'audio' ? 'Audio' : 'Clip';
}
