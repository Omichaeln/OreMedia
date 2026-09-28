import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { cspDirectives } from '../../../tooling/scripts/smoke/checks';
import { productionSecurityHeaders } from './caddy-headers';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import {
  startFakeObjectStore,
  startStaticServer,
  watchCspViolations,
  type CspViolation,
} from './static-server';

/**
 * The production Content-Security-Policy against an object store on another origin, as deployed: the web server
 * serves the headers read from infra/railway/web/Caddyfile, and the mock's signed URLs point at a fake store (a
 * second local server that answers CORS for the web origin). With OBJECT_STORE_PUBLIC_ORIGIN set to the store's
 * origin, a font upload from the brand kit reaches the store and the font files load; unset, the browser blocks the
 * PUT (a connect-src violation) and the page says the upload was not accepted. Opt-in like the other smokes.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const typography = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/system?section=typography`;
const font = readFileSync(
  new URL('../../../tooling/test-fixtures/fonts/karla/Karla[wght].ttf', import.meta.url),
);

interface Deployment {
  origin: string;
  store: Awaited<ReturnType<typeof startFakeObjectStore>>;
  close: () => Promise<void>;
}

describe.skipIf(!enabled)(
  'production CSP and an object store on another origin (built app in Chromium)',
  () => {
    const deployments: Record<'configured' | 'unset', Deployment> = {} as never;
    let browser: Browser;

    /** A fake store, then a web server whose CSP names it (or not); the store's CORS admits that web origin. */
    const deploy = async (storeOriginInCsp: boolean): Promise<Deployment> => {
      const backend = new MockBackend();
      const store = await startFakeObjectStore();
      backend.objectStoreOrigin = store.origin;
      const served = await startStaticServer({
        dist,
        trpcHandler: createMockHandler(backend),
        webEnv: storeOriginInCsp ? { OBJECT_STORE_PUBLIC_ORIGIN: store.origin } : {},
      });
      store.allow(served.origin);
      return {
        origin: served.origin,
        store,
        close: async () => {
          await served.close();
          await store.close();
        },
      };
    };

    const openTypography = async (
      d: Deployment,
    ): Promise<{ context: BrowserContext; page: Page; violations: CspViolation[] }> => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const violations = await watchCspViolations(context);
      const page = await context.newPage();
      await page.goto(`${d.origin}/sign-in`);
      await page.getByLabel('Session token').fill(E2E.token);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL('**/portfolio*', { timeout: 15_000 });
      await page.goto(`${d.origin}${typography}`);
      await page
        .getByRole('group', { name: 'Version shown' })
        .getByRole('button', { name: /proposed/ })
        .click({ timeout: 15_000 });
      await page.getByRole('list', { name: 'Brand fonts' }).getByText('Karla').waitFor({ timeout: 15_000 });
      return { context, page, violations };
    };
    const uploadFont = (page: Page) =>
      page
        .locator('input[type="file"][accept^=".woff2"]')
        .setInputFiles({ name: 'Brand Serif.ttf', mimeType: 'font/ttf', buffer: font });

    beforeAll(async () => {
      if (!existsSync(`${dist}/index.html`))
        throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
      deployments.configured = await deploy(true);
      deployments.unset = await deploy(false);
      browser = await chromium.launch(launchOptions);
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      for (const d of Object.values(deployments)) await d?.close();
    });

    it('serves the Caddyfile CSP: the store origin in connect-src and font-src only when configured', async () => {
      const { configured, unset } = deployments;
      const served = (await fetch(`${configured.origin}/`)).headers.get('content-security-policy');
      expect(served).toBe(
        productionSecurityHeaders({ OBJECT_STORE_PUBLIC_ORIGIN: configured.store.origin }).app[
          'Content-Security-Policy'
        ],
      );
      const csp = cspDirectives(served ?? '');
      expect(csp['connect-src']).toContain(configured.store.origin);
      expect(csp['font-src']).toContain(configured.store.origin);
      const bare = cspDirectives(
        (await fetch(`${unset.origin}/`)).headers.get('content-security-policy') ?? '',
      );
      expect(bare['connect-src']).toEqual(["'self'"]);
    });

    it('with OBJECT_STORE_PUBLIC_ORIGIN set, the upload reaches the store and fonts load, with no violation', async () => {
      const d = deployments.configured;
      const { context, page, violations } = await openTypography(d);
      // The brand's font file (the fixture brand's Karla face, asset version av_font_ast_font) is fetched from the
      // store (font-src and the store's CORS) and its FontFace, named after the version, loads.
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              [...document.fonts]
                .filter((f) => f.family.replace(/"/g, '') === 'av_font_ast_font')
                .map((f) => f.status),
            ),
          { timeout: 15_000 },
        )
        .toContain('loaded');
      expect(d.store.gets).toContain('/e2e-object/av_font_ast_font');
      await uploadFont(page);
      await page.getByText('Processing').first().waitFor({ timeout: 15_000 });
      expect(d.store.puts).toHaveLength(1);
      expect(d.store.puts[0]).toMatch(/^\/e2e-upload\/upi_/);
      expect(violations).toEqual([]);
      await context.close();
    }, 60_000);

    it('with OBJECT_STORE_PUBLIC_ORIGIN unset, the browser blocks the PUT and the page says so', async () => {
      const d = deployments.unset;
      const { context, page, violations } = await openTypography(d);
      await uploadFont(page);
      await page.getByText('Upload not accepted').waitFor({ timeout: 15_000 });
      expect(d.store.puts).toEqual([]);
      expect(violations).toContainEqual(
        expect.objectContaining({
          directive: 'connect-src',
          blockedUri: expect.stringContaining(d.store.origin),
        }),
      );
      await context.close();
    }, 60_000);
  },
);
