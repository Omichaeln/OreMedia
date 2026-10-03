import { useEffect, useState } from 'react';
import type { CreativeDocumentV1, CreativePage } from '@oremedia/contracts/creative';
import {
  TRANSITION_KINDS,
  type AudioItem,
  type CaptionItem,
  type CaptionTrack,
  type OverlayAnimation,
  type OverlayItem,
  type Track,
  type TrackItem,
  type VideoClipItem,
  type VideoMediaInfo,
  type VideoProjectV1,
} from '@oremedia/contracts/video';
import { applyBatch, type IntentBatch } from '@oremedia/editor';
import { Badge, Button, EmptyState, Field, Input, Textarea } from '@oremedia/ui';
import { Select } from '../../../components/select';
import { PropertiesPanel } from '../properties-panel';
import { parseTimecode, timecode } from './timecode';
import { duplicateIntent, itemLabel, removeIntent, splitIntent, transitionBlocked } from './video-actions';
import type { VideoIntent } from './video-state';

export interface InspectorProps {
  project: VideoProjectV1;
  media: Record<string, VideoMediaInfo>;
  track: Track | null;
  item: TrackItem | null;
  playheadMs: number;
  readOnly: boolean;
  colourTokens: Array<{ key: string; value: string }>;
  /** The library's next pick replaces this clip's source. */
  replacing: boolean;
  onReplace: (on: boolean) => void;
  onIntent: (intent: VideoIntent) => boolean;
  onDeselect: () => void;
}

/** A time field (seconds, or m:ss.cc) that commits on blur or Enter; arrows step a frame, Shift a second. */
export function TimeField({
  id,
  label,
  value,
  disabled,
  onCommit,
  step = 33,
}: {
  id: string;
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (ms: number) => void;
  step?: number;
}) {
  const [draft, setDraft] = useState(timecode(value));
  useEffect(() => setDraft(timecode(value)), [value]);
  const commit = (text = draft) => {
    const ms = parseTimecode(text);
    if (ms === null || ms < 0) return setDraft(timecode(value));
    if (ms !== value) onCommit(ms);
  };
  return (
    <Field label={label} htmlFor={id} hint="Seconds, or m:ss.cc">
      <Input
        id={id}
        value={draft}
        disabled={disabled}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = Math.max(0, value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1000 : step));
            onCommit(next);
          }
        }}
      />
    </Field>
  );
}

function NumberInput({
  id,
  label,
  value,
  min,
  max,
  step,
  disabled,
  hint,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  hint?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < min || n > max) return setDraft(String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <Field label={label} htmlFor={id} {...(hint ? { hint } : {})}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </Field>
  );
}

/**
 * The selected timeline item's settings: a clip's source range, framing (fit or fill, focal point, zoom), transition
 * and sound; an audio item's gain and fades; a caption's words, timing and position; an overlay's timing and
 * animations plus the graphic properties panel for its element. Every control is labelled; what an item cannot do
 * is disabled with the reason.
 */
export function Inspector(props: InspectorProps) {
  const { track, item, readOnly, onIntent } = props;
  if (!track || !item)
    return (
      <EmptyState
        title="Nothing selected"
        description="Select a clip, audio, title or caption on the timeline to edit it. Add clips and audio from the library."
      />
    );
  const locked = readOnly || item.locked || track.locked;
  const lockReason = track.locked ? 'The track is locked' : item.locked ? 'This item is locked' : null;
  return (
    <div className="flex flex-col gap-3" data-testid="inspector">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{itemLabel(item)}</span>
        {item.locked && <Badge tone="neutral">Locked</Badge>}
        {'element' in item && item.element.protected && <Badge tone="info">Protected from agents</Badge>}
      </div>
      {lockReason && <p className="text-xs text-muted-foreground">{lockReason}; unlock it to change it.</p>}
      {track.kind === 'video' && 'frame' in item && (
        <ClipFields {...props} track={track} item={item} locked={locked} />
      )}
      {track.kind === 'audio' && 'fadeInMs' in item && (
        <AudioFields {...props} track={track} item={item as AudioItem} locked={locked} />
      )}
      {track.kind === 'caption' && 'text' in item && (
        <CaptionFields {...props} track={track} item={item} locked={locked} />
      )}
      {track.kind === 'overlay' && 'element' in item && (
        <OverlayFields {...props} track={track} item={item} locked={locked} />
      )}
      <TrackField {...props} track={track} item={item} locked={locked} />
      <div className="flex flex-wrap gap-1 border-t border-border pt-2">
        <Button
          size="sm"
          disabledReason={readOnly ? 'Read only' : track.locked ? 'Unlock the track first' : undefined}
          aria-pressed={item.locked}
          onClick={() =>
            onIntent({
              operations: [{ op: 'setItemLock', trackId: track.id, itemId: item.id, locked: !item.locked }],
              summary: `${item.locked ? 'Unlock' : 'Lock'} ${itemLabel(item)}`,
            })
          }
          data-testid="item-lock"
        >
          {item.locked ? 'Unlock' : 'Lock'}
        </Button>
        <Button
          size="sm"
          disabledReason={locked ? (lockReason ?? 'Read only') : undefined}
          onClick={() => onIntent(duplicateIntent(track, item))}
        >
          Duplicate
        </Button>
        {'sourceInMs' in item && (
          <Button
            size="sm"
            disabledReason={
              locked
                ? (lockReason ?? 'Read only')
                : splitIntent(track, item, props.playheadMs)
                  ? undefined
                  : 'Move the playhead inside the item'
            }
            onClick={() => {
              const i = splitIntent(track, item, props.playheadMs);
              if (i) onIntent(i);
            }}
          >
            Split at playhead
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          disabledReason={locked ? (lockReason ?? 'Read only') : undefined}
          onClick={() => {
            if (onIntent(removeIntent(track, item, false))) props.onDeselect();
          }}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

/**
 * Moves the item to another track of the same kind at the same time (moveClip with toTrackId), so the list editor
 * reaches what dragging between lanes does on the timeline. Shown when there is another such track.
 */
function TrackField({
  project,
  track,
  item,
  locked,
  onIntent,
}: InspectorProps & { track: Track; item: TrackItem; locked: boolean }) {
  const same = project.tracks.filter((t) => t.kind === track.kind);
  if (same.length < 2) return null;
  return (
    <Field label="Track" htmlFor="item-track" hint="Moves it to the other track at the same time">
      <Select
        id="item-track"
        value={track.id}
        disabled={locked}
        onValueChange={(toTrackId) => {
          const target = same.find((t) => t.id === toTrackId);
          if (!target || target.id === track.id) return;
          onIntent({
            operations: [
              { op: 'moveClip', trackId: track.id, itemId: item.id, startMs: item.startMs, toTrackId },
            ],
            summary: `Move ${itemLabel(item)} to ${target.name}`,
          });
        }}
        options={same.map((t) => ({
          value: t.id,
          label: t.locked ? `${t.name} (locked)` : t.name,
          disabled: t.locked && t.id !== track.id,
        }))}
      />
    </Field>
  );
}

function ClipFields({
  media,
  track,
  item,
  locked,
  replacing,
  onReplace,
  onIntent,
}: InspectorProps & { track: Track; item: VideoClipItem; locked: boolean }) {
  const info = media[item.assetVersionId];
  const label = itemLabel(item);
  const one = (op: VideoIntent['operations'][number], summary: string) =>
    onIntent({ operations: [op], summary });
  const frame = item.frame;
  const tBlocked = transitionBlocked(track, item);
  const t = item.transitionIn;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {info?.kind === 'image'
          ? 'Still image'
          : `Source ${info?.durationMs ? timecode(info.durationMs) : 'length unknown'}`}{' '}
        · on the timeline {timecode(item.startMs)} to{' '}
        {timecode(item.startMs + item.sourceOutMs - item.sourceInMs)}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <TimeField
          id="clip-start"
          label="Starts at"
          value={item.startMs}
          disabled={locked}
          onCommit={(startMs) =>
            one({ op: 'moveClip', trackId: track.id, itemId: item.id, startMs }, `Move ${label}`)
          }
        />
        <TimeField
          id="clip-length"
          label="Length"
          value={item.sourceOutMs - item.sourceInMs}
          disabled={locked}
          onCommit={(len) =>
            one(
              {
                op: 'trimClip',
                trackId: track.id,
                itemId: item.id,
                sourceInMs: item.sourceInMs,
                sourceOutMs: item.sourceInMs + len,
              },
              `Trim ${label}`,
            )
          }
        />
        {info?.kind !== 'image' && (
          <>
            <TimeField
              id="clip-in"
              label="Source in"
              value={item.sourceInMs}
              disabled={locked}
              onCommit={(sourceInMs) =>
                one(
                  {
                    op: 'trimClip',
                    trackId: track.id,
                    itemId: item.id,
                    sourceInMs,
                    sourceOutMs: item.sourceOutMs,
                  },
                  `Trim ${label}`,
                )
              }
            />
            <TimeField
              id="clip-out"
              label="Source out"
              value={item.sourceOutMs}
              disabled={locked}
              onCommit={(sourceOutMs) =>
                one(
                  {
                    op: 'trimClip',
                    trackId: track.id,
                    itemId: item.id,
                    sourceInMs: item.sourceInMs,
                    sourceOutMs,
                  },
                  `Trim ${label}`,
                )
              }
            />
          </>
        )}
      </div>
      <fieldset className="flex flex-col gap-2 rounded-md border border-border p-2">
        <legend className="px-1 text-xs font-medium">Framing</legend>
        <Field
          label="Fit"
          htmlFor="clip-fit"
          hint="Fill crops to cover the frame; fit shows the whole picture with black bars."
        >
          <Select
            id="clip-fit"
            value={frame.fit}
            disabled={locked}
            onValueChange={(v) =>
              one(
                {
                  op: 'setClipFrame',
                  trackId: track.id,
                  itemId: item.id,
                  frame: { ...frame, fit: v as 'fill' | 'fit' },
                },
                `Frame ${label}`,
              )
            }
            options={[
              { value: 'fill', label: 'Fill (crop)' },
              { value: 'fit', label: 'Fit (bars)' },
            ]}
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <NumberInput
            id="clip-focal-x"
            label="Focus left–right"
            value={frame.focalX}
            min={0}
            max={1}
            step={0.05}
            disabled={locked}
            onCommit={(focalX) =>
              one(
                { op: 'setClipFrame', trackId: track.id, itemId: item.id, frame: { ...frame, focalX } },
                `Reposition ${label}`,
              )
            }
          />
          <NumberInput
            id="clip-focal-y"
            label="Focus top–bottom"
            value={frame.focalY}
            min={0}
            max={1}
            step={0.05}
            disabled={locked}
            onCommit={(focalY) =>
              one(
                { op: 'setClipFrame', trackId: track.id, itemId: item.id, frame: { ...frame, focalY } },
                `Reposition ${label}`,
              )
            }
          />
          <NumberInput
            id="clip-zoom"
            label="Zoom"
            value={frame.zoom}
            min={1}
            max={4}
            step={0.1}
            disabled={locked}
            onCommit={(zoom) =>
              one(
                { op: 'setClipFrame', trackId: track.id, itemId: item.id, frame: { ...frame, zoom } },
                `Zoom ${label}`,
              )
            }
          />
        </div>
      </fieldset>
      <fieldset
        className="flex flex-col gap-2 rounded-md border border-border p-2"
        aria-describedby={tBlocked ? 'transition-blocked' : undefined}
      >
        <legend className="px-1 text-xs font-medium">Transition in</legend>
        {tBlocked && (
          <p id="transition-blocked" className="text-xs text-muted-foreground">
            {tBlocked}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Kind" htmlFor="clip-transition">
            <Select
              id="clip-transition"
              value={t?.kind ?? 'cut'}
              disabled={locked || tBlocked !== null}
              onValueChange={(kind) =>
                one(
                  {
                    op: 'setTransition',
                    trackId: track.id,
                    itemId: item.id,
                    transition:
                      kind === 'cut'
                        ? null
                        : {
                            kind: kind as (typeof TRANSITION_KINDS)[number],
                            durationMs: t?.durationMs || 500,
                          },
                  },
                  `Transition into ${label}`,
                )
              }
              options={TRANSITION_KINDS.map((k) => ({
                value: k,
                label:
                  k === 'cut'
                    ? 'Cut (none)'
                    : k === 'fade_black'
                      ? 'Fade through black'
                      : k === 'crossfade'
                        ? 'Crossfade'
                        : 'Slide',
              }))}
            />
          </Field>
          <TimeField
            id="clip-transition-length"
            label="Transition length"
            value={t?.durationMs ?? 0}
            disabled={locked || !t || t.kind === 'cut'}
            onCommit={(durationMs) =>
              t &&
              one(
                {
                  op: 'setTransition',
                  trackId: track.id,
                  itemId: item.id,
                  transition: { kind: t.kind, durationMs },
                },
                `Transition into ${label}`,
              )
            }
          />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-md border border-border p-2">
        <legend className="px-1 text-xs font-medium">Sound</legend>
        {info?.kind === 'video' && !info.hasAudio && (
          <p className="text-xs text-muted-foreground">This clip has no sound.</p>
        )}
        <div className="grid grid-cols-2 items-end gap-2">
          <NumberInput
            id="clip-gain"
            label="Gain (dB)"
            value={item.gainDb}
            min={-60}
            max={12}
            step={1}
            disabled={locked || info?.kind !== 'video'}
            onCommit={(gainDb) =>
              one({ op: 'setAudio', trackId: track.id, itemId: item.id, gainDb }, `Gain of ${label}`)
            }
          />
          <Button
            size="sm"
            aria-pressed={item.muted}
            disabledReason={
              locked ? 'Unlock it first' : info?.kind !== 'video' ? 'A still has no sound' : undefined
            }
            onClick={() =>
              one(
                { op: 'setAudio', trackId: track.id, itemId: item.id, muted: !item.muted },
                `${item.muted ? 'Unmute' : 'Mute'} ${label}`,
              )
            }
          >
            {item.muted ? 'Unmute clip' : 'Mute clip'}
          </Button>
        </div>
      </fieldset>
      <Button
        size="sm"
        aria-pressed={replacing}
        disabledReason={locked ? 'Unlock it first' : undefined}
        onClick={() => onReplace(!replacing)}
        data-testid="replace-source"
      >
        {replacing ? 'Cancel replace' : 'Replace source…'}
      </Button>
      {replacing && (
        <p className="text-xs text-muted-foreground" role="status">
          Pick a video or image in the library to replace this clip; it keeps its place and length.
        </p>
      )}
    </>
  );
}

function AudioFields({
  media,
  track,
  item,
  locked,
  replacing,
  onReplace,
  onIntent,
}: InspectorProps & { track: Track; item: AudioItem; locked: boolean }) {
  const info = media[item.assetVersionId];
  const label = itemLabel(item);
  const one = (op: VideoIntent['operations'][number], summary: string) =>
    onIntent({ operations: [op], summary });
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Source {info?.durationMs ? timecode(info.durationMs) : 'length unknown'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <TimeField
          id="audio-start"
          label="Starts at"
          value={item.startMs}
          disabled={locked}
          onCommit={(startMs) =>
            one({ op: 'moveClip', trackId: track.id, itemId: item.id, startMs }, `Move ${label}`)
          }
        />
        <TimeField
          id="audio-length"
          label="Length"
          value={item.sourceOutMs - item.sourceInMs}
          disabled={locked}
          onCommit={(len) =>
            one(
              {
                op: 'trimClip',
                trackId: track.id,
                itemId: item.id,
                sourceInMs: item.sourceInMs,
                sourceOutMs: item.sourceInMs + len,
              },
              `Trim ${label}`,
            )
          }
        />
        <TimeField
          id="audio-in"
          label="Source in"
          value={item.sourceInMs}
          disabled={locked}
          onCommit={(sourceInMs) =>
            one(
              {
                op: 'trimClip',
                trackId: track.id,
                itemId: item.id,
                sourceInMs,
                sourceOutMs: item.sourceOutMs,
              },
              `Trim ${label}`,
            )
          }
        />
        <NumberInput
          id="audio-gain"
          label="Gain (dB)"
          value={item.gainDb}
          min={-60}
          max={12}
          step={1}
          disabled={locked}
          onCommit={(gainDb) =>
            one({ op: 'setAudio', trackId: track.id, itemId: item.id, gainDb }, `Gain of ${label}`)
          }
        />
        <TimeField
          id="audio-fade-in"
          label="Fade in"
          value={item.fadeInMs}
          disabled={locked}
          onCommit={(fadeInMs) =>
            one({ op: 'setAudio', trackId: track.id, itemId: item.id, fadeInMs }, `Fade in ${label}`)
          }
        />
        <TimeField
          id="audio-fade-out"
          label="Fade out"
          value={item.fadeOutMs}
          disabled={locked}
          onCommit={(fadeOutMs) =>
            one({ op: 'setAudio', trackId: track.id, itemId: item.id, fadeOutMs }, `Fade out ${label}`)
          }
        />
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          aria-pressed={item.muted}
          disabledReason={locked ? 'Unlock it first' : undefined}
          onClick={() =>
            one(
              { op: 'setAudio', trackId: track.id, itemId: item.id, muted: !item.muted },
              `${item.muted ? 'Unmute' : 'Mute'} ${label}`,
            )
          }
        >
          {item.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          size="sm"
          aria-pressed={replacing}
          disabledReason={locked ? 'Unlock it first' : undefined}
          onClick={() => onReplace(!replacing)}
        >
          {replacing ? 'Cancel replace' : 'Replace source…'}
        </Button>
      </div>
    </>
  );
}

function CaptionFields({
  track,
  item,
  locked,
  onIntent,
}: InspectorProps & { track: Track; item: CaptionItem; locked: boolean }) {
  const set = (caption: CaptionItem, summary: string) =>
    onIntent({ operations: [{ op: 'upsertCaption', trackId: track.id, caption }], summary });
  const style = (track as CaptionTrack).style;
  return (
    <>
      <Field
        label="Caption text"
        htmlFor="caption-text"
        hint="Burnt into the video and written to the captions file."
      >
        <Textarea
          id="caption-text"
          rows={3}
          maxLength={300}
          value={item.text}
          disabled={locked}
          onChange={(e) => e.target.value.trim() && set({ ...item, text: e.target.value }, 'Edit caption')}
          data-testid="caption-text"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <TimeField
          id="caption-start"
          label="Starts at"
          value={item.startMs}
          disabled={locked}
          onCommit={(startMs) => set({ ...item, startMs }, 'Retime caption')}
        />
        <TimeField
          id="caption-end"
          label="Ends at"
          value={item.endMs}
          disabled={locked}
          onCommit={(endMs) => set({ ...item, endMs }, 'Retime caption')}
        />
      </div>
      <Field label="Position" htmlFor="caption-position">
        <Select
          id="caption-position"
          value={item.position ?? style.position}
          disabled={locked}
          onValueChange={(v) => set({ ...item, position: v as CaptionItem['position'] }, 'Move caption')}
          options={[
            { value: 'top', label: 'Top' },
            { value: 'middle', label: 'Middle' },
            { value: 'bottom', label: 'Bottom' },
          ]}
        />
      </Field>
    </>
  );
}

const ANIMATIONS = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide_up', label: 'Slide up' },
];

function OverlayFields({
  project,
  track,
  item,
  locked,
  colourTokens,
  onIntent,
}: InspectorProps & { track: Track; item: OverlayItem; locked: boolean }) {
  const set = (overlay: OverlayItem, summary: string) =>
    onIntent({ operations: [{ op: 'setOverlay', trackId: track.id, overlay }], summary });
  const anim = (which: 'enter' | 'exit', kind: string, durationMs?: number) => {
    const next: OverlayAnimation | undefined =
      kind === 'none'
        ? undefined
        : {
            kind: kind as OverlayAnimation['kind'],
            durationMs: durationMs ?? item[which]?.durationMs ?? 300,
          };
    const { [which]: _old, ...rest } = item;
    set(
      next ? { ...rest, [which]: next } : (rest as OverlayItem),
      `${which === 'enter' ? 'Enter' : 'Exit'} animation`,
    );
  };
  // The graphic properties panel edits the overlay's element on a page at the project's size; each graphic edit
  // becomes the overlay with that element.
  const page: CreativePage = {
    id: 'overlay',
    name: 'Overlay',
    formatKey: project.format.key,
    width: project.format.width,
    height: project.format.height,
    elements: [item.element],
    layoutConstraints: [],
  };
  const onGraphic = (batch: IntentBatch) => {
    const doc: CreativeDocumentV1 = {
      schemaVersion: 1,
      brandVersionId: project.brandVersionId,
      pages: [page],
      variants: [],
    };
    try {
      const next = applyBatch(doc, batch).pages[0]?.elements[0];
      if (next) set({ ...item, element: next }, batch.summary);
    } catch {
      // The graphic reducer refused it; the panel keeps the old value.
    }
  };
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <TimeField
          id="overlay-start"
          label="Starts at"
          value={item.startMs}
          disabled={locked}
          onCommit={(startMs) => set({ ...item, startMs }, 'Retime overlay')}
        />
        <TimeField
          id="overlay-end"
          label="Ends at"
          value={item.endMs}
          disabled={locked}
          onCommit={(endMs) => set({ ...item, endMs }, 'Retime overlay')}
        />
        <Field label="Enter" htmlFor="overlay-enter">
          <Select
            id="overlay-enter"
            value={item.enter?.kind ?? 'none'}
            disabled={locked}
            onValueChange={(v) => anim('enter', v)}
            options={ANIMATIONS}
          />
        </Field>
        <Field label="Exit" htmlFor="overlay-exit">
          <Select
            id="overlay-exit"
            value={item.exit?.kind ?? 'none'}
            disabled={locked}
            onValueChange={(v) => anim('exit', v)}
            options={ANIMATIONS}
          />
        </Field>
      </div>
      <PropertiesPanel
        page={page}
        elementId={item.element.id}
        readOnly={locked}
        colourTokens={colourTokens}
        onIntent={onGraphic}
        focusTextRequest={0}
      />
    </>
  );
}
