import { describe, expect, it } from 'vitest';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import { ContentType, CreativeDocumentV1, type Element } from '@oremedia/contracts/creative';
import { hashCanonical } from '@oremedia/domain/hash';
import { fixtureSnapshot } from '../fixtures';
import { formatFor } from '../formats';
import { allElementIds } from '../reduce';
import { validateAgainstBrand } from '../validate';
import {
  STARTERS,
  blankDocument,
  instantiateStarter,
  starterBrandIssue,
  starterByKey,
  type StarterBrand,
} from './index';

/** The editor fixture brand (light paper, ink text, teal accent; a primary logo allowed on paper only). */
const lightBrand = (): { brand: StarterBrand; snapshot: BrandSnapshot } => {
  const snapshot = fixtureSnapshot();
  snapshot.document.logoRules = [{ ...snapshot.document.logoRules[0]!, assetVersionId: 'av_logo' }];
  return {
    snapshot,
    brand: {
      brandVersionId: snapshot.brandVersionId,
      colours: snapshot.document.tokens.colours,
      typeRoles: snapshot.document.tokens.typeRoles.map((t) => ({
        role: t.role,
        fontAssetVersionId: 'av_font',
        weight: t.weight,
        minSizePx: t.minSizePx,
      })),
      logos: [
        {
          variant: 'primary',
          assetVersionId: 'av_logo',
          aspect: 10 / 3,
          minWidthPx: 120,
          allowedBackgroundColourKeys: ['paper'],
        },
      ],
    },
  };
};

/** A second brand: a saturated primary, larger minimum sizes, a reversed logo allowed on every dark ground. */
const boldBrand = (): { brand: StarterBrand; snapshot: BrandSnapshot } => {
  const snapshot = fixtureSnapshot();
  snapshot.document.tokens.colours = [
    { key: 'navy', value: '#0B1F3A', role: 'primary' },
    { key: 'white', value: '#FFFFFF', role: 'background' },
    { key: 'coral', value: '#E4572E', role: 'accent' },
    { key: 'sand', value: '#F2E8DC', role: 'neutral' },
    { key: 'graphite', value: '#22252A', role: 'text' },
  ];
  snapshot.document.tokens.typeRoles = snapshot.document.tokens.typeRoles.map((t) => ({
    ...t,
    minSizePx: t.minSizePx + 4,
  }));
  snapshot.document.logoRules = [
    {
      assetId: 'ast_logo',
      assetVersionId: 'av_logo',
      variant: 'primary',
      allowedBackgroundColourKeys: ['white', 'sand'],
      clearSpaceRatio: 0.5,
      minWidthPx: 140,
    },
    {
      assetId: 'ast_logo_rev',
      assetVersionId: 'av_logo_rev',
      variant: 'reversed',
      allowedBackgroundColourKeys: ['navy', 'graphite', 'coral'],
      clearSpaceRatio: 0.5,
      minWidthPx: 140,
    },
  ];
  return {
    snapshot,
    brand: {
      brandVersionId: snapshot.brandVersionId,
      colours: snapshot.document.tokens.colours,
      typeRoles: snapshot.document.tokens.typeRoles.map((t) => ({
        role: t.role,
        fontAssetVersionId: `av_font_${t.role}`,
        weight: t.weight,
        minSizePx: t.minSizePx,
      })),
      logos: snapshot.document.logoRules.map((r) => ({
        variant: r.variant,
        assetVersionId: r.assetVersionId!,
        aspect: 4,
        minWidthPx: r.minWidthPx,
        allowedBackgroundColourKeys: r.allowedBackgroundColourKeys,
      })),
    },
  };
};

const flat = (els: Element[]): Element[] =>
  els.flatMap((e) => [e, ...(e.type === 'group' ? flat(e.children) : [])]);

describe('built-in starters (STU-1a, architecture principle 5)', () => {
  it('ships at least 12 starters with unique keys across the graphic content types', () => {
    expect(STARTERS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(STARTERS.map((s) => s.key)).size).toBe(STARTERS.length);
    const types = new Set(STARTERS.map((s) => s.contentType));
    for (const t of ContentType.options.filter((c) => c !== 'video')) expect(types, t).toContain(t);
    const formats = STARTERS.map((s) => s.formatKey);
    expect(formats.filter((f) => f === 'square_1080').length).toBeGreaterThanOrEqual(3);
    expect(formats.filter((f) => f === 'ig_feed_4x5').length).toBeGreaterThanOrEqual(2);
    expect(formats.filter((f) => f === 'ig_story_9x16').length).toBeGreaterThanOrEqual(2);
    expect(formats).toContain('yt_thumbnail_1280x720');
    expect(formats).toContain('li_banner_1584x396');
    expect(
      STARTERS.filter((s) => s.contentType === 'carousel')
        .map((s) => s.pages.length)
        .sort(),
    ).toEqual([3, 5]);
    expect(starterByKey('post-bold-headline')?.name).toBe('Bold headline');
  });

  for (const [label, make] of [
    ['fixture brand', lightBrand],
    ['bold brand', boldBrand],
  ] as const)
    describe(label, () => {
      for (const spec of STARTERS)
        it(`${spec.key}: a valid document with no blocking findings, inside the safe area, on brand tokens`, () => {
          const { brand, snapshot } = make();
          const { document, slots } = instantiateStarter(spec, brand);
          const parsed = CreativeDocumentV1.parse(document);
          expect(hashCanonical(parsed)).toBe(hashCanonical(document)); // nothing the schema would add or strip
          expect(parsed.contentType).toBe(spec.contentType);
          expect(parsed.pages).toHaveLength(spec.pages.length);
          const findings = validateAgainstBrand(parsed, snapshot);
          expect(findings.filter((f) => f.severity === 'blocking')).toEqual([]);
          expect(findings.filter((f) => f.code === 'contrast')).toEqual([]);
          const format = formatFor(spec.formatKey)!;
          const tokens = new Set(snapshot.document.tokens.colours.map((c) => c.key));
          const fonts = new Set(brand.typeRoles.map((t) => t.fontAssetVersionId));
          for (const page of parsed.pages) {
            expect(page).toMatchObject({ width: format.width, height: format.height, formatKey: format.key });
            for (const el of flat(page.elements)) {
              const t = el.transform;
              if (el.type !== 'background' && el.semanticRole !== 'decoration') {
                expect(t.x, `${page.name}/${el.name}`).toBeGreaterThanOrEqual(format.safeArea.left);
                expect(t.y, `${page.name}/${el.name}`).toBeGreaterThanOrEqual(format.safeArea.top);
                expect(t.x + t.width, `${page.name}/${el.name}`).toBeLessThanOrEqual(
                  format.width - format.safeArea.right,
                );
                expect(t.y + t.height, `${page.name}/${el.name}`).toBeLessThanOrEqual(
                  format.height - format.safeArea.bottom,
                );
              }
              if (el.type === 'text') {
                expect(tokens).toContain(el.style.colourToken);
                expect(fonts).toContain(el.style.fontAssetVersionId);
                const min = brand.typeRoles.find((r) => r.role === el.style.typeRole)!.minSizePx;
                expect(el.style.sizePx).toBeGreaterThanOrEqual(min);
              }
              if (el.type === 'shape' || el.type === 'background') expect(tokens).toContain(el.fillToken);
              if (el.type === 'logo') expect(el.protected).toBe(true);
            }
          }
          // Every slot points at an element of the document; there is always a headline to fill.
          const idsInDoc = new Set(allElementIds(parsed));
          for (const slot of slots) expect(idsInDoc).toContain(slot.elementId);
          expect(slots.some((s) => s.key === 'headline' && s.required)).toBe(true);
          expect(new Set(allElementIds(parsed)).size).toBe(allElementIds(parsed).length);
        });
    });

  it('places the logo variant allowed on each ground and says so when none is', () => {
    const light = instantiateStarter(starterByKey('post-offer')!, lightBrand().brand);
    expect(flat(light.document.pages[0]!.elements).some((e) => e.type === 'logo')).toBe(false);
    expect(light.notes.join(' ')).toMatch(/no logo variant is allowed on this background/);
    const bold = instantiateStarter(starterByKey('post-offer')!, boldBrand().brand);
    const logo = flat(bold.document.pages[0]!.elements).find((e) => e.type === 'logo');
    expect(logo).toMatchObject({ variant: 'reversed', assetVersionId: 'av_logo_rev' });
    expect(logo!.transform.width).toBeGreaterThanOrEqual(140);
    expect(bold.notes).toEqual([]);
  });

  it('is deterministic: the same brand gives the same document', () => {
    const spec = starterByKey('carousel-5-tips')!;
    expect(hashCanonical(instantiateStarter(spec, boldBrand().brand).document)).toBe(
      hashCanonical(instantiateStarter(spec, boldBrand().brand).document),
    );
  });

  it('a brand without contrast or fonts cannot instantiate starters, and says why', () => {
    const { brand } = lightBrand();
    expect(starterBrandIssue(brand)).toBeNull();
    expect(
      starterBrandIssue({ ...brand, colours: [{ key: 'only', value: '#777777', role: 'primary' }] }),
    ).toMatch(/light and a dark/);
    expect(starterBrandIssue({ ...brand, typeRoles: [] })).toMatch(/font/);
  });

  it('a blank document has the format, page count and the brand background', () => {
    const doc = blankDocument('custom_1500x500', lightBrand().brand, 'custom', 2);
    expect(CreativeDocumentV1.parse(doc).pages.map((p) => [p.width, p.height, p.formatKey])).toEqual([
      [1500, 500, 'custom_1500x500'],
      [1500, 500, 'custom_1500x500'],
    ]);
    expect(doc.pages[0]!.elements[0]).toMatchObject({ type: 'background', fillToken: 'paper' });
    expect(new Set(allElementIds(doc)).size).toBe(2);
    expect(validateAgainstBrand(doc, lightBrand().snapshot)).toEqual([]);
  });
});
