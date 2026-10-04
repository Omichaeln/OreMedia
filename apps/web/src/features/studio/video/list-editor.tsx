import type { Track, TrackItem, VideoProjectV1 } from '@oremedia/contracts/video';
import { lengthOf, spanOf } from '@oremedia/editor';
import { Button, cn } from '@oremedia/ui';
import { timecode } from './timecode';
import { itemLabel } from './video-actions';
import type { VideoIntent, VideoSelection } from './video-state';

/**
 * The narrow-screen editor: every track as a list in time order, each item a button that selects it (the inspector
 * below it then offers every operation), with move-earlier/later for clips (a ripple move that swaps it with its
 * neighbour), and the track's lock and mute. Nothing the timeline can do is out of reach here.
 */
export function ListEditor({
  project,
  selection,
  readOnly,
  onSelect,
  onIntent,
  inspector,
}: {
  project: VideoProjectV1;
  selection: VideoSelection | null;
  readOnly: boolean;
  onSelect: (s: VideoSelection | null) => void;
  onIntent: (i: VideoIntent) => boolean;
  inspector: React.ReactNode;
}) {
  const reorder = (track: Track, item: TrackItem, by: -1 | 1) => {
    if (!('sourceInMs' in item)) return;
    const sorted = [...(track.items as TrackItem[])].sort((a, b) => a.startMs - b.startMs);
    const k = sorted.findIndex((i) => i.id === item.id);
    const other = sorted[k + by];
    if (!other) return;
    // Earlier: take the neighbour's start; later: end where the neighbour ends.
    const startMs = by < 0 ? other.startMs : spanOf(other).endMs - lengthOf(item);
    onIntent({
      operations: [
        { op: 'moveClip', trackId: track.id, itemId: item.id, startMs: Math.max(0, startMs), ripple: true },
      ],
      summary: `Move ${itemLabel(item)} ${by < 0 ? 'earlier' : 'later'}`,
    });
  };
  return (
    <div className="flex flex-col gap-3" data-testid="list-editor">
      {project.tracks.map((track) => {
        const items = [...(track.items as TrackItem[])].sort((a, b) => a.startMs - b.startMs);
        return (
          <section
            key={track.id}
            aria-label={track.name}
            className="flex flex-col gap-1 rounded-md border border-border p-2"
          >
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{track.name}</h3>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={track.locked}
                  disabledReason={readOnly ? 'Read only' : undefined}
                  onClick={() =>
                    onIntent({
                      operations: [{ op: 'setTrackLock', trackId: track.id, locked: !track.locked }],
                      summary: `${track.locked ? 'Unlock' : 'Lock'} ${track.name}`,
                    })
                  }
                >
                  {track.locked ? 'Unlock track' : 'Lock track'}
                </Button>
                {(track.kind === 'video' || track.kind === 'audio') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={track.muted}
                    disabledReason={
                      readOnly ? 'Read only' : track.locked ? 'Unlock the track first' : undefined
                    }
                    onClick={() =>
                      onIntent({
                        operations: [{ op: 'setTrackMute', trackId: track.id, muted: !track.muted }],
                        summary: `${track.muted ? 'Unmute' : 'Mute'} ${track.name}`,
                      })
                    }
                  >
                    {track.muted ? 'Unmute' : 'Mute'}
                  </Button>
                )}
              </span>
            </header>
            {items.length === 0 && <p className="text-xs text-muted-foreground">Empty</p>}
            <ol className="flex flex-col gap-1">
              {items.map((item, k) => {
                const s = spanOf(item);
                const selected = selection?.itemId === item.id;
                return (
                  <li
                    key={item.id}
                    className={cn(
                      'flex flex-col gap-1 rounded-sm border border-border p-1',
                      selected && 'ring-2 ring-ring',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        className="flex-1 truncate text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-pressed={selected}
                        onClick={() => onSelect(selected ? null : { trackId: track.id, itemId: item.id })}
                        data-testid="list-item"
                        data-item-id={item.id}
                      >
                        {item.locked && <span aria-hidden="true">🔒 </span>}
                        {itemLabel(item)}{' '}
                        <span className="text-xs text-muted-foreground">
                          {timecode(s.startMs)}–{timecode(s.endMs)}
                        </span>
                      </button>
                      {'sourceInMs' in item && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Move ${itemLabel(item)} earlier`}
                            disabledReason={
                              readOnly
                                ? 'Read only'
                                : k === 0
                                  ? 'Already first'
                                  : item.locked
                                    ? 'Unlock it first'
                                    : undefined
                            }
                            onClick={() => reorder(track, item, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Move ${itemLabel(item)} later`}
                            disabledReason={
                              readOnly
                                ? 'Read only'
                                : k === items.length - 1
                                  ? 'Already last'
                                  : item.locked
                                    ? 'Unlock it first'
                                    : undefined
                            }
                            onClick={() => reorder(track, item, 1)}
                          >
                            ↓
                          </Button>
                        </>
                      )}
                    </div>
                    {selected && <div className="border-t border-border pt-2">{inspector}</div>}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
