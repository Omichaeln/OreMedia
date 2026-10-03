import {
  SOURCE_CRAWL_DEADLINE_MS,
  SOURCE_MAX_HOPS,
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_URL_MAX_PAGES,
  type BrandSourcePageV1,
  type BrandSourceReason,
} from '@oremedia/contracts/brand-assist';
import {
  BlockedAddressError,
  ProviderTransportError,
  assertSafeUrl,
  parseRobots,
  robotsAllows,
  sitemapUrls,
  type ProviderIO,
  type SafeDispatcherOptions,
} from '@oremedia/providers';
import { htmlToText, sameSiteHost, sameSiteUrl } from './html-text';

/**
 * BSC-4: a website source read within its caps: https only, robots.txt honoured (its `*` group), the start page and up
 * to SOURCE_URL_MAX_PAGES - 1 more pages of the same site chosen from its navigation and sitemap (pages that say what
 * the brand is first: about, products, services, values...), each fetch through the SSRF-safe IO with every redirect
 * hop re-checked and kept on the site, at most SOURCE_PAGE_MAX_BYTES a page (a larger page is skipped, never read in
 * part) and the whole crawl inside SOURCE_CRAWL_DEADLINE_MS. The text of each page read is kept under its title.
 */
export interface CrawlOptions extends SafeDispatcherOptions {
  maxPages?: number;
  maxBytes?: number;
  deadlineMs?: number;
  now?: () => number;
  heartbeat?: (detail: string) => void;
}

export type CrawlResult =
  | {
      ok: true;
      text: string;
      pages: BrandSourcePageV1[];
      bytes: number;
      skipped: number;
      detail: string | null;
    }
  | { ok: false; reason: BrandSourceReason; detail: string | null };

class PageRefusal extends Error {
  constructor(
    readonly reason: BrandSourceReason,
    readonly detail: string | null = null,
  ) {
    super(reason);
    this.name = 'PageRefusal';
  }
}

const REDIRECTS = [301, 302, 303, 307, 308];
const CONTROL_FILE_MAX_BYTES = 256 * 1024;
const SITEMAP_URLS_READ = 200;
/** Paths that tend to say what a brand is, does and stands for: read first. */
const PRIORITY = [
  /about|who-we-are|our-story|story|company|mission|values|purpose/i,
  /product|service|solution|what-we-do|offer|range|menu|shop/i,
  /team|people|leadership|careers|culture/i,
  /faq|help|how-it-works|pricing|contact/i,
  /blog|news|journal|insight|case-stud/i,
];
const SKIP_PATH =
  /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|pptx?|css|js|xml|json|ico)$|\/(login|log-in|signin|sign-in|account|cart|basket|checkout|wp-admin|wp-login|search)(\/|$)|[?&](replytocom|share|utm_)/i;

interface Fetched {
  status: number;
  body: string;
  bytes: number;
  url: string;
  contentType: string | null;
}

async function fetchOnSite(
  io: ProviderIO,
  url: string,
  siteHost: string,
  opts: CrawlOptions & { maxBytes: number; accept: string },
): Promise<Fetched> {
  let current = url;
  for (let hop = 0; ; hop++) {
    let target: URL;
    try {
      target = assertSafeUrl(current, opts);
    } catch (err) {
      if (err instanceof BlockedAddressError)
        throw new PageRefusal(/is not allowed/.test(err.message) ? 'not_https' : 'blocked_address');
      throw new PageRefusal('unreachable');
    }
    if (!sameSiteHost(target.host, siteHost)) throw new PageRefusal('redirect_elsewhere', target.host);
    const res = await io
      .request(current, { method: 'GET', headers: { accept: opts.accept } }, { mutation: false })
      .then((r) => r.res)
      .catch((err: unknown) => {
        throw transportRefusal(err);
      });
    if (REDIRECTS.includes(res.status)) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location || hop >= SOURCE_MAX_HOPS) throw new PageRefusal('http_error', 'too many redirects');
      current = new URL(location, current).toString();
      continue;
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel();
      throw new PageRefusal('too_large', `${declared} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let read;
        try {
          read = await reader.read();
        } catch (err) {
          throw transportRefusal(err);
        }
        if (read.done) break;
        const chunk = Buffer.from(read.value as Uint8Array);
        total += chunk.length;
        if (total > opts.maxBytes) {
          await reader.cancel();
          throw new PageRefusal('too_large', `over ${opts.maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    }
    return {
      status: res.status,
      body: Buffer.concat(chunks).toString('utf8'),
      bytes: total,
      url: current,
      contentType: res.headers.get('content-type'),
    };
  }
}

function transportRefusal(err: unknown): PageRefusal {
  const name = (err as { name?: string })?.name;
  const cause = err instanceof ProviderTransportError ? err.cause : err;
  const text = `${name ?? ''} ${(cause as Error)?.name ?? ''} ${(cause as Error)?.message ?? ''}`;
  if (/Blocked address/i.test(text)) return new PageRefusal('blocked_address');
  if (/timeout|aborted/i.test(text)) return new PageRefusal('timeout');
  return new PageRefusal('unreachable');
}

const isHtml = (contentType: string | null) =>
  contentType === null || /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType);

const priorityOf = (url: string): number => {
  const path = new URL(url).pathname;
  const i = PRIORITY.findIndex((p) => p.test(path));
  return (i < 0 ? PRIORITY.length : i) * 100 + path.split('/').filter(Boolean).length;
};

/** The pages to read after the start page: navigation links first, then the sitemap, then other links; best first. */
export function choosePages(
  start: string,
  navLinks: string[],
  sitemap: string[],
  links: string[],
  max: number,
) {
  const seen = new Set([start, normalised(start)]);
  const pick = (list: string[]) =>
    list
      .filter((u) => !SKIP_PATH.test(u))
      .map((u) => ({ u, p: priorityOf(u) }))
      .sort((a, b) => a.p - b.p)
      .map((x) => x.u);
  const out: string[] = [];
  for (const u of [...pick(navLinks), ...pick(sitemap), ...pick(links)]) {
    const key = normalised(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

const normalised = (u: string) => {
  try {
    const url = new URL(u);
    url.hash = '';
    url.host = url.host.toLowerCase().replace(/^www\./, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
};

export async function crawlSite(
  io: ProviderIO,
  startUrl: string,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const maxPages = opts.maxPages ?? SOURCE_URL_MAX_PAGES;
  const maxBytes = opts.maxBytes ?? SOURCE_PAGE_MAX_BYTES;
  const deadline = started + (opts.deadlineMs ?? SOURCE_CRAWL_DEADLINE_MS);
  let start: URL;
  try {
    start = assertSafeUrl(startUrl, opts);
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof BlockedAddressError && /is not allowed/.test(err.message)
          ? 'not_https'
          : 'blocked_address',
      detail: null,
    };
  }
  const siteHost = start.host;
  const origin = start.origin;
  // robots.txt: a 4xx means no rules; a 5xx or no answer means the site cannot be read now (RFC 9309 2.3.1).
  let disallow: string[] = [];
  let sitemapRefs: string[] = [];
  try {
    opts.heartbeat?.('robots');
    const robots = await fetchOnSite(io, `${origin}/robots.txt`, siteHost, {
      ...opts,
      maxBytes: CONTROL_FILE_MAX_BYTES,
      accept: 'text/plain',
    });
    if (robots.status >= 500)
      return { ok: false, reason: 'robots_disallowed', detail: 'robots.txt unavailable' };
    if (robots.status === 200) {
      const rules = parseRobots(robots.body, 200);
      disallow = rules.disallow;
      sitemapRefs = rules.sitemaps;
    }
  } catch (err) {
    if (!(err instanceof PageRefusal)) throw err;
    if (err.reason === 'blocked_address' || err.reason === 'not_https')
      return { ok: false, reason: err.reason, detail: null };
    if (err.reason === 'unreachable' || err.reason === 'timeout')
      return { ok: false, reason: err.reason, detail: null };
    // A robots.txt that redirects elsewhere or is oversized is treated as absent.
  }
  if (!robotsAllows(disallow, start.toString()))
    return { ok: false, reason: 'robots_disallowed', detail: null };

  const pages: BrandSourcePageV1[] = [];
  const texts: string[] = [];
  let bytes = 0;
  let skipped = 0;
  let firstRefusal: PageRefusal | null = null;

  const read = async (url: string): Promise<ReturnType<typeof htmlToText> | null> => {
    opts.heartbeat?.(`page ${pages.length + 1}`);
    const page = await fetchOnSite(io, url, siteHost, { ...opts, maxBytes, accept: 'text/html' });
    if (page.status >= 400) throw new PageRefusal('http_error', `status ${page.status}`);
    if (page.status !== 200) throw new PageRefusal('http_error', `status ${page.status}`);
    if (!isHtml(page.contentType)) throw new PageRefusal('not_html', page.contentType);
    const t = htmlToText(page.body, page.url);
    bytes += page.bytes;
    if (!t.text.trim()) throw new PageRefusal('no_text');
    pages.push({ url: page.url, title: t.title, canonicalUrl: t.canonicalUrl, chars: t.text.length });
    texts.push(`## Page: ${t.title ?? page.url}\nAddress: ${page.url}\n\n${t.text}`);
    return t;
  };

  let first: ReturnType<typeof htmlToText> | null = null;
  try {
    first = await read(start.toString());
  } catch (err) {
    if (!(err instanceof PageRefusal)) throw err;
    return { ok: false, reason: err.reason, detail: err.detail };
  }
  let sitemap: string[] = [];
  if (now() < deadline && maxPages > 1)
    for (const ref of [...sitemapRefs, `${origin}/sitemap.xml`].slice(0, 3)) {
      try {
        const sm = await fetchOnSite(io, ref, siteHost, {
          ...opts,
          maxBytes: CONTROL_FILE_MAX_BYTES * 4,
          accept: 'application/xml, text/xml',
        });
        if (sm.status !== 200) continue;
        const listed = sitemapUrls(sm.body);
        sitemap = listed.urls
          .slice(0, SITEMAP_URLS_READ)
          .flatMap((u) => sameSiteUrl(u, start.toString()) ?? []);
        if (sitemap.length) break;
      } catch (err) {
        if (!(err instanceof PageRefusal)) throw err;
      }
    }
  const next = choosePages(
    start.toString(),
    first?.navLinks ?? [],
    sitemap,
    first?.links ?? [],
    maxPages - 1,
  );
  for (const url of next) {
    if (pages.length >= maxPages || now() >= deadline) break;
    if (!robotsAllows(disallow, url)) {
      skipped += 1;
      continue;
    }
    try {
      await read(url);
    } catch (err) {
      if (!(err instanceof PageRefusal)) throw err;
      skipped += 1;
      firstRefusal ??= err;
    }
  }
  return {
    ok: true,
    text: texts.join('\n\n'),
    pages,
    bytes,
    skipped,
    detail: skipped
      ? `${skipped} page${skipped === 1 ? '' : 's'} skipped${firstRefusal ? ` (${firstRefusal.reason})` : ''}`
      : null,
  };
}
