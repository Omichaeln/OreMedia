import type { ContentType, FormatDefinition } from '@oremedia/contracts/creative';
import { VIDEO_FORMAT_KEYS, VIDEO_FORMATS } from '@oremedia/contracts/video';
import { FORMAT_DEFINITIONS, aspectLabel } from '@oremedia/editor';

/**
 * STU-1a (architecture principle 4): what a document is for, separate from its layout (format) and destinations.
 * The one place the creation screen learns which content types exist and which can be started here. The video
 * document kind (STU-2b) has no page formats: its tile opens the video start instead of filtering the gallery.
 */
export interface ContentTypeOption {
  key: ContentType;
  label: string;
  /** Used in suggested titles ("Promotional graphic – Spring offer – 3 Oct"). */
  titleLabel: string;
  description: string;
  /** Formats offered for a blank start of this type, first is the default. */
  formats: readonly string[];
  /** Pages a blank start gets. */
  pages: number;
  available: boolean;
  unavailableReason?: string;
}

export const CONTENT_TYPES: readonly ContentTypeOption[] = [
  {
    key: 'social_post',
    label: 'Social post',
    titleLabel: 'Promotional graphic',
    description: 'A single image for a feed post or a promotion.',
    formats: ['square_1080', 'ig_feed_4x5', 'li_1200x627', 'fb_1200x630', 'x_1600x900', 'li_1080x1080'],
    pages: 1,
    available: true,
  },
  {
    key: 'carousel',
    label: 'Carousel',
    titleLabel: 'Carousel',
    description: 'Several pages people swipe through.',
    formats: ['square_1080', 'ig_feed_4x5', 'li_1080x1080'],
    pages: 3,
    available: true,
  },
  {
    key: 'story',
    label: 'Story',
    titleLabel: 'Story',
    description: 'A vertical, full-screen 9:16 frame.',
    formats: ['ig_story_9x16', 'tt_1080x1920'],
    pages: 1,
    available: true,
  },
  {
    key: 'video',
    label: 'Video or reel',
    titleLabel: 'Video',
    description: 'A reel, short or video ad on a timeline.',
    // A video starts from an output preset or a video template in its own dialog, not from a page format.
    formats: [],
    pages: 1,
    available: true,
  },
  {
    key: 'thumbnail_banner',
    label: 'Thumbnail or banner',
    titleLabel: 'Cover',
    description: 'A video thumbnail, a cover or a profile banner.',
    formats: ['yt_thumbnail_1280x720', 'li_banner_1584x396'],
    pages: 1,
    available: true,
  },
  {
    key: 'custom',
    label: 'Custom artwork',
    titleLabel: 'Artwork',
    description: 'Any layout, at a preset or a size you choose.',
    formats: ['square_1080', 'x_1600x900', 'ig_feed_4x5'],
    pages: 1,
    available: true,
  },
];

export const contentTypeOf = (key: ContentType | undefined): ContentTypeOption =>
  CONTENT_TYPES.find((c) => c.key === key) ?? (CONTENT_TYPES[CONTENT_TYPES.length - 1] as ContentTypeOption);

/** Channels the gallery filters by (provider keys of the format definitions). */
export const CHANNELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'instagram_business', label: 'Instagram' },
  { key: 'facebook_page', label: 'Facebook' },
  { key: 'linkedin_page', label: 'LinkedIn' },
  { key: 'x', label: 'X' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'youtube', label: 'YouTube' },
];

/** "1080 × 1350 · 4:5" for a format key or a page size. */
export function dimensionsLabel(width: number, height: number): string {
  return `${width} × ${height} · ${aspectLabel(width, height)}`;
}

export const formatLabel = (key: string): string => FORMAT_DEFINITIONS[key]?.label ?? key;

/** "Promotional graphic – Spring offer – 3 Oct": content type, what it starts from, today's date. */
export function suggestTitle(type: ContentType, from: string | null, now = new Date()): string {
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return [contentTypeOf(type).titleLabel, from, date].filter(Boolean).join(' – ').slice(0, 200);
}

/**
 * The interface's two kinds of document: Still (pages on the canvas) and Motion (a timeline). Each lists the formats
 * the application can create and export for it: the page formats, and the video output presets.
 */
export type StudioKind = 'still' | 'motion';

export const KIND_FORMATS: Readonly<Record<StudioKind, readonly FormatDefinition[]>> = {
  still: Object.values(FORMAT_DEFINITIONS),
  motion: VIDEO_FORMAT_KEYS.map((k) => VIDEO_FORMATS[k]),
};

export const KINDS: ReadonlyArray<{ key: StudioKind; label: string; description: string; tools: string }> = [
  {
    key: 'still',
    label: 'Still',
    description:
      'Posts, carousels, stories, covers and banners. A layered canvas with brand templates and AI generation.',
    tools: 'Layers · drag-in assets · brand templates · rendered exports',
  },
  {
    key: 'motion',
    label: 'Motion',
    description: 'Reels, shorts and video ads. A multi-track timeline with an AI storyboard and AI edits.',
    tools: 'Multi-track timeline · captions and titles · AI storyboard from your assets',
  },
];

/** The platform list of the format step: each channel with the formats of a kind that it takes, in channel order. */
export const platformsOf = (kind: StudioKind) =>
  CHANNELS.map((c) => ({
    ...c,
    formats: KIND_FORMATS[kind].filter((f) => f.providerKeys.includes(c.key)),
  })).filter((p) => p.formats.length > 0);

/**
 * The content types a page format can be started as: those that offer it, then any a starter or template at that
 * format declares (a custom size is custom artwork). In the content-type order; never the video type.
 */
export function contentTypesFor(formatKey: string, declared: readonly ContentType[] = []): ContentType[] {
  const offered = CONTENT_TYPES.filter(
    (c) => c.key !== 'video' && (c.formats.includes(formatKey) || declared.includes(c.key)),
  ).map((c) => c.key);
  return offered.length > 0 ? offered : ['custom'];
}
