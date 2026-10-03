import { decodeEntities } from '@oremedia/providers';

/**
 * BSC-4: a web page as readable text for the brand assistant. Scripts, styles, forms, embedded media and the page's
 * navigation, footer and side boilerplate are dropped; headings become `#` lines, list items `- ` lines, paragraphs
 * and table rows their own lines. The page's title and canonical URL are kept as the page states them, and its
 * same-site links are returned (navigation links first) so the crawl can choose what to read next. Regex over the
 * markup, as the audit crawl reads pages: nothing is executed and no DOM is built from untrusted HTML.
 */
export interface PageText {
  title: string | null;
  canonicalUrl: string | null;
  text: string;
  /** Same-site links found in the page's navigation (nav, header), then the rest; absolute, without fragments. */
  navLinks: string[];
  links: string[];
}

const DROP_BLOCKS = [
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
  'head',
];
const BOILERPLATE_BLOCKS = ['nav', 'footer', 'aside'];
const LINKS_MAX = 200;

const dropBlocks = (html: string, tags: readonly string[]): string =>
  tags.reduce((h, tag) => h.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' '), html);

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim()) : null;
};

const inline = (html: string): string =>
  decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .trim();

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

function linksIn(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    const url = href === null ? null : sameSiteUrl(href, pageUrl);
    if (url && url !== pageUrl) out.add(url);
    if (out.size >= LINKS_MAX) break;
  }
  return [...out];
}

export function htmlToText(html: string, pageUrl: string): PageText {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(noComments);
  const title = titleTag ? inline(titleTag[1] as string) || null : null;
  let canonicalUrl: string | null = null;
  for (const m of noComments.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attr(m[0], 'href');
    if (rel.includes('canonical') && href) {
      try {
        canonicalUrl = new URL(href, pageUrl).toString();
      } catch {
        canonicalUrl = null;
      }
      break;
    }
  }
  const scriptless = dropBlocks(
    noComments,
    DROP_BLOCKS.filter((t) => t !== 'head'),
  );
  const navHtml = [...scriptless.matchAll(/<(nav|header)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map((m) => m[2] as string)
    .join(' ');
  const navLinks = linksIn(navHtml, pageUrl);
  const links = [...new Set([...navLinks, ...linksIn(scriptless, pageUrl)])].slice(0, LINKS_MAX);

  let body = dropBlocks(noComments, DROP_BLOCKS);
  const main =
    /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(body) ??
    /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(body);
  body = main ? (main[1] as string) : (/<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(body)?.[1] ?? body);
  body = dropBlocks(body, BOILERPLATE_BLOCKS);
  body = body.replace(
    /<[^>]+\b(?:aria-hidden\s*=\s*["']?true|hidden)\b[^>]*>[\s\S]*?<\/[a-z0-9]+\s*>/gi,
    ' ',
  );

  const text = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
      const t = inline(inner);
      return t ? `\n\n${'#'.repeat(Number(level))} ${t}\n\n` : '\n';
    })
    .replace(/<li\b[^>]*>([\s\S]*?)(?:<\/li\s*>|(?=<li\b)|(?=<\/[uo]l))/gi, (_, inner: string) => {
      const t = inline(inner);
      return t ? `\n- ${t}\n` : '\n';
    })
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(p|div|section|tr|table|ul|ol|dl|dt|dd|blockquote|pre|figure|figcaption|header|hr)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ');
  return { title, canonicalUrl, text: tidyText(decodeEntities(text)), navLinks, links };
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
