import { z } from 'zod';
import {
  articleBlockText,
  faqAnswerText,
  type ArticleBlockV1,
  type ArticleDocumentV1,
  type ArticleFaqAnswerBlockV1,
  type ArticleImageV1,
} from './content';
import { scanMarkup, type MarkupToken } from './markup';

/*
 * Ledger R2-3 (D-16): the one place an article becomes HTML and the one place HTML from outside (a remote
 * revision read back, a body edited on a live article) is reduced to what the product allows. Pure: no DOM, no
 * network, so the server, the web app and the UI mock render and check the same way.
 */

/** The tags an article may carry, with the attributes each keeps; everything else is dropped with its attributes. */
export const ARTICLE_HTML_ALLOWED_TAGS: Readonly<Record<string, readonly string[]>> = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  ol: [],
  li: [],
  strong: [],
  em: [],
  b: [],
  i: [],
  u: [],
  s: [],
  br: [],
  hr: [],
  blockquote: [],
  code: [],
  pre: [],
  section: ['class'],
  figure: [],
  figcaption: [],
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height'],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
  dl: [],
  dt: [],
  dd: [],
};
/** Elements whose whole content is discarded, never rendered as text. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'svg',
  'math',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const URL_ATTRS = new Set(['href', 'src']);

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Text taken from a document that may already carry entities: `<`, `>` and bare `&` are escaped, entities kept. */
const escapeText = (text: string): string =>
  text
    .replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
/** An attribute value taken from markup: as `escapeText`, with the quote escaped too (entities kept, never doubled). */
const escapeAttr = (value: string): string => escapeText(value).replace(/"/g, '&quot;');

/** A numeric character reference's character; anything that is not a Unicode scalar value (NUL, surrogates, beyond U+10FFFF) is U+FFFD. */
const codePoint = (n: number): string =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : '\uFFFD';
const URL_NAMED_REFS: Readonly<Record<string, string>> = {
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  Tab: '\t',
  NewLine: '\n',
};
/**
 * An attribute value's character references decoded, as a browser reads them before the URL is parsed: numeric
 * references (the `;` optional, as browsers accept) and the named ones that can spell a scheme or its separator.
 * Any other `&name;` stays literal text, and the caller escapes it again, so the browser cannot decode it either.
 */
const decodeUrlReferences = (value: string): string =>
  value.replace(
    /&(?:#(\d{1,8});?|#x([0-9a-f]{1,8});?|(amp|AMP|lt|LT|gt|GT|quot|QUOT|apos|nbsp|colon|Tab|NewLine);)/gi,
    (ref, dec: string | undefined, hex: string | undefined, named: string | undefined) =>
      dec !== undefined
        ? codePoint(Number(dec))
        : hex !== undefined
          ? codePoint(parseInt(hex, 16))
          : (URL_NAMED_REFS[named as string] ?? ref),
  );

/**
 * A URL an article may link to or embed: http(s), mailto, a relative path or a fragment; never a script. The value
 * is read as the browser reads it (character references decoded), and one carrying a control, format or whitespace
 * character anywhere (or a malformed reference) is refused, so `javascript&#58;`, `java&Tab;script:` or a leading NUL cannot hide a scheme.
 * The URL returned is decoded: the caller escapes it in full (`escapeHtml`), so what the browser sees is what was checked.
 */
export function safeArticleUrl(value: string): string | null {
  const v = decodeUrlReferences(value).trim();
  if (v === '') return null;
  if (/[\p{Cc}\p{Cf}\s<>"�]/u.test(v)) return null; // U+FFFD: a malformed reference (`&#0;`)
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return /^(https?:|mailto:)/i.test(v) ? v : null;
  if (v.startsWith('//')) return null; // protocol-relative: the scheme is the page's, not ours
  return v;
}

/**
 * Reduces HTML to the allow-listed tags and attributes: no scripts, no iframes, no event handlers, no inline
 * styles, no unsafe URLs. Unknown tags are removed but their text is kept; the content of script-like elements is
 * dropped. Open tags are closed at the end in order, so the result is always well-formed.
 */
export function sanitizeArticleHtml(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let dropping: string | null = null;
  // One pass of the linear markup scanner (markup.ts): no regular expression runs over the untrusted markup.
  for (const t of scanMarkup(html, { rawText: false })) {
    if (t.type === 'close') {
      if (dropping) {
        if (t.name === dropping) dropping = null;
        continue;
      }
      if (!Object.hasOwn(ARTICLE_HTML_ALLOWED_TAGS, t.name)) continue;
      const at = open.lastIndexOf(t.name);
      if (at === -1) continue; // a close without its open: dropped
      while (open.length > at) out.push(`</${open.pop() as string}>`);
      continue;
    }
    if (t.type === 'open') {
      const name = t.name;
      if (dropping) continue;
      if (DROP_WITH_CONTENT.has(name)) {
        if (!t.selfClosing) dropping = name;
        continue;
      }
      const allowed = Object.hasOwn(ARTICLE_HTML_ALLOWED_TAGS, name)
        ? ARTICLE_HTML_ALLOWED_TAGS[name]
        : undefined;
      if (!allowed) continue;
      const kept: string[] = [];
      for (const [attr, value] of t.attrs) {
        if (!allowed.includes(attr)) continue;
        if (URL_ATTRS.has(attr)) {
          const url = safeArticleUrl(value);
          if (!url) continue;
          kept.push(`${attr}="${escapeHtml(url)}"`);
        } else kept.push(`${attr}="${escapeAttr(value)}"`);
      }
      if (name === 'a' && kept.some((k) => k.startsWith('href='))) kept.push('rel="noopener"');
      const head = `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}`;
      if (VOID_TAGS.has(name)) out.push(`${head}>`);
      else {
        out.push(`${head}>`);
        open.push(name);
      }
      continue;
    }
    if (dropping) continue;
    out.push(escapeText(t.text));
  }
  while (open.length) out.push(`</${open.pop() as string}>`);
  return out.join('');
}

/**
 * RA-08: how an image block finds its address. The web app resolves asset versions to signed preview URLs; the
 * publisher resolves them to the addresses the website gave the uploaded media; without a resolver (the hash a
 * review manifest freezes) the image carries its alt text and no address. The markup is otherwise identical, so
 * the three renderings differ in the `src` attributes only.
 */
export interface ArticleRenderOptions {
  imageUrl?: (image: ArticleImageV1) => string | null;
}

/** One block as HTML (text escaped; a FAQ is a section with the question as a heading). */
export function renderArticleBlock(
  block: ArticleBlockV1 | ArticleFaqAnswerBlockV1,
  opts: ArticleRenderOptions = {},
): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`;
    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`;
    }
    case 'faq': {
      const answer =
        block.answerBlocks && block.answerBlocks.length > 0
          ? block.answerBlocks.map((b) => renderArticleBlock(b, opts)).join('')
          : `<p>${escapeHtml(block.answer)}</p>`;
      return `<section class="faq"><h3>${escapeHtml(block.question)}</h3>${answer}</section>`;
    }
    case 'link':
      return `<p><a href="${escapeHtml(block.href)}">${escapeHtml(articleBlockText(block))}</a></p>`;
    case 'quote':
      return `<blockquote><p>${escapeHtml(block.text)}</p>${
        block.cite ? `<p><em>${escapeHtml(block.cite)}</em></p>` : ''
      }</blockquote>`;
    case 'image': {
      const url = opts.imageUrl?.({ assetVersionId: block.assetVersionId, alt: block.alt }) ?? null;
      const src = url ? ` src="${escapeHtml(url)}"` : '';
      const caption = block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : '';
      return `<figure><img${src} alt="${escapeHtml(block.alt)}">${caption}</figure>`;
    }
  }
}

/**
 * The article body as HTML: every block in order, then the sanitiser once more (defence in depth). Pure and
 * deterministic: the same document and resolver always give the same bytes, so the hash a review manifest
 * freezes, the fingerprint a read-back is compared with and the body a site receives are one rendering.
 */
export const renderArticleHtml = (
  article: Pick<ArticleDocumentV1, 'blocks'>,
  opts: ArticleRenderOptions = {},
): string => sanitizeArticleHtml(article.blocks.map((b) => renderArticleBlock(b, opts)).join('\n'));

/** The text a block leads with on the page: a list's first item, a FAQ's question, an image's caption (alt text is not page text). */
const blockLeadText = (b: ArticleBlockV1): string => {
  switch (b.type) {
    case 'list':
      return b.items[0] ?? '';
    case 'faq':
      return b.question;
    case 'image':
      return b.caption ?? '';
    default:
      return articleBlockText(b);
  }
};

/** The text a block ends with on the page: a list's last item, a FAQ's answer's last line, a quote's text. */
const blockTailText = (b: ArticleBlockV1 | ArticleFaqAnswerBlockV1): string => {
  switch (b.type) {
    case 'list':
      return b.items[b.items.length - 1] ?? '';
    case 'faq': {
      const last = b.answerBlocks?.[b.answerBlocks.length - 1];
      return last ? blockTailText(last) : faqAnswerText(b);
    }
    case 'image':
      return b.caption ?? '';
    case 'quote':
      return b.cite ?? b.text;
    default:
      return articleBlockText(b);
  }
};

/** The first paragraph's text (what a rendered page must contain), or the first block's text. */
export function articleFirstParagraph(article: Pick<ArticleDocumentV1, 'blocks'>): string {
  const p = article.blocks.find((b) => b.type === 'paragraph' && b.text.trim() !== '');
  if (p && p.type === 'paragraph') return p.text.trim();
  const first = article.blocks[0];
  return first ? blockLeadText(first).trim() : '';
}

/** The last block's text (a list's last item, a FAQ's answer): what a page must still show at its end. */
export function articleLastParagraph(article: Pick<ArticleDocumentV1, 'blocks'>): string {
  for (let i = article.blocks.length - 1; i >= 0; i--) {
    const text = blockTailText(article.blocks[i] as ArticleBlockV1);
    if (text.trim() !== '') return text.trim();
  }
  return '';
}

/** The article's plain text (title, excerpt and body), for a caption or a length check. */
export const articlePlainText = (article: ArticleDocumentV1): string =>
  [article.title, article.excerpt, ...article.blocks.map(articleBlockText)]
    .filter((t) => t.trim() !== '')
    .join('\n\n');

/**
 * RA-03: the characters a body given as HTML carries once rendered (tags removed, entities decoded): the measure
 * ARTICLE_BODY_MAX_CHARS bounds, never the HTML's own length.
 */
export const articleHtmlChars = (html: string): number => {
  let text = '';
  for (const t of scanMarkup(html, { rawText: false })) if (t.type === 'text') text += t.text;
  return decodeEntities(text).length;
};

/** The elements whose text reads as one block of an article (a paragraph, a heading, a list item, a caption…). */
const TEXT_BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'figcaption',
  'pre',
  'dt',
  'dd',
  'td',
  'th',
]);

/**
 * PR-03: the text of each block of an HTML body as it reads (tags removed, inline ones joined as written, entities
 * decoded, whitespace folded, case kept), in order, empty blocks dropped; script and style contents never count.
 * What a screen compares paragraph by paragraph when a website's current article is set beside an edit.
 */
export const articleHtmlBlocks = (html: string): string[] => {
  const blocks: string[] = [];
  let current = '';
  let skip: string | null = null;
  const flush = () => {
    const text = decodeEntities(current).replace(/\s+/g, ' ').trim();
    if (text !== '') blocks.push(text);
    current = '';
  };
  for (const t of scanMarkup(html, { rawText: false })) {
    if (skip !== null) {
      if (t.type === 'close' && t.name === skip) skip = null;
    } else if (t.type === 'text') current += t.text;
    else if (t.type === 'open' && (t.name === 'script' || t.name === 'style')) skip = t.name;
    else if (t.name === 'br') current += ' ';
    else if (TEXT_BLOCK_TAGS.has(t.name) || t.name === 'div') flush();
    // An inline element (strong, a, em…) joins its text to the block's as written.
  }
  flush();
  return blocks;
};

// ---- rendered-page validation (R2-3): what a published page must show ----

/**
 * RA-04 (appended keys): the canonical names this page (the remote URL or the slug's path), and the last block's
 * text is present too, so a page changed after its first paragraph fails. PR-04 (appended keys): the article region
 * was found, it carries every block of the manifest in order and every image, and no `X-Robots-Tag` header hides
 * the page. `body_present` and `last_paragraph_present` stay for evidence recorded before PR-04; a validation now
 * reports `content_complete` instead.
 */
export const RenderedCheckKey = z.enum([
  'status_ok',
  'title_present',
  'canonical_present',
  'indexable',
  'body_present',
  'canonical_matches',
  'last_paragraph_present',
  'article_region_found',
  'content_complete',
  'images_present',
  'header_indexable',
]);
export type RenderedCheckKey = z.infer<typeof RenderedCheckKey>;
export interface RenderedCheck {
  key: RenderedCheckKey;
  ok: boolean;
}

/**
 * PR-04: what a rendered validation proved. `verified`: the page answered, its article region carries the whole
 * manifest, its canonical names the article and (live) nothing hides it from indexing; `failed`: the page answered
 * and contradicts one of those; `unverified`: the page could not be read (a timeout, a 5xx or 429, a transport
 * failure), was cut at the byte cap before the article was complete, or its article region could not be located:
 * nothing was proven either way, and it never counts as a pass.
 */
export const RenderedOutcome = z.enum(['verified', 'failed', 'unverified']);
export type RenderedOutcome = z.infer<typeof RenderedOutcome>;

export interface RenderedValidationV1 {
  url: string;
  fetchedAt: string;
  status: number | null;
  bytes: number;
  truncated: boolean;
  /** `outcome === 'verified'` (kept for readers of evidence recorded before PR-04). */
  ok: boolean;
  checks: RenderedCheck[];
  /** Why the page could not be fetched at all (the checks then all fail), as a code; never a body. */
  error: string | null;
  /** PR-04 (absent on evidence recorded before it: read as `ok ? verified : failed`). */
  outcome?: RenderedOutcome;
  /** PR-04: the first reason the outcome is not `verified`, as a code (`content_changed`, `fetch_unavailable`…). */
  reason?: string | null;
  /** PR-04: where the article region was found and what it carried against the manifest. */
  content?: RenderedContentReportV1;
  /** PR-04: live visibility: a `noindex` / `none` from the robots meta tags and from the `X-Robots-Tag` header. */
  indexability?: { meta: 'index' | 'noindex'; header: 'index' | 'noindex' };
}

/** PR-04: the manifest compared with the article region (the missing blocks named, at most five, cut to 120). */
export interface RenderedContentReportV1 {
  /** The selector whose element was taken as the article region; null when none matched. */
  selector: string | null;
  expectedBlocks: number;
  matchedBlocks: number;
  missingBlocks: Array<{ index: number; text: string }>;
  expectedImages: number;
  missingImages: string[];
  manifestVersion: 1;
}

/** PR-04: the outcome of a validation, reading evidence recorded before PR-04 by its `ok`. */
export const renderedOutcomeOf = (v: Pick<RenderedValidationV1, 'ok' | 'outcome'>): RenderedOutcome =>
  v.outcome ?? (v.ok ? 'verified' : 'failed');

/** The rendered page is read against this many bytes and this long (D-16 bounded validation). */
export const RENDERED_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const RENDERED_PAGE_TIMEOUT_MS = 15_000;

/** Never throws: a reference that is not a Unicode scalar value (NUL, a surrogate, beyond U+10FFFF) is U+FFFD. */
const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => codePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) =>
      e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'nbsp' ? ' ' : "'",
    );
/** Text as shown: entities decoded, whitespace folded, case folded. */
const fold = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The text of markup as it reads, built token by token from the scanner: tags become spaces and the contents of
 * script and style elements are dropped.
 */
const visibleText = () => {
  const parts: string[] = [];
  let skip: string | null = null;
  return {
    add(t: MarkupToken): void {
      if (skip !== null) {
        if (t.type === 'close' && t.name === skip) skip = null;
      } else if (t.type === 'text') parts.push(t.text);
      else {
        parts.push(' ');
        if (t.type === 'open' && (t.name === 'script' || t.name === 'style')) skip = t.name;
      }
    },
    text: (): string => fold(parts.join('')),
  };
};
type VisibleText = ReturnType<typeof visibleText>;

/** Text as a page shows it: tags removed, entities decoded, whitespace folded, case folded. */
export const pageText = (html: string): string => {
  const text = visibleText();
  for (const t of scanMarkup(html, { rawText: false })) text.add(t);
  return text.text();
};

/** What the rendered-page checks read from a page, in one pass of the linear markup scanner (markup.ts). */
interface RenderedPageRead {
  text: string;
  /** The text of each `<title>` and each `<h1>`. */
  titles: string[];
  metas: Array<Map<string, string>>;
  links: Array<Map<string, string>>;
}
function readRenderedPage(html: string): RenderedPageRead {
  const page = visibleText();
  const titles: string[] = [];
  const metas: Array<Map<string, string>> = [];
  const links: Array<Map<string, string>> = [];
  // An element whose text is being read (each up to its first close tag, as a title or heading is written).
  const reading: Record<'title' | 'h1', VisibleText | null> = { title: null, h1: null };
  for (const t of scanMarkup(html, { rawText: false })) {
    page.add(t);
    for (const name of ['title', 'h1'] as const) {
      const current = reading[name];
      if (current && t.type === 'close' && t.name === name) {
        titles.push(current.text());
        reading[name] = null;
      } else if (current) current.add(t);
      else if (t.type === 'open' && t.name === name) reading[name] = visibleText();
    }
    if (t.type === 'open' && t.name === 'meta') metas.push(t.attrs);
    else if (t.type === 'open' && t.name === 'link') links.push(t.attrs);
  }
  return { text: page.text(), titles, metas, links };
}
/** A meta tag naming `name` (as the earlier pattern read it: the name attribute begins with it) whose content matches. */
const hasMeta = (page: RenderedPageRead, name: string, content: RegExp): boolean =>
  page.metas.some(
    (attrs) =>
      (attrs.get('name') ?? '').toLowerCase().startsWith(name) && content.test(attrs.get('content') ?? ''),
  );
/** The canonical link's href, or null when the page carries none. */
const canonicalHref = (page: RenderedPageRead): string | null => {
  for (const attrs of page.links) {
    if (!(attrs.get('rel') ?? '').toLowerCase().startsWith('canonical')) continue;
    const href = attrs.get('href');
    if (href) return decodeEntities(href);
  }
  return null;
};
/** A URL as compared: lower-case origin, the path without its trailing slash, no query or fragment. */
const foldUrl = (value: string): string | null => {
  try {
    const u = new URL(value);
    return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};
/** RA-04: the canonical is the remote URL itself, or a path on the same site ending in the slug's segment. */
export function canonicalMatches(canonical: string | null, remoteUrl: string, slug: string): boolean {
  if (!canonical) return false;
  const c = foldUrl(canonical);
  const r = foldUrl(remoteUrl);
  if (!c || !r) return false;
  if (c === r) return true;
  const sameSite = c.startsWith(`${new URL(r).origin.toLowerCase()}/`);
  return sameSite && slug !== '' && c.endsWith(`/${slug.toLowerCase()}`);
}

// ---- PR-04: the article manifest and the article region of a rendered page ----

/**
 * PR-04: what an article's rendered region must carry, derived from the HTML the site was sent (the immutable
 * revision's own rendering, or the body of the latest edit that went through): the text of each block in order,
 * folded for comparison, and the alt text of each image. Deterministic: the same HTML always gives the same manifest,
 * so the one built when the page is checked equals the one the approved revision fixed.
 */
export interface ArticleManifestV1 {
  version: 1;
  blocks: string[];
  images: string[];
}

/** Elements whose text is one block (a paragraph, a heading, a list item…); any other element joins its text inline. */
const MANIFEST_BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'dt',
  'dd',
  'blockquote',
  'figcaption',
  'figure',
  'pre',
  'td',
  'th',
  'tr',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'table',
  'ul',
  'ol',
  'dl',
  'form',
  'hr',
]);
/** HTML void elements: never closed, so they never open a level of a page's element tree. */
const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * PR-04: text as compared between the manifest and a rendered page: entities decoded, compatibility-normalised,
 * invisible characters dropped, the typography WordPress applies on output (wptexturize: curly quotes, en and em
 * dashes, an ellipsis, a multiplication sign) folded back, whitespace folded, case folded.
 */
export const verificationText = (text: string): string =>
  decodeEntities(text)
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u0060\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212-]+/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00d7/g, 'x')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** The blocks and image alts of a token stream (a whole body, or an article region). */
function manifestOfTokens(tokens: Iterable<MarkupToken>): ArticleManifestV1 {
  const blocks: string[] = [];
  const images: string[] = [];
  let current = '';
  const flush = () => {
    const text = verificationText(current);
    if (text !== '') blocks.push(text);
    current = '';
  };
  for (const t of tokens) {
    if (t.type === 'text') current += t.text;
    else if (t.name === 'br') current += ' ';
    else if (t.name === 'img') {
      if (t.type === 'open') {
        const alt = verificationText(t.attrs.get('alt') ?? '');
        if (alt !== '') images.push(alt);
      }
    } else if (MANIFEST_BLOCK_TAGS.has(t.name)) flush();
  }
  flush();
  return { version: 1, blocks, images };
}

/** PR-04: the manifest of the HTML an article was sent as (script and style contents never count). */
export const articleManifest = (html: string): ArticleManifestV1 => manifestOfTokens(scanMarkup(html));

/**
 * PR-04: where an article's body sits in common WordPress themes, most specific first (block themes, classic
 * themes, schema.org markup, then the semantic elements). A destination's own selector is tried before these.
 */
export const DEFAULT_ARTICLE_REGION_SELECTORS = [
  '.entry-content',
  '.wp-block-post-content',
  '.post-content',
  '[itemprop=articleBody]',
  'article',
  'main',
] as const;

/**
 * PR-04: a selector a destination may configure for its article region: one or more simple selectors separated by
 * commas, each a tag name, `#id`, `.class` (several allowed) or `[attr]` / `[attr=value]`, combined without spaces
 * (`div.post-body`, `[itemprop=articleBody]`). No descendant or sibling combinators, no pseudo-classes.
 */
export const ARTICLE_SELECTOR_MAX_CHARS = 200;
const SIMPLE_SELECTOR =
  /^(?:[a-z][a-z0-9-]*)?(?:(?:#[A-Za-z_][\w-]*)|(?:\.[A-Za-z_][\w-]*)|(?:\[[a-z][\w-]*(?:=(?:"[^"\]]*"|'[^'\]]*'|[\w-]+))?\]))*$/;
export const ArticleRegionSelector = z
  .string()
  .trim()
  .min(1)
  .max(ARTICLE_SELECTOR_MAX_CHARS)
  .refine(
    (v) =>
      v
        .split(',')
        .map((p) => p.trim())
        .every((p) => p !== '' && SIMPLE_SELECTOR.test(p)),
    { message: 'article_selector_invalid' },
  );

interface SimpleSelector {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: Array<{ name: string; value: string | null }>;
}
function parseSimpleSelector(source: string): SimpleSelector | null {
  const text = source.trim();
  if (!SIMPLE_SELECTOR.test(text)) return null;
  const tag = /^[a-z][a-z0-9-]*/.exec(text)?.[0] ?? null;
  const ids: string[] = [];
  const classes: string[] = [];
  const attrs: SimpleSelector['attrs'] = [];
  const part =
    /#([A-Za-z_][\w-]*)|\.([A-Za-z_][\w-]*)|\[([a-z][\w-]*)(?:=(?:"([^"\]]*)"|'([^'\]]*)'|([\w-]+)))?\]/g;
  for (let m = part.exec(text); m; m = part.exec(text)) {
    if (m[1] !== undefined) ids.push(m[1]);
    else if (m[2] !== undefined) classes.push(m[2]);
    else if (m[3] !== undefined) attrs.push({ name: m[3], value: m[4] ?? m[5] ?? m[6] ?? null });
  }
  return { tag, ids, classes, attrs };
}
const matchesSelector = (sel: SimpleSelector, name: string, attrs: Map<string, string>): boolean => {
  if (sel.tag && sel.tag !== name) return false;
  if (sel.ids.some((id) => attrs.get('id') !== id)) return false;
  const classList = (attrs.get('class') ?? '').split(/\s+/);
  if (sel.classes.some((c) => !classList.includes(c))) return false;
  return sel.attrs.every((a) => attrs.has(a.name) && (a.value === null || attrs.get(a.name) === a.value));
};

/**
 * PR-04: the elements a selector names in a page, each as its own token stream (open to matching close, nested
 * matches inside a captured element belong to it). Close tags pop the open elements back to their match, as a
 * browser closes unclosed paragraphs and list items; a stray close tag is ignored.
 */
function regionsOf(html: string, selector: SimpleSelector): MarkupToken[][] {
  const regions: MarkupToken[][] = [];
  const stack: string[] = [];
  let capture: { tokens: MarkupToken[]; depth: number } | null = null;
  for (const t of scanMarkup(html)) {
    if (t.type === 'open') {
      const opens = !HTML_VOID_TAGS.has(t.name) && !t.selfClosing;
      if (!capture && opens && matchesSelector(selector, t.name, t.attrs)) {
        capture = { tokens: [], depth: stack.length };
        stack.push(t.name);
        continue;
      }
      if (opens) stack.push(t.name);
      capture?.tokens.push(t);
    } else if (t.type === 'close') {
      const at = stack.lastIndexOf(t.name);
      if (at < 0) continue;
      stack.length = at;
      if (capture && stack.length <= capture.depth) {
        regions.push(capture.tokens);
        capture = null;
        continue;
      }
      capture?.tokens.push(t);
    } else capture?.tokens.push(t);
  }
  if (capture) regions.push(capture.tokens); // a page cut at the byte cap: the region read so far
  return regions;
}

/** How many of the manifest's blocks a region carries in order (each block equal to one of the region's, in turn). */
function inOrder(
  expected: readonly string[],
  found: readonly string[],
): { matched: number; missing: number[] } {
  const missing: number[] = [];
  let at = 0;
  expected.forEach((block, index) => {
    const hit = found.indexOf(block, at);
    if (hit < 0) missing.push(index);
    else at = hit + 1;
  });
  return { matched: expected.length - missing.length, missing };
}

/**
 * PR-04: the article region of a page and what it carries against the manifest. The selectors are tried in order
 * (a destination's own first, then the theme defaults); the first one that names any element decides, and among its
 * elements the one carrying most of the manifest is the region. A later selector is never consulted once one
 * matched, so a paragraph found only outside the region (a sidebar, a related-posts excerpt) never counts.
 */
export function compareArticleRegion(
  html: string,
  manifest: ArticleManifestV1,
  selectors: readonly string[],
): RenderedContentReportV1 {
  const report = (selector: string | null, region: ArticleManifestV1 | null): RenderedContentReportV1 => {
    const blocks = region
      ? inOrder(manifest.blocks, region.blocks)
      : { matched: 0, missing: manifest.blocks.map((_, i) => i) };
    const have = [...(region?.images ?? [])];
    const missingImages: string[] = [];
    for (const alt of manifest.images) {
      const i = have.indexOf(alt);
      if (i < 0) missingImages.push(alt.slice(0, 120));
      else have.splice(i, 1);
    }
    return {
      selector,
      expectedBlocks: manifest.blocks.length,
      matchedBlocks: blocks.matched,
      missingBlocks: blocks.missing
        .slice(0, 5)
        .map((index) => ({ index, text: (manifest.blocks[index] ?? '').slice(0, 120) })),
      expectedImages: manifest.images.length,
      missingImages: missingImages.slice(0, 5),
      manifestVersion: 1,
    };
  };
  for (const source of selectors) {
    for (const part of source.split(',')) {
      const selector = parseSimpleSelector(part);
      if (!selector) continue;
      const regions = regionsOf(html, selector).map(manifestOfTokens);
      if (regions.length === 0) continue;
      let best = report(part.trim(), regions[0] as ArticleManifestV1);
      for (const region of regions.slice(1)) {
        const candidate = report(part.trim(), region);
        if (candidate.matchedBlocks > best.matchedBlocks) best = candidate;
      }
      return best;
    }
  }
  return report(null, null);
}

/** The value of an X-Robots-Tag header hides the page from the general crawlers (or from Google or Bing). */
export function robotsHeaderNoindex(value: string | null): boolean {
  if (!value) return false;
  const directive = /^(noindex|none)$/i;
  const valued = /^(unavailable_after|max-snippet|max-image-preview|max-video-preview)$/i;
  let agent: string | null = null;
  for (const raw of value.split(',')) {
    let segment = raw.trim();
    const named = /^([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(segment);
    if (named && !valued.test(named[1] as string)) {
      agent = (named[1] as string).toLowerCase();
      segment = (named[2] as string).trim();
    }
    for (const word of segment.split(/\s+/))
      if (directive.test(word) && (agent === null || agent === 'googlebot' || agent === 'bingbot'))
        return true;
  }
  return false;
}

/** The canonical an HTTP `Link` header declares (`<url>; rel="canonical"`), or null. */
export function canonicalFromLinkHeader(value: string | null): string | null {
  if (!value) return null;
  for (const m of value.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]*)*)/g)) {
    if (/;\s*rel\s*=\s*"?canonical"?/i.test(m[2] ?? '')) return m[1] ?? null;
  }
  return null;
}

/**
 * The checks over a fetched page (PR-04): the status, the title, the canonical (an HTML link and an HTTP Link header,
 * each naming the article when present), indexability from the robots meta tags and, separately, from the
 * X-Robots-Tag header (a draft is expected to be hidden), the article region found, every block of the manifest in
 * that region in order and every image in it. Pure; the outcome is `verified` only when every check passes.
 */
export function validateRenderedPage(input: {
  status: number | null;
  html: string;
  title: string;
  draft: boolean;
  /** The page address the article was read back with and its slug; both empty when unknown (an old record). */
  remoteUrl?: string;
  slug?: string;
  manifest: ArticleManifestV1;
  /** The destination's own article-region selector, tried before the theme defaults. */
  regionSelector?: string | null;
  headers?: { xRobotsTag: string | null; link: string | null };
  truncated?: boolean;
}): {
  checks: RenderedCheck[];
  outcome: RenderedOutcome;
  reason: string | null;
  content: RenderedContentReportV1;
  indexability: NonNullable<RenderedValidationV1['indexability']>;
} {
  const page = readRenderedPage(input.html);
  const title = fold(input.title);
  const metaNoindex =
    hasMeta(page, 'robots', /noindex|\bnone\b/i) || hasMeta(page, 'googlebot', /noindex|\bnone\b/i);
  const headerNoindex = robotsHeaderNoindex(input.headers?.xRobotsTag ?? null);
  const htmlCanonical = canonicalHref(page);
  const headerCanonical = canonicalFromLinkHeader(input.headers?.link ?? null);
  const canonicals = [htmlCanonical, headerCanonical].filter((c): c is string => c !== null);
  const selectors = [
    ...(input.regionSelector ? [input.regionSelector] : []),
    ...DEFAULT_ARTICLE_REGION_SELECTORS,
  ];
  const content = compareArticleRegion(input.html, input.manifest, selectors);
  const contentComplete =
    content.selector !== null &&
    content.expectedBlocks > 0 &&
    content.matchedBlocks === content.expectedBlocks;
  const checks: RenderedCheck[] = [
    { key: 'status_ok', ok: input.status === 200 },
    { key: 'title_present', ok: title !== '' && page.titles.some((t) => t.includes(title)) },
    { key: 'canonical_present', ok: canonicals.length > 0 },
    { key: 'indexable', ok: input.draft || !metaNoindex },
    {
      key: 'canonical_matches',
      ok:
        canonicals.length > 0 &&
        canonicals.every((c) => canonicalMatches(c, input.remoteUrl ?? '', input.slug ?? '')),
    },
    { key: 'article_region_found', ok: content.selector !== null },
    { key: 'content_complete', ok: contentComplete },
    { key: 'images_present', ok: content.selector !== null && content.missingImages.length === 0 },
    { key: 'header_indexable', ok: input.draft || !headerNoindex },
  ];
  const failed = checks.filter((c) => !c.ok).map((c) => c.key);
  // Nothing proven either way: the page did not answer, was cut before the article ended, or has no region.
  const unavailable =
    input.status === null || input.status === 408 || input.status === 429 || input.status >= 500;
  const outcome: RenderedOutcome =
    failed.length === 0
      ? 'verified'
      : unavailable || content.selector === null || (input.truncated === true && !contentComplete)
        ? 'unverified'
        : 'failed';
  const reason =
    outcome === 'verified'
      ? null
      : unavailable
        ? `page_unavailable_${input.status ?? 'none'}`
        : content.selector === null
          ? 'article_region_not_found'
          : input.truncated === true && !contentComplete
            ? 'page_truncated'
            : failed.includes('content_complete') || failed.includes('images_present')
              ? 'content_changed'
              : (failed[0] ?? null);
  return {
    checks,
    outcome,
    reason,
    content,
    indexability: { meta: metaNoindex ? 'noindex' : 'index', header: headerNoindex ? 'noindex' : 'index' },
  };
}

export const renderedValidationOk = (checks: readonly RenderedCheck[]): boolean => checks.every((c) => c.ok);
