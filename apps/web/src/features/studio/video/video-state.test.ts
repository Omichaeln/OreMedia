import { describe, expect, it } from 'vitest';
import { fixtureVideoProject, VIDEO_FIXTURE_MEDIA } from '@oremedia/editor/video/fixtures';
import type { VideoOperation } from '@oremedia/contracts/video';
import {
  coalesceVideo,
  hasLocalVideoWork,
  initialVideoState,
  localProject,
  videoStudioReducer,
  type VideoCommitted,
} from './video-state';

const committed = (n = 1): VideoCommitted => ({
  revisionId: `rev_${n}`,
  number: n,
  snapshot: fixtureVideoProject(),
  contentHash: 'h'.repeat(64),
});
const start = () => initialVideoState(committed(), Object.values(VIDEO_FIXTURE_MEDIA));
const move = (startMs: number): VideoOperation => ({
  op: 'moveClip',
  trackId: 'trk_video',
  itemId: 'clip_c',
  startMs,
});

describe('video studio state', () => {
  it('queues intents (coalescing repeated drags of one item) and shows them on the local project', () => {
    let s = videoStudioReducer(start(), {
      type: 'intent',
      intent: { operations: [move(11_000)], summary: 'Move C' },
      key: 'k1',
    });
    s = videoStudioReducer(s, {
      type: 'intent',
      intent: { operations: [move(12_000)], summary: 'Move C' },
      key: 'k2',
    });
    expect(s.pending).toMatchObject({ operations: [move(12_000)], summary: 'Move C', key: 'k2' });
    expect(s.save.kind).toBe('pending');
    expect(localProject(s).project.tracks[0]?.items.find((c) => c.id === 'clip_c')?.startMs).toBe(12_000);
    expect(hasLocalVideoWork(s)).toBe(true);
  });
  it('a ripple edit never collapses into the previous one', () => {
    const ripple: VideoOperation = { ...move(0), ripple: true } as VideoOperation;
    expect(coalesceVideo([move(1)], ripple)).toHaveLength(2);
    expect(
      coalesceVideo([{ op: 'setAudio', trackId: 't', itemId: 'a', gainDb: 1 }], {
        op: 'setAudio',
        trackId: 't',
        itemId: 'a',
        muted: true,
      }),
    ).toEqual([{ op: 'setAudio', trackId: 't', itemId: 'a', gainDb: 1, muted: true }]);
  });
  it('autosave moves pending to in flight; success records an undo entry and clears redo', () => {
    let s = videoStudioReducer(start(), {
      type: 'intent',
      intent: { operations: [move(11_000)], summary: 'Move C' },
      key: 'k1',
    });
    s = videoStudioReducer(s, { type: 'commit:start', mode: 'autosave' });
    expect(s.inFlight?.mode).toBe('autosave');
    expect(s.pending).toBeNull();
    s = videoStudioReducer(s, { type: 'commit:success', revision: committed(2), findings: [], media: [] });
    expect(s.committed.number).toBe(2);
    expect(s.undo).toHaveLength(1);
    expect(s.undo[0]?.summary).toBe('Move C');
    expect(s.save.kind).toBe('saved');
  });
  it('undo moves the entry to redo (as the undo commit), redo moves it back', () => {
    let s = {
      ...start(),
      undo: [{ before: fixtureVideoProject(), operations: [move(11_000)], summary: 'Move C' }],
    };
    s = videoStudioReducer(s, {
      type: 'commit:start',
      mode: 'undo',
      operations: [move(7_000)],
      summary: 'Undo: Move C',
      key: 'u',
    });
    s = videoStudioReducer(s, { type: 'commit:success', revision: committed(3), findings: [], media: [] });
    expect(s.undo).toHaveLength(0);
    expect(s.redo).toEqual([expect.objectContaining({ operations: [move(7_000)], summary: 'Undo: Move C' })]);
    s = videoStudioReducer(s, {
      type: 'commit:start',
      mode: 'redo',
      operations: [move(11_000)],
      summary: 'Redo: Move C',
      key: 'r',
    });
    s = videoStudioReducer(s, { type: 'commit:success', revision: committed(4), findings: [], media: [] });
    expect(s.redo).toHaveLength(0);
    expect(s.undo).toHaveLength(1);
  });
  it('a failed autosave puts its operations back in front with a fresh key; a conflict can keep mine', () => {
    let s = videoStudioReducer(start(), {
      type: 'intent',
      intent: { operations: [move(11_000)], summary: 'Move C' },
      key: 'k1',
    });
    s = videoStudioReducer(s, { type: 'commit:start', mode: 'autosave' });
    s = videoStudioReducer(s, {
      type: 'commit:failed',
      error: { kind: 'unknown', message: 'down', code: 'INTERNAL' } as never,
      key: 'k9',
    });
    expect(s.pending).toMatchObject({ operations: [move(11_000)], key: 'k9' });
    expect(s.save.kind).toBe('failed');
    s = videoStudioReducer(s, {
      type: 'rebase:conflict',
      head: committed(5),
      localOps: [move(11_000), { op: 'removeClip', trackId: 'trk_video', itemId: 'gone' }],
      conflicts: [],
    });
    expect(s.save.kind).toBe('conflict');
    s = videoStudioReducer(s, { type: 'conflict:keep-mine', key: 'k10' });
    expect(s.committed.number).toBe(5);
    expect(s.pending?.operations).toEqual([move(11_000)]);
    expect(s.notice?.text).toMatch(/1 of your changes no longer apply/);
  });
});
