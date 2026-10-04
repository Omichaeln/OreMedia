import { describe, expect, it } from 'vitest';
import { VideoProjectV1, VideoTemplateSummary } from '@oremedia/contracts/video';
import { applyVideoBatch } from './reduce';
import { captionElements, captionsVtt, overlayAnimationAt, SLIDE_FRACTION } from './overlays';
import { fixtureVideoProject } from './fixtures';
import {
  blankVideoProject,
  instantiateVideoTemplate,
  listVideoTemplates,
  VIDEO_TEMPLATE_KEYS,
} from './templates';

let n = 0;
const bindings = {
  brandVersionId: 'bv_1',
  fonts: { display: 'av_font_display', heading: 'av_font_heading', caption: 'av_font_caption' },
  colours: { text: 'paper', box: 'ink', accent: 'accent' },
  logoAssetVersionId: 'av_logo',
  newElementId: () => `el_${String(++n).padStart(26, '0')}`,
};

describe('built-in video templates', () => {
  it('lists three templates (15 s vertical promo, 30 s 16:9 demo, 6 s bumper) with scenes and slots', () => {
    const list = listVideoTemplates();
    expect(list.map((t) => [t.key, t.formatKey, t.durationMs])).toEqual([
      ['promo_vertical_15s', 'video_9x16', 15_000],
      ['product_demo_16x9_30s', 'video_16x9', 30_000],
      ['bumper_6s', 'video_1x1', 6_000],
    ]);
    for (const t of list) {
      VideoTemplateSummary.parse(t);
      expect(t.slots.some((s) => s.kind === 'clip')).toBe(true);
      expect(t.slots.some((s) => s.kind === 'logo')).toBe(true);
    }
  });
  it.each(VIDEO_TEMPLATE_KEYS)(
    '%s instantiates into a valid project bound to the brand tokens, editable by the reducer',
    (key) => {
      const p = instantiateVideoTemplate(key, bindings);
      expect(p).not.toBeNull();
      const project = VideoProjectV1.parse(p);
      expect(project.templateKey).toBe(key);
      const overlays = project.tracks.find((t) => t.kind === 'overlay');
      const texts =
        overlays?.kind === 'overlay' ? overlays.items.filter((o) => o.element.type === 'text') : [];
      expect(texts.length).toBeGreaterThan(0);
      for (const o of texts)
        if (o.element.type === 'text') {
          expect(o.element.style.colourToken).toBe('paper');
          expect(['av_font_display', 'av_font_heading']).toContain(o.element.style.fontAssetVersionId);
        }
      expect(
        overlays?.kind === 'overlay' && overlays.items.find((o) => o.id === 'ov_logo')?.element,
      ).toMatchObject({ type: 'logo', assetVersionId: 'av_logo', protected: true });
      // The reducer accepts the template as a base: a no-op duration set passes every invariant.
      expect(
        applyVideoBatch(project, { operations: [{ op: 'setDuration', durationMs: project.durationMs }] })
          .durationMs,
      ).toBe(project.durationMs);
    },
  );
  it('without brand fonts or logo the text and logo slots stay empty; unknown keys give null', () => {
    const p = instantiateVideoTemplate('bumper_6s', {
      ...bindings,
      fonts: {},
      logoAssetVersionId: undefined,
    });
    expect(p?.tracks.find((t) => t.kind === 'overlay')?.items).toEqual([]);
    expect(p?.tracks.some((t) => t.kind === 'caption')).toBe(false);
    expect(instantiateVideoTemplate('nope', bindings)).toBeNull();
    expect(
      VideoProjectV1.parse(blankVideoProject(bindings, { formatKey: 'video_4x5', fps: 25 })).format,
    ).toEqual({ key: 'video_4x5', width: 1080, height: 1350, fps: 25 });
  });
});

describe('overlay helpers shared by preview and compositor', () => {
  it('animates fade and slide linearly over the enter and exit windows', () => {
    const o = {
      startMs: 1_000,
      endMs: 3_000,
      enter: { kind: 'fade' as const, durationMs: 500 },
      exit: { kind: 'slide_up' as const, durationMs: 400 },
    };
    expect(overlayAnimationAt(o, 1_000, 1920)).toEqual({ opacity: 0, dy: 0 });
    expect(overlayAnimationAt(o, 1_250, 1920).opacity).toBeCloseTo(0.5);
    expect(overlayAnimationAt(o, 2_000, 1920)).toEqual({ opacity: 1, dy: 0 });
    expect(overlayAnimationAt(o, 3_000, 1920).dy).toBeCloseTo(-SLIDE_FRACTION * 1920);
  });
  it('lays captions in the safe area with a box and shrink-to-fit text', () => {
    const p = fixtureVideoProject();
    const track = p.tracks[2];
    if (track?.kind !== 'caption') throw new Error('fixture');
    const [box, text] = captionElements(p, track, track.items[0]!);
    expect(box).toMatchObject({ type: 'shape', fillToken: 'ink', opacity: 0.6 });
    expect(text).toMatchObject({
      type: 'text',
      text: 'First caption',
      style: { overflow: 'shrink_to_fit', align: 'center' },
    });
    expect(box!.transform.y + box!.transform.height).toBe(1920 - 320);
  });
  it('writes WebVTT cues for every caption in time order', () => {
    expect(captionsVtt(fixtureVideoProject())).toBe(
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nFirst caption\n\n2\n00:00:02.000 --> 00:00:04.000\nSecond caption\n',
    );
  });
});
