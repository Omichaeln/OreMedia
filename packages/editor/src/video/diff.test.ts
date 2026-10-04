import { describe, expect, it } from 'vitest';
import type { VideoOperation } from '@oremedia/contracts/video';
import { videoTimelineDiff } from './diff';
import { fixtureVideoProject, videoFixtureLookup } from './fixtures';
import { applyVideoBatch } from './reduce';

describe('timeline diff', () => {
  it('names added, removed, moved, trimmed and changed items, scenes and the length', () => {
    const before = fixtureVideoProject();
    const operations: VideoOperation[] = [
      { op: 'removeCaption', trackId: 'trk_captions', itemId: 'cap_2' },
      { op: 'trimClip', trackId: 'trk_video', itemId: 'clip_c', sourceInMs: 0, sourceOutMs: 2_000 },
      { op: 'trimClip', trackId: 'trk_music', itemId: 'aud_1', sourceInMs: 0, sourceOutMs: 9_000 },
      {
        op: 'upsertCaption',
        trackId: 'trk_captions',
        caption: { id: 'cap_1', startMs: 500, endMs: 2_500, text: 'First caption', locked: false },
      },
      {
        op: 'upsertCaption',
        trackId: 'trk_captions',
        caption: { id: 'cap_3', startMs: 5_000, endMs: 6_000, text: 'New', locked: false },
      },
      {
        op: 'setClipFrame',
        trackId: 'trk_video',
        itemId: 'clip_b',
        frame: { fit: 'fit', focalX: 0.5, focalY: 0.5, zoom: 1 },
      },
      { op: 'setScene', scene: { id: 'scene_2', title: 'Middle', startMs: 4_000, endMs: 9_000 } },
      { op: 'setDuration', durationMs: 9_000 },
    ];
    const after = applyVideoBatch(before, { operations }, { media: videoFixtureLookup() });
    const changes = videoTimelineDiff(before, after);
    const by = (id: string) => changes.find((c) => c.id === id)?.kind;
    expect(by('cap_2')).toBe('removed');
    expect(by('cap_3')).toBe('added');
    expect(by('cap_1')).toBe('moved');
    expect(by('clip_c')).toBe('trimmed');
    expect(by('clip_b')).toBe('changed');
    expect(by('aud_1')).toBe('trimmed');
    expect(by('ov_title')).toBeUndefined();
    expect(by('scene_2')).toBe('trimmed');
    expect(by('duration')).toBe('trimmed');
    expect(videoTimelineDiff(before, before)).toEqual([]);
  });
});
