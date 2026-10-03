import { fileTypeFromBuffer } from 'file-type';
import * as fontkit from './fontkit-loader';
import DOMPurify from 'isomorphic-dompurify';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import {
  ACCEPTED_MIMES,
  ARCHIVE_MIMES,
  KIND_MIME_GROUPS,
  MAX_IMAGE_PIXELS,
  MEDIA_DURATION_CAPS_SECONDS,
  type AssetKind,
  type AssetState,
  type DerivativePurpose,
  type FontMetadata,
  type IngestRejectionReason,
  type IngestStepRejection,
  type IngestStepResult,
  type MimeGroup,
} from '@oremedia/contracts/assets';
import { sha256Hex } from '@oremedia/domain/hash';
import type { StorageProvider } from '../storage';
import { inspectMedia } from './media';
import { ScannerUnavailableError, type Scanner } from './scanner';

/**
 * Spec 9.1 ingestion steps as pure, individually testable functions. Every step returns a typed result and never
 * throws for an expected rejection: a rejection is a value with a reason code (contracts IngestRejectionReason).
 * The activities in packages/activities wrap these with tenant context and storage I/O.
 */
export const SNIFF_BYTES = 4100;

const reject = (reason: IngestRejectionReason, detail?: string): IngestStepRejection =>
  detail ? { ok: false, reason, detail } : { ok: false, reason };

// ---- 1. verify ------------------------------------------------------------------------------------------------

export async function verifyObject(
  storage: StorageProvider,
  key: string,
  maxBytes: number,
): Promise<IngestStepResult<{ bytes: number }>> {
  const head = await storage.headObject(key);
  if (!head) return reject('object_missing');
  if (head.bytes <= 0) return reject('object_missing', 'empty object');
  if (head.bytes > maxBytes) return reject('exceeds_cap', `${head.bytes} bytes exceeds cap of ${maxBytes}`);
  return { ok: true, bytes: head.bytes };
}

// ---- 2. sniff -------------------------------------------------------------------------------------------------

const MIME_EQUIVALENTS: ReadonlyArray<readonly string[]> = [
  ['font/ttf', 'application/x-font-ttf', 'application/font-sfnt', 'font/sfnt'],
  ['font/otf', 'application/x-font-otf', 'application/font-sfnt', 'font/sfnt'],
  ['image/jpeg', 'image/jpg'],
  ['image/heic', 'image/heif'],
  ['video/mp4', 'video/x-m4v'],
];

const normaliseMime = (m: string): string => (m.split(';')[0] ?? '').trim().toLowerCase();

/** Detector names with an accepted canonical mime (file-type reports M4A audio as audio/x-m4a). */
const CANONICAL_MIME: Readonly<Record<string, string>> = {
  'audio/x-m4a': 'audio/mp4',
  'video/x-m4v': 'video/mp4',
};

function mimeMatches(declared: string, sniffed: string): boolean {
  const d = normaliseMime(declared);
  const s = normaliseMime(sniffed);
  if (d === s) return true;
  return MIME_EQUIVALENTS.some((set) => set.includes(d) && set.includes(s));
}

export function groupForMime(mime: string): MimeGroup | null {
  for (const [group, list] of Object.entries(ACCEPTED_MIMES))
    if (list.includes(mime)) return group as MimeGroup;
  return null;
}

/** Fonts by magic (spec 9.1): sfnt version tags, WOFF/WOFF2 signatures, TrueType collections. */
function sniffFontMagic(head: Uint8Array): string | 'collection' | null {
  if (head.length < 4) return null;
  const tag = Buffer.from(head.subarray(0, 4)).toString('latin1');
  if (tag === 'OTTO') return 'font/otf';
  if (tag === 'true' || (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0)) return 'font/ttf';
  if (tag === 'wOF2') return 'font/woff2';
  if (tag === 'wOFF') return 'font/woff';
  if (tag === 'ttcf') return 'collection';
  return null;
}

/** SVG by content, never by extension or declared mime. */
function looksLikeSvg(head: Uint8Array): boolean {
  const text = Buffer.from(head)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (!text.startsWith('<')) return false;
  return /<svg[\s>]/i.test(text);
}

const XML_LIKE = new Set(['application/xml', 'text/xml', 'text/html', 'image/svg+xml']);

export async function sniffType(
  head: Uint8Array,
  declared: { kind: AssetKind; mime: string },
): Promise<IngestStepResult<{ mime: string; group: MimeGroup }>> {
  const font = sniffFontMagic(head);
  if (font === 'collection') return reject('font_collection_unsupported');
  let mime: string | null = font;
  if (!mime) {
    const detected = await fileTypeFromBuffer(head);
    mime = detected?.mime ?? null;
  }
  if ((!mime || XML_LIKE.has(mime)) && looksLikeSvg(head)) mime = 'image/svg+xml';
  if (!mime) return reject('type_unrecognised');
  mime = CANONICAL_MIME[mime] ?? mime;
  if (ARCHIVE_MIMES.includes(mime)) return reject('archive_rejected');
  const group = groupForMime(mime);
  if (!group) return reject('format_unsupported', mime);
  if (!KIND_MIME_GROUPS[declared.kind].includes(group))
    return reject('type_mismatch', `${group} content cannot be an asset of kind ${declared.kind}`);
  if (!mimeMatches(declared.mime, mime))
    return reject('declared_mime_mismatch', `declared ${normaliseMime(declared.mime)}, detected ${mime}`);
  return { ok: true, mime, group };
}

// ---- 3. scan --------------------------------------------------------------------------------------------------

export async function scan(
  scanner: Scanner,
  bytes: Uint8Array,
): Promise<IngestStepResult<{ engine: string }>> {
  try {
    const verdict = await scanner.scan(bytes);
    if (!verdict.clean) return reject('malware_detected', verdict.signature);
    return { ok: true, engine: verdict.engine };
  } catch (err) {
    if (err instanceof ScannerUnavailableError)
      return { ok: false, reason: 'scanner_unavailable', retryable: true, detail: err.message };
    throw err;
  }
}

// ---- 4. sanitise ----------------------------------------------------------------------------------------------

export interface SanitisedFile {
  bytes: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
  colourProfile: string | null;
  fontMetadata?: FontMetadata;
  /** Rasterised PNG of a sanitised SVG (source of its derivatives). */
  preview?: Buffer;
  /** True when the stored bytes differ from the upload (metadata stripped, orientation normalised, SVG cleaned). */
  sanitised: boolean;
}

export interface SanitiseOptions {
  maxPixels?: number;
}

export async function sanitise(
  bytes: Buffer,
  mime: string,
  group: MimeGroup,
  opts: SanitiseOptions = {},
): Promise<IngestStepResult<SanitisedFile>> {
  switch (group) {
    case 'svg':
      return sanitiseSvg(bytes, opts);
    case 'image':
      return sanitiseImage(bytes, opts);
    case 'font':
      return sanitiseFont(bytes, mime);
    case 'pdf':
      return checkPdf(bytes, mime);
    case 'video':
    case 'audio':
      return checkMedia(bytes, mime, group);
    default:
      return reject('format_unsupported', `no sanitiser for ${group}`);
  }
}

const SVG_UNSAFE_TAGS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'handler',
  'listener',
  'base',
  'meta',
  'link',
]);
const SVG_URI_ATTRS = new Set(['href', 'xlink:href', 'src', 'xml:base', 'action', 'formaction']);
/** A link stays inside the file: a fragment, or (on `<image>` only) an embedded raster of an admitted type. */
const SVG_LINK_ATTRS = new Set(['href', 'xlink:href']);
const SVG_EMBEDDED_RASTER = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i;

/**
 * DOMPurify hook: an href or xlink:href that is not a fragment (or an embedded raster on `<image>`) is dropped, so a
 * relative reference (`other.svg#a`, `pic.png`, `/path`) is reported as a removal like an absolute one and the file is
 * refused. SVG_ALLOWED_URI alone admits relative values.
 */
function keepOnlyLocalLinks(
  node: { nodeName: string },
  data: { attrName: string; attrValue: string; keepAttr: boolean },
): void {
  if (!SVG_LINK_ATTRS.has(data.attrName)) return;
  const value = data.attrValue.trim();
  if (value.startsWith('#')) return;
  if (node.nodeName.toLowerCase() === 'image' && SVG_EMBEDDED_RASTER.test(value)) return;
  data.keepAttr = false;
}
/**
 * DOMPurify tests this against every attribute value that is not on its URI-safe list, so it must accept plain
 * values (numbers, path data, `url(#id)`, keywords) and fragment references while rejecting anything carrying a
 * scheme (`http:`, `javascript:`, `data:`) or a protocol-relative `//` prefix. Embedded `data:` rasters on
 * `<image>` are still admitted by DOMPurify's own data-URI rule for image tags. The xlink namespace declaration
 * is the one absolute URL a design file legitimately carries.
 */
const SVG_ALLOWED_URI = /^(?:#|[^a-z/\\]|[a-z+.-]+(?:[^a-z+.:-]|$)|http:\/\/www\.w3\.org\/1999\/xlink$)/i;
/**
 * External loads from CSS, tested on the cleaned file after the serialiser's entities are decoded (an attribute's
 * `"` is written `&quot;`), CSS comments removed and CSS escapes decoded (so `\75rl(\68ttp://…)` and `@\69mport` are
 * seen for what they are): a url() whose target is anything but a fragment (`#id`), so a scheme, `//`, a backslash or
 * a relative path; an image-set() string with a scheme other than data:image or a `//` prefix; and @import. An
 * empty url() loads nothing and is left alone.
 */
const EXTERNAL_STYLE_REF =
  /(?:url\(\s*(?:['"]\s*)?(?=[^#)'"\s])|image-set\([^)]*?['"]\s*(?!data:image\/)(?:[a-z][a-z0-9+.-]*:|\/\/)|@import)/i;

/** The entities DOMPurify's serialiser writes (attribute quotes, markup characters, no-break space), decoded once. */
const SERIALISED_ENTITIES: Readonly<Record<string, string>> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
};

/** The serialised file with its entities decoded in one pass, as a browser reads the attribute values. Test only. */
export function decodeSerialised(text: string): string {
  return text.replace(/&(quot|amp|lt|gt|nbsp);/g, (_m, name: string) => SERIALISED_ENTITIES[name] ?? '');
}

/** The text as CSS reads it: comments removed, escapes (`\68`, `\h`) decoded. Used only to test, never stored. */
export function cssReadable(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (_m, hex: string | undefined, ch: string | undefined) => {
      if (hex === undefined) return ch ?? '';
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    });
}

/** SMIL elements that can rewrite a link's target at run time (`<set attributeName="href" to="javascript:…">`). */
const SVG_ANIMATION_TAGS = new Set(['animate', 'set', 'animatemotion', 'animatetransform']);

/** Shape of DOMPurify.removed entries (jsdom nodes); typed structurally because the lib has no DOM types. */
type Removed = {
  element?: { nodeName: string; getAttribute?: (name: string) => string | null } | null;
  attribute?: { name: string; value: string | null } | null;
  from?: { nodeName: string } | null;
};

/** Elements that embed another document or media player: never part of a logo or illustration. */
const SVG_EMBEDDING_TAGS = new Set(['foreignobject', 'iframe', 'object', 'embed', 'audio', 'video']);
/** Elements that point the file at another address (a base URL, a stylesheet link). */
const SVG_LINKING_TAGS = new Set(['base', 'link']);
/** An embedded raster is admitted only as one of these image types (DOMPurify admits any data: URI on <image>). */
const EMBEDDED_DATA_URI = /\b(?:href|src)\s*=\s*["']\s*data:(?!image\/(?:png|jpe?g|gif|webp)[;,])/i;

/**
 * Why an SVG is refused, most specific first: the reason the uploader is shown (contracts INGEST_REJECTION_MESSAGES)
 * says what to remove from the file. A file carrying several problems is refused for the first in this order; the
 * detail lists every finding.
 */
const SVG_REASON_ORDER: readonly IngestRejectionReason[] = [
  'svg_script',
  'svg_event_handler',
  'svg_embedded_content',
  'svg_remote_image',
  'svg_external_reference',
  'svg_unsafe_content',
];

/** Which removals mean the file carried active or external content (an attack fixture, not a design file). */
function unsafeRemovals(removed: Removed[]): Array<{ reason: IngestRejectionReason; finding: string }> {
  const unsafe: Array<{ reason: IngestRejectionReason; finding: string }> = [];
  for (const r of removed) {
    if (r.element) {
      const tag = r.element.nodeName.toLowerCase();
      // A script under any prefix (`<x:script>` bound to the SVG namespace) is still a script.
      const local = tag.slice(tag.lastIndexOf(':') + 1);
      if (local === 'script' && tag !== 'script') {
        unsafe.push({ reason: 'svg_script', finding: `element:${tag}` });
        continue;
      }
      if (SVG_ANIMATION_TAGS.has(local)) {
        const target = (r.element.getAttribute?.('attributeName') ?? '').trim().toLowerCase();
        if (target === 'href' || target === 'xlink:href')
          unsafe.push({ reason: 'svg_script', finding: `animation:${local}:${target}` });
        continue; // other animations are dropped (a logo is static); metadata and editor namespaces likewise
      }
      if (!SVG_UNSAFE_TAGS.has(tag)) continue;
      const reason: IngestRejectionReason =
        tag === 'script'
          ? 'svg_script'
          : SVG_EMBEDDING_TAGS.has(tag)
            ? 'svg_embedded_content'
            : SVG_LINKING_TAGS.has(tag)
              ? 'svg_external_reference'
              : 'svg_unsafe_content';
      unsafe.push({ reason, finding: `element:${tag}` });
    } else if (r.attribute) {
      const name = r.attribute.name.toLowerCase();
      const value = (r.attribute.value ?? '').trimStart();
      if (name.startsWith('on')) unsafe.push({ reason: 'svg_event_handler', finding: `handler:${name}` });
      else if (name.startsWith('xmlns')) continue;
      else if (SVG_URI_ATTRS.has(name) || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
        const from = r.from?.nodeName.toLowerCase();
        const reason: IngestRejectionReason = /^javascript:/i.test(value.replace(/\s+/g, ''))
          ? 'svg_script'
          : /^data:/i.test(value)
            ? 'svg_embedded_content'
            : from === 'image' || from === 'img'
              ? 'svg_remote_image'
              : 'svg_external_reference';
        unsafe.push({ reason, finding: `external_ref:${name}` });
      }
    }
  }
  return unsafe;
}

/** At most this many internal entities, each a short literal: Illustrator declares about ten namespace URIs. */
const SVG_MAX_ENTITIES = 32;
const SVG_MAX_ENTITY_VALUE = 512;
const SVG_DOCTYPE = /<!DOCTYPE\s+svg\b([^[>]*)(?:\[([\s\S]*?)\]\s*)?>/i;
const SVG_ENTITY = /^<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>$/;

/**
 * Design tools write a DOCTYPE: Affinity and Illustrator's SVG 1.1 export reference the public SVG 1.1 DTD, and
 * Illustrator's "preserve editing" export declares its namespace URIs as internal entities (`&ns_ai;`). Neither
 * is needed to draw the file. The DOCTYPE is removed (nothing fetches the external DTD) and internal entities are
 * expanded once, in place, only when each is a short literal with no markup or further references: external
 * (SYSTEM/PUBLIC) and parameter entities, nested references and anything else in the internal subset are refused,
 * which closes XXE and entity-expansion attacks. Anything outside the one leading DOCTYPE is refused as before.
 */
export function stripSvgDoctype(text: string): { ok: true; text: string } | { ok: false; detail: string } {
  const match = SVG_DOCTYPE.exec(text);
  if (!match)
    return /<!DOCTYPE|<!ENTITY/i.test(text)
      ? { ok: false, detail: 'entity_declaration' }
      : { ok: true, text };
  const before = text.slice(0, match.index);
  // Only an XML declaration and comments may precede the DOCTYPE, so it is the document's own.
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*$/.test(before))
    return { ok: false, detail: 'entity_declaration' };
  const rest = text.slice(match.index + match[0].length);
  if (/<!DOCTYPE|<!ENTITY/i.test(rest)) return { ok: false, detail: 'entity_declaration' };
  const entities = new Map<string, string>();
  const subset = (match[2] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (subset) {
    const declarations = subset.match(/<![\s\S]*?>/g) ?? [];
    if (declarations.join('').replace(/\s/g, '') !== subset.replace(/\s/g, ''))
      return { ok: false, detail: 'entity_declaration' };
    if (declarations.length > SVG_MAX_ENTITIES) return { ok: false, detail: 'entity_declaration' };
    for (const declaration of declarations) {
      const [, name, double, single] = SVG_ENTITY.exec(declaration.trim()) ?? [];
      const value = double ?? single ?? '';
      if (!name || value.length > SVG_MAX_ENTITY_VALUE || /[&%<>]/.test(value))
        return { ok: false, detail: 'entity_declaration' };
      entities.set(name, value);
    }
  }
  let unknown = false;
  const body = rest.replace(/&([A-Za-z_][\w.-]*);/g, (ref, name: string) => {
    const value = entities.get(name);
    if (value !== undefined) return value.replace(/"/g, '&quot;');
    if (!['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) unknown = true;
    return ref;
  });
  if (unknown) return { ok: false, detail: 'entity_declaration' };
  return { ok: true, text: before + body };
}

/**
 * SVG: DOMPurify SVG profile with only fragment and data-image URIs allowed (scripts, event handlers, external and
 * relative references stripped), then a PNG preview rasterised with sharp. A file from which active or external content
 * had to be removed is rejected rather than quietly cleaned (Phase 2 gate: attack fixtures rejected), with the most
 * specific reason (BSC-2) so the uploader is told what to take out. Legitimate artwork is kept as it is: gradients,
 * clip paths, masks, `<use>` of a fragment, `<style>` without external references, transparency and a viewBox.
 */
async function sanitiseSvg(bytes: Buffer, opts: SanitiseOptions): Promise<IngestStepResult<SanitisedFile>> {
  const maxPixels = opts.maxPixels ?? MAX_IMAGE_PIXELS;
  const prolog = stripSvgDoctype(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  // What stripSvgDoctype still refuses (external or parameter entities, expansion) is the XXE vector.
  if (!prolog.ok) return reject('svg_entity_declaration', prolog.detail);
  const text = prolog.text;
  // The hook is added for this call only (DOMPurify is a shared instance; sanitize is synchronous).
  DOMPurify.addHook('uponSanitizeAttribute', keepOnlyLocalLinks);
  let clean: string;
  try {
    clean = DOMPurify.sanitize(text, {
      USE_PROFILES: { svg: true, svgFilters: true },
      // `use` is outside DOMPurify's SVG profile because of external references; with hrefs limited to fragments it is safe.
      ADD_TAGS: ['use'],
      FORBID_TAGS: [...SVG_UNSAFE_TAGS],
      ALLOWED_URI_REGEXP: SVG_ALLOWED_URI,
      KEEP_CONTENT: false,
    });
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute', keepOnlyLocalLinks);
  }
  const removed = [...(DOMPurify.removed as Removed[])];
  const unsafe = unsafeRemovals(removed);
  if (EXTERNAL_STYLE_REF.test(cssReadable(decodeSerialised(clean))))
    unsafe.push({ reason: 'svg_external_reference', finding: 'style:external_url' });
  if (EMBEDDED_DATA_URI.test(clean))
    unsafe.push({ reason: 'svg_embedded_content', finding: 'data_uri:not_image' });
  if (unsafe.length) {
    const reasons = new Set(unsafe.map((u) => u.reason));
    const reason = SVG_REASON_ORDER.find((r) => reasons.has(r)) ?? 'svg_unsafe_content';
    return reject(reason, [...new Set(unsafe.map((u) => u.finding))].slice(0, 10).join(','));
  }
  if (!/<svg[\s>]/i.test(clean)) return reject('svg_unparsable');
  const cleanBytes = Buffer.from(clean, 'utf8');
  let meta: Metadata;
  try {
    meta = await sharp(cleanBytes, { limitInputPixels: false }).metadata();
  } catch (err) {
    // librsvg refuses a zero, negative or relative size ("bad dimensions"); anything else could not be drawn.
    if (err instanceof Error && /dimensions/i.test(err.message))
      return reject('svg_no_size', 'bad dimensions');
    return reject('svg_unrenderable');
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return reject('svg_no_size', 'no intrinsic size');
  if (width * height > maxPixels) return reject('pixel_limit_exceeded', `${width}x${height}`);
  const preview = await rasteriseSvg(cleanBytes, { width, height }, 1024, maxPixels);
  if (!preview) return reject('svg_unrenderable');
  return {
    ok: true,
    bytes: cleanBytes,
    mime: 'image/svg+xml',
    width,
    height,
    colourProfile: null,
    preview,
    sanitised: removed.length > 0 || clean !== text,
  };
}

/**
 * A sanitised SVG drawn as a transparent PNG whose longer side is about `targetSide` (never below the intrinsic size,
 * at most 8x it): the source of an SVG's derivatives and of its PNG renditions. Null when the file cannot be drawn.
 */
export async function rasteriseSvg(
  svg: Buffer,
  intrinsic: { width: number; height: number },
  targetSide: number,
  maxPixels: number = MAX_IMAGE_PIXELS,
): Promise<Buffer | null> {
  const density = Math.round(
    72 * Math.max(1, Math.min(8, targetSide / Math.max(intrinsic.width, intrinsic.height))),
  );
  try {
    return await sharp(svg, { density, limitInputPixels: maxPixels }).png().toBuffer();
  } catch {
    return null;
  }
}

const RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

/**
 * Raster images: the header-declared dimensions are compared with the pixel budget BEFORE any decode
 * (decompression bombs), then sharp re-encodes with EXIF/GPS dropped, orientation normalised and the ICC profile
 * kept. HEIC/HEIF and AVIF are converted (spec 9.1 "HEIC→converted").
 */
async function sanitiseImage(bytes: Buffer, opts: SanitiseOptions): Promise<IngestStepResult<SanitisedFile>> {
  const maxPixels = opts.maxPixels ?? MAX_IMAGE_PIXELS;
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    return reject('image_undecodable');
  }
  if (!meta.format || !RASTER_FORMATS.has(meta.format))
    return reject('format_unsupported', meta.format ?? 'unknown');
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return reject('image_undecodable', 'no dimensions');
  if (width * height > maxPixels) return reject('pixel_limit_exceeded', `${width}x${height}`);
  const pipeline = sharp(bytes, { limitInputPixels: maxPixels }).rotate().keepIccProfile();
  let mime: string;
  switch (meta.format) {
    case 'png':
      pipeline.png();
      mime = 'image/png';
      break;
    case 'webp':
      pipeline.webp({ quality: 95 });
      mime = 'image/webp';
      break;
    case 'jpeg':
      pipeline.jpeg({ quality: 95 });
      mime = 'image/jpeg';
      break;
    default:
      // heif (HEIC and AVIF are both reported as heif): converted, keeping alpha where the source has it.
      if (meta.hasAlpha) {
        pipeline.png();
        mime = 'image/png';
      } else {
        pipeline.jpeg({ quality: 92 });
        mime = 'image/jpeg';
      }
  }
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch {
    return reject('image_undecodable');
  }
  const colourProfile = meta.icc ? `icc:${meta.space ?? 'unknown'}` : (meta.space ?? null);
  return {
    ok: true,
    bytes: out.data,
    mime,
    width: out.info.width,
    height: out.info.height,
    colourProfile,
    sanitised: true,
  };
}

interface FontLike {
  numGlyphs?: number;
  familyName?: string | null;
  subfamilyName?: string | null;
  postscriptName?: string | null;
  copyright?: string | null;
  version?: string | null;
  unitsPerEm?: number;
  name?: { records?: Record<string, Record<string, string> | undefined> };
}

const clip = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length ? v.slice(0, max) : null;

function nameRecord(f: FontLike, key: string): string | null {
  const rec = f.name?.records?.[key];
  if (!rec) return null;
  const first = rec['en'] ?? Object.values(rec)[0];
  return clip(first, 500);
}

/**
 * Largest font a compressed file (WOFF, WOFF2) may expand to. A compressed font declares the size of every table it
 * holds, and fontkit decompresses into buffers of exactly those sizes, so bounding the declared sizes bounds the
 * work: a small file that claims to expand to gigabytes (a decompression bomb) is refused before any decompression.
 */
export const MAX_FONT_EXPANDED_BYTES = 32 * 1024 * 1024;

function readBase128(b: Buffer, at: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = b[at + i];
    if (byte === undefined || (i === 0 && byte === 0x80) || value & 0xfe000000) return null;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  return null;
}

/**
 * The size a WOFF or WOFF2 file declares it expands to (the larger of its header's total and the sum of its table
 * sizes, as fontkit allocates them), null for an uncompressed font, NaN for a header too short or malformed to read.
 * Reads only the header and table directory; nothing is decompressed.
 */
export function declaredFontExpansion(bytes: Buffer): number | null {
  const tag = bytes.toString('latin1', 0, 4);
  if (tag === 'wOFF') {
    if (bytes.length < 44) return NaN;
    const numTables = bytes.readUInt16BE(12);
    if (bytes.length < 44 + 20 * numTables) return NaN;
    let sum = 0;
    for (let i = 0; i < numTables; i++) sum += bytes.readUInt32BE(44 + 20 * i + 12);
    return Math.max(sum, bytes.readUInt32BE(16));
  }
  if (tag === 'wOF2') {
    if (bytes.length < 48) return NaN;
    const numTables = bytes.readUInt16BE(12);
    let at = 48;
    let sum = 0;
    for (let i = 0; i < numTables; i++) {
      const flags = bytes[at];
      if (flags === undefined) return NaN;
      at += (flags & 0x3f) === 0x3f ? 5 : 1;
      const length = readBase128(bytes, at);
      if (!length) return NaN;
      at = length.next;
      const index = flags & 0x3f;
      const version = flags >>> 6;
      // glyf (10) and loca (11) are transformed at version 0; every other table at a non-zero version.
      const transformed = index === 10 || index === 11 ? version === 0 : version !== 0;
      let size = length.value;
      if (transformed) {
        const t = readBase128(bytes, at);
        if (!t) return NaN;
        at = t.next;
        size = Math.max(size, t.value);
      }
      sum += size;
    }
    return Math.max(sum, bytes.readUInt32BE(16));
  }
  return null;
}

/** Fonts: parsed with fontkit; family and licence metadata recorded; anything unparsable is rejected. */
function sanitiseFont(bytes: Buffer, mime: string): IngestStepResult<SanitisedFile> {
  const expanded = declaredFontExpansion(bytes);
  if (expanded !== null && Number.isNaN(expanded)) return reject('font_unparsable', 'truncated header');
  if (expanded !== null && expanded > MAX_FONT_EXPANDED_BYTES)
    return reject('exceeds_cap', `expands to ${expanded} bytes, more than ${MAX_FONT_EXPANDED_BYTES}`);
  let font: unknown;
  try {
    font = fontkit.create(bytes);
  } catch {
    return reject('font_unparsable');
  }
  if (!font || typeof font !== 'object') return reject('font_unparsable');
  if ('fonts' in font) return reject('font_collection_unsupported');
  const f = font as FontLike;
  let fontMetadata: FontMetadata;
  try {
    const glyphs = typeof f.numGlyphs === 'number' ? f.numGlyphs : 0;
    if (glyphs <= 0 || !f.unitsPerEm) return reject('font_unparsable', 'no glyphs');
    fontMetadata = {
      family: clip(f.familyName, 200),
      subfamily: clip(f.subfamilyName, 200),
      postscriptName: clip(f.postscriptName, 200),
      copyright: clip(f.copyright, 500),
      licence: nameRecord(f, 'license'),
      licenceUrl: nameRecord(f, 'licenseURL'),
      fontVersion: clip(f.version, 100),
      glyphs,
    };
  } catch {
    return reject('font_unparsable');
  }
  return {
    ok: true,
    bytes,
    mime,
    width: null,
    height: null,
    colourProfile: null,
    fontMetadata,
    sanitised: false,
  };
}

/** PDF references: header check only; there is no sanitiser, they are served as files and never rendered server-side. */
function checkPdf(bytes: Buffer, mime: string): IngestStepResult<SanitisedFile> {
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-'))
    return reject('format_unsupported', 'not a pdf');
  return { ok: true, bytes, mime, width: null, height: null, colourProfile: null, sanitised: false };
}

/**
 * Video and audio (ADR-11 generated media): the container is checked structurally and the duration capped; the bytes
 * are stored as delivered (nothing is transcoded, so there is no preview and no derivative).
 */
function checkMedia(bytes: Buffer, mime: string, group: 'video' | 'audio'): IngestStepResult<SanitisedFile> {
  const r = inspectMedia(bytes, mime);
  if (!r) return reject('format_unsupported', mime);
  if (!r.ok) return reject('media_malformed', r.detail);
  const cap = MEDIA_DURATION_CAPS_SECONDS[group];
  if (r.info.durationSeconds > cap)
    return reject('duration_exceeds_cap', `${Math.round(r.info.durationSeconds)} s exceeds ${cap} s`);
  return {
    ok: true,
    bytes,
    mime,
    width: r.info.width,
    height: r.info.height,
    colourProfile: null,
    sanitised: false,
  };
}

// ---- 5. hash and dedupe ---------------------------------------------------------------------------------------

/** SHA-256 of the stored bytes; a match within the brand is a `duplicate_of` proposal, never a silent merge. */
export async function hashAndDedupe(
  bytes: Uint8Array,
  findExistingAssetId: (contentHash: string) => Promise<string | null>,
): Promise<IngestStepResult<{ contentHash: string }>> {
  const contentHash = sha256Hex(bytes);
  const existing = await findExistingAssetId(contentHash);
  if (existing)
    return {
      ok: false,
      reason: 'duplicate_of',
      duplicateOfAssetId: existing,
      detail: 'identical content already exists in this brand',
    };
  return { ok: true, contentHash };
}

// ---- 6. derivatives -------------------------------------------------------------------------------------------

export interface DerivativeFile {
  purpose: DerivativePurpose;
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  transform: Record<string, string | number | boolean>;
}

const DERIVATIVE_SPECS: ReadonlyArray<{ purpose: DerivativePurpose; maxSide: number; quality: number }> = [
  { purpose: 'thumbnail', maxSide: 256, quality: 80 },
  { purpose: 'preview', maxSide: 1024, quality: 85 },
  { purpose: 'web', maxSide: 2048, quality: 88 },
];

/** Thumbnail, preview and web-optimised WebP renditions of a raster (or of an SVG's rasterised preview). */
export async function derivatives(
  source: { bytes: Buffer; group: MimeGroup; preview?: Buffer },
  opts: SanitiseOptions = {},
): Promise<IngestStepResult<{ derivatives: DerivativeFile[] }>> {
  const maxPixels = opts.maxPixels ?? MAX_IMAGE_PIXELS;
  const raster =
    source.group === 'image' ? source.bytes : source.group === 'svg' ? source.preview : undefined;
  if (!raster) return { ok: true, derivatives: [] };
  const out: DerivativeFile[] = [];
  for (const spec of DERIVATIVE_SPECS) {
    try {
      const r = await sharp(raster, { limitInputPixels: maxPixels })
        .resize({ width: spec.maxSide, height: spec.maxSide, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: spec.quality })
        .toBuffer({ resolveWithObject: true });
      out.push({
        purpose: spec.purpose,
        bytes: r.data,
        mime: 'image/webp',
        width: r.info.width,
        height: r.info.height,
        transform: {
          op: 'resize',
          fit: 'inside',
          maxSide: spec.maxSide,
          format: 'webp',
          quality: spec.quality,
        },
      });
    } catch {
      return reject('image_undecodable', `derivative ${spec.purpose}`);
    }
  }
  if (source.group === 'svg') {
    const png = await svgPngRendition(source.bytes, PNG_RENDITION_MAX_SIDE, maxPixels);
    if (!png) return reject('svg_unrenderable', 'derivative png');
    out.push(png);
  }
  return { ok: true, derivatives: out };
}

/** Longest side of the PNG rendition of an SVG kept at ingest: what a destination that needs a raster receives. */
export const PNG_RENDITION_MAX_SIDE = 2048;

/**
 * BSC-2: a transparent PNG of a sanitised SVG whose longer side is `maxSide` (drawn from the vector at that size, never
 * upscaled from a smaller raster; a tiny SVG is drawn at most 8x its own size), or, with `side: 'width'`, whose width
 * is `maxSide`: kept at ingest as the `png` derivative for destinations that take rasters only
 * (website articles), and drawn at a chosen width for a download. Null when the file cannot be drawn.
 */
export async function svgPngRendition(
  svg: Buffer,
  maxSide: number,
  maxPixels: number = MAX_IMAGE_PIXELS,
  opts: { side?: 'longer' | 'width' } = {},
): Promise<DerivativeFile | null> {
  let meta: Metadata;
  try {
    meta = await sharp(svg, { limitInputPixels: false }).metadata();
  } catch {
    return null;
  }
  if (!meta.width || !meta.height) return null;
  const byWidth = opts.side === 'width';
  const target = byWidth ? Math.max(maxSide, (maxSide * meta.height) / meta.width) : maxSide;
  // Drawn a little larger than asked (the density is whole dots per inch), then resized down to the exact size.
  const drawn = await rasteriseSvg(svg, { width: meta.width, height: meta.height }, target * 1.05, maxPixels);
  if (!drawn) return null;
  try {
    const r = await sharp(drawn, { limitInputPixels: maxPixels })
      .resize(
        byWidth
          ? { width: maxSide, withoutEnlargement: true }
          : { width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true },
      )
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      purpose: 'png',
      bytes: r.data,
      mime: 'image/png',
      width: r.info.width,
      height: r.info.height,
      transform: { op: 'rasterise', fit: 'inside', maxSide, format: 'png' },
    };
  } catch {
    return null;
  }
}

/**
 * BSC-2: a PNG of a raster image at `width` (never enlarged; alpha kept), for a download at a chosen width. Null
 * when the bytes cannot be decoded.
 */
export async function rasterPngRendition(
  bytes: Buffer,
  width: number,
  maxPixels: number = MAX_IMAGE_PIXELS,
): Promise<DerivativeFile | null> {
  try {
    const r = await sharp(bytes, { limitInputPixels: maxPixels })
      .resize({ width, withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      purpose: 'png',
      bytes: r.data,
      mime: 'image/png',
      width: r.info.width,
      height: r.info.height,
      transform: { op: 'resize', width, format: 'png' },
    };
  } catch {
    return null;
  }
}

// ---- 7. move to immutable -------------------------------------------------------------------------------------

/** Copies the sanitised objects to their immutable assets/ keys, then deletes the quarantine objects listed. */
export async function moveToImmutable(
  storage: StorageProvider,
  plan: { copies: Array<{ fromKey: string; toKey: string }>; deleteKeys: string[] },
): Promise<{ ok: true; copied: number }> {
  for (const c of plan.copies) await storage.copyObject(c.fromKey, c.toKey);
  for (const k of plan.deleteKeys) await storage.deleteObject(k);
  return { ok: true, copied: plan.copies.length };
}

// ---- 8. catalogue ---------------------------------------------------------------------------------------------

/** The initial state is an explicit input decided by the caller (policy), never inferred here (spec 9.1 step 8). */
export const initialAssetState = (autoApprove: boolean): AssetState =>
  autoApprove ? 'approved' : 'pending_review';
