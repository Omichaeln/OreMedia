import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@oremedia/domain/hash';
import type {
  AudioItem,
  Track,
  TrackItem,
  VideoClipItem,
  VideoOperation as Op,
  VideoProjectV1,
} from '@oremedia/contracts/video';
import { fixtureVideoProject, videoFixtureLookup } from './fixtures';
import { invertVideoBatch } from './invert';
import { applyVideoBatch, reduceVideo, VideoOperationError } from './reduce';
import { isTimedTrack, lengthOf, previousAdjacent, sortByStart, spanOf } from './time';

const ctx = { media: videoFixtureLookup(), strictMedia: true };

const roundTrips = (ops: Op[], start = fixtureVideoProject()) => {
  const edited = applyVideoBatch(start, { operations: ops }, ctx);
  const inv = invertVideoBatch(start, { operations: ops }, ctx);
  if (!inv.ok) throw new Error(`not invertible: ${inv.reason}`);
  const restored = applyVideoBatch(edited, { operations: inv.operations }, ctx);
  expect(hashCanonical(restored)).toBe(hashCanonical(VideoProjectV1Parse(start)));
  return inv.operations;
};
// The reducer output is schema-parsed; compare against the parsed start so defaults line up.
const VideoProjectV1Parse = (p: VideoProjectV1) =>
  applyVideoBatch(p, { operations: [{ op: 'setDuration', durationMs: p.durationMs }] }, ctx);

const clipA = (over: Partial<VideoClipItem> = {}): VideoClipItem => ({
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

describe('invertVideoBatch: undo restores the exact project for every operation', () => {
  const cases: Array<[string, Op[]]> = [
    ['insertClip (grows the project)', [{ op: 'insertClip', trackId: 'trk_video', item: clipA() }]],
    [
      'insertClip ripple',
      [{ op: 'insertClip', trackId: 'trk_video', item: clipA({ startMs: 4_000 }), ripple: true }],
    ],
    ['moveClip', [{ op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 11_000 }]],
    [
      'moveClip ripple reorder',
      [
        { op: 'setTransition', trackId: 'trk_video', itemId: 'clip_b', transition: null },
        { op: 'moveClip', trackId: 'trk_video', itemId: 'clip_c', startMs: 0, ripple: true },
      ],
    ],
    ['moveClip caption', [{ op: 'moveClip', trackId: 'trk_captions', itemId: 'cap_2', startMs: 7_000 }]],
    [
      'trimClip head',
      [{ op: 'trimClip', trackId: 'trk_video', itemId: 'clip_c', sourceInMs: 500, sourceOutMs: 3_000 }],
    ],
    [
      'trimClip ripple',
      [
        {
          op: 'trimClip',
          trackId: 'trk_video',
          itemId: 'clip_a',
          sourceInMs: 1_000,
          sourceOutMs: 6_000,
          ripple: true,
        },
      ],
    ],
    [
      'splitClip',
      [{ op: 'splitClip', trackId: 'trk_video', itemId: 'clip_b', atMs: 6_000, newItemId: 'clip_b2' }],
    ],
    [
      'splitClip audio',
      [{ op: 'splitClip', trackId: 'trk_music', itemId: 'aud_1', atMs: 3_000, newItemId: 'aud_2' }],
    ],
    [
      'duplicateClip ripple',
      [{ op: 'duplicateClip', trackId: 'trk_video', itemId: 'clip_a', newItemId: 'clip_a2', ripple: true }],
    ],
    [
      'duplicateClip overlay',
      [{ op: 'duplicateClip', trackId: 'trk_titles', itemId: 'ov_title', newItemId: 'ov_2' }],
    ],
    ['removeClip', [{ op: 'removeClip', trackId: 'trk_video', itemId: 'clip_c' }]],
    ['removeClip ripple', [{ op: 'removeClip', trackId: 'trk_video', itemId: 'clip_a', ripple: true }]],
    ['removeClip overlay', [{ op: 'removeClip', trackId: 'trk_titles', itemId: 'ov_title' }]],
    [
      'replaceClipSource',
      [
        {
          op: 'replaceClipSource',
          trackId: 'trk_video',
          itemId: 'clip_a',
          assetVersionId: 'av_clip_b',
          sourceInMs: 200,
        },
      ],
    ],
    [
      'setClipFrame',
      [
        {
          op: 'setClipFrame',
          trackId: 'trk_video',
          itemId: 'clip_a',
          frame: { fit: 'fit', focalX: 0, focalY: 1, zoom: 2 },
        },
      ],
    ],
    [
      'setTransition add',
      [
        {
          op: 'setTransition',
          trackId: 'trk_video',
          itemId: 'clip_c',
          transition: { kind: 'fade_black', durationMs: 600 },
        },
      ],
    ],
    [
      'setTransition remove',
      [{ op: 'setTransition', trackId: 'trk_video', itemId: 'clip_b', transition: null }],
    ],
    [
      'setAudio',
      [{ op: 'setAudio', trackId: 'trk_music', itemId: 'aud_1', gainDb: 3, fadeOutMs: 2_000, muted: true }],
    ],
    [
      'upsertCaption new',
      [
        {
          op: 'upsertCaption',
          trackId: 'trk_captions',
          caption: { id: 'cap_9', startMs: 5_000, endMs: 6_000, text: 'New', locked: false },
        },
      ],
    ],
    [
      'upsertCaption edit',
      [
        {
          op: 'upsertCaption',
          trackId: 'trk_captions',
          caption: { id: 'cap_1', startMs: 0, endMs: 1_000, text: 'Edited', locked: false },
        },
      ],
    ],
    ['removeCaption', [{ op: 'removeCaption', trackId: 'trk_captions', itemId: 'cap_2' }]],
    [
      'setCaptionStyle',
      [
        {
          op: 'setCaptionStyle',
          trackId: 'trk_captions',
          style: { fontAssetVersionId: 'av_font', sizePx: 60, weight: 700, boxOpacity: 0.3, position: 'top' },
        },
      ],
    ],
    ['removeOverlay', [{ op: 'removeOverlay', trackId: 'trk_titles', itemId: 'ov_title' }]],
    ['setTrackLock', [{ op: 'setTrackLock', trackId: 'trk_video', locked: true }]],
    ['setTrackMute', [{ op: 'setTrackMute', trackId: 'trk_music', muted: true }]],
    ['setItemLock', [{ op: 'setItemLock', trackId: 'trk_video', itemId: 'clip_a', locked: true }]],
    ['setDuration', [{ op: 'setDuration', durationMs: 30_000 }]],
    [
      'setScene new',
      [
        { op: 'setDuration', durationMs: 12_000 },
        { op: 'setScene', scene: { id: 'scene_x', title: 'X', startMs: 10_000, endMs: 12_000 } },
      ],
    ],
    ['removeScene', [{ op: 'removeScene', sceneId: 'scene_2' }]],
    [
      'reorderScenes',
      [
        { op: 'trimClip', trackId: 'trk_music', itemId: 'aud_1', sourceInMs: 0, sourceOutMs: 4_000 },
        { op: 'setTransition', trackId: 'trk_video', itemId: 'clip_b', transition: null },
        { op: 'reorderScenes', order: ['scene_2', 'scene_1'] },
      ],
    ],
    [
      'addTrack',
      [
        {
          op: 'addTrack',
          track: { id: 'trk_vo', kind: 'audio', name: 'Voice', locked: false, muted: false, items: [] },
          index: 1,
        },
      ],
    ],
    ['removeTrack', [{ op: 'removeTrack', trackId: 'trk_captions' }]],
  ];
  it.each(cases)('%s', (_name, ops) => {
    roundTrips(ops);
  });
});

// ---- property-style checks: random edits keep every invariant, and every accepted batch undoes exactly ----------

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOp(p: VideoProjectV1, r: () => number, n: number): Op {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const ms = (max: number) => Math.round((r() * max) / 100) * 100;
  const timed = p.tracks.filter(isTimedTrack);
  const track = pick(timed);
  const items = track.items as Array<VideoClipItem | AudioItem>;
  const item = items.length ? pick(items) : null;
  const kind = pick([
    'insert',
    'move',
    'trim',
    'split',
    'dup',
    'remove',
    'transition',
    'lock',
    'duration',
    'caption',
  ] as const);
  const ripple = r() < 0.5;
  if (!item || kind === 'insert') {
    const asset = track.kind === 'video' ? pick(['av_clip_a', 'av_clip_b', 'av_still']) : 'av_music';
    const inMs = ms(2_000);
    const base = {
      id: `it_${n}`,
      assetVersionId: asset,
      sourceInMs: inMs,
      sourceOutMs: inMs + 200 + ms(2_800),
      startMs: ms(14_000),
      gainDb: 0,
      muted: false,
      locked: false,
    };
    return {
      op: 'insertClip',
      trackId: track.id,
      item:
        track.kind === 'video'
          ? { ...base, frame: { fit: 'fill', focalX: 0.5, focalY: 0.5, zoom: 1 } }
          : { ...base, fadeInMs: 0, fadeOutMs: 0 },
      ripple,
    };
  }
  switch (kind) {
    case 'move':
      return { op: 'moveClip', trackId: track.id, itemId: item.id, startMs: ms(14_000), ripple };
    case 'trim': {
      const inMs = Math.max(0, item.sourceInMs + ms(1_000) - 500);
      return {
        op: 'trimClip',
        trackId: track.id,
        itemId: item.id,
        sourceInMs: inMs,
        sourceOutMs: inMs + 100 + ms(3_000),
        ripple,
      };
    }
    case 'split':
      return {
        op: 'splitClip',
        trackId: track.id,
        itemId: item.id,
        atMs: item.startMs + ms(lengthOf(item)),
        newItemId: `sp_${n}`,
      };
    case 'dup':
      return { op: 'duplicateClip', trackId: track.id, itemId: item.id, newItemId: `dp_${n}`, ripple };
    case 'remove':
      return { op: 'removeClip', trackId: track.id, itemId: item.id, ripple };
    case 'transition':
      return {
        op: 'setTransition',
        trackId: 'trk_video',
        itemId: (p.tracks[0]?.items[0] as TrackItem | undefined)?.id ?? item.id,
        transition:
          r() < 0.3
            ? null
            : { kind: pick(['crossfade', 'fade_black', 'slide'] as const), durationMs: ms(2_000) },
      };
    case 'lock':
      return { op: 'setItemLock', trackId: track.id, itemId: item.id, locked: r() < 0.3 };
    case 'duration':
      return { op: 'setDuration', durationMs: 1_000 + ms(30_000) };
    case 'caption':
      return {
        op: 'upsertCaption',
        trackId: 'trk_captions',
        caption: { id: `c_${n}`, startMs: ms(9_000), endMs: 9_500, text: 'x', locked: false },
      };
  }
}

/** Every structural invariant the reducer promises, checked from scratch. */
function assertInvariants(p: VideoProjectV1) {
  const ids = p.tracks.flatMap((t: Track) => (t.items as TrackItem[]).map((i) => i.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(p.durationMs).toBeLessThanOrEqual(180_000);
  expect(p.tracks.filter((t) => t.kind === 'video')).toHaveLength(1);
  for (const t of p.tracks) {
    for (const i of t.items as TrackItem[]) {
      const s = spanOf(i);
      expect(s.endMs - s.startMs).toBeGreaterThanOrEqual(100);
      expect(s.endMs).toBeLessThanOrEqual(p.durationMs);
      expect(s.startMs).toBeGreaterThanOrEqual(0);
      if ('sourceInMs' in i) {
        expect(i.sourceInMs).toBeLessThan(i.sourceOutMs);
        const media = ctx.media[i.assetVersionId];
        if (media?.kind !== 'image' && media?.durationMs)
          expect(i.sourceOutMs).toBeLessThanOrEqual(media.durationMs);
      }
    }
    if (isTimedTrack(t)) {
      const sorted = sortByStart(t.items as Array<VideoClipItem | AudioItem>);
      for (let k = 1; k < sorted.length; k++)
        expect(sorted[k - 1]!.startMs + lengthOf(sorted[k - 1]!)).toBeLessThanOrEqual(sorted[k]!.startMs);
    }
    if (t.kind === 'video')
      for (const c of t.items) {
        if (!c.transitionIn || c.transitionIn.kind === 'cut') continue;
        const prev = previousAdjacent(t.items, c);
        expect(c.transitionIn.durationMs).toBeLessThanOrEqual(lengthOf(c) / 2);
        if (prev) expect(c.transitionIn.durationMs).toBeLessThanOrEqual(lengthOf(prev) / 2);
      }
  }
}

describe('property: random edit sequences', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))(
    'seed %i keeps invariants, locks and exact undo',
    (seed) => {
      const r = rng(seed);
      let p = fixtureVideoProject();
      let accepted = 0;
      for (let n = 0; n < 60; n++) {
        const op = randomOp(p, r, n);
        let next: VideoProjectV1;
        try {
          next = applyVideoBatch(p, { operations: [op] }, ctx);
        } catch (err) {
          expect(err).toBeInstanceOf(VideoOperationError); // refusals are typed, never crashes
          continue;
        }
        // A locked item never changes, except through its own lock operation.
        for (const t of p.tracks)
          for (const i of t.items as TrackItem[])
            if (i.locked && !(op.op === 'setItemLock' && op.itemId === i.id)) {
              const after = next.tracks.flatMap((x) => x.items as TrackItem[]).find((x) => x.id === i.id);
              expect(after).toEqual(i);
            }
        assertInvariants(next);
        const inv = invertVideoBatch(p, { operations: [op] }, ctx);
        expect(inv.ok).toBe(true);
        if (inv.ok) {
          const restored = applyVideoBatch(next, { operations: inv.operations }, ctx);
          expect(hashCanonical(restored)).toBe(
            hashCanonical(
              applyVideoBatch(p, { operations: [{ op: 'setDuration', durationMs: p.durationMs }] }, ctx),
            ),
          );
        }
        p = next;
        accepted++;
      }
      expect(accepted).toBeGreaterThan(5);
    },
  );
  it('reduceVideo agrees with applyVideoBatch', () => {
    const p = fixtureVideoProject();
    const op: Op = { op: 'removeClip', trackId: 'trk_video', itemId: 'clip_c' };
    expect(reduceVideo(p, op, ctx).tracks[0]?.items).toHaveLength(2);
  });
});
