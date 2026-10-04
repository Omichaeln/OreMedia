import { describe, expect, it } from 'vitest';
import type { VideoOperation as Op } from '@oremedia/contracts/video';
import { rebaseVideoBatch } from './rebase';

const move = (itemId: string, startMs: number, ripple = false): Op => ({
  op: 'moveClip',
  trackId: 'trk_video',
  itemId,
  startMs,
  ripple,
});
const caption = (id: string): Op => ({
  op: 'upsertCaption',
  trackId: 'trk_captions',
  caption: { id, startMs: 0, endMs: 1000, text: 'x', locked: false },
});

describe('rebaseVideoBatch (spec 21.4 for timelines)', () => {
  it('keeps local intents that touch other items', () => {
    const r = rebaseVideoBatch(
      [move('clip_a', 100), caption('cap_9')],
      [[move('clip_b', 9_000)], [caption('cap_1')]],
    );
    expect(r).toEqual({ ok: true, operations: [move('clip_a', 100), caption('cap_9')] });
  });
  it('the same item on both sides is a conflict', () => {
    const r = rebaseVideoBatch(
      [move('clip_a', 100)],
      [[{ op: 'setItemLock', trackId: 'trk_video', itemId: 'clip_a', locked: true }]],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts[0]?.key).toBe('item:clip_a');
  });
  it('a ripple on a track conflicts with anything on that track, either way round', () => {
    expect(
      rebaseVideoBatch(
        [move('clip_a', 100)],
        [[{ op: 'removeClip', trackId: 'trk_video', itemId: 'clip_c', ripple: true }]],
      ).ok,
    ).toBe(false);
    expect(rebaseVideoBatch([move('clip_a', 100, true)], [[move('clip_c', 20_000)]]).ok).toBe(false);
    expect(rebaseVideoBatch([move('clip_a', 100, true)], [[caption('cap_1')]]).ok).toBe(true);
  });
  it('project settings conflict with the same setting; a scene reorder conflicts with every item edit', () => {
    expect(
      rebaseVideoBatch(
        [{ op: 'setDuration', durationMs: 5_000 }],
        [[{ op: 'setDuration', durationMs: 8_000 }]],
      ).ok,
    ).toBe(false);
    expect(
      rebaseVideoBatch(
        [{ op: 'setTrackMute', trackId: 'trk_music', muted: true }],
        [[{ op: 'setTrackMute', trackId: 'trk_video', muted: true }]],
      ).ok,
    ).toBe(true);
    expect(rebaseVideoBatch([caption('cap_5')], [[{ op: 'reorderScenes', order: ['s2', 's1'] }]]).ok).toBe(
      false,
    );
  });
});
