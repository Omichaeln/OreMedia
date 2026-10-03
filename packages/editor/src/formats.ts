import {
  CUSTOM_FORMAT_MAX_ASPECT,
  CUSTOM_FORMAT_MAX_PX,
  CUSTOM_FORMAT_MIN_PX,
  type FormatDefinition,
} from '@oremedia/contracts/creative';

/** Format definitions referenced by page.formatKey: dimensions and safe areas per channel format. */
export const FORMAT_DEFINITIONS: Readonly<Record<string, FormatDefinition>> = {
  square_1080: {
    key: 'square_1080',
    label: 'Square 1080',
    width: 1080,
    height: 1080,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['instagram_business', 'facebook_page', 'linkedin_page'],
  },
  ig_feed_4x5: {
    key: 'ig_feed_4x5',
    label: 'Instagram feed 4:5',
    width: 1080,
    height: 1350,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['instagram_business'],
  },
  ig_story_9x16: {
    key: 'ig_story_9x16',
    label: 'Instagram story 9:16',
    width: 1080,
    height: 1920,
    safeArea: { top: 250, right: 54, bottom: 250, left: 54 },
    providerKeys: ['instagram_business', 'facebook_page'],
  },
  li_1200x627: {
    key: 'li_1200x627',
    label: 'LinkedIn link image',
    width: 1200,
    height: 627,
    safeArea: { top: 40, right: 40, bottom: 40, left: 40 },
    providerKeys: ['linkedin_page'],
  },
  li_1080x1080: {
    key: 'li_1080x1080',
    label: 'LinkedIn square',
    width: 1080,
    height: 1080,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['linkedin_page'],
  },
  fb_1200x630: {
    key: 'fb_1200x630',
    label: 'Facebook link image',
    width: 1200,
    height: 630,
    safeArea: { top: 40, right: 40, bottom: 40, left: 40 },
    providerKeys: ['facebook_page'],
  },
  x_1600x900: {
    key: 'x_1600x900',
    label: 'X image 16:9',
    width: 1600,
    height: 900,
    safeArea: { top: 48, right: 48, bottom: 48, left: 48 },
    providerKeys: ['x'],
  },
  tt_1080x1920: {
    key: 'tt_1080x1920',
    label: 'TikTok 9:16',
    width: 1080,
    height: 1920,
    safeArea: { top: 260, right: 120, bottom: 320, left: 54 },
    providerKeys: ['tiktok'],
  },
  // STU-1a: covers and banners for the thumbnail/banner content type.
  yt_thumbnail_1280x720: {
    key: 'yt_thumbnail_1280x720',
    label: 'YouTube thumbnail 16:9',
    width: 1280,
    height: 720,
    // The bottom-right corner carries the video duration badge.
    safeArea: { top: 40, right: 40, bottom: 72, left: 40 },
    providerKeys: ['youtube'],
  },
  li_banner_1584x396: {
    key: 'li_banner_1584x396',
    label: 'LinkedIn banner 4:1',
    width: 1584,
    height: 396,
    // The profile photo covers the lower left on profile pages.
    safeArea: { top: 32, right: 48, bottom: 32, left: 400 },
    providerKeys: ['linkedin_page'],
  },
};

const CUSTOM_KEY = /^custom_(\d{2,4})x(\d{2,4})$/;

/** Why a custom size is refused, or null when it is within the render limits and the aspect range. */
export function customFormatIssue(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return 'Width and height are whole pixels';
  if (width < CUSTOM_FORMAT_MIN_PX || height < CUSTOM_FORMAT_MIN_PX)
    return `Width and height are at least ${CUSTOM_FORMAT_MIN_PX}px`;
  if (width > CUSTOM_FORMAT_MAX_PX || height > CUSTOM_FORMAT_MAX_PX)
    return `Width and height are at most ${CUSTOM_FORMAT_MAX_PX}px (the render limit)`;
  if (Math.max(width, height) / Math.min(width, height) > CUSTOM_FORMAT_MAX_ASPECT)
    return `The long edge is at most ${CUSTOM_FORMAT_MAX_ASPECT} times the short edge`;
  return null;
}

export const customFormatKey = (width: number, height: number): string => `custom_${width}x${height}`;

/**
 * A custom size as a format definition: a safe area of 5% of the short edge on every side, no channel. Undefined for
 * a key that is not a valid custom size, so an out-of-range key is an unknown format everywhere.
 */
function customFormat(key: string): FormatDefinition | undefined {
  const m = CUSTOM_KEY.exec(key);
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (customFormatIssue(width, height) !== null) return undefined;
  const inset = Math.round(Math.min(width, height) * 0.05);
  return {
    key,
    label: `Custom ${width}×${height}`,
    width,
    height,
    safeArea: { top: inset, right: inset, bottom: inset, left: inset },
    providerKeys: [],
  };
}

export const formatFor = (key: string): FormatDefinition | undefined =>
  FORMAT_DEFINITIONS[key] ?? customFormat(key);

/** Greatest common divisor, for the aspect label of a size. */
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** "4:5", "16:9", "1.91:1" style label for a size: exact when small, else rounded to two decimals against 1. */
export function aspectLabel(width: number, height: number): string {
  const d = gcd(width, height);
  const w = width / d;
  const h = height / d;
  if (w <= 21 && h <= 21) return `${w}:${h}`;
  return width >= height
    ? `${Math.round((width / height) * 100) / 100}:1`
    : `1:${Math.round((height / width) * 100) / 100}`;
}
