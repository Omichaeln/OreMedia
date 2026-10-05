import { describe, expect, it } from 'vitest';
import {
  BrandSystemDocumentV1,
  CHANNEL_GUIDANCE_FIELDS,
  CHANNEL_OVERRIDE_KEY,
  channelOverride,
  emptyBrandSystemDocument,
  GuidanceProvenance,
} from './brand';

const guidance = () => ({
  ...emptyBrandSystemDocument(),
  voice: {
    ...emptyBrandSystemDocument().voice,
    audiences: [{ key: 'owners', description: 'Owners', needs: ['Fresh stock'], objections: ['Price'] }],
    examples: [
      {
        text: 'Best coffee ever!!!',
        verdict: 'off_brand' as const,
        note: '',
        channelKey: 'x',
        contentType: 'social_post' as const,
        rationale: 'Unprovable superlative',
        rewrite: 'Roasted this morning.',
        provenance: { origin: 'user' as const },
      },
    ],
    personality: [{ trait: 'Warm' }],
    principles: [{ statement: 'Say what we can prove', rationale: 'Trust' }],
    spelling: { locale: 'en-GB', notes: 'Oxford comma' },
    styleRules: [{ topic: 'numbers' as const, rule: 'Numerals from 10' }],
    claimRules: [{ rule: 'No superlatives without a fact' }],
  },
  messaging: {
    positioning: 'The roaster for owners',
    valueProposition: 'Fresh beans weekly',
    pillars: [{ key: 'fresh', title: 'Fresh', statement: 'Roasted weekly', proofFactIds: ['fact_1'] }],
    keyMessages: [{ text: 'Roasted this week', pillarKey: 'fresh' }],
  },
  vocabulary: [{ term: 'roast', usage: 'preferred' as const, alternatives: [] }],
  writingPatterns: { headline: { guidance: 'Short', dos: ['Verbs'], donts: ['Puns'], examples: [] } },
  copyTemplates: [
    {
      key: 'proof-post',
      name: 'Proof post',
      contentType: 'social_post' as const,
      channelKeys: ['linkedin_page'],
      purpose: 'Show a fact',
      structure: [{ slot: 'hook', guidance: 'A number', maxLength: 80 }],
    },
  ],
  channelBaseline: { cta: 'Invite a reply' },
});

describe('BrandSystemDocumentV1 guidance additions (BSC-1)', () => {
  it('accepts the guidance fields and keeps them', () => {
    const doc = guidance();
    expect(BrandSystemDocumentV1.parse(doc)).toEqual(doc);
  });

  it('fills in no defaults: the original document parses with no new keys', () => {
    const parsed = BrandSystemDocumentV1.parse(emptyBrandSystemDocument());
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(emptyBrandSystemDocument()).sort());
    expect(Object.keys(parsed.voice).sort()).toEqual(Object.keys(emptyBrandSystemDocument().voice).sort());
  });

  it('bounds lengths and list sizes', () => {
    const doc = guidance();
    const tooMany = {
      ...doc,
      vocabulary: Array.from({ length: 201 }, (_, i) => ({
        term: `t${i}`,
        usage: 'allowed',
        alternatives: [],
      })),
    };
    expect(BrandSystemDocumentV1.safeParse(tooMany).success).toBe(false);
    const longPositioning = { ...doc, messaging: { ...doc.messaging, positioning: 'x'.repeat(2001) } };
    expect(BrandSystemDocumentV1.safeParse(longPositioning).success).toBe(false);
    const noSlots = { ...doc, copyTemplates: [{ ...doc.copyTemplates[0], structure: [] }] };
    expect(BrandSystemDocumentV1.safeParse(noSlots).success).toBe(false);
    const emptyTerm = { ...doc, vocabulary: [{ term: '', usage: 'allowed', alternatives: [] }] };
    expect(BrandSystemDocumentV1.safeParse(emptyTerm).success).toBe(false);
  });

  it('provenance names its origin and cites at most ten pieces of evidence', () => {
    expect(GuidanceProvenance.safeParse({ origin: 'inferred', confidence: 'low' }).success).toBe(true);
    expect(GuidanceProvenance.safeParse({ origin: 'guessed' }).success).toBe(false);
    const evidence = Array.from({ length: 11 }, (_, i) => ({ kind: 'url', ref: `https://x.test/${i}` }));
    expect(GuidanceProvenance.safeParse({ origin: 'imported', evidence }).success).toBe(false);
  });
});

describe('BrandSystemDocumentV1 type roles: size and line height', () => {
  const withRole = (extra: Record<string, unknown>) => ({
    ...emptyBrandSystemDocument(),
    tokens: {
      ...emptyBrandSystemDocument().tokens,
      typeRoles: [{ role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 16, ...extra }],
    },
  });

  it('keeps a stored role without them as it was: no keys are added', () => {
    const parsed = BrandSystemDocumentV1.parse(withRole({}));
    expect(parsed.tokens.typeRoles[0]).toEqual({
      role: 'body',
      fontAssetId: 'ast_font',
      weight: 400,
      minSizePx: 16,
    });
  });

  it('keeps an intended size and a line height, and rejects a size or line height that is not positive', () => {
    const parsed = BrandSystemDocumentV1.parse(withRole({ sizePx: 18, lineHeight: 1.5 }));
    expect(parsed.tokens.typeRoles[0]).toMatchObject({ sizePx: 18, lineHeight: 1.5 });
    // A size below the minimum is guidance to warn about, not a malformed document.
    expect(BrandSystemDocumentV1.safeParse(withRole({ sizePx: 12 })).success).toBe(true);
    expect(BrandSystemDocumentV1.safeParse(withRole({ lineHeight: 0 })).success).toBe(false);
    expect(BrandSystemDocumentV1.safeParse(withRole({ sizePx: -1 })).success).toBe(false);
  });
});

describe('channelOverride', () => {
  const entry = {
    providerKey: 'x',
    captionStyle: 'Short',
    preferredFormats: [],
    ctaConventions: '  ',
    links: 'One link, at the end',
  };
  it('reads caption style and CTA conventions as tone adaptation and CTA; blank inherits', () => {
    expect(channelOverride(entry, 'toneAdaptation')).toBe('Short');
    expect(channelOverride(entry, 'cta')).toBeUndefined();
    expect(channelOverride(entry, 'links')).toBe('One link, at the end');
    expect(channelOverride(entry, 'hashtags')).toBeUndefined();
  });
  it('maps every baseline field to a field of the entry', () => {
    expect(Object.keys(CHANNEL_OVERRIDE_KEY).sort()).toEqual([...CHANNEL_GUIDANCE_FIELDS].sort());
  });
});
