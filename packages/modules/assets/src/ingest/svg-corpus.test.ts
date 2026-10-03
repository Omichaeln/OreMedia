import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { INGEST_REJECTION_MESSAGES, IngestRejectionReason } from '@oremedia/contracts/assets';
import { derivatives, sanitise, svgPngRendition } from './steps';

/**
 * BSC-2 SVG corpus: what a design tool exports must pass with its structure kept (gradients, clip paths, masks, `<use>`
 * of a fragment, `<style>` without external references, transparency, a viewBox and no width or height), and every
 * file carrying active or external content must be refused with the reason that tells the uploader what to remove.
 */
const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (body: string, attrs = 'width="200" height="80"') => `<svg ${NS} ${attrs}>${body}</svg>`;
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SAFE: Array<{ name: string; file: string; keeps: string[] }> = [
  {
    name: 'linear and radial gradients',
    file: svg(
      '<defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="#e94e1b"/><stop offset="1" stop-color="#1b4ee9" stop-opacity="0.4"/></linearGradient><radialGradient id="rg"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs><rect width="100" height="80" fill="url(#lg)"/><circle cx="150" cy="40" r="30" fill="url(#rg)"/>',
    ),
    keeps: ['<linearGradient id="lg"', '<radialGradient id="rg"', 'fill="url(#lg)"', 'stop-opacity="0.4"'],
  },
  {
    name: 'clip paths and masks',
    file: svg(
      '<defs><clipPath id="c"><circle cx="40" cy="40" r="35"/></clipPath><mask id="m"><rect width="200" height="80" fill="#fff"/><circle cx="160" cy="40" r="20" fill="#000"/></mask></defs><g clip-path="url(#c)"><rect width="80" height="80" fill="#123456"/></g><rect x="100" width="100" height="80" fill="#654321" mask="url(#m)"/>',
    ),
    keeps: ['<clipPath id="c"', '<mask id="m"', 'clip-path="url(#c)"', 'mask="url(#m)"'],
  },
  {
    name: '<use> of a fragment (href and xlink:href)',
    file: svg(
      '<defs><path id="leaf" d="M0 0 C 20 -20 40 -20 60 0 C 40 20 20 20 0 0 Z" fill="#2a7"/></defs><use href="#leaf" x="10" y="40"/><use xlink:href="#leaf" x="110" y="40"/>',
    ),
    keeps: ['<use href="#leaf"', 'xlink:href="#leaf"', 'id="leaf"'],
  },
  {
    name: 'an internal <style> block with classes',
    file: svg(
      '<style>.mark{fill:#e94e1b}.word{fill:#222;font-weight:700}</style><rect class="mark" width="60" height="60"/><path class="word" d="M80 10h100v40H80z"/>',
    ),
    keeps: ['<style>', '.mark{fill:#e94e1b}', 'class="mark"'],
  },
  {
    name: 'a transparent background (no backdrop, fill-opacity)',
    file: svg('<circle cx="40" cy="40" r="30" fill="#e94e1b" fill-opacity="0.5"/>'),
    keeps: ['fill-opacity="0.5"'],
  },
  {
    name: 'a viewBox and no width or height',
    file: svg('<rect width="300" height="100" fill="#0a0"/>', 'viewBox="0 0 300 100"'),
    keeps: ['viewBox="0 0 300 100"'],
  },
  {
    name: 'editor metadata (Inkscape, Sodipodi, RDF) and a harmless colour animation, dropped silently',
    file: `<svg ${NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" width="200" height="80"><metadata><rdf:RDF/></metadata><sodipodi:namedview inkscape:zoom="1"/><rect width="200" height="80" fill="#123"><animate attributeName="fill" values="#123;#456" dur="1s"/></rect></svg>`,
    keeps: ['<rect width="200" height="80" fill="#123"'],
  },
  {
    name: 'an embedded PNG raster (data:image/png)',
    file: svg(`<image width="20" height="20" href="data:image/png;base64,${PNG_1PX}"/>`),
    keeps: ['data:image/png;base64,'],
  },
  {
    name: 'the public SVG 1.1 DOCTYPE a design tool writes (dropped; nothing fetches the DTD)',
    file: `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${svg('<rect width="9" height="9"/>')}`,
    keeps: ['<rect'],
  },
];

const UNSAFE: Array<{ name: string; file: string; reason: IngestRejectionReason }> = [
  {
    name: 'a <script> element',
    file: svg('<script>alert(1)</script><rect width="9" height="9"/>'),
    reason: 'svg_script',
  },
  {
    name: 'an onload handler',
    file: svg('<rect width="9" height="9"/>', 'width="10" height="10" onload="alert(1)"'),
    reason: 'svg_event_handler',
  },
  {
    name: 'an onclick handler on a shape',
    file: svg('<rect width="9" height="9" onclick="steal()"/>'),
    reason: 'svg_event_handler',
  },
  {
    name: 'a javascript: link',
    file: svg('<a href="javascript:alert(1)"><rect width="9" height="9"/></a>'),
    reason: 'svg_script',
  },
  {
    name: 'an external xlink:href on <use>',
    file: svg('<use xlink:href="https://evil.example/sprite.svg#logo"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: 'a protocol-relative href on <use>',
    file: svg('<use href="//evil.example/sprite.svg#logo"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: 'url(http…) in a style attribute',
    file: svg('<rect width="9" height="9" style="fill:url(https://evil.example/p.svg#g)"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: '@import in a <style> block',
    file: svg('<style>@import "https://evil.example/a.css";</style><rect width="9" height="9"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: 'a foreignObject with HTML',
    file: svg(
      '<foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>',
    ),
    reason: 'svg_embedded_content',
  },
  {
    name: 'an <image> fetched from a remote address',
    file: svg('<image width="20" height="20" href="https://evil.example/track.png"/>'),
    reason: 'svg_remote_image',
  },
  {
    name: 'an <image> with a data:text/html document',
    file: svg(
      '<image width="20" height="20" href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="/>',
    ),
    reason: 'svg_embedded_content',
  },
  {
    name: 'entity expansion (billion laughs)',
    file: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>${svg('<text>&b;</text>')}`,
    reason: 'svg_entity_declaration',
  },
  {
    name: 'an external entity in the DOCTYPE (XXE)',
    file: `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg('<text>&x;</text>')}`,
    reason: 'svg_entity_declaration',
  },
  // Review hardening: bypasses through backslashes, CSS escapes, image-set, namespaced scripts and SMIL.
  {
    name: 'a backslash-prefixed href (\\host)',
    file: svg('<image width="20" height="20" href="\\\\evil.example/a.png"/>'),
    reason: 'svg_remote_image',
  },
  {
    name: 'an escaped-slash href (\\/host)',
    file: svg('<use href="\\/evil.example/a.svg#x"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: 'a CSS-escaped scheme in url() in a style attribute',
    file: svg('<rect width="9" height="9" style="fill:url(\\68ttp://evil.example/x)"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: 'a CSS-escaped url( function in a <style> block',
    file: svg('<style>.a{fill:\\75rl(http://evil.example/x)}</style><rect class="a" width="9" height="9"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: 'a CSS-escaped @import',
    file: svg('<style>@\\69mport "http://evil.example/a.css";</style><rect width="9" height="9"/>'),
    reason: 'svg_external_reference',
  },
  {
    name: 'a comment inside url( in a <style> block',
    file: svg(
      '<style>.a{fill:url(/**/"https://evil.example/x")}</style><rect class="a" width="9" height="9"/>',
    ),
    reason: 'svg_external_reference',
  },
  {
    name: 'image-set() naming a remote image',
    file: svg(
      '<style>.a{background-image:image-set("https://evil.example/x.png" 1x)}</style><rect class="a" width="9" height="9"/>',
    ),
    reason: 'svg_external_reference',
  },
  {
    name: 'a script element under another prefix bound to the SVG namespace',
    file: svg(
      '<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script><rect width="9" height="9"/>',
    ),
    reason: 'svg_script',
  },
  {
    name: 'a <set> rewriting a link to javascript:',
    file: svg(
      '<a href="#a"><set attributeName="href" to="javascript:alert(1)"/><rect width="9" height="9"/></a>',
    ),
    reason: 'svg_script',
  },
  {
    name: 'an <animate> of xlink:href',
    file: svg(
      '<a xlink:href="#a"><animate attributeName="xlink:href" values="javascript:alert(1)"/><rect width="9" height="9"/></a>',
    ),
    reason: 'svg_script',
  },
  {
    name: 'huge declared dimensions',
    file: svg('<rect width="9" height="9"/>', 'width="40000" height="40000"'),
    reason: 'pixel_limit_exceeded',
  },
];

const sanitiseSvg = (file: string) => sanitise(Buffer.from(file), 'image/svg+xml', 'svg');

describe('BSC-2 SVG corpus: legitimate artwork passes with its structure kept', () => {
  it.each(SAFE)('$name', async ({ file, keeps }) => {
    const r = await sanitiseSvg(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.bytes.toString('utf8');
    for (const k of keeps) expect(text).toContain(k);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect((await sharp(r.preview).metadata()).format).toBe('png');
  });

  it('a transparent SVG keeps its transparency in the preview and the PNG rendition', async () => {
    const r = await sanitiseSvg(svg('<circle cx="40" cy="40" r="30" fill="#e94e1b"/>'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const corner = async (png: Buffer) => {
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      return data[3]; // alpha of the top-left pixel
    };
    expect(await corner(r.preview as Buffer)).toBe(0);
    const rendition = await svgPngRendition(r.bytes, 2048);
    expect(rendition).not.toBeNull();
    expect(rendition?.mime).toBe('image/png');
    // 200×80 is drawn at most 8x its own size, never upscaled from a smaller raster.
    expect([rendition?.width, rendition?.height]).toEqual([1600, 640]);
    expect(await corner(rendition?.bytes as Buffer)).toBe(0);
  });

  it('an SVG gets a PNG rendition (longer side up to 2048, at most 8x its size) beside its WebP derivatives; a raster gets none', async () => {
    const r = await sanitiseSvg(SAFE[0]?.file as string);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const built = await derivatives({ bytes: r.bytes, group: 'svg', preview: r.preview });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.derivatives.map((d) => d.purpose)).toEqual(['thumbnail', 'preview', 'web', 'png']);
    const png = built.derivatives.find((d) => d.purpose === 'png');
    expect(png).toMatchObject({ mime: 'image/png', width: 1600, height: 640 });
    expect((await sharp(png?.bytes).metadata()).hasAlpha).toBe(true);
    const raster = await derivatives({ bytes: r.preview as Buffer, group: 'image' });
    expect(raster.ok && raster.derivatives.map((d) => d.purpose)).toEqual(['thumbnail', 'preview', 'web']);
  });

  it('a PNG rendition at a chosen width is exactly that wide', async () => {
    const r = await sanitiseSvg(SAFE[0]?.file as string);
    if (!r.ok) throw new Error('safe SVG refused');
    const png = await svgPngRendition(r.bytes, 512, undefined, { side: 'width' });
    expect(png).toMatchObject({ width: 512, mime: 'image/png' });
    expect(Math.abs((png?.height ?? 0) - 205)).toBeLessThanOrEqual(1);
  });
});

describe('BSC-2 SVG corpus: active and external content is refused with the reason to act on', () => {
  it.each(UNSAFE)('$name → $reason', async ({ file, reason }) => {
    const r = await sanitiseSvg(file);
    expect(r).toMatchObject({ ok: false, reason });
  });

  it('a file with several problems is refused for the most specific one, every finding in the detail', async () => {
    const r = await sanitiseSvg(
      svg(
        '<script>x()</script><rect width="9" height="9" onclick="y()"/><use href="https://e.example/a#b"/>',
      ),
    );
    expect(r).toMatchObject({ ok: false, reason: 'svg_script' });
    const detail = (r as { detail?: string }).detail ?? '';
    expect(detail).toContain('element:script');
    expect(detail).toContain('handler:onclick');
    expect(detail).toContain('external_ref:href');
  });

  it('an SVG whose size is zero or relative is refused with svg_no_size', async () => {
    expect(await sanitiseSvg(svg('<rect width="9" height="9"/>', 'width="0" height="0"'))).toMatchObject({
      ok: false,
      reason: 'svg_no_size',
    });
  });

  it('every rejection reason has words for the uploader', () => {
    for (const reason of IngestRejectionReason.options)
      expect(INGEST_REJECTION_MESSAGES[reason].length).toBeGreaterThan(20);
  });
});
