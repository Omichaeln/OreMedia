import { fetch, type Dispatcher } from 'undici';
import {
  GOOGLE_FONTS_DEFAULT_SUBSETS,
  GOOGLE_FONTS_MAX_FILES,
  UNICODE_RANGE,
  type FontStyle,
} from '@oremedia/contracts/assets';
import { ProviderUnavailableError, ValidationFailedError } from '@oremedia/contracts/errors';
import { assertCurrentTenantEgress } from '@oremedia/module-access';
import { logger } from '@oremedia/observability';
import { assertSafeUrl, ssrfSafeDispatcher } from '@oremedia/providers';
import * as fontkit from './ingest/fontkit-loader';
import { MAX_FONT_EXPANDED_BYTES, declaredFontExpansion } from './ingest/steps';

/**
 * Google Fonts, as the brand kit's typography import reaches it: the css2 stylesheet API and the font files it links
 * to, and nothing else. Two hosts only (fonts.googleapis.com for the stylesheet, fonts.gstatic.com for files): a
 * stylesheet that points anywhere else is refused before any request is made, redirects are refused, every request
 * goes through the SSRF-safe dispatcher (pinned DNS, private ranges refused) with an explicit timeout, and bodies
 * are read against a byte cap so an oversized answer is abandoned mid-stream. There is no URL parameter: callers
 * name a family, weights and styles, and this module builds the one URL it will fetch.
 */
export interface GoogleFontsOptions {
  /** Origin of the css2 API; tests point it at a loopback fixture server. */
  cssOrigin?: string;
  /** The one origin font files may come from. */
  fontOrigin?: string;
  timeoutMs?: number;
  /** The whole import (stylesheet and every file) finishes within this, or fails as unavailable. */
  totalTimeoutMs?: number;
  maxCssBytes?: number;
  maxFileBytes?: number;
  /** Tests only: allow loopback origins (refused in production by the dispatcher). */
  insecureAllowLoopback?: boolean;
}

const DEFAULTS = {
  cssOrigin: 'https://fonts.googleapis.com',
  fontOrigin: 'https://fonts.gstatic.com',
  timeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxCssBytes: 256 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
};

/** css2 lists WOFF2 only for a browser it knows supports it; a current desktop Chrome is the reference client. */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WOFF2_MAGIC = 'wOF2';

let options: GoogleFontsOptions = {};
let dispatcher: Dispatcher | null = null;

/** Composition root and tests; production uses the defaults. */
export function configureGoogleFonts(opts: GoogleFontsOptions): void {
  options = { ...opts };
  dispatcher = null;
}

const config = () => ({ ...DEFAULTS, ...options });

function safeDispatcher(): Dispatcher {
  return (dispatcher ??= ssrfSafeDispatcher(
    options.insecureAllowLoopback ? { insecureAllowLoopback: true } : {},
  ));
}

/** One @font-face of a css2 answer, as kept: a WOFF2 file on the font origin with its descriptors. */
export interface GoogleFontFaceSource {
  family: string;
  weight: number;
  style: FontStyle;
  subset: string | null;
  unicodeRange: string | null;
  url: string;
}

/** `Inter:ital,wght@0,400;0,700;1,400` — tuples sorted as css2 requires. */
export function css2Url(
  cssOrigin: string,
  family: string,
  weights: readonly number[],
  styles: readonly FontStyle[],
): string {
  const tuples = [...new Set(styles)]
    .map((s) => (s === 'italic' ? 1 : 0))
    .sort()
    .flatMap((ital) => [...new Set(weights)].sort((a, b) => a - b).map((w) => `${ital},${w}`));
  const name = family.trim().replace(/\s+/g, '+');
  return `${cssOrigin}/css2?family=${name}:ital,wght@${tuples.join(';')}&display=swap`;
}

// The answer is untrusted, so every pattern is bounded: a subset comment is short and has no '*', a block body is
// at most 8 KB (css2 blocks are a few hundred bytes), and descriptors are split on ';' and ':' rather than matched
// by a pattern that could backtrack over a long run of letters. SRC_URL runs on one descriptor value only.
const FACE_BLOCK = /(?:\/\*([^*]{0,80})\*\/\s*)?@font-face\s*\{([^{}]{0,8192})\}/g;
const SRC_URL = /^url\(\s*(['"]?)([^'")\s]{1,2048})\1\s*\)\s*format\(\s*['"]?([a-z0-9-]{1,20})['"]?\s*\)/i;

function descriptors(body: string): Map<string, string> {
  const d = new Map<string, string>();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    d.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return d;
}

/**
 * The @font-face blocks of a css2 answer. A block is kept when its subset is wanted and its source is a WOFF2 file
 * on `fontOrigin`; a source on any other origin, scheme or port fails the whole import (the answer is not what
 * Google serves). Descriptor values are validated, never passed on as they are.
 */
export function parseCss2(
  css: string,
  fontOrigin: string,
  subsets: readonly string[] = GOOGLE_FONTS_DEFAULT_SUBSETS,
): GoogleFontFaceSource[] {
  const wanted = new Set(subsets);
  const out: GoogleFontFaceSource[] = [];
  for (const block of css.matchAll(FACE_BLOCK)) {
    const subset = block[1]?.trim() || null;
    const d = descriptors(block[2] ?? '');
    const src = SRC_URL.exec(d.get('src') ?? '');
    if (!src) continue;
    const url = src[2] ?? '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw untrusted('font source is not a URL');
    }
    if (parsed.origin !== fontOrigin || parsed.username || parsed.password)
      throw untrusted('font source outside the font host');
    if ((src[3] ?? '').toLowerCase() !== 'woff2') continue;
    // A named subset is kept when wanted; an unnamed block only when it is the family's one file (no range).
    if (subset !== null ? !wanted.has(subset) : d.has('unicode-range')) continue;
    const family = (d.get('font-family') ?? '').replace(/^['"]|['"]$/g, '');
    const style = d.get('font-style');
    const weight = Number(d.get('font-weight'));
    const range = d.get('unicode-range') ?? null;
    if (!family || (style !== 'normal' && style !== 'italic') || !Number.isInteger(weight)) continue;
    if (weight < 1 || weight > 1000) continue;
    if (range !== null && (range.length > 4000 || !UNICODE_RANGE.test(range)))
      throw untrusted('unicode-range is malformed');
    out.push({ family, weight, style, subset, unicodeRange: range, url: parsed.toString() });
  }
  return out;
}

const untrusted = (detail: string) =>
  new ValidationFailedError(
    [{ path: 'family', issue: 'google_fonts_answer_rejected' }],
    `Google Fonts answered with something this import does not accept (${detail})`,
  );

const unavailable = () => new ProviderUnavailableError('google_fonts');

/** css2 answers 400 for an unknown family or axis values; a font file that is gone answers 404. */
class NotServed extends Error {}

/** GET one URL on an allowed origin: SSRF-safe dispatcher, no redirects, timeout, body read against a cap. */
async function get(
  url: string,
  allowedOrigin: string,
  maxBytes: number,
  accept: string,
  deadline: number,
): Promise<Buffer> {
  const cfg = config();
  const remaining = Math.min(cfg.timeoutMs, deadline - Date.now());
  if (remaining <= 0) throw unavailable();
  const target = assertSafeUrl(url, options.insecureAllowLoopback ? { insecureAllowLoopback: true } : {});
  if (target.origin !== allowedOrigin) throw untrusted('request outside the allowed host');
  // Architecture §4.4: a demo company never downloads from Google Fonts (the import is refused in its service first).
  await assertCurrentTenantEgress();
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(target, {
      method: 'GET',
      headers: { 'user-agent': CHROME_UA, accept },
      dispatcher: safeDispatcher(),
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
    });
  } catch (err) {
    logger()
      .child('google-fonts')
      .warn({ path: target.pathname, errorName: (err as Error)?.name }, 'google fonts request failed');
    throw unavailable();
  }
  if (res.status === 400 || res.status === 404) {
    await res.body?.cancel();
    throw new NotServed();
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw unavailable();
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw untrusted(`answer larger than ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      total += (chunk as Uint8Array).length;
      if (total > maxBytes) throw untrusted(`answer larger than ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
  } catch (err) {
    if (err instanceof ValidationFailedError) throw err;
    throw unavailable();
  }
  return Buffer.concat(chunks);
}

/**
 * One downloaded WOFF2 file. css2 names one file per face and subset; for a variable family it names the same file for
 * every weight requested, so such a file is downloaded once and carries the weight range it covers.
 */
export interface GoogleFontFile extends GoogleFontFaceSource {
  weightRange: { min: number; max: number } | null;
  bytes: Buffer;
}

/**
 * The weight range a variable WOFF2 declares on its wght axis; null when it declares none or cannot be read. The
 * declared expansion is checked first, as at ingest, so a decompression bomb is never decompressed here.
 */
function variableWeightRange(bytes: Buffer): { min: number; max: number } | null {
  const expanded = declaredFontExpansion(bytes);
  if (expanded === null || Number.isNaN(expanded) || expanded > MAX_FONT_EXPANDED_BYTES) return null;
  try {
    const font = fontkit.create(bytes) as { variationAxes?: Record<string, { min?: number; max?: number }> };
    const axis = font.variationAxes?.['wght'];
    const min = Math.round(Number(axis?.min));
    const max = Math.round(Number(axis?.max));
    return Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max <= 1000 && min < max
      ? { min, max }
      : null;
  } catch {
    return null;
  }
}

/**
 * The files of the requested faces: the css2 stylesheet, then each distinct WOFF2 file it names (at most
 * GOOGLE_FONTS_MAX_FILES, four at a time). Blocks naming the same file (a variable family asked for several weights)
 * become one file whose weight range is the file's own wght axis, or the weights asked for when it declares none.
 * An unknown family, or weights and styles the family does not have, is a validation error (css2 answers 400); a
 * request that names nothing css2 keeps is one too. Everything is downloaded before anything is returned, so a
 * failure part-way leaves nothing behind.
 */
export async function fetchGoogleFontFiles(input: {
  family: string;
  weights: readonly number[];
  styles: readonly FontStyle[];
  subsets?: readonly string[];
}): Promise<GoogleFontFile[]> {
  const cfg = config();
  const deadline = Date.now() + cfg.totalTimeoutMs;
  let css: string;
  try {
    const url = css2Url(cfg.cssOrigin, input.family, input.weights, input.styles);
    css = (await get(url, cfg.cssOrigin, cfg.maxCssBytes, 'text/css,*/*;q=0.1', deadline)).toString('utf8');
  } catch (err) {
    if (err instanceof NotServed)
      throw new ValidationFailedError(
        [{ path: 'family', issue: 'google_fonts_family_unknown' }],
        `Google Fonts has no family "${input.family}" with those weights and styles`,
      );
    throw err;
  }
  const blocks = parseCss2(css, cfg.fontOrigin, input.subsets ?? GOOGLE_FONTS_DEFAULT_SUBSETS);
  if (blocks.some((f) => f.family.toLowerCase() !== input.family.trim().toLowerCase()))
    throw untrusted('a face of another family');
  const byUrl = new Map<string, GoogleFontFaceSource[]>();
  for (const b of blocks) byUrl.set(b.url, [...(byUrl.get(b.url) ?? []), b]);
  const faces = [...byUrl.values()].map((same) => {
    const first = same[0] as GoogleFontFaceSource;
    if (same.some((b) => b.style !== first.style || b.subset !== first.subset))
      throw untrusted('one file named for different styles or subsets');
    const weights = same.map((b) => b.weight);
    return {
      ...first,
      weight: Math.min(...weights),
      maxRequested: Math.max(...weights),
      shared: same.length > 1,
    };
  });
  if (faces.length === 0)
    throw new ValidationFailedError(
      [{ path: 'subsets', issue: 'google_fonts_no_matching_files' }],
      'Google Fonts has no WOFF2 files of this family in the chosen subsets',
    );
  if (faces.length > GOOGLE_FONTS_MAX_FILES)
    throw new ValidationFailedError(
      [{ path: 'weights', issue: `too_many_files_${GOOGLE_FONTS_MAX_FILES}` }],
      'That is more files than one import takes; import fewer weights, styles or subsets',
    );
  const files: GoogleFontFile[] = [];
  for (let i = 0; i < faces.length; i += 4) {
    const batch = faces.slice(i, i + 4);
    const bytes = await Promise.all(
      batch.map(async (f) => {
        try {
          return await get(f.url, cfg.fontOrigin, cfg.maxFileBytes, 'font/woff2,*/*;q=0.1', deadline);
        } catch (err) {
          if (err instanceof NotServed) throw unavailable();
          throw err;
        }
      }),
    );
    batch.forEach(({ maxRequested, shared, ...f }, j) => {
      const b = bytes[j] as Buffer;
      if (b.subarray(0, 4).toString('latin1') !== WOFF2_MAGIC) throw untrusted('a file is not WOFF2');
      const axis = shared ? variableWeightRange(b) : null;
      const weightRange = shared ? (axis ?? { min: f.weight, max: maxRequested }) : null;
      files.push({ ...f, weight: weightRange?.min ?? f.weight, weightRange, bytes: b });
    });
  }
  return files;
}
