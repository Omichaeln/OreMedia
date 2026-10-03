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

/** HTML/XML character references and the common named entities, decoded. */
export const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
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

const escapeRegex = (s: string) => s.replace(/[.+?^{}()|[\]\\]/g, '\\$&');

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
    const body = anchored ? rule.slice(0, -1) : rule;
    const pattern = `^${body.split('*').map(escapeRegex).join('.*')}${anchored ? '$' : ''}`;
    return new RegExp(pattern).test(path);
  });
}

export interface SitemapListing {
  urls: string[];
  /** Nested sitemaps of an index (read one level deep by the caller). */
  sitemaps: string[];
}

const locsIn = (xml: string, container: 'url' | 'sitemap'): string[] =>
  [...xml.matchAll(new RegExp(`<${container}\\b[^>]*>([\\s\\S]*?)</${container}>`, 'gi'))].flatMap((m) => {
    const loc = /<loc\b[^>]*>\s*([^<\s]+)\s*<\/loc>/i.exec(m[1] as string);
    return loc ? [decodeEntities(loc[1] as string)] : [];
  });

export function sitemapUrls(xml: string): SitemapListing {
  return { urls: locsIn(xml, 'url'), sitemaps: locsIn(xml, 'sitemap') };
}
