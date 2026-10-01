import { z } from 'zod';
import type { ArticleBlockV1, ArticleDocumentV1 } from './content';

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

/** A URL an article may link to or embed: http(s), mailto, a relative path or a fragment; never a script. */
export function safeArticleUrl(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return /^(https?:|mailto:)/i.test(v) && !/[\s<>"]/.test(v) ? v : null;
  if (v.startsWith('//')) return null; // protocol-relative: the scheme is the page's, not ours
  return /[\s<>"]/.test(v) ? null : v;
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
  const token =
    /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|<|[^<]+/g;
  for (const m of html.matchAll(token)) {
    const [raw, closing, opening, attrs, selfClosing] = m;
    if (raw.startsWith('<!--')) continue;
    if (closing !== undefined) {
      const name = closing.toLowerCase();
      if (dropping) {
        if (name === dropping) dropping = null;
        continue;
      }
      if (!(name in ARTICLE_HTML_ALLOWED_TAGS)) continue;
      const at = open.lastIndexOf(name);
      if (at === -1) continue; // a close without its open: dropped
      while (open.length > at) out.push(`</${open.pop() as string}>`);
      continue;
    }
    if (opening !== undefined) {
      const name = opening.toLowerCase();
      if (dropping) continue;
      if (DROP_WITH_CONTENT.has(name)) {
        if (!selfClosing) dropping = name;
        continue;
      }
      const allowed = ARTICLE_HTML_ALLOWED_TAGS[name];
      if (!allowed) continue;
      const kept: string[] = [];
      for (const a of (attrs ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const attr = (a[1] as string).toLowerCase();
        if (!allowed.includes(attr)) continue;
        const value = a[2] ?? a[3] ?? a[4] ?? '';
        if (URL_ATTRS.has(attr)) {
          const url = safeArticleUrl(value);
          if (!url) continue;
          kept.push(`${attr}="${escapeHtml(url)}"`);
        } else kept.push(`${attr}="${escapeHtml(value)}"`);
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
    out.push(raw === '<' ? '&lt;' : escapeText(raw));
  }
  while (open.length) out.push(`</${open.pop() as string}>`);
  return out.join('');
}

/** One block as HTML (text escaped; a FAQ is a section with the question as a heading). */
export function renderArticleBlock(block: ArticleBlockV1): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`;
    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`;
    }
    case 'faq':
      return `<section class="faq"><h3>${escapeHtml(block.question)}</h3><p>${escapeHtml(block.answer)}</p></section>`;
  }
}

/** The article body as HTML: every block in order, then the sanitiser once more (defence in depth). */
export const renderArticleHtml = (article: Pick<ArticleDocumentV1, 'blocks'>): string =>
  sanitizeArticleHtml(article.blocks.map(renderArticleBlock).join('\n'));

/** The first paragraph's text (what a rendered page must contain), or the first block's text. */
export function articleFirstParagraph(article: Pick<ArticleDocumentV1, 'blocks'>): string {
  const p = article.blocks.find((b) => b.type === 'paragraph' && b.text.trim() !== '');
  if (p && p.type === 'paragraph') return p.text.trim();
  const first = article.blocks[0];
  if (!first) return '';
  return first.type === 'list'
    ? (first.items[0] ?? '').trim()
    : first.type === 'faq'
      ? first.question.trim()
      : first.text.trim();
}

/** The article's plain text (title, excerpt and body), for a caption or a length check. */
export const articlePlainText = (article: ArticleDocumentV1): string =>
  [
    article.title,
    article.excerpt,
    ...article.blocks.map((b) =>
      b.type === 'list' ? b.items.join('\n') : b.type === 'faq' ? `${b.question}\n${b.answer}` : b.text,
    ),
  ]
    .filter((t) => t.trim() !== '')
    .join('\n\n');

// ---- rendered-page validation (R2-3): what a published page must show ----

export const RenderedCheckKey = z.enum([
  'status_ok',
  'title_present',
  'canonical_present',
  'indexable',
  'body_present',
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

const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) =>
      e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'nbsp' ? ' ' : "'",
    );
/** Text as a page shows it: tags removed, entities decoded, whitespace folded, case folded. */
export const pageText = (html: string): string =>
  decodeEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const fold = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim().toLowerCase();
const tagText = (html: string, tag: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) =>
    pageText(m[1] as string),
  );
const hasMeta = (html: string, name: string, content: RegExp): boolean =>
  [...html.matchAll(/<meta\b[^>]*>/gi)].some((m) => {
    const tag = m[0];
    return new RegExp(`name\\s*=\\s*["']?${name}["']?`, 'i').test(tag) && content.test(tag);
  });
const hasCanonical = (html: string): boolean =>
  [...html.matchAll(/<link\b[^>]*>/gi)].some(
    (m) => /rel\s*=\s*["']?canonical["']?/i.test(m[0]) && /href\s*=\s*["'][^"']+["']/i.test(m[0]),
  );

/**
 * The checks over a fetched page: 200, the title in <title> or an <h1>, a canonical link, no `noindex` unless the
 * article is a draft (a draft is expected to be hidden), and the first paragraph in the page's text. Pure.
 */
export function validateRenderedPage(input: {
  status: number | null;
  html: string;
  title: string;
  firstParagraph: string;
  draft: boolean;
}): RenderedCheck[] {
  const html = input.html;
  const title = fold(input.title);
  const titles = [...tagText(html, 'title'), ...tagText(html, 'h1')];
  const noindex = hasMeta(html, 'robots', /noindex/i) || hasMeta(html, 'googlebot', /noindex/i);
  const paragraph = fold(input.firstParagraph);
  return [
    { key: 'status_ok', ok: input.status === 200 },
    { key: 'title_present', ok: title !== '' && titles.some((t) => t.includes(title)) },
    { key: 'canonical_present', ok: hasCanonical(html) },
    { key: 'indexable', ok: input.draft || !noindex },
    { key: 'body_present', ok: paragraph !== '' && pageText(html).includes(paragraph) },
  ];
}

export const renderedValidationOk = (checks: readonly RenderedCheck[]): boolean => checks.every((c) => c.ok);
