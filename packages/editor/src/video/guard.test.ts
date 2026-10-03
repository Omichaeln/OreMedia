import { describe, expect, it } from 'vitest';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type { OverlayItem, VideoOperation as Op, VideoProjectV1 } from '@oremedia/contracts/video';
import { fixtureVideoProject, videoFixtureLookup } from './fixtures';
import { guardVideoAgent, guardVideoAgentScoped, guardVideoScopeChange, videoScopeOf } from './guard';
import { reduceVideo } from './reduce';

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
  it('agents may edit ordinary items', () => {
    expect(denied({ op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 11_000 })).toBeNull();
    expect(denied({ op: 'removeOverlay', trackId: 'trk_titles', itemId: 'ov_title' })).toBeNull();
  });
});

describe('agent scope and locks (STU-3)', () => {
  const scoped = (scope: Parameters<typeof videoScopeOf>[1]) => {
    const p = fixtureVideoProject();
    return { p, s: videoScopeOf(p, scope) };
  };
  const refused = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError);
      return (err as PolicyDeniedError).reason;
    }
  };

  it('resolves a scene scope to the items inside it and refuses unknown items or scenes', () => {
    const { s } = scoped({ kind: 'scene', sceneId: 'scene_2' });
    expect([...(s?.ids ?? [])].sort()).toEqual(['clip_b', 'clip_c']);
    expect(scoped({ kind: 'timeline' }).s).toBeNull();
    expect(refused(() => videoScopeOf(fixtureVideoProject(), { kind: 'items', itemIds: ['nope'] }))).toBe(
      'out_of_scope',
    );
    expect(refused(() => videoScopeOf(fixtureVideoProject(), { kind: 'scene', sceneId: 'nope' }))).toBe(
      'out_of_scope',
    );
  });

  it('refuses agent operations on locked items and tracks with a policy error', () => {
    const p = fixtureVideoProject();
    const v = p.tracks[0];
    if (v?.kind !== 'video') throw new Error('fixture');
    v.items[0] = { ...v.items[0], locked: true } as (typeof v.items)[number];
    const op: Op = {
      op: 'setClipFrame',
      trackId: 'trk_video',
      itemId: 'clip_a',
      frame: { fit: 'fit', focalX: 0.5, focalY: 0.5, zoom: 1 },
    };
    expect(refused(() => guardVideoAgentScoped(p, op, 'agent', null))).toBe('locked');
    expect(refused(() => guardVideoAgentScoped(p, op, 'user', null))).toBeNull();
    p.tracks[2] = { ...p.tracks[2], locked: true } as (typeof p.tracks)[number];
    const caption: Op = { op: 'removeCaption', trackId: 'trk_captions', itemId: 'cap_1' };
    expect(refused(() => guardVideoAgentScoped(p, caption, 'agent', null))).toBe('locked');
  });

  it('allows only whole-timeline scope to change tracks or the scene order', () => {
    const { p, s } = scoped({ kind: 'scene', sceneId: 'scene_1' });
    const op: Op = { op: 'reorderScenes', order: ['scene_2', 'scene_1'] };
    expect(refused(() => guardVideoAgentScoped(p, op, 'agent', s))).toBe('out_of_scope');
    expect(refused(() => guardVideoAgentScoped(p, op, 'agent', null))).toBeNull();
  });

  it('lets items outside the scope move but not change, disappear or appear', () => {
    const { p, s } = scoped({ kind: 'items', itemIds: ['clip_a'] });
    const media = videoFixtureLookup();
    const trim: Op = {
      op: 'trimClip',
      trackId: 'trk_video',
      itemId: 'clip_a',
      sourceInMs: 1_000,
      sourceOutMs: 4_000,
      ripple: true,
    };
    const after = reduceVideo(p, trim, { media });
    expect(refused(() => guardVideoScopeChange(p, after, trim, s))).toBeNull();
    const frame: Op = {
      op: 'setClipFrame',
      trackId: 'trk_video',
      itemId: 'clip_c',
      frame: { fit: 'fit', focalX: 0.5, focalY: 0.5, zoom: 1 },
    };
    expect(refused(() => guardVideoScopeChange(p, reduceVideo(p, frame, { media }), frame, s))).toBe(
      'out_of_scope',
    );
    const remove: Op = { op: 'removeCaption', trackId: 'trk_captions', itemId: 'cap_2' };
    expect(refused(() => guardVideoScopeChange(p, reduceVideo(p, remove, { media }), remove, s))).toBe(
      'out_of_scope',
    );
    const split: Op = {
      op: 'splitClip',
      trackId: 'trk_video',
      itemId: 'clip_a',
      atMs: 2_000,
      newItemId: 'clip_a2',
    };
    expect(refused(() => guardVideoScopeChange(p, reduceVideo(p, split, { media }), split, s))).toBeNull();
    expect(s?.ids.has('clip_a2')).toBe(true);
  });

  it('lets new items appear inside the scoped scene only', () => {
    const { p, s } = scoped({ kind: 'scene', sceneId: 'scene_2' });
    const media = videoFixtureLookup();
    const inside: Op = {
      op: 'upsertCaption',
      trackId: 'trk_captions',
      caption: { id: 'cap_new', startMs: 5_000, endMs: 6_000, text: 'x', locked: false },
    };
    expect(refused(() => guardVideoScopeChange(p, reduceVideo(p, inside, { media }), inside, s))).toBeNull();
    const outside: Op = {
      op: 'upsertCaption',
      trackId: 'trk_captions',
      caption: { id: 'cap_out', startMs: 1_000, endMs: 1_500, text: 'x', locked: false },
    };
    expect(refused(() => guardVideoScopeChange(p, reduceVideo(p, outside, { media }), outside, s))).toBe(
      'out_of_scope',
    );
  });
});
