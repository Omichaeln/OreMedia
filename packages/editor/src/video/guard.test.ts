import { describe, expect, it } from 'vitest';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type { OverlayItem, VideoOperation as Op, VideoProjectV1 } from '@oremedia/contracts/video';
import { fixtureVideoProject } from './fixtures';
import { guardVideoAgent } from './guard';

const withLogo = (): VideoProjectV1 => {
  const p = fixtureVideoProject();
  const t = p.tracks[1];
  if (t?.kind !== 'overlay') throw new Error('fixture');
  t.items.push({
    id: 'ov_logo',
    startMs: 8_000,
    endMs: 10_000,
    locked: false,
    element: {
      id: 'el_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      name: 'Logo',
      type: 'logo',
      locked: false,
      visible: true,
      opacity: 1,
      protected: true,
      transform: { x: 0, y: 0, width: 300, height: 150, rotation: 0 },
      assetVersionId: 'av_logo',
      variant: 'primary',
    },
  });
  return p;
};
const denied = (op: Op, p = withLogo()) => {
  try {
    guardVideoAgent(p, op, 'agent');
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyDeniedError);
    return (err as PolicyDeniedError).message;
  }
};

describe('guardVideoAgent', () => {
  it('lets people do anything (the reducer still enforces locks)', () => {
    expect(() =>
      guardVideoAgent(withLogo(), { op: 'removeOverlay', trackId: 'trk_titles', itemId: 'ov_logo' }, 'user'),
    ).not.toThrow();
  });
  it('agents never lock or unlock', () => {
    expect(denied({ op: 'setItemLock', trackId: 'trk_video', itemId: 'clip_a', locked: false })).toMatch(
      /lock/,
    );
    expect(denied({ op: 'setTrackLock', trackId: 'trk_video', locked: true })).toMatch(/lock/);
  });
  it('agents cannot change, move or remove protected overlays, nor add logos, nor drop their track', () => {
    const p = withLogo();
    const logo = (p.tracks[1]?.items as OverlayItem[]).find((o) => o.id === 'ov_logo') as OverlayItem;
    expect(denied({ op: 'setOverlay', trackId: 'trk_titles', overlay: { ...logo, endMs: 9_000 } })).toMatch(
      /protected/,
    );
    expect(denied({ op: 'moveClip', trackId: 'trk_titles', itemId: 'ov_logo', startMs: 0 })).toMatch(
      /protected/,
    );
    expect(denied({ op: 'removeOverlay', trackId: 'trk_titles', itemId: 'ov_logo' })).toMatch(/protected/);
    expect(
      denied({ op: 'setOverlay', trackId: 'trk_titles', overlay: { ...logo, id: 'ov_new_logo' } }),
    ).toMatch(/logo/);
    expect(denied({ op: 'removeTrack', trackId: 'trk_titles' })).toMatch(/protected/);
  });
  it('agents cannot reorder scenes that would move a protected overlay; other reorders are allowed', () => {
    // The logo (8-10 s) is in scene_2: swapping the two scenes moves it.
    expect(denied({ op: 'reorderScenes', order: ['scene_2', 'scene_1'] })).toMatch(/ov_logo/);
    // Three scenes, the logo in the last one: swapping the first two leaves it where it is.
    const p = withLogo();
    p.scenes = [
      { id: 'scene_a', title: 'A', startMs: 0, endMs: 4_000 },
      { id: 'scene_b', title: 'B', startMs: 4_000, endMs: 7_000 },
      { id: 'scene_c', title: 'C', startMs: 7_000, endMs: 10_000 },
    ];
    expect(denied({ op: 'reorderScenes', order: ['scene_b', 'scene_a', 'scene_c'] }, p)).toBeNull();
    expect(denied({ op: 'reorderScenes', order: ['scene_a', 'scene_c', 'scene_b'] }, p)).toMatch(/ov_logo/);
    // People may reorder freely.
    expect(() =>
      guardVideoAgent(withLogo(), { op: 'reorderScenes', order: ['scene_2', 'scene_1'] }, 'user'),
    ).not.toThrow();
  });
  it('agents cannot make ripple edits on an overlay track holding a protected overlay', () => {
    expect(
      denied({ op: 'moveClip', trackId: 'trk_titles', itemId: 'ov_title', startMs: 4_000, ripple: true }),
    ).toMatch(/ripple/);
    expect(
      denied({
        op: 'trimClip',
        trackId: 'trk_titles',
        itemId: 'ov_title',
        sourceInMs: 0,
        sourceOutMs: 1_000,
        ripple: true,
      }),
    ).toMatch(/ripple/);
    // Without ripple only the item itself moves, and a removed overlay never shifts the others (removeOverlay has
    // no ripple): an ordinary title next to the logo may still be moved or removed.
    expect(denied({ op: 'moveClip', trackId: 'trk_titles', itemId: 'ov_title', startMs: 4_000 })).toBeNull();
    expect(denied({ op: 'removeOverlay', trackId: 'trk_titles', itemId: 'ov_title' })).toBeNull();
    // A ripple edit on a track without protected overlays is allowed.
    expect(
      denied({ op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 11_000, ripple: true }),
    ).toBeNull();
  });
  it('agents may edit ordinary items', () => {
    expect(denied({ op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 11_000 })).toBeNull();
    expect(denied({ op: 'removeOverlay', trackId: 'trk_titles', itemId: 'ov_title' })).toBeNull();
  });
});
