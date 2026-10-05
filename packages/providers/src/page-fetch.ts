import type { ProviderIO } from './io';
import { assertSafeUrl, type SafeDispatcherOptions } from './ssrf';

/**
 * The one bounded fetch of a public page (D-16 rendered-page validation, R2-4 audit crawl): no credentials, https
 * only, every redirect hop re-checked against the SSRF policy and pinned to the site's host before it is
 * followed, the body read against `maxBytes` and marked truncated beyond it. Both the CMS adapters and the audit
 * crawler read pages through this, so there is exactly one place the policy lives.
 */
export interface FetchedPage {
  status: number;
  html: string;
  bytes: number;
  truncated: boolean;
  /** The URL the page was finally read from (after re-checked redirects). */
  url: string;
  /** Redirects followed before the final response. */
  hops: number;
  contentType: string | null;
  /**
   * PR-04: the response headers a rendered-article check reads (live visibility and canonical identity), each as
   * the server sent it (several of one name joined with `, `) and cut to 2000 characters; null when absent.
   */
  xRobotsTag: string | null;
  link: string | null;
}

const HEADER_MAX_CHARS = 2000;
const boundedHeader = (value: string | null): string | null =>
  value === null ? null : value.slice(0, HEADER_MAX_CHARS);

export interface FetchPageOptions extends SafeDispatcherOptions {
  /** The site's host (with port when present): a redirect elsewhere is refused, never followed. */
  host: string;
  maxBytes: number;
  maxHops: number;
  accept?: string;
}

/** A page that could not be read within the policy (another host, too many redirects). */
export class RenderedPageError extends Error {
  constructor(
    readonly code: 'other_host' | 'redirect_limit',
    message: string,
  ) {
    super(message);
    this.name = 'RenderedPageError';
  }
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

export async function fetchPageBounded(
  io: ProviderIO,
  url: string,
  opts: FetchPageOptions,
): Promise<FetchedPage> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const target = assertSafeUrl(current, opts);
    if (target.host !== opts.host)
      throw new RenderedPageError('other_host', `${target.host} is not the site's host`);
    const { res } = await io.request(
      current,
      { method: 'GET', headers: { accept: opts.accept ?? 'text/html' } },
      { mutation: false },
    );
    if (REDIRECT_STATUSES.includes(res.status)) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location || hop >= opts.maxHops)
        throw new RenderedPageError('redirect_limit', 'too many redirects or no location');
      current = new URL(location, current).toString();
      continue;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value as Uint8Array);
        total += chunk.length;
        if (total > opts.maxBytes) {
          chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - opts.maxBytes))));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(chunk);
      }
    }
    return {
      status: res.status,
      html: Buffer.concat(chunks).toString('utf8'),
      bytes: Math.min(total, opts.maxBytes),
      truncated,
      url: current,
      hops: hop,
      contentType: res.headers.get('content-type'),
      xRobotsTag: boundedHeader(res.headers.get('x-robots-tag')),
      link: boundedHeader(res.headers.get('link')),
    };
  }
}
