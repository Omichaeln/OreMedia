import { useState } from 'react';
import type { VideoProjectV1 } from '@oremedia/contracts/video';
import { Button, EmptyState, Field, Input } from '@oremedia/ui';
import { TimeField } from './inspector';
import { newItemId } from './video-actions';
import { timecode } from './timecode';
import type { VideoIntent } from './video-state';

/**
 * Scene markers (storyboard sections): add one at the playhead, rename and retime it, remove it, and reorder scenes,
 * which moves everything inside each scene with it (the reducer refuses when an item straddles a scene boundary).
 */
export function ScenesPanel({
  project,
  playheadMs,
  readOnly,
  onIntent,
  onSeek,
}: {
  project: VideoProjectV1;
  playheadMs: number;
  readOnly: boolean;
  onIntent: (i: VideoIntent) => boolean;
  onSeek: (ms: number) => void;
}) {
  const scenes = [...project.scenes].sort((a, b) => a.startMs - b.startMs);
  const [title, setTitle] = useState('');
  const add = () => {
    const after = scenes.find((s) => s.startMs > playheadMs);
    const startMs = Math.min(playheadMs, project.durationMs - 500);
    const endMs = Math.min(after?.startMs ?? project.durationMs, startMs + 3_000);
    onIntent({
      operations: [
        {
          op: 'setScene',
          scene: { id: newItemId(), title: title.trim() || `Scene ${scenes.length + 1}`, startMs, endMs },
        },
      ],
      summary: 'Add a scene',
    });
    setTitle('');
  };
  const move = (index: number, by: -1 | 1) => {
    const order = scenes.map((s) => s.id);
    const [id] = order.splice(index, 1);
    order.splice(index + by, 0, id as string);
    onIntent({ operations: [{ op: 'reorderScenes', order }], summary: 'Reorder scenes' });
  };
  return (
    <section aria-labelledby="scenes-heading" className="flex flex-col gap-2" data-testid="scenes">
      <h2 id="scenes-heading" className="text-sm font-semibold">
        Scenes
      </h2>
      {scenes.length === 0 && (
        <EmptyState
          title="No scenes"
          description="Scenes group the video into sections you can jump to and reorder."
          className="py-2"
        />
      )}
      <ol className="flex flex-col gap-2">
        {scenes.map((s, i) => (
          <li key={s.id} className="flex flex-col gap-1 rounded-md border border-border p-2">
            <Field label="Scene title" htmlFor={`scene-title-${s.id}`}>
              <Input
                id={`scene-title-${s.id}`}
                defaultValue={s.title}
                disabled={readOnly}
                maxLength={80}
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== s.title &&
                  onIntent({
                    operations: [{ op: 'setScene', scene: { ...s, title: e.target.value.trim() } }],
                    summary: 'Rename scene',
                  })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <TimeField
                id={`scene-start-${s.id}`}
                label="Starts at"
                value={s.startMs}
                disabled={readOnly}
                onCommit={(startMs) =>
                  onIntent({
                    operations: [{ op: 'setScene', scene: { ...s, startMs } }],
                    summary: 'Retime scene',
                  })
                }
              />
              <TimeField
                id={`scene-end-${s.id}`}
                label="Ends at"
                value={s.endMs}
                disabled={readOnly}
                onCommit={(endMs) =>
                  onIntent({
                    operations: [{ op: 'setScene', scene: { ...s, endMs } }],
                    summary: 'Retime scene',
                  })
                }
              />
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSeek(s.startMs)}
                aria-label={`Go to ${s.title} at ${timecode(s.startMs)}`}
              >
                Go to
              </Button>
              <Button
                size="sm"
                disabledReason={readOnly ? 'Read only' : i === 0 ? 'Already first' : undefined}
                onClick={() => move(i, -1)}
                aria-label={`Move ${s.title} earlier`}
              >
                Earlier
              </Button>
              <Button
                size="sm"
                disabledReason={readOnly ? 'Read only' : i === scenes.length - 1 ? 'Already last' : undefined}
                onClick={() => move(i, 1)}
                aria-label={`Move ${s.title} later`}
              >
                Later
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabledReason={readOnly ? 'Read only' : undefined}
                onClick={() =>
                  onIntent({
                    operations: [{ op: 'removeScene', sceneId: s.id }],
                    summary: `Remove scene ${s.title}`,
                  })
                }
                aria-label={`Remove scene ${s.title}`}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex items-end gap-2">
        <Field label="New scene title" htmlFor="new-scene-title" className="flex-1">
          <Input
            id="new-scene-title"
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Button size="sm" disabledReason={readOnly ? 'Read only' : undefined} onClick={add}>
          Add scene at playhead
        </Button>
      </div>
    </section>
  );
}
