import { describe, expect, it } from 'vitest';
import { VideoOperation, VideoProjectV1 } from '@oremedia/contracts/video';
import type { AudioItem, CaptionItem, VideoClipItem, VideoOperation as Op } from '@oremedia/contracts/video';
import { fixtureVideoProject, videoFixtureLookup } from './fixtures';
import { applyVideoBatch, reduceVideo, VideoOperationError } from './reduce';
import { findItem, lengthOf, spanOf } from './time';

const ctx = { media: videoFixtureLookup(), strictMedia: true };
const apply = (ops: Op[], p = fixtureVideoProject()) => applyVideoBatch(p, { operations: ops }, ctx);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof VideoOperationError) return err.code;
    throw err;
  }
  return 'ok';
};
const fails = (ops: Op[], p = fixtureVideoProject()) => code(() => apply(ops, p));
const clip = (p: VideoProjectV1, id: string) => findItem(p, id)?.item as VideoClipItem;
const video = (p: VideoProjectV1) => p.tracks.find((t) => t.kind === 'video')?.items as VideoClipItem[];
const newClip = (over: Partial<VideoClipItem> = {}): VideoClipItem => ({
  id: 'clip_new',
  assetVersionId: 'av_clip_a',
  sourceInMs: 0,
  sourceOutMs: 2_000,
  startMs: 10_000,
  frame: { fit: 'fill', focalX: 0.5, focalY: 0.5, zoom: 1 },
  gainDb: 0,
  muted: false,
  locked: false,
  ...over,
});

describe('video project schema', () => {
  it('the fixture parses and keeps kind video; a graphic document is not a video project', () => {
    expect(VideoProjectV1.parse(fixtureVideoProject()).kind).toBe('video');
    expect(
      VideoProjectV1.safeParse({ schemaVersion: 1, brandVersionId: 'bv', pages: [], variants: [] }).success,
    ).toBe(false);
  });
  it('insertClip reads an audio item with fades as audio (never as a clip that drops them)', () => {
    const parsed = VideoOperation.parse({
      op: 'insertClip',
      trackId: 'trk_music',
      item: {
        id: 'a2',
        assetVersionId: 'av_music',
        sourceInMs: 0,
        sourceOutMs: 1000,
        startMs: 0,
        fadeInMs: 200,
      },
    });
    expect(parsed.op === 'insertClip' && 'fadeInMs' in parsed.item && parsed.item.fadeInMs).toBe(200);
  });
});

describe('insertClip', () => {
  it('appends a clip and grows the project to fit it', () => {
    const p = apply([{ op: 'insertClip', trackId: 'trk_video', item: newClip() }]);
    expect(video(p).map((c) => c.id)).toEqual(['clip_a', 'clip_b', 'clip_c', 'clip_new']);
    expect(p.durationMs).toBe(12_000);
  });
  it('refuses an overlap without ripple and pushes later clips right with ripple', () => {
    expect(fails([{ op: 'insertClip', trackId: 'trk_video', item: newClip({ startMs: 4_000 }) }])).toBe(
      'overlap',
    );
    const p = apply([
      { op: 'insertClip', trackId: 'trk_video', item: newClip({ startMs: 4_000 }), ripple: true },
    ]);
    expect(video(p).map((c) => [c.id, c.startMs])).toEqual([
      ['clip_a', 0],
      ['clip_new', 4_000],
      ['clip_b', 6_000],
      ['clip_c', 9_000],
    ]);
    expect(p.durationMs).toBe(12_000);
  });
  it('checks the source: kind, range and duration', () => {
    expect(fails([{ op: 'insertClip', trackId: 'trk_video', item: newClip({ sourceOutMs: 7_000 }) }])).toBe(
      'beyond_source',
    );
    expect(
      fails([
        { op: 'insertClip', trackId: 'trk_video', item: newClip({ sourceInMs: 2_000, sourceOutMs: 2_000 }) },
      ]),
    ).toBe('source_range_empty');
    expect(fails([{ op: 'insertClip', trackId: 'trk_video', item: newClip({ sourceOutMs: 50 }) }])).toBe(
      'item_too_short',
    );
    expect(
      fails([{ op: 'insertClip', trackId: 'trk_video', item: newClip({ assetVersionId: 'av_music' }) }]),
    ).toBe('source_kind_mismatch');
    expect(
      fails([{ op: 'insertClip', trackId: 'trk_video', item: newClip({ assetVersionId: 'av_unknown' }) }]),
    ).toBe('media_unknown');
    const audioFromSilentVideo: AudioItem = {
      id: 'a9',
      assetVersionId: 'av_clip_b',
      sourceInMs: 0,
      sourceOutMs: 1000,
      startMs: 0,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      muted: false,
      locked: false,
    };
    expect(
      fails([{ op: 'insertClip', trackId: 'trk_music', item: { ...audioFromSilentVideo, startMs: 12_000 } }]),
    ).toBe('source_has_no_audio');
    // An image is a still of any length (up to the project limit).
    const p = apply([
      {
        op: 'insertClip',
        trackId: 'trk_video',
        item: newClip({ assetVersionId: 'av_still', sourceOutMs: 20_000 }),
      },
    ]);
    expect(p.durationMs).toBe(30_000);
  });
  it('without strict media the editor checks only what it knows', () => {
    const p = applyVideoBatch(
      fixtureVideoProject(),
      {
        operations: [
          { op: 'insertClip', trackId: 'trk_video', item: newClip({ assetVersionId: 'av_new_upload' }) },
        ],
      },
      { media: {} },
    );
    expect(clip(p, 'clip_new').assetVersionId).toBe('av_new_upload');
  });
  it('refuses duplicate ids, unknown tracks, overlay tracks and projects longer than 180 s', () => {
    expect(fails([{ op: 'insertClip', trackId: 'trk_video', item: newClip({ id: 'cap_1' }) }])).toBe(
      'duplicate_item_id',
    );
    expect(fails([{ op: 'insertClip', trackId: 'nope', item: newClip() }])).toBe('track_not_found');
    expect(fails([{ op: 'insertClip', trackId: 'trk_titles', item: newClip() }])).toBe('track_kind_mismatch');
    expect(
      fails([
        {
          op: 'insertClip',
          trackId: 'trk_video',
          item: newClip({ assetVersionId: 'av_still', startMs: 170_000, sourceOutMs: 20_000 }),
        },
      ]),
    ).toBe('duration_exceeds_max');
  });
});

describe('moveClip', () => {
  it('moves into free time, refuses overlaps, and ripple-moves to reorder', () => {
    const p = apply([{ op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 12_000 }]);
    expect(clip(p, 'clip_c').startMs).toBe(12_000);
    expect(p.durationMs).toBe(15_000);
    expect(fails([{ op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 6_000 }])).toBe(
      'overlap',
    );
    // Reorder C to the front: remove with ripple (closes its gap), insert at 0 with ripple.
    const r = apply([
      { op: 'setTransition', trackId: 'trk_video', itemId: 'clip_b', transition: null },
      { op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 0, ripple: true },
    ]);
    expect(video(r).map((c) => [c.id, c.startMs])).toEqual([
      ['clip_c', 0],
      ['clip_a', 3_000],
      ['clip_b', 7_000],
    ]);
    expect(r.durationMs).toBe(10_000);
  });
  it('moves overlays and captions keeping their length; only to a track of the same kind', () => {
    const p = apply([{ op: 'moveClip', trackId: 'trk_captions', itemId: 'cap_2', startMs: 8_000 }]);
    expect(findItem(p, 'cap_2')?.item).toMatchObject({ startMs: 8_000, endMs: 10_000 });
    expect(
      fails([
        { op: 'moveClip', trackId: 'trk_captions', itemId: 'cap_2', startMs: 0, toTrackId: 'trk_titles' },
      ]),
    ).toBe('track_kind_mismatch');
  });
});

describe('trimClip', () => {
  it('trims the tail in place and the head keeping the picture anchored in time', () => {
    const p = apply([
      { op: 'trimClip', trackId: 'trk_video', itemId: 'clip_c', sourceInMs: 500, sourceOutMs: 3_000 },
    ]);
    expect(clip(p, 'clip_c')).toMatchObject({ startMs: 7_500, sourceInMs: 500, sourceOutMs: 3_000 });
    expect(
      fails([
        { op: 'trimClip', trackId: 'trk_video', itemId: 'clip_a', sourceInMs: 1_000, sourceOutMs: 5_500 },
      ]),
    ).toBe('overlap');
    expect(
      fails([{ op: 'trimClip', trackId: 'trk_video', itemId: 'clip_a', sourceInMs: 0, sourceOutMs: 5_000 }]),
    ).toBe('before_zero');
  });
  it('ripple trim keeps the start and shifts later clips by the change', () => {
    const p = apply([
      {
        op: 'trimClip',
        trackId: 'trk_video',
        itemId: 'clip_a',
        sourceInMs: 1_000,
        sourceOutMs: 6_000,
        ripple: true,
      },
    ]);
    expect(video(p).map((c) => [c.id, c.startMs])).toEqual([
      ['clip_a', 0],
      ['clip_b', 5_000],
      ['clip_c', 8_000],
    ]);
    expect(p.durationMs).toBe(11_000);
  });
  it('keeps in < out <= source and transitions at most half a neighbour', () => {
    expect(
      fails([
        {
          op: 'trimClip',
          trackId: 'trk_video',
          itemId: 'clip_b',
          sourceInMs: 0,
          sourceOutMs: 5_200,
          ripple: true,
        },
      ]),
    ).toBe('beyond_source');
    // B has a 1 s crossfade from A; trimming B to 1.5 s makes it more than half of B.
    expect(
      fails([
        {
          op: 'trimClip',
          trackId: 'trk_video',
          itemId: 'clip_b',
          sourceInMs: 0,
          sourceOutMs: 1_500,
          ripple: true,
        },
      ]),
    ).toBe('transition_too_long');
    expect(
      fails([{ op: 'trimClip', trackId: 'trk_titles', itemId: 'ov_title', sourceInMs: 0, sourceOutMs: 100 }]),
    ).toBe('not_a_clip');
  });
});

describe('splitClip, duplicateClip, removeClip', () => {
  it('splits at a time inside the clip: sources continue, the second half has no transition', () => {
    const p = apply([
      { op: 'splitClip', trackId: 'trk_video', itemId: 'clip_b', atMs: 6_000, newItemId: 'clip_b2' },
    ]);
    expect(clip(p, 'clip_b')).toMatchObject({ startMs: 4_000, sourceInMs: 0, sourceOutMs: 2_000 });
    expect(clip(p, 'clip_b').transitionIn).toBeDefined();
    expect(clip(p, 'clip_b2')).toMatchObject({ startMs: 6_000, sourceInMs: 2_000, sourceOutMs: 3_000 });
    expect(clip(p, 'clip_b2').transitionIn).toBeUndefined();
    expect(
      fails([{ op: 'splitClip', trackId: 'trk_video', itemId: 'clip_b', atMs: 4_050, newItemId: 'x' }]),
    ).toBe('split_outside_clip');
    // Splitting B at 5.5 s would leave a 1.5 s first half under a 1 s transition (more than half of it).
    expect(
      fails([{ op: 'splitClip', trackId: 'trk_video', itemId: 'clip_b', atMs: 5_500, newItemId: 'x' }]),
    ).toBe('transition_too_long');
  });
  it('splits audio keeping the fade in on the first part and the fade out on the second', () => {
    const p = apply([
      { op: 'splitClip', trackId: 'trk_music', itemId: 'aud_1', atMs: 5_000, newItemId: 'aud_2' },
    ]);
    expect(findItem(p, 'aud_1')?.item).toMatchObject({ fadeInMs: 500, fadeOutMs: 0, sourceOutMs: 5_000 });
    expect(findItem(p, 'aud_2')?.item).toMatchObject({
      fadeInMs: 0,
      fadeOutMs: 1_000,
      sourceInMs: 5_000,
      startMs: 5_000,
    });
  });
  it('duplicates right after the original (ripple pushes later clips); copies never inherit a lock or transition', () => {
    const p = apply([
      { op: 'duplicateClip', trackId: 'trk_video', itemId: 'clip_b', newItemId: 'clip_b_copy', ripple: true },
    ]);
    expect(video(p).map((c) => [c.id, c.startMs])).toEqual([
      ['clip_a', 0],
      ['clip_b', 4_000],
      ['clip_b_copy', 7_000],
      ['clip_c', 10_000],
    ]);
    expect(clip(p, 'clip_b_copy').transitionIn).toBeUndefined();
    expect(fails([{ op: 'duplicateClip', trackId: 'trk_video', itemId: 'clip_b', newItemId: 'x' }])).toBe(
      'overlap',
    );
  });
  it('removes with or without ripple; removeCaption and removeOverlay name their track kind', () => {
    expect(
      video(apply([{ op: 'removeClip', trackId: 'trk_video', itemId: 'clip_a' }])).map((c) => c.startMs),
    ).toEqual([4_000, 7_000]);
    expect(
      video(apply([{ op: 'removeClip', trackId: 'trk_video', itemId: 'clip_a', ripple: true }])).map(
        (c) => c.startMs,
      ),
    ).toEqual([0, 3_000]);
    expect(fails([{ op: 'removeCaption', trackId: 'trk_titles', itemId: 'ov_title' }])).toBe(
      'track_kind_mismatch',
    );
    expect(
      findItem(apply([{ op: 'removeCaption', trackId: 'trk_captions', itemId: 'cap_1' }]), 'cap_1'),
    ).toBeNull();
  });
});

describe('sources, framing, transitions, sound', () => {
  it('replaces a source keeping the length, and checks the new source is long enough', () => {
    const p = apply([
      {
        op: 'replaceClipSource',
        trackId: 'trk_video',
        itemId: 'clip_a',
        assetVersionId: 'av_clip_b',
        sourceInMs: 500,
      },
    ]);
    expect(clip(p, 'clip_a')).toMatchObject({
      assetVersionId: 'av_clip_b',
      sourceInMs: 500,
      sourceOutMs: 4_500,
    });
    expect(
      fails([
        {
          op: 'replaceClipSource',
          trackId: 'trk_video',
          itemId: 'clip_a',
          assetVersionId: 'av_clip_b',
          sourceInMs: 2_000,
        },
      ]),
    ).toBe('beyond_source');
  });
  it('sets framing on video clips only', () => {
    const frame = { fit: 'fit' as const, focalX: 0.2, focalY: 0.8, zoom: 1.5 };
    expect(
      clip(apply([{ op: 'setClipFrame', trackId: 'trk_video', itemId: 'clip_a', frame }]), 'clip_a').frame,
    ).toEqual(frame);
    expect(fails([{ op: 'setClipFrame', trackId: 'trk_music', itemId: 'aud_1', frame }])).toBe(
      'not_a_video_clip',
    );
  });
  it('transitions need an adjacent clip before and fit in half of each; cut removes it', () => {
    expect(
      clip(
        apply([
          {
            op: 'setTransition',
            trackId: 'trk_video',
            itemId: 'clip_c',
            transition: { kind: 'slide', durationMs: 1_500 },
          },
        ]),
        'clip_c',
      ).transitionIn,
    ).toEqual({ kind: 'slide', durationMs: 1_500 });
    expect(
      fails([
        {
          op: 'setTransition',
          trackId: 'trk_video',
          itemId: 'clip_c',
          transition: { kind: 'slide', durationMs: 1_600 },
        },
      ]),
    ).toBe('transition_too_long');
    expect(
      fails([
        {
          op: 'setTransition',
          trackId: 'trk_video',
          itemId: 'clip_a',
          transition: { kind: 'fade_black', durationMs: 500 },
        },
      ]),
    ).toBe('transition_without_neighbour');
    expect(
      clip(
        apply([
          {
            op: 'setTransition',
            trackId: 'trk_video',
            itemId: 'clip_b',
            transition: { kind: 'cut', durationMs: 0 },
          },
        ]),
        'clip_b',
      ).transitionIn,
    ).toBeUndefined();
  });
  it('sets gain and mute on clips, fades on audio only, fades within the item', () => {
    expect(
      clip(
        apply([{ op: 'setAudio', trackId: 'trk_video', itemId: 'clip_a', gainDb: -3, muted: true }]),
        'clip_a',
      ),
    ).toMatchObject({ gainDb: -3, muted: true });
    expect(fails([{ op: 'setAudio', trackId: 'trk_video', itemId: 'clip_a', fadeInMs: 100 }])).toBe(
      'fades_on_audio_items_only',
    );
    expect(fails([{ op: 'setAudio', trackId: 'trk_music', itemId: 'aud_1', fadeInMs: 9_500 }])).toBe(
      'fades_too_long',
    );
  });
});

describe('captions, overlays and tracks', () => {
  const cap = (over: Partial<CaptionItem> = {}): CaptionItem => ({
    id: 'cap_3',
    startMs: 4_000,
    endMs: 6_000,
    text: 'Third',
    locked: false,
    ...over,
  });
  it('upserts captions (new and existing) and refuses empty ones', () => {
    const p = apply([
      { op: 'upsertCaption', trackId: 'trk_captions', caption: cap() },
      {
        op: 'upsertCaption',
        trackId: 'trk_captions',
        caption: cap({ id: 'cap_1', startMs: 0, endMs: 1_500, text: 'Edited' }),
      },
    ]);
    const track = p.tracks.find((t) => t.kind === 'caption');
    expect(track?.items.map((c) => [c.id, (c as CaptionItem).text])).toEqual([
      ['cap_1', 'Edited'],
      ['cap_2', 'Second caption'],
      ['cap_3', 'Third'],
    ]);
    expect(fails([{ op: 'upsertCaption', trackId: 'trk_captions', caption: cap({ endMs: 4_000 }) }])).toBe(
      'item_empty',
    );
    expect(fails([{ op: 'upsertCaption', trackId: 'trk_video', caption: cap() }])).toBe(
      'track_kind_mismatch',
    );
  });
  it('overlay animations must fit; overlays may overlap each other', () => {
    const base = fixtureVideoProject().tracks[1];
    if (base?.kind !== 'overlay') throw new Error('fixture');
    const ov = { ...base.items[0]!, id: 'ov_2', exit: { kind: 'fade' as const, durationMs: 2_800 } };
    expect(fails([{ op: 'setOverlay', trackId: 'trk_titles', overlay: ov }])).toBe('animation_too_long');
    const p = apply([
      {
        op: 'setOverlay',
        trackId: 'trk_titles',
        overlay: { ...ov, exit: { kind: 'fade', durationMs: 300 } },
      },
    ]);
    expect(p.tracks[1]?.items).toHaveLength(2);
  });
  it('adds and removes audio and overlay tracks; the picture track is single and required', () => {
    const p = apply([
      {
        op: 'addTrack',
        track: { id: 'trk_vo', kind: 'audio', name: 'Voice', locked: false, muted: false, items: [] },
      },
    ]);
    expect(p.tracks.map((t) => t.id)).toContain('trk_vo');
    expect(
      fails([
        {
          op: 'addTrack',
          track: { id: 'trk_v2', kind: 'video', name: 'V2', locked: false, muted: false, items: [] },
        },
      ]),
    ).toBe('one_video_track');
    expect(fails([{ op: 'removeTrack', trackId: 'trk_video' }])).toBe('video_track_required');
    expect(apply([{ op: 'removeTrack', trackId: 'trk_music' }]).tracks.map((t) => t.id)).not.toContain(
      'trk_music',
    );
  });
});

describe('locks bind everyone except the unlock operation', () => {
  const locked = () => apply([{ op: 'setItemLock', trackId: 'trk_video', itemId: 'clip_b', locked: true }]);
  it.each<[string, Op]>([
    ['moveClip', { op: 'moveClip', trackId: 'trk_video', itemId: 'clip_b', startMs: 20_000 }],
    [
      'trimClip',
      { op: 'trimClip', trackId: 'trk_video', itemId: 'clip_b', sourceInMs: 0, sourceOutMs: 2_500 },
    ],
    ['splitClip', { op: 'splitClip', trackId: 'trk_video', itemId: 'clip_b', atMs: 5_500, newItemId: 'x' }],
    ['removeClip', { op: 'removeClip', trackId: 'trk_video', itemId: 'clip_b' }],
    [
      'replaceClipSource',
      { op: 'replaceClipSource', trackId: 'trk_video', itemId: 'clip_b', assetVersionId: 'av_clip_a' },
    ],
    [
      'setClipFrame',
      {
        op: 'setClipFrame',
        trackId: 'trk_video',
        itemId: 'clip_b',
        frame: { fit: 'fit', focalX: 0.5, focalY: 0.5, zoom: 1 },
      },
    ],
    ['setTransition', { op: 'setTransition', trackId: 'trk_video', itemId: 'clip_b', transition: null }],
    ['setAudio', { op: 'setAudio', trackId: 'trk_video', itemId: 'clip_b', muted: true }],
  ])('%s on a locked clip is refused', (_n, op) => {
    expect(code(() => applyVideoBatch(locked(), { operations: [op] }, ctx))).toBe('item_locked');
  });
  it('ripple that would move a locked clip is refused; unlocking works', () => {
    expect(
      code(() =>
        applyVideoBatch(
          locked(),
          { operations: [{ op: 'removeClip', trackId: 'trk_video', itemId: 'clip_a', ripple: true }] },
          ctx,
        ),
      ),
    ).toBe('locked_item_would_move');
    const unlocked = applyVideoBatch(
      locked(),
      { operations: [{ op: 'setItemLock', trackId: 'trk_video', itemId: 'clip_b', locked: false }] },
      ctx,
    );
    expect(clip(unlocked, 'clip_b').locked).toBe(false);
  });
  it('a locked track refuses edits, inserts and mutes until the track is unlocked', () => {
    const p = apply([{ op: 'setTrackLock', trackId: 'trk_music', locked: true }]);
    expect(
      code(() =>
        applyVideoBatch(
          p,
          { operations: [{ op: 'setAudio', trackId: 'trk_music', itemId: 'aud_1', gainDb: 0 }] },
          ctx,
        ),
      ),
    ).toBe('track_locked');
    expect(
      code(() =>
        applyVideoBatch(p, { operations: [{ op: 'setTrackMute', trackId: 'trk_music', muted: true }] }, ctx),
      ),
    ).toBe('track_locked');
    expect(
      code(() => applyVideoBatch(p, { operations: [{ op: 'removeTrack', trackId: 'trk_music' }] }, ctx)),
    ).toBe('track_locked');
    expect(
      applyVideoBatch(p, { operations: [{ op: 'setTrackLock', trackId: 'trk_music', locked: false }] }, ctx)
        .tracks[3]?.locked,
    ).toBe(false);
  });
  it('a caption cannot be locked or unlocked through upsert', () => {
    expect(
      fails([
        {
          op: 'upsertCaption',
          trackId: 'trk_captions',
          caption: { id: 'cap_1', startMs: 0, endMs: 2_000, text: 'x', locked: true },
        },
      ]),
    ).toBe('lock_by_lock_op');
  });
  it('new items and tracks start unlocked: a lock arrives only through the lock ops', () => {
    expect(fails([{ op: 'insertClip', trackId: 'trk_video', item: newClip({ locked: true }) }])).toBe(
      'lock_by_lock_op',
    );
    expect(
      fails([
        {
          op: 'upsertCaption',
          trackId: 'trk_captions',
          caption: { id: 'cap_new', startMs: 0, endMs: 1_000, text: 'x', locked: true },
        },
      ]),
    ).toBe('lock_by_lock_op');
    expect(
      fails([
        { op: 'addTrack', track: { id: 'trk_more', kind: 'overlay', name: 'More', locked: true, items: [] } },
      ]),
    ).toBe('lock_by_lock_op');
    const p = apply([
      { op: 'insertClip', trackId: 'trk_video', item: newClip() },
      { op: 'setItemLock', trackId: 'trk_video', itemId: 'clip_new', locked: true },
    ]);
    expect(clip(p, 'clip_new').locked).toBe(true);
  });
});

describe('duration and scenes', () => {
  it('setDuration cannot cut content; it can extend', () => {
    expect(fails([{ op: 'setDuration', durationMs: 9_000 }])).toBe('content_beyond_duration');
    expect(apply([{ op: 'setDuration', durationMs: 20_000 }]).durationMs).toBe(20_000);
  });
  it('scenes are upserted, removed, must not overlap and stay within the video', () => {
    expect(
      fails([{ op: 'setScene', scene: { id: 'scene_3', title: 'x', startMs: 3_000, endMs: 5_000 } }]),
    ).toBe('scene_overlap');
    expect(
      fails([{ op: 'setScene', scene: { id: 'scene_3', title: 'x', startMs: 9_000, endMs: 11_000 } }]),
    ).toBe('scene_beyond_duration');
    expect(apply([{ op: 'removeScene', sceneId: 'scene_1' }]).scenes.map((s) => s.id)).toEqual(['scene_2']);
  });
  it('reorderScenes moves every item inside each scene; straddling items refuse it', () => {
    expect(fails([{ op: 'reorderScenes', order: ['scene_2', 'scene_1'] }])).toBe('item_crosses_scene');
    const p = apply([
      { op: 'trimClip', trackId: 'trk_music', itemId: 'aud_1', sourceInMs: 0, sourceOutMs: 4_000 },
      { op: 'setTransition', trackId: 'trk_video', itemId: 'clip_b', transition: null },
      { op: 'reorderScenes', order: ['scene_2', 'scene_1'] },
    ]);
    expect(p.scenes.map((s) => [s.id, s.startMs, s.endMs])).toEqual([
      ['scene_2', 0, 6_000],
      ['scene_1', 6_000, 10_000],
    ]);
    expect(video(p).map((c) => [c.id, c.startMs])).toEqual([
      ['clip_b', 0],
      ['clip_c', 3_000],
      ['clip_a', 6_000],
    ]);
    expect(findItem(p, 'cap_2')?.item).toMatchObject({ startMs: 8_000, endMs: 10_000 });
    expect(spanOf(findItem(p, 'aud_1')!.item)).toEqual({ startMs: 6_000, endMs: 10_000 });
  });
});

describe('purity', () => {
  it('never mutates its input', () => {
    const p = fixtureVideoProject();
    const before = JSON.stringify(p);
    reduceVideo(p, { op: 'removeClip', trackId: 'trk_video', itemId: 'clip_a', ripple: true }, ctx);
    expect(JSON.stringify(p)).toBe(before);
    expect(lengthOf(video(p)[0]!)).toBe(4_000);
  });
});
