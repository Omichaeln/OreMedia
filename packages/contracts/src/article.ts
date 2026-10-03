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

// ---- rendered-page validation (R2-3): what a published page must show ----

/**
 * RA-04 (appended keys): the canonical names this page (the remote URL or the slug's path), and the last block's
 * text is present too, so a page changed after its first paragraph fails.
 */
export const RenderedCheckKey = z.enum([
  'status_ok',
  'title_present',
  'canonical_present',
  'indexable',
  'body_present',
  'canonical_matches',
  'last_paragraph_present',
]);
export type RenderedCheckKey = z.infer<typeof RenderedCheckKey>;
export interface RenderedCheck {
  key: RenderedCheckKey;
  ok: boolean;
}
export interface RenderedValidationV1 {
  url: string;
  fetchedAt: string;
  status: number | null;
  bytes: number;
  truncated: boolean;
  ok: boolean;
  checks: RenderedCheck[];
  /** Why the page could not be fetched at all (the checks then all fail), as a code; never a body. */
  error: string | null;
}
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

/**
 * The checks over a fetched page: 200, the title in <title> or an <h1>, a canonical link that names this page
 * (RA-04: the remote URL or the slug's path), no `noindex` unless the article is a draft (a draft is expected to be
 * hidden), and the first and the last paragraph in the page's text. Pure.
 */
export function validateRenderedPage(input: {
  status: number | null;
  html: string;
  title: string;
  firstParagraph: string;
  draft: boolean;
  /** The page address the article was read back with and its slug; both empty when unknown (an old record). */
  remoteUrl?: string;
  slug?: string;
  lastParagraph?: string;
}): RenderedCheck[] {
  const page = readRenderedPage(input.html);
  const title = fold(input.title);
  const titles = page.titles;
  const noindex = hasMeta(page, 'robots', /noindex/i) || hasMeta(page, 'googlebot', /noindex/i);
  const paragraph = fold(input.firstParagraph);
  const last = fold(input.lastParagraph ?? '');
  const canonical = canonicalHref(page);
  const text = page.text;
  return [
    { key: 'status_ok', ok: input.status === 200 },
    { key: 'title_present', ok: title !== '' && titles.some((t) => t.includes(title)) },
    { key: 'canonical_present', ok: canonical !== null },
    { key: 'indexable', ok: input.draft || !noindex },
    { key: 'body_present', ok: paragraph !== '' && text.includes(paragraph) },
    { key: 'canonical_matches', ok: canonicalMatches(canonical, input.remoteUrl ?? '', input.slug ?? '') },
    { key: 'last_paragraph_present', ok: last !== '' && text.includes(last) },
  ];
}

export const renderedValidationOk = (checks: readonly RenderedCheck[]): boolean => checks.every((c) => c.ok);
