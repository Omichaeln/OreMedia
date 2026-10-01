import {
  SEO_AUDIT_FINDING_EXAMPLES,
  SEO_AUDIT_LINKS_PER_PAGE,
  SEO_AUDIT_ROBOTS_RULES,
  SEO_AUDIT_URL_MAX,
  SEO_DESCRIPTION_MAX,
  SEO_DESCRIPTION_MIN,
  SEO_PAGE_HEAVY_BYTES,
  SEO_TITLE_HARD_MAX,
  SEO_TITLE_MAX,
  SeoAuditCheckKey,
  type SeoAuditCheckV1,
  type SeoAuditFindingV1,
  type SeoAuditPageSeverity,
  type SeoAuditSeverity,
  type SeoAuditSummaryCountsV1,
} from '@oremedia/contracts/seo-audit';
import { sha256Hex } from '@oremedia/domain/hash';

/**
 * The pure half of the technical SEO audit (ledger R2-4): what a URL must look like to be followed, the minimal
 * robots.txt reading (`Disallow` rules for `*`, `*` and `$` in a rule), the sitemap's URLs, the links a page
 * carries and the lab checks over one page and across the crawl. Nothing here performs I/O or names a vendor;
 * the runtime (audit-runtime.ts) fetches and stores. The check catalogue is docs/contracts/seo-audit.md.
 */

// ---- URLs ----

/** The absolute URL of a link on a page when it stays on the origin, without its fragment; else null. */
export function sameOriginUrl(href: string, pageUrl: string, origin: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '' || /^(javascript|mailto|tel|data|sms|ftp):/i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, pageUrl);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.username || url.password) return null;
  url.hash = '';
  const out = url.toString();
  return out.length > SEO_AUDIT_URL_MAX ? null : out;
}

// ---- robots.txt (RFC 9309 subset: the `*` group's Disallow rules; Allow and other agents are ignored) ----

export interface RobotsRules {
  disallow: string[];
  truncated: boolean;
}

export function robotsDisallowFor(text: string): RobotsRules {
  const disallow: string[] = [];
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
    if (field === 'user-agent') {
      // Consecutive user-agent lines share the group that follows; a rule line closes the agent list.
      if (!sawAgent) inStar = false;
      sawAgent = true;
      if (value === '*') inStar = true;
      continue;
    }
    sawAgent = false;
    if (field !== 'disallow' || !inStar || value === '') continue;
    if (disallow.length >= SEO_AUDIT_ROBOTS_RULES) {
      truncated = true;
      break;
    }
    disallow.push(value);
  }
  return { disallow, truncated };
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

// ---- sitemaps ----

export interface SitemapListing {
  urls: string[];
  /** Nested sitemaps of an index (read one level deep by the runtime). */
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

// ---- HTML reading (regex over the markup, as contracts/article.ts validates a rendered page) ----

const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) =>
      e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'nbsp' ? ' ' : "'",
    );
const fold = (text: string): string =>
  decodeEntities(text.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
const tags = (html: string, tag: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim()) : null;
};
const hasAttr = (tag: string, name: string): boolean =>
  new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|/|>|$)`, 'i').test(tag);
const metaContent = (html: string, name: string): string | null => {
  for (const tag of tags(html, 'meta')) {
    const n = attr(tag, 'name') ?? attr(tag, 'property');
    if (n && n.toLowerCase() === name) return attr(tag, 'content');
  }
  return null;
};
const linkRel = (html: string, rel: string): string[] =>
  tags(html, 'link').filter((t) => (attr(t, 'rel') ?? '').toLowerCase().split(/\s+/).includes(rel));
const withoutScripts = (html: string): string =>
  html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

/** Same-origin links on a page: `<a href>`, absolute, without fragments, deduplicated, capped. */
export function extractLinks(html: string, pageUrl: string, origin: string): string[] {
  const seen = new Set<string>();
  for (const tag of tags(withoutScripts(html), 'a')) {
    const href = attr(tag, 'href');
    if (href === null) continue;
    const url = sameOriginUrl(href, pageUrl, origin);
    if (url && url !== pageUrl) seen.add(url);
    if (seen.size >= SEO_AUDIT_LINKS_PER_PAGE) break;
  }
  return [...seen];
}

export const isHtml = (contentType: string | null): boolean =>
  contentType === null || /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType);

// ---- per-page checks ----

export interface FetchedPageFacts {
  url: string;
  origin: string;
  /** null when the page could not be fetched at all. */
  status: number | null;
  html: string;
  bytes: number;
  truncated: boolean;
  hops: number;
  contentType: string | null;
}

export interface PageAudit {
  checks: SeoAuditCheckV1[];
  /** sha-256 of the lower-cased title / description: what the duplicate checks compare; the text is never kept. */
  titleHash: string | null;
  metaDescriptionHash: string | null;
  links: string[];
}
const textHash = (text: string): string | null => (text === '' ? null : sha256Hex(text.toLowerCase()));

const pass = (key: SeoAuditCheckKey): SeoAuditCheckV1 => ({ key, ok: true, severity: null, detail: null });
const fail = (key: SeoAuditCheckKey, severity: SeoAuditSeverity, detail: string): SeoAuditCheckV1 => ({
  key,
  ok: false,
  severity,
  detail,
});

const SUBRESOURCE_TAGS = ['img', 'script', 'iframe', 'video', 'audio', 'source', 'embed', 'object'];

/** The lab checks over one fetched page; the cross-page ones (broken links, duplicates) are added at finish. */
export function auditPage(page: FetchedPageFacts): PageAudit {
  const checks: SeoAuditCheckV1[] = [];
  if (page.status === null) checks.push(fail('status', 'critical', 'unreachable'));
  else if (page.status >= 500) checks.push(fail('status', 'critical', `status=${page.status}`));
  else if (page.status >= 400) checks.push(fail('status', 'major', `status=${page.status}`));
  else checks.push(pass('status'));
  checks.push(page.hops <= 1 ? pass('redirect_chain') : fail('redirect_chain', 'minor', `hops=${page.hops}`));
  if (page.status !== 200 || !isHtml(page.contentType))
    return { checks, titleHash: null, metaDescriptionHash: null, links: [] };

  const html = page.html;
  const head = withoutScripts(html);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleTag ? fold(titleTag[1] as string) : '';
  if (title === '') checks.push(fail('title', 'major', 'missing'));
  else if (title.length > SEO_TITLE_HARD_MAX) checks.push(fail('title', 'major', `length=${title.length}`));
  else if (title.length > SEO_TITLE_MAX) checks.push(fail('title', 'minor', `length=${title.length}`));
  else checks.push(pass('title'));

  const description = (metaContent(html, 'description') ?? '').replace(/\s+/g, ' ').trim();
  if (description === '') checks.push(fail('meta_description', 'major', 'missing'));
  else if (description.length < SEO_DESCRIPTION_MIN || description.length > SEO_DESCRIPTION_MAX)
    checks.push(fail('meta_description', 'minor', `length=${description.length}`));
  else checks.push(pass('meta_description'));

  const h1s = tags(head, 'h1').length;
  checks.push(
    h1s === 1 ? pass('h1') : h1s === 0 ? fail('h1', 'major', 'count=0') : fail('h1', 'minor', `count=${h1s}`),
  );

  const canonical = linkRel(html, 'canonical').map((t) => attr(t, 'href') ?? '')[0] ?? '';
  if (canonical === '') checks.push(fail('canonical', 'minor', 'missing'));
  else {
    const target = sameOriginUrl(canonical, page.url, page.origin);
    checks.push(target ? pass('canonical') : fail('canonical', 'major', 'other_origin'));
  }

  const robots = `${metaContent(html, 'robots') ?? ''} ${metaContent(html, 'googlebot') ?? ''}`.toLowerCase();
  if (/\bnoindex\b/.test(robots)) checks.push(fail('robots_meta', 'critical', 'noindex'));
  else if (/\bnofollow\b/.test(robots)) checks.push(fail('robots_meta', 'minor', 'nofollow'));
  else checks.push(pass('robots_meta'));

  checks.push(metaContent(html, 'viewport') ? pass('viewport') : fail('viewport', 'minor', 'missing'));
  const htmlTag = tags(html, 'html')[0] ?? '';
  checks.push((attr(htmlTag, 'lang') ?? '') !== '' ? pass('lang') : fail('lang', 'minor', 'missing'));

  const missingAlt = tags(head, 'img').filter((t) => !hasAttr(t, 'alt')).length;
  checks.push(missingAlt === 0 ? pass('image_alt') : fail('image_alt', 'minor', `count=${missingAlt}`));

  const hreflangs = linkRel(html, 'alternate').filter((t) => attr(t, 'hreflang') !== null);
  if (hreflangs.length === 0) checks.push(pass('hreflang'));
  else {
    const hrefs = hreflangs.map((t) => attr(t, 'href') ?? '');
    const absolute = hrefs.every((h) => /^https?:\/\//i.test(h));
    const self = hrefs.some((h) => sameOriginUrl(h, page.url, page.origin) === page.url);
    checks.push(
      !absolute
        ? fail('hreflang', 'minor', 'relative')
        : !self
          ? fail('hreflang', 'minor', 'no_self')
          : pass('hreflang'),
    );
  }

  const ldJson = [
    ...html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi),
  ].map((m) => m[1] as string);
  if (ldJson.length === 0) checks.push(fail('structured_data', 'minor', 'absent'));
  else {
    const valid = ldJson.every((block) => {
      try {
        JSON.parse(block);
        return true;
      } catch {
        return false;
      }
    });
    checks.push(valid ? pass('structured_data') : fail('structured_data', 'major', 'invalid'));
  }

  if (page.truncated) checks.push(fail('page_size', 'major', `bytes>${page.bytes}`));
  else if (page.bytes > SEO_PAGE_HEAVY_BYTES) checks.push(fail('page_size', 'minor', `bytes=${page.bytes}`));
  else checks.push(pass('page_size'));

  let mixed = 0;
  if (page.url.startsWith('https://')) {
    for (const tagName of SUBRESOURCE_TAGS)
      for (const t of tags(html, tagName)) if (/^http:\/\//i.test(attr(t, 'src') ?? '')) mixed++;
    for (const t of linkRel(html, 'stylesheet')) if (/^http:\/\//i.test(attr(t, 'href') ?? '')) mixed++;
  }
  checks.push(mixed === 0 ? pass('mixed_content') : fail('mixed_content', 'major', `count=${mixed}`));

  return {
    checks,
    titleHash: textHash(title),
    metaDescriptionHash: textHash(description),
    links: extractLinks(html, page.url, page.origin),
  };
}

// ---- cross-page checks and the run's summary ----

export interface CrawledPageFacts {
  url: string;
  status: number | null;
  titleHash: string | null;
  metaDescriptionHash: string | null;
  links: readonly string[];
  checks: SeoAuditCheckV1[];
}

const SEVERITY_RANK: Record<SeoAuditSeverity, number> = { minor: 1, major: 2, critical: 3 };

export function pageSeverity(checks: readonly SeoAuditCheckV1[]): SeoAuditPageSeverity {
  let worst: SeoAuditSeverity | null = null;
  for (const c of checks)
    if (!c.ok && c.severity && (!worst || SEVERITY_RANK[c.severity] > SEVERITY_RANK[worst]))
      worst = c.severity;
  return worst ?? 'ok';
}

/**
 * Broken internal links (a same-origin link whose target the crawl fetched with status ≥ 400) and duplicate
 * titles and descriptions across the crawl (by hash); the per-page checks are kept and the three keys replaced.
 */
export function crossPageChecks(pages: readonly CrawledPageFacts[]): Map<string, SeoAuditCheckV1[]> {
  const statusOf = new Map(pages.map((p) => [p.url, p.status]));
  const count = (key: (p: CrawledPageFacts) => string | null) => {
    const by = new Map<string, number>();
    for (const p of pages) {
      const k = key(p);
      if (k !== null) by.set(k, (by.get(k) ?? 0) + 1);
    }
    return by;
  };
  const titles = count((p) => p.titleHash);
  const descriptions = count((p) => p.metaDescriptionHash);
  const out = new Map<string, SeoAuditCheckV1[]>();
  for (const p of pages) {
    if (p.status !== 200) continue; // an unreachable page is already its own finding
    const broken = p.links.filter((l) => (statusOf.get(l) ?? 0) >= 400).length;
    const sameTitle = p.titleHash ? (titles.get(p.titleHash) ?? 0) : 0;
    const sameDescription = p.metaDescriptionHash ? (descriptions.get(p.metaDescriptionHash) ?? 0) : 0;
    const added: SeoAuditCheckV1[] = [
      broken === 0 ? pass('broken_links') : fail('broken_links', 'major', `count=${broken}`),
      sameTitle > 1 ? fail('duplicate_title', 'minor', `count=${sameTitle}`) : pass('duplicate_title'),
      sameDescription > 1
        ? fail('duplicate_description', 'minor', `count=${sameDescription}`)
        : pass('duplicate_description'),
    ];
    const keys = new Set(added.map((c) => c.key));
    out.set(p.url, [...p.checks.filter((c) => !keys.has(c.key)), ...added]);
  }
  return out;
}

export function summarise(
  pages: ReadonlyArray<{ severity: SeoAuditPageSeverity; checks: readonly SeoAuditCheckV1[] }>,
): SeoAuditSummaryCountsV1 {
  const out: SeoAuditSummaryCountsV1 = { critical: 0, major: 0, minor: 0, byCheck: {} };
  for (const p of pages) {
    if (p.severity !== 'ok') out[p.severity] += 1;
    for (const c of p.checks) if (!c.ok) out.byCheck[c.key] = (out.byCheck[c.key] ?? 0) + 1;
  }
  return out;
}

// ---- findings → tasks: the rule table (generic wording; a person turns a task into a brief) ----

interface FindingRule {
  label: string;
  task: (count: number) => string;
}
const pages = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;

export const FINDING_RULES: Readonly<Record<SeoAuditCheckKey, FindingRule>> = {
  status: {
    label: 'Pages not returning 200',
    task: (n) => `Fix or redirect ${pages(n)} that answer with an error status, and remove links to them.`,
  },
  redirect_chain: {
    label: 'Redirect chains',
    task: (n) =>
      `Point links and redirects at the final URL for ${pages(n)} reached through more than one hop.`,
  },
  title: {
    label: 'Missing or long titles',
    task: (n) =>
      `Write a unique title of ${SEO_TITLE_MAX} characters or fewer for ${pages(n)} whose title is missing or too long.`,
  },
  meta_description: {
    label: 'Missing or off-length meta descriptions',
    task: (n) =>
      `Write a meta description of ${SEO_DESCRIPTION_MIN}–${SEO_DESCRIPTION_MAX} characters for ${pages(n)}.`,
  },
  h1: {
    label: 'Not exactly one H1',
    task: (n) => `Give ${pages(n)} exactly one H1 that states what the page is about.`,
  },
  canonical: {
    label: 'Canonical missing or off-origin',
    task: (n) => `Add a self-referencing canonical link on ${pages(n)}, pointing at this site's own URL.`,
  },
  robots_meta: {
    label: 'Pages excluded by robots meta',
    task: (n) =>
      `Confirm ${pages(n)} should carry noindex or nofollow; remove the directive where they should rank.`,
  },
  viewport: {
    label: 'No viewport meta',
    task: (n) => `Add a viewport meta tag so ${pages(n)} render correctly on phones.`,
  },
  lang: {
    label: 'No language attribute',
    task: (n) => `Set the lang attribute on the html element of ${pages(n)}.`,
  },
  image_alt: {
    label: 'Images without alt text',
    task: (n) => `Add alt text to the images on ${pages(n)} (an empty alt for decorative images).`,
  },
  broken_links: {
    label: 'Broken internal links',
    task: (n) =>
      `Fix or remove the internal links on ${pages(n)} that lead to pages answering with an error.`,
  },
  hreflang: {
    label: 'Inconsistent hreflang',
    task: (n) =>
      `Make the hreflang set on ${pages(n)} absolute and include the page itself, so every language version lists all the others.`,
  },
  structured_data: {
    label: 'Structured data missing or invalid',
    task: (n) => `Add valid JSON-LD structured data to ${pages(n)} (or fix the blocks that do not parse).`,
  },
  page_size: {
    label: 'Heavy pages',
    task: (n) =>
      `Reduce the HTML of ${pages(n)} over ${Math.round(SEO_PAGE_HEAVY_BYTES / 1024)} KB (inline scripts, styles, embedded data).`,
  },
  mixed_content: {
    label: 'Mixed content',
    task: (n) => `Serve the http:// subresources on ${pages(n)} over https.`,
  },
  duplicate_title: {
    label: 'Duplicate titles',
    task: (n) => `Give each of the ${pages(n)} sharing a title its own.`,
  },
  duplicate_description: {
    label: 'Duplicate meta descriptions',
    task: (n) => `Give each of the ${pages(n)} sharing a meta description its own.`,
  },
};

/** The run's findings: one per check with failing pages, worst severity first, with example URLs. */
export function findingsOf(
  pages: ReadonlyArray<{ url: string; checks: readonly SeoAuditCheckV1[] }>,
): SeoAuditFindingV1[] {
  const by = new Map<SeoAuditCheckKey, { severity: SeoAuditSeverity; count: number; examples: string[] }>();
  for (const p of pages)
    for (const c of p.checks) {
      if (c.ok || !c.severity) continue;
      const f = by.get(c.key) ?? { severity: c.severity, count: 0, examples: [] };
      f.count += 1;
      if (SEVERITY_RANK[c.severity] > SEVERITY_RANK[f.severity]) f.severity = c.severity;
      if (f.examples.length < SEO_AUDIT_FINDING_EXAMPLES) f.examples.push(p.url);
      by.set(c.key, f);
    }
  return SeoAuditCheckKey.options
    .flatMap((check) => {
      const f = by.get(check);
      return f
        ? [
            {
              check,
              label: FINDING_RULES[check].label,
              severity: f.severity,
              count: f.count,
              examples: f.examples,
              suggestedTask: FINDING_RULES[check].task(f.count),
            },
          ]
        : [];
    })
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count);
}
