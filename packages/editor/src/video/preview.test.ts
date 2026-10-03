import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@oremedia/domain/hash';
import { fixtureVideoProject, videoFixtureLookup } from './fixtures';
import { framePlacement } from './frame';
import { activeCaptions, activeOverlays, pictureLayersAt, restoreVideoOps } from './preview';
import { applyVideoBatch } from './reduce';

const ctx = { media: videoFixtureLookup(), strictMedia: true };
const ids = (ms: number) =>
  pictureLayersAt(fixtureVideoProject(), ms).map((l) => [
    l.clip.id,
    Math.round(l.opacity * 100) / 100,
    l.offsetX,
  ]);

describe('pictureLayersAt (the compositor timing, for the preview)', () => {
  it('shows each clip in its own range at the source time it plays', () => {
    expect(pictureLayersAt(fixtureVideoProject(), 1_000)[0]).toMatchObject({ sourceMs: 2_000, opacity: 1 });
    expect(ids(9_999)).toEqual([['clip_c', 1, 0]]);
    expect(ids(10_000)).toEqual([]);
  });
  it('centres a 1 s crossfade on the 4 s cut: incoming below, outgoing fading out on top, edges frozen', () => {
    expect(ids(3_499)).toEqual([['clip_a', 1, 0]]);
    expect(ids(3_500)).toEqual([
      ['clip_b', 1, 0],
      ['clip_a', 1, 0],
    ]);
    expect(ids(4_000)).toEqual([
      ['clip_b', 1, 0],
      ['clip_a', 0.5, 0],
    ]);
    const after = pictureLayersAt(fixtureVideoProject(), 4_250);
    expect(after.find((l) => l.clip.id === 'clip_a')?.sourceMs).toBe(5_000 - 33); // A frozen at its last frame
    expect(ids(4_500)).toEqual([['clip_b', 1, 0]]);
  });
  it('slides and fades through black as the compositor does', () => {
    const slide = applyVideoBatch(
      fixtureVideoProject(),
      {
        operations: [
          {
            op: 'setTransition',
            trackId: 'trk_video',
            itemId: 'clip_b',
            transition: { kind: 'slide', durationMs: 1_000 },
          },
        ],
      },
      ctx,
    );
    expect(pictureLayersAt(slide, 4_000).map((l) => l.offsetX)).toEqual([-0.5, 0.5]);
    const black = applyVideoBatch(
      fixtureVideoProject(),
      {
        operations: [
          {
            op: 'setTransition',
            trackId: 'trk_video',
            itemId: 'clip_b',
            transition: { kind: 'fade_black', durationMs: 1_000 },
          },
        ],
      },
      ctx,
    );
    expect(pictureLayersAt(black, 3_750)).toMatchObject([{ clip: { id: 'clip_a' }, opacity: 0.5 }]);
    expect(pictureLayersAt(black, 4_000)).toMatchObject([{ clip: { id: 'clip_b' }, opacity: 0 }]);
    expect(pictureLayersAt(black, 4_250)).toMatchObject([{ clip: { id: 'clip_b' }, opacity: 0.5 }]);
  });
  it('lists the overlays and captions active at a time', () => {
    expect(activeOverlays(fixtureVideoProject(), 600).map((o) => o.id)).toEqual(['ov_title']);
    expect(activeOverlays(fixtureVideoProject(), 3_500)).toEqual([]);
    expect(activeCaptions(fixtureVideoProject(), 2_000).map((c) => c.caption.id)).toEqual(['cap_2']);
  });
});

describe('framePlacement (shared with the compositor)', () => {
  it('fills a 16:9 source into 9:16 by covering and cropping around the focal point', () => {
    expect(
      framePlacement(
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
        { fit: 'fill', focalX: 0.5, focalY: 0.5, zoom: 1 },
      ),
    ).toEqual({
      scaledWidth: 3414,
      scaledHeight: 1920,
      cropX: 1166,
      cropY: 0,
      cropWidth: 1080,
      cropHeight: 1920,
      padX: 0,
      padY: 0,
    });
    expect(
      framePlacement(
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
        { fit: 'fill', focalX: 0, focalY: 0.5, zoom: 1 },
      ).cropX,
    ).toBe(0);
  });
  it('fits with black bars, and zoom crops a fitted source', () => {
    expect(
      framePlacement(
        { width: 640, height: 360 },
        { width: 1080, height: 1920 },
        { fit: 'fit', focalX: 0.5, focalY: 0.5, zoom: 1 },
      ),
    ).toMatchObject({ scaledWidth: 1080, scaledHeight: 608, padX: 0, padY: 656 });
    expect(
      framePlacement(
        { width: 640, height: 360 },
        { width: 1080, height: 1920 },
        { fit: 'fit', focalX: 0.5, focalY: 0.5, zoom: 2 },
      ),
    ).toMatchObject({ cropWidth: 1080, cropHeight: 1216, padY: 352 });
  });
});

describe('restoreVideoOps', () => {
  it('turns the current project into an earlier one with operations (a new revision)', () => {
    const earlier = fixtureVideoProject();
    const now = applyVideoBatch(
      earlier,
      {
        operations: [
          { op: 'removeClip', trackId: 'trk_video', itemId: 'clip_c' },
          { op: 'removeTrack', trackId: 'trk_music' },
          { op: 'setDuration', durationMs: 20_000 },
          { op: 'setScene', scene: { id: 'scene_3', title: 'Late', startMs: 12_000, endMs: 14_000 } },
        ],
      },
      ctx,
    );
    const restore = restoreVideoOps(now, earlier);
    if (!restore.ok) throw new Error(restore.reason);
    const restored = applyVideoBatch(now, { operations: restore.operations }, ctx);
    expect(hashCanonical(restored)).toBe(
      hashCanonical(
        applyVideoBatch(earlier, { operations: [{ op: 'setDuration', durationMs: 10_000 }] }, ctx),
      ),
    );
  });
  it('refuses over locked items', () => {
    const locked = applyVideoBatch(
      fixtureVideoProject(),
      { operations: [{ op: 'setItemLock', trackId: 'trk_video', itemId: 'clip_a', locked: true }] },
      ctx,
    );
    expect(restoreVideoOps(locked, fixtureVideoProject())).toEqual({
      ok: false,
      reason: 'Unlock the locked tracks and items first',
    });
  });
});
