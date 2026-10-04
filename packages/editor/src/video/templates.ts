import type { Element, TextElement } from '@oremedia/contracts/creative';
import {
  VIDEO_FORMATS,
  type CaptionTrack,
  type OverlayItem,
  type Track,
  type VideoFormatKey,
  type VideoFps,
  type VideoProjectV1,
  type VideoScene,
  type VideoTemplateSlot,
  type VideoTemplateSummary,
} from '@oremedia/contracts/video';

/**
 * Built-in starter video templates (architecture principle 5: templates are composition structure). Each is data:
 * an output preset, scenes, clip placeholders (slots on the video track the creation screen or STU-3 assembly
 * fills), and title, caption and logo overlays bound to the brand's tokens when instantiated. STU-1a's creation
 * screen lists them with listVideoTemplates and creates a document with `video.templateKey`.
 */

interface TextSpec {
  key: string;
  label: string;
  text: string;
  role: 'display' | 'heading' | 'body';
  sizePx: number;
  /** Box in output pixels. */
  box: { x: number; y: number; width: number; height: number };
  startMs: number;
  endMs: number;
  enter?: OverlayItem['enter'];
  exit?: OverlayItem['exit'];
}

interface TemplateSpec {
  key: string;
  name: string;
  description: string;
  formatKey: VideoFormatKey;
  fps: VideoFps;
  durationMs: number;
  scenes: VideoScene[];
  clips: Array<{ key: string; label: string; sceneId: string; startMs: number; endMs: number; hint: string }>;
  texts: TextSpec[];
  logo?: { box: { x: number; y: number; width: number; height: number }; startMs: number; endMs: number };
  captions: Array<{ startMs: number; endMs: number; text: string }>;
  music: boolean;
}

const fade = (durationMs: number) => ({ kind: 'fade' as const, durationMs });
const slide = (durationMs: number) => ({ kind: 'slide_up' as const, durationMs });

const TEMPLATES: readonly TemplateSpec[] = [
  {
    key: 'promo_vertical_15s',
    name: 'Vertical promo, 15 s',
    description: 'Hook, product, offer and call to action for stories, reels and shorts.',
    formatKey: 'video_9x16',
    fps: 30,
    durationMs: 15_000,
    scenes: [
      { id: 'scene_hook', title: 'Hook', startMs: 0, endMs: 3_000 },
      { id: 'scene_product', title: 'Product', startMs: 3_000, endMs: 9_000 },
      { id: 'scene_offer', title: 'Offer', startMs: 9_000, endMs: 12_000 },
      { id: 'scene_cta', title: 'Call to action', startMs: 12_000, endMs: 15_000 },
    ],
    clips: [
      {
        key: 'hook_clip',
        label: 'Hook shot',
        sceneId: 'scene_hook',
        startMs: 0,
        endMs: 3_000,
        hint: 'An attention-grabbing moment, motion in the first second',
      },
      {
        key: 'product_clip',
        label: 'Product in use',
        sceneId: 'scene_product',
        startMs: 3_000,
        endMs: 9_000,
        hint: 'The product being used, close up',
      },
      {
        key: 'offer_clip',
        label: 'Offer shot',
        sceneId: 'scene_offer',
        startMs: 9_000,
        endMs: 12_000,
        hint: 'The product or a lifestyle shot behind the offer',
      },
      {
        key: 'cta_clip',
        label: 'Closing shot',
        sceneId: 'scene_cta',
        startMs: 12_000,
        endMs: 15_000,
        hint: 'A calm closing shot behind the call to action',
      },
    ],
    texts: [
      {
        key: 'hook_title',
        label: 'Hook line',
        text: 'Your hook line',
        role: 'display',
        sizePx: 96,
        box: { x: 64, y: 300, width: 952, height: 260 },
        startMs: 0,
        endMs: 3_000,
        enter: slide(400),
        exit: fade(300),
      },
      {
        key: 'offer_title',
        label: 'Offer',
        text: 'The offer',
        role: 'heading',
        sizePx: 80,
        box: { x: 64, y: 760, width: 952, height: 220 },
        startMs: 9_000,
        endMs: 12_000,
        enter: fade(300),
        exit: fade(300),
      },
      {
        key: 'cta_title',
        label: 'Call to action',
        text: 'Shop now',
        role: 'heading',
        sizePx: 88,
        box: { x: 64, y: 1300, width: 952, height: 200 },
        startMs: 12_000,
        endMs: 15_000,
        enter: slide(400),
      },
    ],
    logo: { box: { x: 390, y: 1080, width: 300, height: 150 }, startMs: 12_000, endMs: 15_000 },
    captions: [
      { startMs: 3_000, endMs: 6_000, text: 'Say what it does in a few words' },
      { startMs: 6_000, endMs: 9_000, text: 'And why it matters to your audience' },
    ],
    music: true,
  },
  {
    key: 'product_demo_16x9_30s',
    name: 'Product demo, 30 s',
    description: 'Intro, three features and an outro for LinkedIn, X and websites.',
    formatKey: 'video_16x9',
    fps: 30,
    durationMs: 30_000,
    scenes: [
      { id: 'scene_intro', title: 'Intro', startMs: 0, endMs: 4_000 },
      { id: 'scene_feature_1', title: 'Feature 1', startMs: 4_000, endMs: 12_000 },
      { id: 'scene_feature_2', title: 'Feature 2', startMs: 12_000, endMs: 20_000 },
      { id: 'scene_feature_3', title: 'Feature 3', startMs: 20_000, endMs: 26_000 },
      { id: 'scene_outro', title: 'Outro', startMs: 26_000, endMs: 30_000 },
    ],
    clips: [
      {
        key: 'intro_clip',
        label: 'Intro shot',
        sceneId: 'scene_intro',
        startMs: 0,
        endMs: 4_000,
        hint: 'The product or team, wide',
      },
      {
        key: 'feature_1_clip',
        label: 'Feature 1 footage',
        sceneId: 'scene_feature_1',
        startMs: 4_000,
        endMs: 12_000,
        hint: 'Screen recording or close-up of the first feature',
      },
      {
        key: 'feature_2_clip',
        label: 'Feature 2 footage',
        sceneId: 'scene_feature_2',
        startMs: 12_000,
        endMs: 20_000,
        hint: 'The second feature in use',
      },
      {
        key: 'feature_3_clip',
        label: 'Feature 3 footage',
        sceneId: 'scene_feature_3',
        startMs: 20_000,
        endMs: 26_000,
        hint: 'The third feature in use',
      },
      {
        key: 'outro_clip',
        label: 'Outro shot',
        sceneId: 'scene_outro',
        startMs: 26_000,
        endMs: 30_000,
        hint: 'A calm closing shot behind the logo',
      },
    ],
    texts: [
      {
        key: 'intro_title',
        label: 'Product name',
        text: 'Product name',
        role: 'display',
        sizePx: 96,
        box: { x: 96, y: 380, width: 1728, height: 200 },
        startMs: 0,
        endMs: 4_000,
        enter: fade(500),
        exit: fade(400),
      },
      {
        key: 'feature_1_title',
        label: 'Feature 1',
        text: 'Feature one',
        role: 'heading',
        sizePx: 64,
        box: { x: 96, y: 80, width: 1200, height: 120 },
        startMs: 4_000,
        endMs: 12_000,
        enter: slide(400),
        exit: fade(300),
      },
      {
        key: 'feature_2_title',
        label: 'Feature 2',
        text: 'Feature two',
        role: 'heading',
        sizePx: 64,
        box: { x: 96, y: 80, width: 1200, height: 120 },
        startMs: 12_000,
        endMs: 20_000,
        enter: slide(400),
        exit: fade(300),
      },
      {
        key: 'feature_3_title',
        label: 'Feature 3',
        text: 'Feature three',
        role: 'heading',
        sizePx: 64,
        box: { x: 96, y: 80, width: 1200, height: 120 },
        startMs: 20_000,
        endMs: 26_000,
        enter: slide(400),
        exit: fade(300),
      },
    ],
    logo: { box: { x: 760, y: 440, width: 400, height: 200 }, startMs: 26_000, endMs: 30_000 },
    captions: [
      { startMs: 4_000, endMs: 8_000, text: 'Describe the first feature' },
      { startMs: 12_000, endMs: 16_000, text: 'Describe the second feature' },
      { startMs: 20_000, endMs: 24_000, text: 'Describe the third feature' },
    ],
    music: true,
  },
  {
    key: 'bumper_6s',
    name: 'Bumper, 6 s',
    description: 'One shot, one line and the logo: a six-second bumper.',
    formatKey: 'video_1x1',
    fps: 30,
    durationMs: 6_000,
    scenes: [
      { id: 'scene_shot', title: 'Shot', startMs: 0, endMs: 4_000 },
      { id: 'scene_logo', title: 'Logo', startMs: 4_000, endMs: 6_000 },
    ],
    clips: [
      {
        key: 'main_clip',
        label: 'Main shot',
        sceneId: 'scene_shot',
        startMs: 0,
        endMs: 6_000,
        hint: 'One striking shot that runs under the logo',
      },
    ],
    texts: [
      {
        key: 'line',
        label: 'Line',
        text: 'One line that sticks',
        role: 'display',
        sizePx: 80,
        box: { x: 54, y: 760, width: 972, height: 220 },
        startMs: 500,
        endMs: 4_000,
        enter: slide(400),
        exit: fade(300),
      },
    ],
    logo: { box: { x: 365, y: 440, width: 350, height: 200 }, startMs: 4_000, endMs: 6_000 },
    captions: [],
    music: true,
  },
];

export const VIDEO_TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);

const TRACK_IDS = { video: 'trk_video', overlay: 'trk_titles', caption: 'trk_captions', audio: 'trk_music' };

function slotsOf(t: TemplateSpec): VideoTemplateSlot[] {
  return [
    ...t.clips.map((c) => ({
      key: c.key,
      kind: 'clip' as const,
      label: c.label,
      trackId: TRACK_IDS.video,
      sceneId: c.sceneId,
      startMs: c.startMs,
      endMs: c.endMs,
      hint: c.hint,
    })),
    ...t.texts.map((x) => ({
      key: x.key,
      kind: 'text' as const,
      label: x.label,
      trackId: TRACK_IDS.overlay,
      itemId: `ov_${x.key}`,
      startMs: x.startMs,
      endMs: x.endMs,
      hint: x.text,
    })),
    ...(t.logo
      ? [
          {
            key: 'logo',
            kind: 'logo' as const,
            label: 'Logo',
            trackId: TRACK_IDS.overlay,
            itemId: 'ov_logo',
            startMs: t.logo.startMs,
            endMs: t.logo.endMs,
          },
        ]
      : []),
    ...t.captions.map((c, i) => ({
      key: `caption_${i + 1}`,
      kind: 'caption' as const,
      label: `Caption ${i + 1}`,
      trackId: TRACK_IDS.caption,
      itemId: `cap_${i + 1}`,
      startMs: c.startMs,
      endMs: c.endMs,
      hint: c.text,
    })),
    ...(t.music
      ? [
          {
            key: 'music',
            kind: 'audio' as const,
            label: 'Music',
            trackId: TRACK_IDS.audio,
            startMs: 0,
            endMs: t.durationMs,
          },
        ]
      : []),
  ];
}

/** The built-in starter templates, as the creation screen lists them. */
export function listVideoTemplates(): VideoTemplateSummary[] {
  return TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    formatKey: t.formatKey,
    fps: t.fps,
    durationMs: t.durationMs,
    scenes: structuredClone(t.scenes),
    slots: slotsOf(t),
  }));
}

/** The brand's tokens a template binds to (resolved by the service from the published brand snapshot). */
export interface VideoBrandBindings {
  brandVersionId: string;
  /** Current font asset versions per type role (display/heading/body/caption), when the brand has them. */
  fonts: Partial<Record<'display' | 'heading' | 'body' | 'label' | 'caption', string>>;
  /** Colour token keys for text on video, the caption box and an accent. */
  colours: { text?: string; box?: string; accent?: string };
  /** The brand's primary logo version, when it has one. */
  logoAssetVersionId?: string;
  /** Mints element ids (overlay elements carry graphic element ids). */
  newElementId: () => string;
}

const fontFor = (b: VideoBrandBindings, role: TextSpec['role'] | 'caption'): string | undefined =>
  role === 'caption'
    ? (b.fonts.caption ?? b.fonts.body ?? b.fonts.heading)
    : role === 'body'
      ? (b.fonts.body ?? b.fonts.heading)
      : (b.fonts[role] ?? b.fonts.heading ?? b.fonts.display ?? b.fonts.body);

/** Tracks every new video starts with: the picture, titles, captions (when the brand has a font) and music. */
function baseTracks(b: VideoBrandBindings, withCaptions: boolean): Track[] {
  const captionFont = fontFor(b, 'caption');
  const tracks: Track[] = [
    { id: TRACK_IDS.video, kind: 'video', name: 'Video', locked: false, muted: false, items: [] },
    { id: TRACK_IDS.overlay, kind: 'overlay', name: 'Titles', locked: false, items: [] },
  ];
  if (withCaptions && captionFont)
    tracks.push({
      id: TRACK_IDS.caption,
      kind: 'caption',
      name: 'Captions',
      locked: false,
      style: {
        fontAssetVersionId: captionFont,
        sizePx: 48,
        weight: 600,
        ...(b.colours.text ? { colourToken: b.colours.text } : { colourValue: '#ffffff' }),
        ...(b.colours.box ? { boxToken: b.colours.box } : {}),
        boxOpacity: 0.6,
        position: 'bottom',
      },
      items: [],
    } satisfies CaptionTrack);
  tracks.push({ id: TRACK_IDS.audio, kind: 'audio', name: 'Music', locked: false, muted: false, items: [] });
  return tracks;
}

/** A blank project at an output preset (no template). */
export function blankVideoProject(
  b: VideoBrandBindings,
  opts: { formatKey: VideoFormatKey; fps: VideoFps; durationMs?: number },
): VideoProjectV1 {
  const f = VIDEO_FORMATS[opts.formatKey];
  return {
    schemaVersion: 1,
    kind: 'video',
    brandVersionId: b.brandVersionId,
    format: { key: f.key as VideoFormatKey, width: f.width, height: f.height, fps: opts.fps },
    durationMs: opts.durationMs ?? 15_000,
    tracks: baseTracks(b, true),
    scenes: [],
  };
}

/**
 * A project from a starter template, bound to the brand: text overlays in the brand's display/heading font and
 * text colour, captions in its caption font over its box colour, the primary logo at the end. Text overlays need a
 * brand font and the logo a logo asset; without them those slots stay listed but empty.
 */
export function instantiateVideoTemplate(
  key: string,
  b: VideoBrandBindings,
  opts: { fps?: VideoFps } = {},
): VideoProjectV1 | null {
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) return null;
  const project = blankVideoProject(b, {
    formatKey: t.formatKey,
    fps: opts.fps ?? t.fps,
    durationMs: t.durationMs,
  });
  project.templateKey = t.key;
  project.scenes = structuredClone(t.scenes);
  const overlays = project.tracks.find((x) => x.kind === 'overlay');
  if (overlays?.kind === 'overlay') {
    for (const spec of t.texts) {
      const font = fontFor(b, spec.role);
      if (!font) continue;
      const element: TextElement = {
        id: b.newElementId(),
        name: spec.label,
        type: 'text',
        locked: false,
        visible: true,
        opacity: 1,
        protected: false,
        semanticRole: spec.role === 'body' ? 'body' : spec.key.startsWith('cta') ? 'cta' : 'headline',
        transform: { ...spec.box, rotation: 0 },
        text: spec.text,
        factRefs: [],
        style: {
          typeRole: spec.role,
          fontAssetVersionId: font,
          weight: 700,
          sizePx: spec.sizePx,
          lineHeight: 1.1,
          tracking: 0,
          ...(b.colours.text ? { colourToken: b.colours.text } : { colourValue: '#ffffff' }),
          align: 'center',
          overflow: 'shrink_to_fit',
        },
      };
      overlays.items.push({
        id: `ov_${spec.key}`,
        startMs: spec.startMs,
        endMs: spec.endMs,
        element,
        ...(spec.enter ? { enter: spec.enter } : {}),
        ...(spec.exit ? { exit: spec.exit } : {}),
        locked: false,
      });
    }
    if (t.logo && b.logoAssetVersionId) {
      const logo: Element = {
        id: b.newElementId(),
        name: 'Logo',
        type: 'logo',
        locked: false,
        visible: true,
        opacity: 1,
        protected: true,
        semanticRole: 'logo',
        transform: { ...t.logo.box, rotation: 0 },
        assetVersionId: b.logoAssetVersionId,
        variant: 'primary',
      };
      overlays.items.push({
        id: 'ov_logo',
        startMs: t.logo.startMs,
        endMs: t.logo.endMs,
        element: logo,
        enter: fade(300),
        locked: false,
      });
    }
    overlays.items.sort((a, c) => a.startMs - c.startMs || a.id.localeCompare(c.id));
  }
  const captions = project.tracks.find((x) => x.kind === 'caption');
  if (captions?.kind === 'caption')
    captions.items = t.captions.map((c, i) => ({ id: `cap_${i + 1}`, ...c, locked: false }));
  return project;
}
