import { describe, expect, it } from 'vitest';
import { BrandSystemDocumentV1, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import { hashCanonical } from '@oremedia/domain/hash';

/**
 * BSC-2: the logo rule additions (secondary variant, pinned version, usage guidance, preferred format) are optional
 * with no defaults, so a document stored before them parses to exactly what was stored and hashes the same.
 */
const stored = {
  ...emptyBrandSystemDocument(),
  tokens: {
    colours: [{ key: 'paper', value: '#F4F6F3', role: 'background' as const }],
    typeRoles: [],
    spacingScale: [],
    radii: [],
    contrastTarget: 'AA' as const,
  },
  logoRules: [
    {
      assetId: 'ast_logo',
      variant: 'primary' as const,
      allowedBackgroundColourKeys: ['paper'],
      clearSpaceRatio: 0.5,
      minWidthPx: 120,
    },
  ],
};
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe('logo rules in the brand system document (BSC-2)', () => {
  it('a document stored before BSC-2 parses unchanged and keeps its hash', () => {
    const raw = json(stored);
    const parsed = BrandSystemDocumentV1.parse(raw);
    expect(parsed).toEqual(raw);
    expect(Object.keys(parsed.logoRules[0] ?? {}).sort()).toEqual(
      ['allowedBackgroundColourKeys', 'assetId', 'clearSpaceRatio', 'minWidthPx', 'variant'].sort(),
    );
    expect(hashCanonical(parsed)).toBe(hashCanonical(raw));
  });

  it('accepts the secondary variant, a pinned version, usage guidance and a preferred format', () => {
    const doc = BrandSystemDocumentV1.parse({
      ...stored,
      logoRules: [
        ...stored.logoRules,
        {
          assetId: 'ast_stacked',
          assetVersionId: 'av_stacked',
          variant: 'secondary',
          allowedBackgroundColourKeys: [],
          clearSpaceRatio: 0.25,
          minWidthPx: 64,
          usage: { backgroundsNote: 'Works on mid-tone photographs.', donts: ['Never recolour the mark'] },
          preferredFormat: 'svg',
        },
      ],
    });
    expect(doc.logoRules[1]).toMatchObject({ variant: 'secondary', preferredFormat: 'svg' });
  });

  it('bounds the guidance: note 500 characters, at most 10 don’ts of 200 characters', () => {
    const rule = (usage: unknown) =>
      BrandSystemDocumentV1.safeParse({ ...stored, logoRules: [{ ...stored.logoRules[0], usage }] }).success;
    expect(rule({ backgroundsNote: 'x'.repeat(500), donts: Array(10).fill('y'.repeat(200)) })).toBe(true);
    expect(rule({ backgroundsNote: 'x'.repeat(501), donts: [] })).toBe(false);
    expect(rule({ backgroundsNote: '', donts: Array(11).fill('y') })).toBe(false);
    expect(rule({ backgroundsNote: '', donts: ['y'.repeat(201)] })).toBe(false);
    expect(
      BrandSystemDocumentV1.safeParse({
        ...stored,
        logoRules: [{ ...stored.logoRules[0], preferredFormat: 'pdf' }],
      }).success,
    ).toBe(false);
  });
});
