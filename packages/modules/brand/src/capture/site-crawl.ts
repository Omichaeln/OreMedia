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
import { DocumentRefusal } from './documents';
import { htmlToText, sameSiteHost, sameSiteUrl, type PageText } from './html-text';

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
  /** How a page's HTML becomes text; the capture activity parses in an isolated worker (capture/isolate.ts). */
  parse?: (html: string, pageUrl: string) => PageText | Promise<PageText>;
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
/** robots.txt beyond this is read in part: its first ROBOTS_READ_BYTES (RFC 9309 2.5 asks for at least 500 KiB). */
const ROBOTS_READ_BYTES = 512 * 1024;
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
  /** Only with `readPart`: the body was cut at maxBytes. */
  truncated: boolean;
}

/** Settles as `p`, or refuses with `timeout` once `ms` have passed (the crawl's remaining time). */
function within<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  if (ms <= 0) {
    onTimeout?.();
    return Promise.reject(new PageRefusal('timeout', 'crawl time used up'));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new PageRefusal('timeout', 'crawl time used up'));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function fetchOnSite(
  io: ProviderIO,
  url: string,
  siteHost: string,
  opts: CrawlOptions & {
    maxBytes: number;
    accept: string;
    /** Milliseconds left in the crawl: each request and body read gets no more than this. */
    remaining: () => number;
    /** Keep the first maxBytes of a larger body instead of refusing it. */
    readPart?: boolean;
  },
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
    const res = await within(
      io
        .request(current, { method: 'GET', headers: { accept: opts.accept } }, { mutation: false })
        .then((r) => r.res)
        .catch((err: unknown) => {
          throw transportRefusal(err);
        }),
      opts.remaining(),
    );
    if (REDIRECTS.includes(res.status)) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location || hop >= SOURCE_MAX_HOPS) throw new PageRefusal('http_error', 'too many redirects');
      current = new URL(location, current).toString();
      continue;
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > opts.maxBytes && !opts.readPart) {
      await res.body?.cancel();
      throw new PageRefusal('too_large', `${declared} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let read;
        try {
          read = await within(reader.read(), opts.remaining(), () => void reader.cancel().catch(() => {}));
        } catch (err) {
          throw err instanceof PageRefusal ? err : transportRefusal(err);
        }
        if (read.done) break;
        const chunk = Buffer.from(read.value as Uint8Array);
        if (total + chunk.length > opts.maxBytes) {
          await reader.cancel().catch(() => {});
          if (!opts.readPart) throw new PageRefusal('too_large', `over ${opts.maxBytes} bytes`);
          chunks.push(chunk.subarray(0, opts.maxBytes - total));
          total = opts.maxBytes;
          truncated = true;
          break;
        }
        total += chunk.length;
        chunks.push(chunk);
      }
    }
    return {
      status: res.status,
      body: Buffer.concat(chunks).toString('utf8'),
      bytes: total,
      url: current,
      contentType: res.headers.get('content-type'),
      truncated,
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
  // Only the standard https port (loopback test servers aside): a site is read where its visitors read it.
  if (start.port !== '' && !opts.insecureAllowLoopback)
    return { ok: false, reason: 'not_https', detail: 'only the standard https port is read' };
  const remaining = () => deadline - now();
  const parse = opts.parse ?? htmlToText;
  const siteHost = start.host;
  const origin = start.origin;
  // robots.txt: a 4xx means no rules; a 5xx or no answer means the site cannot be read now (RFC 9309 2.3.1).
  let disallow: string[] = [];
  let sitemapRefs: string[] = [];
  try {
    opts.heartbeat?.('robots');
    const robots = await fetchOnSite(io, `${origin}/robots.txt`, siteHost, {
      ...opts,
      maxBytes: ROBOTS_READ_BYTES,
      accept: 'text/plain',
      remaining,
      readPart: true,
    });
    if (robots.status >= 500)
      return { ok: false, reason: 'robots_disallowed', detail: 'robots.txt unavailable' };
    if (robots.status === 200) {
      // A cut file loses its last (partial) line rather than reading half a rule.
      const body = robots.truncated
        ? robots.body.slice(0, Math.max(0, robots.body.lastIndexOf('\n')))
        : robots.body;
      const rules = parseRobots(body, 200);
      disallow = rules.disallow;
      sitemapRefs = rules.sitemaps;
    }
  } catch (err) {
    if (!(err instanceof PageRefusal)) throw err;
    if (err.reason === 'blocked_address' || err.reason === 'not_https')
      return { ok: false, reason: err.reason, detail: null };
    if (err.reason === 'unreachable' || err.reason === 'timeout')
      return { ok: false, reason: err.reason, detail: null };
    // A robots.txt that redirects elsewhere is treated as absent.
  }
  if (!robotsAllows(disallow, start.toString()))
    return { ok: false, reason: 'robots_disallowed', detail: null };

  const pages: BrandSourcePageV1[] = [];
  const texts: string[] = [];
  let bytes = 0;
  let skipped = 0;
  let firstRefusal: PageRefusal | null = null;

  const read = async (url: string): Promise<PageText | null> => {
    opts.heartbeat?.(`page ${pages.length + 1}`);
    const page = await fetchOnSite(io, url, siteHost, { ...opts, maxBytes, accept: 'text/html', remaining });
    if (page.status !== 200) throw new PageRefusal('http_error', `status ${page.status}`);
    if (!isHtml(page.contentType)) throw new PageRefusal('not_html', page.contentType);
    let t: PageText;
    try {
      t = await parse(page.body, page.url);
    } catch (err) {
      // The isolated parser refuses (processing_limit) as documents do; the page is skipped like any other refusal.
      if (err instanceof DocumentRefusal) throw new PageRefusal(err.reason, err.detail);
      throw err;
    }
    bytes += page.bytes;
    if (!t.text.trim()) throw new PageRefusal('no_text');
    pages.push({ url: page.url, title: t.title, canonicalUrl: t.canonicalUrl, chars: t.text.length });
    texts.push(`## Page: ${t.title ?? page.url}\nAddress: ${page.url}\n\n${t.text}`);
    return t;
  };

  let first: PageText | null = null;
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
          remaining,
        });
        if (sm.status !== 200) continue;
        const listed = sitemapUrls(sm.body);
        sitemap = listed.urls
          .slice(0, SITEMAP_URLS_READ)
          .flatMap((u) => sameSiteUrl(u, start.toString()) ?? []);
        if (sitemap.length) break;
      } catch {
        // A sitemap that cannot be read or makes no sense only means fewer pages to choose from.
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
      // Past the start page, whatever goes wrong with one page (a refusal, or a page the parser chokes on) skips that
      // page; the source keeps what was read.
      skipped += 1;
      firstRefusal ??= err instanceof PageRefusal ? err : new PageRefusal('capture_failed');
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
