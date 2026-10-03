import { scanMarkup } from '@oremedia/providers/markup';
import { decodeEntities } from '@oremedia/providers/site-rules';

/**
 * BSC-4: a web page as readable text for the brand assistant. Scripts, styles, forms, embedded media and the page's
 * navigation, footer and side boilerplate are dropped; headings become `#` lines, list items `- ` lines, paragraphs
 * and table rows their own lines. The page's title and canonical URL are kept as the page states them, and its
 * same-site links are returned (navigation links first) so the crawl can choose what to read next. One pass of the
 * linear markup scanner (packages/providers/src/markup.ts): no regular expression runs over the markup, nothing is
 * executed and no DOM is built from untrusted HTML.
 */
export interface PageText {
  title: string | null;
  canonicalUrl: string | null;
  text: string;
  /** Same-site links found in the page's navigation (nav, header), then the rest; absolute, without fragments. */
  navLinks: string[];
  links: string[];
}

/** Elements whose whole contents are dropped (and whose links are not followed). */
const DROP_BLOCKS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'canvas',
  'video',
  'audio',
  'object',
  'form',
  'select',
  'button',
]);
/** Boilerplate: its text is dropped, its links still guide the crawl. */
const BOILERPLATE_BLOCKS = new Set(['nav', 'footer', 'aside']);
const NAV_BLOCKS = new Set(['nav', 'header']);
const LINE_BLOCKS = new Set([
  'p',
  'div',
  'section',
  'tr',
  'table',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'header',
  'hr',
  'main',
  'article',
  'body',
]);
const VOID = new Set([
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
const LINKS_MAX = 200;

const collapse = (text: string): string => text.replace(/[\s\u00a0]+/g, ' ').trim();

/** The absolute URL of a link when it stays on the site (same host, or the same host with/without `www.`). */
export function sameSiteUrl(href: string, pageUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '' || /^(javascript|mailto|tel|data|sms|ftp|blob):/i.test(trimmed)) return null;
  let url: URL;
  let page: URL;
  try {
    url = new URL(trimmed, pageUrl);
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== page.protocol || !sameSiteHost(url.host, page.host)) return null;
  if (url.username || url.password) return null;
  url.hash = '';
  const out = url.toString();
  return out.length > 1000 ? null : out;
}

/** Hosts of one site: equal once a leading `www.` is ignored (ports included). */
export const sameSiteHost = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/^www\./, '') === b.toLowerCase().replace(/^www\./, '');

export function htmlToText(html: string, pageUrl: string): PageText {
  let title: string | null = null;
  let canonicalUrl: string | null = null;
  let canonicalSeen = false;
  const navLinks = new Set<string>();
  const links = new Set<string>();
  const parts: string[] = [];
  // An element being skipped whole (dropped block, or hidden): its name and how deeply it nests in itself.
  let skip: string | null = null;
  let skipDepth = 0;
  let inHead = false;
  let inTitle = false;
  let navDepth = 0;
  let boilerplateDepth = 0;
  let heading: { level: number; text: string } | null = null;
  let item = -1; // index in `parts` of the open list item's marker
  const region: Record<'main' | 'article', { start: number; end: number; depth: number }> = {
    main: { start: -1, end: -1, depth: 0 },
    article: { start: -1, end: -1, depth: 0 },
  };
  const emit = (text: string) => {
    if (heading) heading.text += text;
    else if (!inHead && boilerplateDepth === 0) parts.push(text);
  };
  const endHeading = () => {
    if (!heading) return;
    const t = collapse(heading.text);
    const level = heading.level;
    heading = null;
    emit(t ? `\n\n${'#'.repeat(level)} ${t}\n\n` : '\n');
  };

  for (const t of scanMarkup(html)) {
    if (skip !== null) {
      if (t.type === 'open' && t.name === skip && !t.selfClosing) skipDepth++;
      else if (t.type === 'close' && t.name === skip && --skipDepth === 0) skip = null;
      continue;
    }
    if (t.type === 'text') {
      if (!inTitle) emit(t.text);
      else if (title === null) title = collapse(decodeEntities(t.text)) || null;
      continue;
    }
    const name = t.name;
    if (t.type === 'close') {
      if (name === 'title') inTitle = false;
      else if (name === 'head') inHead = false;
      else if (/^h[1-6]$/.test(name)) endHeading();
      else if (name === 'li') closeItem();
      else if (name === 'main' || name === 'article') {
        const r = region[name];
        if (r.depth > 0 && --r.depth === 0 && r.end < 0) r.end = parts.length;
      }
      if (NAV_BLOCKS.has(name) && navDepth > 0) navDepth--;
      if (BOILERPLATE_BLOCKS.has(name) && boilerplateDepth > 0) boilerplateDepth--;
      if (LINE_BLOCKS.has(name)) emit('\n');
      else if (name !== 'title') emit(' ');
      continue;
    }
    const open = !t.selfClosing && !VOID.has(name);
    const hidden =
      t.attrs.has('hidden') || (t.attrs.get('aria-hidden') ?? '').trim().toLowerCase() === 'true';
    if (open && (DROP_BLOCKS.has(name) || hidden)) {
      skip = name;
      skipDepth = 1;
      continue;
    }
    if (name === 'title') inTitle = open;
    else if (name === 'head') inHead = open;
    else if (name === 'body') inHead = false;
    else if (name === 'link' && !canonicalSeen) {
      const rel = (t.attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      const href = t.attrs.get('href');
      if (rel.includes('canonical') && href) {
        canonicalSeen = true;
        try {
          canonicalUrl = new URL(decodeEntities(href).trim(), pageUrl).toString();
        } catch {
          canonicalUrl = null;
        }
      }
    } else if (name === 'a') {
      const href = t.attrs.get('href');
      const url = href === undefined ? null : sameSiteUrl(decodeEntities(href), pageUrl);
      if (url && url !== pageUrl) {
        if (navDepth > 0 && navLinks.size < LINKS_MAX) navLinks.add(url);
        if (links.size < LINKS_MAX) links.add(url);
      }
    }
    if (!open) {
      emit(name === 'br' ? '\n' : LINE_BLOCKS.has(name) ? '\n' : ' ');
      continue;
    }
    if (NAV_BLOCKS.has(name)) navDepth++;
    if (BOILERPLATE_BLOCKS.has(name)) boilerplateDepth++;
    if (name === 'main' || name === 'article') {
      const r = region[name];
      if (r.start < 0) r.start = parts.length;
      if (r.end < 0) r.depth++;
    }
    const level = /^h([1-6])$/.exec(name);
    if (level) {
      endHeading();
      heading = { level: Number(level[1]), text: '' };
    } else if (name === 'li') {
      closeItem();
      emit('\n');
      item = parts.length;
      emit('- ');
      if (parts.length === item) item = -1;
    } else if (name === 'td' || name === 'th') emit(' | ');
    else if (LINE_BLOCKS.has(name)) emit('\n');
    else emit(' ');
  }
  endHeading();
  closeItem();
  const pick = (r: { start: number; end: number }) => parts.slice(r.start, r.end < 0 ? parts.length : r.end);
  const chosen =
    region.main.start >= 0 ? pick(region.main) : region.article.start >= 0 ? pick(region.article) : parts;
  const text = tidyText(decodeEntities(chosen.join('')));
  return {
    title,
    canonicalUrl,
    text,
    navLinks: [...navLinks],
    links: [...new Set([...navLinks, ...links])].slice(0, LINKS_MAX),
  };

  function closeItem() {
    if (item < 0) return;
    // An item with no text leaves no `- ` line behind.
    if (
      parts
        .slice(item + 1)
        .join('')
        .trim() === ''
    )
      parts[item] = '';
    else emit('\n');
    item = -1;
  }
}

/** NFC, LF line ends, spaces collapsed within lines, at most one blank line in a row, trimmed lines. */
export function tidyText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^\|\s*/, '')
        .replace(/\s*\|$/, ''),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
