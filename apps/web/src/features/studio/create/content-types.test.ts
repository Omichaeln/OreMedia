import { describe, expect, it } from 'vitest';
import { FORMAT_DEFINITIONS } from '@oremedia/editor';
import { VIDEO_FORMAT_KEYS } from '@oremedia/contracts/video';
import { KIND_FORMATS, contentTypesFor, platformsOf } from './content-types';

describe('the format step’s groupings (the interface’s Still / Motion, platforms and sizes)', () => {
  it('counts what each kind can make: every page format for Still, every video output preset for Motion', () => {
    expect(KIND_FORMATS.still).toHaveLength(Object.keys(FORMAT_DEFINITIONS).length);
    expect(KIND_FORMATS.motion.map((f) => f.key)).toEqual([...VIDEO_FORMAT_KEYS]);
  });

  it('lists each channel with the formats it takes, in channel order, and leaves out channels with none', () => {
    const still = platformsOf('still');
    expect(still.map((p) => p.label)).toEqual([
      'Instagram',
      'Facebook',
      'LinkedIn',
      'X',
      'TikTok',
      'YouTube',
    ]);
    expect(still.find((p) => p.key === 'linkedin_page')?.formats.map((f) => f.key)).toEqual([
      'square_1080',
      'li_1200x627',
      'li_1080x1080',
      'li_banner_1584x396',
    ]);
    for (const p of platformsOf('motion'))
      expect(p.formats.every((f) => f.providerKeys.includes(p.key) && f.key.startsWith('video_'))).toBe(true);
  });

  it('offers the content types a size can start as, never video; a size no type offers is custom artwork', () => {
    expect(contentTypesFor('square_1080')).toEqual(['social_post', 'carousel', 'custom']);
    expect(contentTypesFor('ig_story_9x16')).toEqual(['story']);
    // A starter or template that declares another type at the size adds it, in the content-type order.
    expect(contentTypesFor('x_1600x900', ['thumbnail_banner'])).toEqual([
      'social_post',
      'thumbnail_banner',
      'custom',
    ]);
    expect(contentTypesFor('custom_1500x500')).toEqual(['custom']);
    expect(contentTypesFor('square_1080', ['video'])).not.toContain('video');
  });
});
