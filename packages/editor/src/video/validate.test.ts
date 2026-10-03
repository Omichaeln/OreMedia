import { describe, expect, it } from 'vitest';
import type { CaptionTrack, OverlayTrack, VideoClipItem } from '@oremedia/contracts/video';
import { fixtureSnapshot } from '../fixtures';
import { VIDEO_FIXTURE_MEDIA, fixtureVideoProject } from './fixtures';
import { validateVideoProject } from './validate';

const run = (
  mutate: (p: ReturnType<typeof fixtureVideoProject>) => void = () => undefined,
  media = VIDEO_FIXTURE_MEDIA,
) => {
  const p = fixtureVideoProject();
  mutate(p);
  return validateVideoProject(p, { media, snapshot: fixtureSnapshot() });
};
const codes = (fs: ReturnType<typeof run>) => fs.map((f) => `${f.code}:${f.severity}:${f.elementId ?? ''}`);

describe('validateVideoProject', () => {
  it('the fixture is clean of blocking findings', () => {
    expect(run().filter((f) => f.severity === 'blocking')).toEqual([]);
  });
  it('names a missing source and a clip beyond its source, with what to do', () => {
    const { av_clip_b: _gone, ...rest } = VIDEO_FIXTURE_MEDIA;
    const missing = run(() => undefined, rest);
    expect(codes(missing)).toContain('missing_asset:blocking:clip_b');
    expect(missing.find((f) => f.code === 'missing_asset')?.message).toMatch(/replace it/);
    const beyond = run((p) => {
      (p.tracks[0]?.items[0] as VideoClipItem).sourceOutMs = 6_500;
    });
    expect(beyond.find((f) => f.code === 'clip_beyond_source')?.message).toMatch(
      /ends at 6.50 s of a 6.00 s source/,
    );
  });
  it('reports black gaps, a transition with no clip before it, and an empty picture track', () => {
    const gaps = run((p) => {
      const v = p.tracks[0]?.items as VideoClipItem[];
      v.splice(0, 1); // B keeps its crossfade, now with nothing before it
    });
    expect(codes(gaps)).toEqual(
      expect.arrayContaining(['black_gap:warning:clip_b', 'unsupported_transition:warning:clip_b']),
    );
    expect(codes(run((p) => void ((p.tracks[0] as { items: unknown[] }).items = [])))).toContain(
      'no_clips:blocking:',
    );
  });
  it('flags overlapping and too-fast captions and prohibited phrases', () => {
    const fs = run((p) => {
      const c = p.tracks[2] as CaptionTrack;
      c.items[1] = {
        ...c.items[1]!,
        startMs: 1_500,
        text: 'This is cheap and it is a very long caption for half a second',
      };
      c.items[1].endMs = 2_000;
    });
    expect(codes(fs)).toEqual(
      expect.arrayContaining([
        'caption_overlap:warning:cap_2',
        'caption_too_fast:warning:cap_2',
        'prohibited_phrase:blocking:cap_2',
      ]),
    );
  });
  it('checks overlays with the graphic brand rules at the output preset (tokens, safe area, overflow)', () => {
    const fs = run((p) => {
      const o = (p.tracks[1] as OverlayTrack).items[0]!;
      if (o.element.type !== 'text') throw new Error('fixture');
      o.element.style.colourToken = 'nope';
      o.element.transform.y = 10; // into the 9:16 top safe area
    });
    expect(codes(fs)).toEqual(
      expect.arrayContaining(['unknown_colour_token:blocking:ov_title', 'safe_area:blocking:ov_title']),
    );
  });
});
