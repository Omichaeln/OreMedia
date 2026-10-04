import { scanMarkup } from './markup';

/**
 * The pure site rules every bounded crawl reads (R2-4 technical SEO audit, BSC-4 brand sources): the minimal
 * robots.txt reading (RFC 9309 subset: the `*` group's Disallow rules, `*` and `$` in a rule, Sitemap lines) and a
 * sitemap's URLs. Nothing here performs I/O; the crawlers fetch through fetchPageBounded or their own SSRF-safe IO.
 */

export interface RobotsRules {
  disallow: string[];
  truncated: boolean;
  /** `Sitemap:` lines (any group; absolute URLs as written). */
  sitemaps: string[];
}

/** A numeric character reference's character; anything that is not a Unicode scalar value (NUL, surrogates, beyond U+10FFFF) is U+FFFD. */
const codePoint = (n: number): string =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : '\uFFFD';

/** HTML/XML character references and the common named entities, decoded. Never throws on a malformed reference. */
export const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d{1,8});/g, (_, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,8});/gi, (_, n: string) => codePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) =>
      e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'nbsp' ? ' ' : "'",
    );

/** The `*` group's Disallow rules (at most `maxRules`; the rest are dropped and `truncated` set). */
export function parseRobots(text: string, maxRules: number): RobotsRules {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let truncated = false;
  let inStar = false;
  let sawAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'sitemap') {
      if (value && sitemaps.length < 10) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Consecutive user-agent lines share the group that follows; a rule line closes the agent list.
      if (!sawAgent) inStar = false;
      sawAgent = true;
      if (value === '*') inStar = true;
      continue;
    }
    sawAgent = false;
    if (field !== 'disallow' || !inStar || value === '' || truncated) continue;
    if (disallow.length >= maxRules) {
      truncated = true;
      continue;
    }
    disallow.push(value);
  }
  return { disallow, truncated, sitemaps };
}

/**
 * Whether `path` starts with (or, anchored, equals) a rule where `*` matches any run. A greedy two-pointer match that
 * backtracks only to the last `*`: no regular expression is built from the site's rules, so a crafted robots.txt
 * (many `*`s) cannot make matching super-linear beyond rule length times path length.
 */
function ruleMatches(rule: string, anchored: boolean, path: string): boolean {
  let p = 0;
  let r = 0;
  let star = -1;
  let mark = 0;
  while (p < path.length) {
    if (r < rule.length && rule[r] === '*') {
      star = r++;
      mark = p;
    } else if (r < rule.length && rule[r] === path[p]) {
      r++;
      p++;
    } else if (r === rule.length && !anchored) {
      return true; // the rule is a prefix of the path
    } else if (star >= 0) {
      r = star + 1;
      p = ++mark;
    } else return false;
  }
  while (r < rule.length && rule[r] === '*') r++;
  return r === rule.length;
}

/** Whether a URL's path (with its query) is outside every Disallow rule; `*` matches any run, `$` ends the match. */
export function robotsAllows(disallow: readonly string[], url: string): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
  } catch {
    return false;
  }
  return !disallow.some((rule) => {
    const anchored = rule.endsWith('$');
    return ruleMatches(anchored ? rule.slice(0, -1) : rule, anchored, path);
  });
}

export interface SitemapListing {
  urls: string[];
  /** Nested sitemaps of an index (read one level deep by the caller). */
  sitemaps: string[];
}

/** The `<loc>` of each `<url>` / `<sitemap>` entry, read with the linear markup scanner. */
function locsIn(xml: string): SitemapListing {
  const urls: string[] = [];
  const sitemaps: string[] = [];
  let container: 'url' | 'sitemap' | null = null;
  let loc: string | null = null;
  let found: string | null = null;
  for (const t of scanMarkup(xml, { rawText: false })) {
    if (t.type === 'open' && !t.selfClosing && (t.name === 'url' || t.name === 'sitemap')) {
      container = t.name;
      found = null;
    } else if (t.type === 'open' && t.name === 'loc' && container && !t.selfClosing) loc = '';
    else if (t.type === 'text' && loc !== null) loc += t.text;
    else if (t.type === 'close' && t.name === 'loc' && loc !== null) {
      const value = loc.trim();
      if (found === null && value && !/\s/.test(value)) found = decodeEntities(value);
      loc = null;
    } else if (t.type === 'close' && t.name === container) {
      if (found) (container === 'url' ? urls : sitemaps).push(found);
      container = null;
      found = null;
      loc = null;
    }
  }
  return { urls, sitemaps };
}

export function sitemapUrls(xml: string): SitemapListing {
  return locsIn(xml);
}
