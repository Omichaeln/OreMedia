import { useMemo, useRef, useState } from 'react';
import type { StripMapV1, WaveformV1 } from '@oremedia/contracts/media';
import {
  VIDEO_MIN_ITEM_MS,
  type Track,
  type TrackItem,
  type VideoMediaInfo,
  type VideoOperation,
  type VideoProjectV1,
} from '@oremedia/contracts/video';
import { frameMs, lengthOf, spanOf } from '@oremedia/editor';
import { Button, cn } from '@oremedia/ui';
import type { VideoIntent, VideoSelection } from './video-state';
import type { SourceUrls } from './use-video-media';
import { timecode } from './timecode';
import { itemLabel, splitIntent, duplicateIntent, removeIntent, newItemId } from './video-actions';

export interface TimelineProps {
  project: VideoProjectV1;
  media: Record<string, VideoMediaInfo>;
  urls: Map<string, SourceUrls>;
  selection: VideoSelection | null;
  playheadMs: number;
  pendingItemIds: string[];
  readOnly: boolean;
  onSelect: (s: VideoSelection | null) => void;
  onSeek: (ms: number) => void;
  onIntent: (intent: VideoIntent) => boolean;
}

/** Zoom steps in pixels per second. */
const ZOOMS = [10, 20, 40, 80, 160, 320];
const LANE_H = 56;
const SNAP_PX = 8;

const TRACK_KIND_LABEL: Record<Track['kind'], string> = {
  video: 'Video',
  audio: 'Audio',
  overlay: 'Overlays',
  caption: 'Captions',
};

interface Drag {
  trackId: string;
  itemId: string;
  mode: 'move' | 'trimStart' | 'trimEnd';
  startX: number;
  deltaMs: number;
}

/**
 * The timeline editor: tracks with labels, lock and mute; clips with strip thumbnails and audio with waveforms;
 * zoom, a playhead, snapping to edges, the playhead and scenes; drag to move (dropping a clip onto another inserts
 * it there, rippling), edge handles to trim; and a keyboard path for everything (arrows move the selected item by a
 * frame or, with Shift, a second; [ and ] trim to the playhead; S splits; Ctrl+D duplicates; Delete removes).
 */
export function Timeline(props: TimelineProps) {
  const {
    project,
    media,
    urls,
    selection,
    playheadMs,
    pendingItemIds,
    readOnly,
    onSelect,
    onSeek,
    onIntent,
  } = props;
  const [zoom, setZoom] = useState(2);
  const [snapping, setSnapping] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const pxPerMs = (ZOOMS[zoom] ?? 40) / 1000;
  const frame = frameMs(project.format.fps);
  const width = Math.max(600, Math.ceil(project.durationMs * pxPerMs) + 80);
  const pending = useMemo(() => new Set(pendingItemIds), [pendingItemIds]);

  const edges = useMemo(() => {
    const out = new Set<number>([0, project.durationMs]);
    for (const t of project.tracks)
      for (const i of t.items as TrackItem[]) {
        const s = spanOf(i);
        out.add(s.startMs).add(s.endMs);
      }
    for (const s of project.scenes) out.add(s.startMs).add(s.endMs);
    return [...out];
  }, [project]);
  const snap = (ms: number, exclude: TrackItem): number => {
    const own = spanOf(exclude);
    const candidates = [...edges.filter((e) => e !== own.startMs && e !== own.endMs), playheadMs];
    if (!snapping) return Math.round(ms / frame) * frame;
    let best = ms;
    let bestPx = SNAP_PX;
    for (const c of candidates) {
      const d = Math.abs(c - ms) * pxPerMs;
      if (d < bestPx) {
        best = c;
        bestPx = d;
      }
    }
    return best === ms ? Math.round(ms / frame) * frame : best;
  };

  const find = (trackId: string, itemId: string) => {
    const track = project.tracks.find((t) => t.id === trackId);
    const item = (track?.items as TrackItem[] | undefined)?.find((i) => i.id === itemId);
    return track && item ? { track, item } : null;
  };

  /** The operation a finished drag means (or null for a click). */
  const dragIntent = (d: Drag): VideoIntent | null => {
    const found = find(d.trackId, d.itemId);
    if (!found || Math.abs(d.deltaMs) < 1) return null;
    const { track, item } = found;
    const span = spanOf(item);
    const label = itemLabel(item);
    if (d.mode === 'move') {
      const startMs = Math.max(0, snap(span.startMs + d.deltaMs, item));
      if ('sourceInMs' in item) {
        // Dropped onto another clip of the track: insert there (ripple), which is how clips are reordered.
        const len = lengthOf(item);
        const hit = (track.items as TrackItem[]).find(
          (o) => o.id !== item.id && spanOf(o).startMs < startMs + len && startMs < spanOf(o).endMs,
        );
        if (hit) {
          const target = spanOf(hit).startMs > span.startMs ? spanOf(hit).endMs - len : spanOf(hit).startMs;
          return {
            operations: [
              {
                op: 'moveClip',
                trackId: track.id,
                itemId: item.id,
                startMs: Math.max(0, target),
                ripple: true,
              },
            ],
            summary: `Reorder ${label}`,
          };
        }
      }
      return {
        operations: [{ op: 'moveClip', trackId: track.id, itemId: item.id, startMs }],
        summary: `Move ${label}`,
      };
    }
    if ('sourceInMs' in item) {
      const sourceDuration =
        media[item.assetVersionId]?.kind === 'image'
          ? Infinity
          : (media[item.assetVersionId]?.durationMs ?? Infinity);
      if (d.mode === 'trimStart') {
        const startMs = snap(span.startMs + d.deltaMs, item);
        const sourceInMs = Math.max(
          0,
          Math.min(item.sourceOutMs - VIDEO_MIN_ITEM_MS, item.sourceInMs + (startMs - span.startMs)),
        );
        return {
          operations: [
            { op: 'trimClip', trackId: track.id, itemId: item.id, sourceInMs, sourceOutMs: item.sourceOutMs },
          ],
          summary: `Trim ${label}`,
        };
      }
      const endMs = snap(span.endMs + d.deltaMs, item);
      const sourceOutMs = Math.min(
        sourceDuration,
        Math.max(item.sourceInMs + VIDEO_MIN_ITEM_MS, item.sourceOutMs + (endMs - span.endMs)),
      );
      return {
        operations: [
          { op: 'trimClip', trackId: track.id, itemId: item.id, sourceInMs: item.sourceInMs, sourceOutMs },
        ],
        summary: `Trim ${label}`,
      };
    }
    const startMs =
      d.mode === 'trimStart'
        ? Math.min(span.endMs - VIDEO_MIN_ITEM_MS, snap(span.startMs + d.deltaMs, item))
        : span.startMs;
    const endMs =
      d.mode === 'trimEnd'
        ? Math.max(span.startMs + VIDEO_MIN_ITEM_MS, snap(span.endMs + d.deltaMs, item))
        : span.endMs;
    if ('element' in item)
      return {
        operations: [
          { op: 'setOverlay', trackId: track.id, overlay: { ...item, startMs: Math.max(0, startMs), endMs } },
        ],
        summary: `Retime ${label}`,
      };
    return {
      operations: [
        {
          op: 'upsertCaption',
          trackId: track.id,
          caption: { ...item, startMs: Math.max(0, startMs), endMs },
        },
      ],
      summary: `Retime ${label}`,
    };
  };

  const onPointerDown = (e: React.PointerEvent, trackId: string, item: TrackItem, mode: Drag['mode']) => {
    e.stopPropagation();
    onSelect({ trackId, itemId: item.id });
    if (readOnly || item.locked || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ trackId, itemId: item.id, mode, startX: e.clientX, deltaMs: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, deltaMs: (e.clientX - drag.startX) / pxPerMs });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const intent = dragIntent(drag);
    setDrag(null);
    if (intent) onIntent(intent);
  };

  const keyOnItem = (e: React.KeyboardEvent, track: Track, item: TrackItem) => {
    const step = e.shiftKey ? 1000 : frame;
    const span = spanOf(item);
    const label = itemLabel(item);
    const run = (intent: VideoIntent | null) => {
      e.preventDefault();
      if (intent && !readOnly) onIntent(intent);
    };
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const startMs = Math.max(0, span.startMs + (e.key === 'ArrowLeft' ? -step : step));
      run({
        operations: [{ op: 'moveClip', trackId: track.id, itemId: item.id, startMs }],
        summary: `Move ${label}`,
      });
    } else if (e.key === 'Delete' || e.key === 'Backspace') run(removeIntent(track, item, false));
    else if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) run(duplicateIntent(track, item));
    else if (e.key === 's' || e.key === 'S') run(splitIntent(track, item, playheadMs));
    else if (e.key === '[' || e.key === ']') {
      if (!('sourceInMs' in item)) return;
      e.preventDefault();
      const ops: VideoOperation[] =
        e.key === '['
          ? [
              {
                op: 'trimClip',
                trackId: track.id,
                itemId: item.id,
                sourceInMs: item.sourceInMs + (playheadMs - span.startMs),
                sourceOutMs: item.sourceOutMs,
              },
            ]
          : [
              {
                op: 'trimClip',
                trackId: track.id,
                itemId: item.id,
                sourceInMs: item.sourceInMs,
                sourceOutMs: item.sourceInMs + (playheadMs - span.startMs),
              },
            ];
      if (!readOnly) onIntent({ operations: ops, summary: `Trim ${label} to the playhead` });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onSelect(null);
    }
  };
  const keyOnLanes = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const step = e.shiftKey ? 1000 : frame;
    if (e.key === 'ArrowLeft') onSeek(Math.max(0, playheadMs - step));
    else if (e.key === 'ArrowRight') onSeek(Math.min(project.durationMs - frame, playheadMs + step));
    else if (e.key === 'Home') onSeek(0);
    else if (e.key === 'End') onSeek(project.durationMs - frame);
    else return;
    e.preventDefault();
  };
  const seekFromPointer = (e: React.PointerEvent) => {
    const lane = laneRef.current;
    if (!lane) return;
    const x = e.clientX - lane.getBoundingClientRect().left + lane.scrollLeft;
    onSeek(Math.max(0, Math.min(project.durationMs - frame, x / pxPerMs)));
  };

  const selectedFound = selection ? find(selection.trackId, selection.itemId) : null;
  const tickEvery = pxPerMs * 1000 >= 40 ? 1000 : 5000;
  const ticks = Array.from(
    { length: Math.floor(project.durationMs / tickEvery) + 1 },
    (_, i) => i * tickEvery,
  );

  return (
    <section aria-label="Timeline" className="flex flex-col gap-2" data-testid="timeline">
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Timeline tools">
        <Button
          size="sm"
          onClick={() => setZoom((z) => Math.max(0, z - 1))}
          disabledReason={zoom === 0 ? 'Fully zoomed out' : undefined}
          aria-label="Zoom out"
        >
          −
        </Button>
        <span className="w-16 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {ZOOMS[zoom]} px/s
        </span>
        <Button
          size="sm"
          onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
          disabledReason={zoom === ZOOMS.length - 1 ? 'Fully zoomed in' : undefined}
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={snapping}
          onClick={() => setSnapping((v) => !v)}
          data-testid="snap-toggle"
        >
          Snapping {snapping ? 'on' : 'off'}
        </Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <TimelineItemActions {...props} found={selectedFound} />
      </div>
      <div className="flex min-w-0 rounded-md border border-border">
        <div className="w-36 shrink-0 border-r border-border">
          <div className="h-8 border-b border-border px-2 py-1 text-xs text-muted-foreground">Tracks</div>
          {project.tracks.map((track) => (
            <TrackLabel key={track.id} track={track} readOnly={readOnly} onIntent={onIntent} />
          ))}
        </div>
        <div
          ref={laneRef}
          className="relative min-w-0 flex-1 overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
          onKeyDown={keyOnLanes}
          aria-label={`Timeline lanes; playhead at ${timecode(playheadMs)}. Arrow keys move the playhead a frame, Shift+arrow one second.`}
          data-testid="timeline-lanes"
        >
          <div className="relative" style={{ width }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <div
              className="relative h-8 cursor-pointer border-b border-border bg-muted/40"
              onPointerDown={seekFromPointer}
              data-testid="ruler"
            >
              {project.scenes.map((s) => (
                <div
                  key={s.id}
                  className="absolute top-0 h-3 truncate border-x border-primary/60 bg-primary/15 px-1 text-[10px] leading-3"
                  style={{ left: s.startMs * pxPerMs, width: (s.endMs - s.startMs) * pxPerMs }}
                  title={s.title}
                  data-testid="scene-marker"
                >
                  {s.title}
                </div>
              ))}
              {ticks.map((ms) => (
                <span
                  key={ms}
                  className="absolute bottom-0 border-l border-border pl-0.5 text-[10px] text-muted-foreground"
                  style={{ left: ms * pxPerMs }}
                >
                  {Math.round(ms / 1000)}s
                </span>
              ))}
            </div>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                role="group"
                aria-label={`${track.name} (${TRACK_KIND_LABEL[track.kind]} track)`}
                className="relative border-b border-border"
                style={{ height: LANE_H }}
                onPointerDown={seekFromPointer}
              >
                {(track.items as TrackItem[]).map((item) => {
                  const span = spanOf(item);
                  const d = drag && drag.itemId === item.id ? drag : null;
                  const left =
                    (span.startMs + (d?.mode === 'move' || d?.mode === 'trimStart' ? d.deltaMs : 0)) *
                    pxPerMs;
                  const w = Math.max(
                    6,
                    (span.endMs -
                      span.startMs +
                      (d?.mode === 'trimEnd' ? d.deltaMs : d?.mode === 'trimStart' ? -d.deltaMs : 0)) *
                      pxPerMs,
                  );
                  const selected = selection?.itemId === item.id;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      aria-label={`${itemLabel(item)}, ${timecode(span.startMs)} to ${timecode(span.endMs)}${item.locked ? ', locked' : ''}`}
                      className={cn(
                        'absolute top-1 bottom-1 flex cursor-grab select-none flex-col overflow-hidden rounded-sm border text-left text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        track.kind === 'video' && 'border-primary/50 bg-primary/20',
                        track.kind === 'audio' && 'border-status-good/50 bg-status-good/15',
                        track.kind === 'overlay' && 'border-accent bg-accent/30',
                        track.kind === 'caption' && 'border-status-info/50 bg-status-info/15',
                        selected && 'ring-2 ring-ring',
                        pending.has(item.id) && 'border-dashed',
                        item.locked && 'cursor-not-allowed opacity-80',
                      )}
                      style={{ left, width: w }}
                      onPointerDown={(e) => onPointerDown(e, track.id, item, 'move')}
                      onKeyDown={(e) => keyOnItem(e, track, item)}
                      onFocus={() => onSelect({ trackId: track.id, itemId: item.id })}
                      data-testid="timeline-item"
                      data-item-id={item.id}
                      data-track-kind={track.kind}
                    >
                      {'sourceInMs' in item && track.kind === 'video' && (
                        <Thumbnails
                          url={urls.get(item.assetVersionId)}
                          item={item}
                          widthPx={w}
                          heightPx={LANE_H - 8}
                        />
                      )}
                      {'sourceInMs' in item && track.kind === 'audio' && (
                        <Waveform
                          peaks={urls.get(item.assetVersionId)?.waveform}
                          sourceInMs={item.sourceInMs}
                          sourceOutMs={item.sourceOutMs}
                          widthPx={w}
                          heightPx={LANE_H - 8}
                        />
                      )}
                      <span className="relative z-10 truncate px-1 py-0.5 font-medium [text-shadow:0_0_2px_var(--background)]">
                        {item.locked && <span aria-hidden="true">🔒 </span>}
                        {itemLabel(item)}
                      </span>
                      {'transitionIn' in item && item.transitionIn && item.transitionIn.kind !== 'cut' && (
                        <span
                          className="absolute left-0 top-0 z-10 rounded-br-sm bg-foreground px-1 text-[9px] text-background"
                          aria-hidden="true"
                        >
                          {item.transitionIn.kind.replace('_', ' ')}
                        </span>
                      )}
                      {!item.locked && !readOnly && (
                        <>
                          <span
                            className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize bg-foreground/30"
                            onPointerDown={(e) => onPointerDown(e, track.id, item, 'trimStart')}
                            aria-hidden="true"
                            data-testid="trim-start"
                          />
                          <span
                            className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize bg-foreground/30"
                            onPointerDown={(e) => onPointerDown(e, track.id, item, 'trimEnd')}
                            aria-hidden="true"
                            data-testid="trim-end"
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-status-critical"
              style={{ left: playheadMs * pxPerMs }}
              aria-hidden="true"
              data-testid="playhead"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function TrackLabel({
  track,
  readOnly,
  onIntent,
}: {
  track: Track;
  readOnly: boolean;
  onIntent: (i: VideoIntent) => boolean;
}) {
  return (
    <div
      className="flex flex-col justify-center gap-0.5 border-b border-border px-2"
      style={{ height: LANE_H }}
    >
      <span className="truncate text-xs font-medium">{track.name}</span>
      <span className="flex gap-1">
        <button
          type="button"
          className="rounded-sm border border-border px-1 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-pressed={track.locked}
          aria-label={`${track.locked ? 'Unlock' : 'Lock'} ${track.name}`}
          disabled={readOnly}
          onClick={() =>
            onIntent({
              operations: [{ op: 'setTrackLock', trackId: track.id, locked: !track.locked }],
              summary: `${track.locked ? 'Unlock' : 'Lock'} ${track.name}`,
            })
          }
          data-testid="track-lock"
        >
          {track.locked ? 'Locked' : 'Lock'}
        </button>
        {(track.kind === 'video' || track.kind === 'audio') && (
          <button
            type="button"
            className="rounded-sm border border-border px-1 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            aria-pressed={track.muted}
            aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
            disabled={readOnly || track.locked}
            title={track.locked ? 'Unlock the track to change it' : undefined}
            onClick={() =>
              onIntent({
                operations: [{ op: 'setTrackMute', trackId: track.id, muted: !track.muted }],
                summary: `${track.muted ? 'Unmute' : 'Mute'} ${track.name}`,
              })
            }
            data-testid="track-mute"
          >
            {track.muted ? 'Muted' : 'Mute'}
          </button>
        )}
      </span>
    </div>
  );
}

/** Split, duplicate, remove (with or without closing the gap) for the selected item, disabled with the reason. */
function TimelineItemActions({
  project,
  playheadMs,
  readOnly,
  onIntent,
  onSelect,
  found,
}: TimelineProps & { found: { track: Track; item: TrackItem } | null }) {
  const reason = !found
    ? 'Select an item first'
    : readOnly
      ? 'Read only'
      : found.item.locked || found.track.locked
        ? 'Unlock it first'
        : null;
  const split = found ? splitIntent(found.track, found.item, playheadMs) : null;
  const splitReason =
    reason ??
    (!split
      ? found && 'sourceInMs' in found.item
        ? 'Move the playhead inside the clip'
        : 'Only clips and audio can be split'
      : null);
  return (
    <>
      <Button
        size="sm"
        disabledReason={splitReason ?? undefined}
        onClick={() => split && onIntent(split)}
        data-testid="split"
      >
        Split at playhead
      </Button>
      <Button
        size="sm"
        disabledReason={reason ?? undefined}
        onClick={() => found && onIntent(duplicateIntent(found.track, found.item))}
        data-testid="duplicate"
      >
        Duplicate
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabledReason={reason ?? undefined}
        onClick={() => {
          if (!found) return;
          if (onIntent(removeIntent(found.track, found.item, false))) onSelect(null);
        }}
        data-testid="remove"
      >
        Remove
      </Button>
      <Button
        size="sm"
        disabledReason={
          reason ??
          (found && !('sourceInMs' in found.item) ? 'Only clips and audio leave a gap to close' : undefined)
        }
        onClick={() => {
          if (!found) return;
          if (onIntent(removeIntent(found.track, found.item, true))) onSelect(null);
        }}
        data-testid="ripple-remove"
      >
        Remove and close gap
      </Button>
      <AddTrack project={project} readOnly={readOnly} onIntent={onIntent} />
    </>
  );
}

function AddTrack({
  project,
  readOnly,
  onIntent,
}: {
  project: VideoProjectV1;
  readOnly: boolean;
  onIntent: (i: VideoIntent) => boolean;
}) {
  const full = project.tracks.length >= 8 ? 'A video has at most 8 tracks' : undefined;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={readOnly ? 'Read only' : full}
        onClick={() => {
          const n = project.tracks.filter((t) => t.kind === 'audio').length + 1;
          onIntent({
            operations: [
              {
                op: 'addTrack',
                track: {
                  id: newItemId(),
                  kind: 'audio',
                  name: `Audio ${n}`,
                  locked: false,
                  muted: false,
                  items: [],
                },
              },
            ],
            summary: 'Add an audio track',
          });
        }}
      >
        Add audio track
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabledReason={readOnly ? 'Read only' : full}
        onClick={() => {
          const n = project.tracks.filter((t) => t.kind === 'overlay').length + 1;
          onIntent({
            operations: [
              {
                op: 'addTrack',
                track: { id: newItemId(), kind: 'overlay', name: `Overlays ${n}`, locked: false, items: [] },
              },
            ],
            summary: 'Add an overlay track',
          });
        }}
      >
        Add overlay track
      </Button>
    </>
  );
}

/** Thumbnails from the source's strip sprite: one tile per lane height, each the strip frame nearest its time. */
function Thumbnails({
  url,
  item,
  widthPx,
  heightPx,
}: {
  url: SourceUrls | undefined;
  item: { sourceInMs: number; sourceOutMs: number };
  widthPx: number;
  heightPx: number;
}) {
  const map: StripMapV1 | undefined = url?.stripMap;
  if (!url?.strip || !map || map.frames.length === 0) return null;
  const scale = heightPx / map.frameHeight;
  const tileW = Math.max(16, map.frameWidth * scale);
  const tiles = Math.min(40, Math.ceil(widthPx / tileW));
  const rows = Math.ceil(map.frames.length / map.columns);
  return (
    <div
      className="pointer-events-none absolute inset-0 flex opacity-80"
      aria-hidden="true"
      data-testid="clip-thumbnails"
    >
      {Array.from({ length: tiles }, (_, k) => {
        const t = item.sourceInMs + ((k + 0.5) / tiles) * (item.sourceOutMs - item.sourceInMs);
        const f = map.frames.reduce((best, x) =>
          Math.abs(x.timeMs - t) < Math.abs(best.timeMs - t) ? x : best,
        );
        const col = f.index % map.columns;
        const row = Math.floor(f.index / map.columns);
        return (
          <div
            key={k}
            style={{
              width: tileW,
              height: heightPx,
              flexShrink: 0,
              backgroundImage: `url(${url.strip})`,
              backgroundSize: `${map.columns * map.frameWidth * scale}px ${rows * map.frameHeight * scale}px`,
              backgroundPosition: `${-col * map.frameWidth * scale}px ${-row * map.frameHeight * scale}px`,
            }}
          />
        );
      })}
    </div>
  );
}

/** The source range's peaks as bars, one per two pixels. */
function Waveform({
  peaks,
  sourceInMs,
  sourceOutMs,
  widthPx,
  heightPx,
}: {
  peaks: WaveformV1 | undefined;
  sourceInMs: number;
  sourceOutMs: number;
  widthPx: number;
  heightPx: number;
}) {
  if (!peaks || peaks.peaks.length === 0) return null;
  const bars = Math.max(1, Math.floor(widthPx / 2));
  const pps = peaks.peaksPerSecond;
  const heights = Array.from({ length: bars }, (_, k) => {
    const from = Math.floor(((sourceInMs + (k / bars) * (sourceOutMs - sourceInMs)) / 1000) * pps);
    const to = Math.max(
      from + 1,
      Math.floor(((sourceInMs + ((k + 1) / bars) * (sourceOutMs - sourceInMs)) / 1000) * pps),
    );
    let max = 0;
    for (let i = from; i < to && i < peaks.peaks.length; i++) max = Math.max(max, peaks.peaks[i] ?? 0);
    return (max / 1000) * heightPx;
  });
  return (
    <svg
      className="pointer-events-none absolute inset-0 text-status-good"
      width={widthPx}
      height={heightPx}
      aria-hidden="true"
      data-testid="waveform"
    >
      {heights.map((h, k) => (
        <rect
          key={k}
          x={k * 2}
          y={(heightPx - h) / 2}
          width={1}
          height={Math.max(1, h)}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
