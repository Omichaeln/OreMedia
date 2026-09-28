import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderUnavailableError, ValidationFailedError } from '@oremedia/contracts/errors';
import { karlaTtf, toWoff2 } from './ingest/font.fixtures';
import { configureGoogleFonts, css2Url, fetchGoogleFontFiles, parseCss2 } from './google-fonts';

/**
 * The Google Fonts client against two loopback servers standing in for fonts.googleapis.com (css2) and
 * fonts.gstatic.com (files), reached through the real SSRF-safe dispatcher (loopback allowed for tests only).
 * Never the real internet.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(): Promise<{
  server: Server;
  origin: string;
  handle: (h: Handler) => void;
  hits: string[];
}> {
  let handler: Handler = (_req, res) => res.writeHead(404).end();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.url} ${req.headers['user-agent'] ?? ''}`);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, handle: (h) => (handler = h), hits };
}

const face = (
  fontOrigin: string,
  subset: string,
  weight: number,
  style: string,
  file: string,
  range: string,
) =>
  `/* ${subset} */
@font-face {
  font-family: 'Karla';
  font-style: ${style};
  font-weight: ${weight};
  font-display: swap;
  src: url(${fontOrigin}/s/karla/v31/${file}.woff2) format('woff2');
  unicode-range: ${range};
}
`;
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+2000-206F, U+FEFF, U+FFFD';
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+1E00-1E9F, U+2C60-2C7F, U+A720-A7FF';

describe('Google Fonts client (css2 + font files, loopback fixtures)', () => {
  let css: Awaited<ReturnType<typeof serve>>;
  let files: Awaited<ReturnType<typeof serve>>;
  const woff2 = toWoff2(karlaTtf());

  const stylesheet = (fontOrigin = files.origin) =>
    face(fontOrigin, 'cyrillic', 400, 'normal', 'cyr', 'U+0400-045F') +
    face(fontOrigin, 'latin-ext', 400, 'normal', 'ext400', LATIN_EXT) +
    face(fontOrigin, 'latin', 400, 'normal', 'lat400', LATIN) +
    face(fontOrigin, 'latin', 700, 'italic', 'lat700i', LATIN);

  beforeAll(async () => {
    css = await serve();
    files = await serve();
  });
  afterEach(() => {
    css.hits.length = 0;
    files.hits.length = 0;
    configureGoogleFonts({});
  });
  afterAll(async () => {
    css.server.close();
    files.server.close();
  });
  const configure = (extra: Record<string, unknown> = {}) =>
    configureGoogleFonts({
      cssOrigin: css.origin,
      fontOrigin: files.origin,
      insecureAllowLoopback: true,
      ...extra,
    });
  const serveFonts = () =>
    files.handle((_req, res) => res.writeHead(200, { 'content-type': 'font/woff2' }).end(woff2));

  it('builds the css2 URL with sorted ital,wght tuples', () => {
    expect(
      css2Url('https://fonts.googleapis.com', 'IBM Plex  Sans', [700, 400, 400], ['italic', 'normal']),
    ).toBe(
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,700;1,400;1,700&display=swap',
    );
  });

  it('keeps the latin and latin-ext WOFF2 files of the requested faces, as a desktop browser is served', async () => {
    configure();
    css.handle((_req, res) => res.writeHead(200, { 'content-type': 'text/css' }).end(stylesheet()));
    serveFonts();
    const out = await fetchGoogleFontFiles({
      family: 'Karla',
      weights: [400, 700],
      styles: ['normal', 'italic'],
    });
    expect(css.hits[0]).toMatch(
      /^\/css2\?family=Karla:ital,wght@0,400;0,700;1,400;1,700&display=swap .*Chrome\//,
    );
    expect(out.map((f) => [f.subset, f.weight, f.style, f.unicodeRange])).toEqual([
      ['latin-ext', 400, 'normal', LATIN_EXT],
      ['latin', 400, 'normal', LATIN],
      ['latin', 700, 'italic', LATIN],
    ]);
    expect(out[0]?.url).toBe(`${files.origin}/s/karla/v31/ext400.woff2`);
    expect(out.every((f) => f.bytes.equals(woff2))).toBe(true);
    expect(files.hits).toHaveLength(3); // the cyrillic file is never fetched
    const arabic = await fetchGoogleFontFiles({
      family: 'Karla',
      weights: [400],
      styles: ['normal'],
      subsets: ['cyrillic'],
    });
    expect(arabic.map((f) => f.subset)).toEqual(['cyrillic']);
  });

  it('an unknown family (css2 answers 400) is a validation error', async () => {
    configure();
    css.handle((_req, res) => res.writeHead(400).end('Font family not found'));
    await expect(
      fetchGoogleFontFiles({ family: 'Nope Sans', weights: [400], styles: ['normal'] }),
    ).rejects.toMatchObject({ details: [{ path: 'family', issue: 'google_fonts_family_unknown' }] });
  });

  it('refuses a stylesheet naming a file anywhere but the font host, before fetching any file', async () => {
    configure();
    for (const other of ['http://169.254.169.254', css.origin, 'https://evil.example', 'file://']) {
      css.handle((_req, res) => res.writeHead(200).end(stylesheet(other)));
      await expect(
        fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    }
    expect(files.hits).toHaveLength(0);
  });

  it('refuses a malformed unicode-range and faces of another family', async () => {
    configure();
    css.handle((_req, res) =>
      res
        .writeHead(200)
        .end(face(files.origin, 'latin', 400, 'normal', 'x', 'U+0000-00FF, expression(alert(1))')),
    );
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    css.handle((_req, res) => res.writeHead(200).end(stylesheet()));
    serveFonts();
    await expect(
      fetchGoogleFontFiles({ family: 'Inter', weights: [400], styles: ['normal'] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('does not follow redirects, caps sizes and checks the WOFF2 signature', async () => {
    configure({ maxFileBytes: 1024 });
    css.handle((_req, res) => res.writeHead(200).end(stylesheet()));
    files.handle((_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end());
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    // Oversized: declared by content-length, and streamed without one.
    serveFonts();
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toMatchObject({ message: expect.stringContaining('larger than 1024 bytes') });
    files.handle((_req, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write(woff2.subarray(0, 800));
      res.end(woff2.subarray(800, 2000));
    });
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toMatchObject({ message: expect.stringContaining('larger than 1024 bytes') });
    configure();
    files.handle((_req, res) => res.writeHead(200).end(karlaTtf()));
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toMatchObject({ message: expect.stringContaining('not WOFF2') });
  });

  it('a host that stalls is abandoned at the timeout, mid-body too', async () => {
    configure({ timeoutMs: 300, totalTimeoutMs: 2_000 });
    css.handle(() => undefined); // never answers
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    css.handle((_req, res) => res.writeHead(200).end(stylesheet()));
    files.handle((_req, res) => {
      res.writeHead(200);
      res.write(woff2.subarray(0, 100)); // and then nothing
    });
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('without the test-only loopback allowance, private addresses are refused by the SSRF guard', async () => {
    configureGoogleFonts({ cssOrigin: css.origin, fontOrigin: files.origin });
    css.handle((_req, res) => res.writeHead(200).end(stylesheet()));
    await expect(
      fetchGoogleFontFiles({ family: 'Karla', weights: [400], styles: ['normal'] }),
    ).rejects.toThrow(/Blocked address|not allowed/);
    expect(css.hits).toHaveLength(0);
  });

  it('a variable family (one file for every weight asked) is one file per subset carrying its weight range', async () => {
    configure();
    css.handle((_req, res) =>
      res
        .writeHead(200)
        .end(
          face(files.origin, 'latin', 400, 'normal', 'var', LATIN) +
            face(files.origin, 'latin', 700, 'normal', 'var', LATIN),
        ),
    );
    serveFonts();
    const out = await fetchGoogleFontFiles({ family: 'Karla', weights: [400, 700], styles: ['normal'] });
    // Karla's own wght axis (200–800) is recorded, not just the weights asked for.
    expect(out.map((f) => [f.subset, f.weight, f.weightRange])).toEqual([
      ['latin', 200, { min: 200, max: 800 }],
    ]);
    expect(files.hits).toHaveLength(1);
    // A static file keeps its one weight.
    css.handle((_req, res) => res.writeHead(200).end(face(files.origin, 'latin', 700, 'normal', 'b', LATIN)));
    expect(
      (await fetchGoogleFontFiles({ family: 'Karla', weights: [700], styles: ['normal'] })).map((f) => [
        f.weight,
        f.weightRange,
      ]),
    ).toEqual([[700, null]]);
  });

  it('refuses userinfo, IP literals and look-alike hosts against the production font host', () => {
    const origin = 'https://fonts.gstatic.com';
    for (const src of [
      'https://user:pw@fonts.gstatic.com/s/k/v1/a.woff2',
      'https://fonts.gstatic.com@evil.example/s/k/v1/a.woff2',
      'https://142.250.72.3/s/k/v1/a.woff2',
      'https://[::ffff:a9fe:a9fe]/s/k/v1/a.woff2',
      'https://2130706433/s/k/v1/a.woff2',
      'https://fonts.gstatic.com.evil.example/s/k/v1/a.woff2',
      'https://fonts.gstatic.com:8443/s/k/v1/a.woff2',
      'http://fonts.gstatic.com/s/k/v1/a.woff2',
    ])
      expect(() =>
        parseCss2(
          `/* latin */ @font-face { font-family: 'K'; font-style: normal; font-weight: 400; src: url(${src}) format('woff2'); unicode-range: U+0000-00FF; }`,
          origin,
        ),
      ).toThrow(ValidationFailedError);
  });

  it('parses a hostile answer in linear time (no catastrophic backtracking)', () => {
    const run = 'a'.repeat(200_000);
    const hostile = [
      `@font-face { ${run} }`,
      `/* latin */ @font-face { font-family: ${run}; src: url(${run}`,
      `@font-face {`.repeat(20_000),
      `/*${'x'.repeat(100_000)}`,
    ];
    for (const css of hostile) {
      const started = Date.now();
      expect(parseCss2(css, 'https://fonts.gstatic.com')).toEqual([]);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('parses a css2 answer without a subset comment only when it is the family’s one file', () => {
    const single = `@font-face { font-family: 'Solo'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/solo/a.woff2) format('woff2'); }`;
    expect(parseCss2(single, 'https://fonts.gstatic.com')).toMatchObject([
      { family: 'Solo', subset: null, unicodeRange: null },
    ]);
    const slice = `/* [3] */ @font-face { font-family: 'Cjk'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/c/3.woff2) format('woff2'); unicode-range: U+4E00-4EFF; }`;
    expect(parseCss2(slice, 'https://fonts.gstatic.com')).toEqual([]);
  });
});
