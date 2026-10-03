import { describe, expect, it } from 'vitest';
import {
  BrandSystemDocumentV1,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1 as Doc,
} from '@oremedia/contracts/brand';
import { effectiveChannelGuidance } from './channel-guidance';
import { hashCanonical } from './hash';

/** A document as stored before the BSC-1 guidance fields existed: every original field set, nothing else. */
const legacyDocument = (): Doc => ({
  schemaVersion: 1,
  voice: {
    summary: 'Plain, warm and exact.',
    tone: ['plain', 'warm'],
    audiences: [{ key: 'owners', description: 'Small business owners in Harare' }],
    preferredTerms: [{ use: 'roast', avoid: ['blend', 'mix'] }],
    prohibitedPhrases: ['world-class'],
    locales: ['en-GB'],
    examples: [{ text: 'Roasted this morning.', verdict: 'on_brand', note: 'Concrete and short' }],
  },
  tokens: {
    colours: [{ key: 'ink', value: '#172120', role: 'text' }],
    typeRoles: [{ role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 16 }],
    spacingScale: [4, 8, 16],
    radii: [4],
    contrastTarget: 'AA',
  },
  logoRules: [
    {
      assetId: 'ast_logo',
      variant: 'primary',
      allowedBackgroundColourKeys: ['ink'],
      clearSpaceRatio: 0.5,
      minWidthPx: 80,
    },
  ],
  patterns: [{ key: 'quote-card', description: 'A pull quote', exampleAssetIds: [], templateVersionIds: [] }],
  channelGuidance: [
    {
      providerKey: 'linkedin_page',
      captionStyle: 'Short, first person plural.',
      preferredFormats: ['carousel'],
      ctaConventions: 'Ask for a reply.',
    },
  ],
});

/** hashCanonical of legacyDocument(), recorded with the schema as it was before BSC-1. */
const LEGACY_HASH = '66b7a649d755c663ec0330cfa14c8ef2f88f92303a443f6e97ba0b08953a4518';

describe('BSC-1 document additions keep stored documents as they are', () => {
  it('a document stored before the guidance fields parses to itself and hashes to its recorded hash', () => {
    const parsed = BrandSystemDocumentV1.parse(legacyDocument());
    expect(parsed).toEqual(legacyDocument());
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(legacyDocument()).sort());
    expect(hashCanonical(parsed)).toBe(LEGACY_HASH);
    expect(hashCanonical(BrandSystemDocumentV1.parse(emptyBrandSystemDocument()))).toBe(
      hashCanonical(emptyBrandSystemDocument()),
    );
  });
});

const withChannels = (): Doc => ({
  ...legacyDocument(),
  channelBaseline: {
    objectives: 'Enquiries from owners',
    toneAdaptation: 'Warm everywhere',
    cta: 'Invite a reply',
    hashtags: '   ',
    frequency: 'Three times a week',
  },
  channelGuidance: [
    {
      providerKey: 'linkedin_page',
      captionStyle: 'Short, first person plural.',
      preferredFormats: ['carousel'],
      ctaConventions: '',
      frequency: 'Twice a week',
      audience: 'Owners and managers',
      formats: 'Carousels of 5 to 7 slides',
      examples: [{ text: 'We roasted 40 kg this morning.' }],
    },
    { providerKey: 'x', captionStyle: '', preferredFormats: [], ctaConventions: 'Reply with your order' },
  ],
});

describe('effectiveChannelGuidance', () => {
  it('overlays the channel entry on the baseline and says which fields are inherited and which overridden', () => {
    const g = effectiveChannelGuidance(withChannels(), 'linkedin_page');
    expect(g).toEqual({
      providerKey: 'linkedin_page',
      hasEntry: true,
      fields: {
        objectives: 'Enquiries from owners',
        toneAdaptation: 'Short, first person plural.',
        cta: 'Invite a reply',
        frequency: 'Twice a week',
      },
      inherited: ['objectives', 'cta'],
      overridden: ['toneAdaptation', 'frequency'],
      preferredFormats: ['carousel'],
      formats: 'Carousels of 5 to 7 slides',
      audience: 'Owners and managers',
      examples: [{ text: 'We roasted 40 kg this morning.' }],
    });
  });

  it('treats a blank channel value as inherited and a blank baseline value as unset', () => {
    const g = effectiveChannelGuidance(withChannels(), 'x');
    expect(g.fields.toneAdaptation).toBe('Warm everywhere'); // captionStyle '' inherits
    expect(g.fields.cta).toBe('Reply with your order');
    expect(g.inherited).toEqual(['objectives', 'toneAdaptation', 'frequency']);
    expect(g.overridden).toEqual(['cta']);
    expect(g.fields.hashtags).toBeUndefined(); // whitespace-only baseline
  });

  it('a channel with no entry gets the baseline alone; a document with neither gets nothing', () => {
    const g = effectiveChannelGuidance(withChannels(), 'facebook_page');
    expect(g.hasEntry).toBe(false);
    expect(g.overridden).toEqual([]);
    expect(g.inherited).toEqual(['objectives', 'toneAdaptation', 'cta', 'frequency']);
    expect(g.preferredFormats).toEqual([]);
    expect(g.examples).toEqual([]);
    const none = effectiveChannelGuidance(emptyBrandSystemDocument(), 'x');
    expect(none).toEqual({
      providerKey: 'x',
      hasEntry: false,
      fields: {},
      inherited: [],
      overridden: [],
      preferredFormats: [],
      examples: [],
    });
  });

  it('a legacy entry without a baseline overrides only what it sets', () => {
    const g = effectiveChannelGuidance(legacyDocument(), 'linkedin_page');
    expect(g.fields).toEqual({ toneAdaptation: 'Short, first person plural.', cta: 'Ask for a reply.' });
    expect(g.overridden).toEqual(['toneAdaptation', 'cta']);
    expect(g.inherited).toEqual([]);
  });
});
