import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type { RenderTargetInput } from '@oremedia/activities';
import {
  STARTERS,
  blankDocument,
  instantiateStarter,
  type StarterBrand,
} from '@oremedia/editor/starters/index';
import { latinFeedFixture } from '@oremedia/editor/renderer/fixtures';
import { createChromiumRenderer } from './chromium-renderer';
import { generateFixtureAsset, loadFixtureFont } from './fixture-assets';

/**
 * STU-1a: every built-in starter, instantiated with the Latin fixture brand (Karla, its palette and logo), renders
 * through the real worker path (headless Chromium + the render-only bundle) with no blocking render check: text fits
 * (measured in the browser), everything that must stay inside the format's safe area does, contrast is measured on
 * the pixels and the logo keeps its minimum width. Requires OREMEDIA_CHROMIUM_PATH and the renderer bundle.
 */
const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];

describe('built-in starters render cleanly through the worker path', () => {
  const renderer = createChromiumRenderer({
    ...(executablePath ? { executablePath } : {}),
    timeoutMs: 120_000,
  });
  const fixture = latinFeedFixture();
  const font = fixture.fonts[0]!;
  const logoAsset = fixture.assets.find((a) => a.kind === 'logo')!;
  const brand: StarterBrand = {
    brandVersionId: fixture.document.brandVersionId,
    colours: fixture.snapshot.document.tokens.colours,
    typeRoles: fixture.snapshot.document.tokens.typeRoles.map((t) => ({
      role: t.role,
      fontAssetVersionId: font.assetVersionId,
      weight: t.weight,
      minSizePx: t.minSizePx,
    })),
    logos: fixture.snapshot.document.logoRules.map((r) => ({
      variant: r.variant,
      assetVersionId: logoAsset.assetVersionId,
      aspect: logoAsset.width / logoAsset.height,
      minWidthPx: r.minWidthPx,
      allowedBackgroundColourKeys: r.allowedBackgroundColourKeys,
    })),
  };
  let fonts: RenderTargetInput['fonts'] = [];
  let assets: RenderTargetInput['assets'] = [];

  beforeAll(async () => {
    fonts = [await loadFixtureFont(font)];
    assets = [await generateFixtureAsset(logoAsset)];
  }, 120_000);
  afterAll(async () => {
    await renderer.close();
  });

  for (const spec of STARTERS)
    it(`${spec.key}: every page renders at its format with no blocking finding`, async () => {
      const { document } = instantiateStarter(spec, brand);
      for (const page of document.pages) {
        const out = await renderer.render({
          document,
          page,
          formatKey: page.formatKey,
          reflow: false,
          snapshot: fixture.snapshot as BrandSnapshot,
          fonts,
          assets,
        });
        expect({ width: out.width, height: out.height }).toEqual({ width: page.width, height: page.height });
        expect(
          out.findings
            .filter((f) => f.severity === 'blocking')
            .map((f) => `${page.name}: ${f.code} ${f.message}`),
        ).toEqual([]);
      }
    }, 180_000);

  it('a custom size renders at exactly that size', async () => {
    const document = blankDocument('custom_1500x500', brand, 'custom');
    const page = document.pages[0]!;
    const out = await renderer.render({
      document,
      page,
      formatKey: page.formatKey,
      reflow: false,
      snapshot: fixture.snapshot as BrandSnapshot,
      fonts,
      assets,
    });
    expect({ width: out.width, height: out.height }).toEqual({ width: 1500, height: 500 });
    expect(out.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
  }, 120_000);
});
