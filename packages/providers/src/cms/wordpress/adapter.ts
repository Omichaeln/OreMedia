import type { DecryptedCredentials, ProviderErrorClass } from '@oremedia/contracts/providers';
import { classifyByStatus, retryAfterMs, truncateForTemporal } from '../../base';
import type {
  CmsAdapter,
  CmsArticleInput,
  CmsMediaInput,
  CmsMediaResult,
  CmsReadResult,
  CmsRemoteArticle,
  CmsRemoveResult,
  CmsRenderedPage,
  CmsSite,
  CmsUpdatePrecondition,
  CmsVerifyResult,
  CmsWriteResult,
} from '../../cms-contract';
import { ProviderTransportError, type ProviderIO } from '../../io';
import {
  EffectBoundary,
  MediaFetchError,
  arr,
  fetchBytes,
  get,
  num,
  readResponse,
  str,
  summarise,
  textFingerprint,
  type ProviderResponse,
} from '../../shared';
import { RenderedPageError, fetchPageBounded } from '../../page-fetch';
import { assertSafeUrl } from '../../ssrf';
import { wordpressCmsCapability } from './capability';

/** The REST API root under the site (pretty permalinks or not, `/wp-json` is served by the site itself). */
export const WP_REST_ROOT = '/wp-json/wp/v2';
/** Term listings page at the API's maximum; a name is matched exactly among what the search returns. */
export const WP_TERMS_PER_PAGE = 100;
const WP_TERMS_MAX_PAGES = 10;
/** Redirects of a rendered page are followed this many hops, each re-checked (https, the site's host). */
export const WP_RENDERED_MAX_HOPS = 3;

/** HTTP Basic with the application password (WordPress strips the spaces it shows; sent as given either way). */
const basic = (site: CmsSite, credentials: DecryptedCredentials): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${site.username}:${credentials.accessToken}`, 'utf8').toString('base64')}`,
});
const siteOrigin = (site: CmsSite): string => assertSafeUrl(site.siteUrl).origin;
const api = (site: CmsSite, path: string): string => `${siteOrigin(site)}${WP_REST_ROOT}${path}`;

async function request(
  io: ProviderIO,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  mutation: boolean,
): Promise<ProviderResponse> {
  const { res } = await io.request(url, init, { mutation });
  return readResponse(res);
}

/**
 * RA-12: the hash of a remote revision covers its identity and state beside the content (title, slug, status, the
 * term ids and the raw content), so a change to any of them on the site moves the hash an edit must match.
 */
export const remoteArticleFingerprint = (fields: {
  title: string;
  slug: string;
  status: string;
  categories: number[];
  tags: number[];
  html: string;
}): string =>
  textFingerprint(
    JSON.stringify({
      title: fields.title,
      slug: fields.slug,
      status: fields.status,
      categories: [...fields.categories].sort((a, b) => a - b),
      tags: [...fields.tags].sort((a, b) => a - b),
      content: fields.html,
    }),
  );

/** modified_gmt is UTC without a zone designator; stored as an ISO instant. */
const instantOf = (modified: string | undefined): string | null =>
  modified ? (modified.endsWith('Z') ? modified : `${modified}Z`) : null;
const termIds = (json: unknown, taxonomy: 'categories' | 'tags'): number[] =>
  arr(get(json, taxonomy))
    .map((t) => num(t))
    .filter((t): t is number => t !== undefined);

/** The post object as the API returns it with `context=edit` (raw title and content); never the rendered HTML only. */
function toArticle(json: unknown): CmsRemoteArticle | null {
  const id = num(get(json, 'id'));
  if (id === undefined) return null;
  const html = str(get(json, 'content', 'raw')) ?? str(get(json, 'content', 'rendered')) ?? '';
  const title = str(get(json, 'title', 'raw')) ?? str(get(json, 'title', 'rendered')) ?? '';
  const slug = str(get(json, 'slug')) ?? '';
  const status = str(get(json, 'status')) ?? 'unknown';
  return {
    remoteId: String(id),
    remoteUrl: str(get(json, 'link')) ?? '',
    title,
    slug,
    status,
    modifiedAt: instantOf(str(get(json, 'modified_gmt'))),
    contentHash: remoteArticleFingerprint({
      title,
      slug,
      status,
      categories: termIds(json, 'categories'),
      tags: termIds(json, 'tags'),
      html,
    }),
    html,
  };
}

/**
 * A revision object (`/posts/<id>/revisions`, context=edit): the parent's fields as they were when it was saved.
 * The remote id is the parent's; the hash leaves the terms out (a revision carries none), so it is never compared
 * with a post's hash, only recorded as what the write replaced.
 */
function toRevisionArticle(json: unknown, parentId: string, link: string): CmsRemoteArticle | null {
  const article = toArticle(json);
  return article && { ...article, remoteId: parentId, remoteUrl: link };
}

/**
 * WordPress REST (ledger R2-3, D-16 working assumption): posts under `/wp-json/wp/v2/posts` with an application
 * password over HTTP Basic. Writes land as drafts unless asked to publish; an update first reads the current
 * revision and refuses (`conflict`) when the remote moved since the caller's read-back, so nothing is overwritten.
 * Terms are resolved by exact name among the site's categories and tags (created when missing).
 */
export class WordPressCmsAdapter implements CmsAdapter {
  readonly key = 'cms_site' as const;
  readonly capability = wordpressCmsCapability;

  async verify(site: CmsSite, credentials: DecryptedCredentials, io: ProviderIO): Promise<CmsVerifyResult> {
    let res: ProviderResponse;
    try {
      res = await request(
        io,
        `${api(site, '/users/me')}?context=edit`,
        { method: 'GET', headers: { ...basic(site, credentials), accept: 'application/json' } },
        false,
      );
    } catch (err) {
      if (err instanceof ProviderTransportError)
        return { ok: false, reason: 'transient', detail: truncateForTemporal(err.message, 300) };
      throw err;
    }
    if (res.status === 401 || res.status === 403)
      return { ok: false, reason: 'reconnect_required', detail: summarise(res, 300) };
    if (res.status !== 200)
      return { ok: false, reason: res.status >= 500 ? 'transient' : 'rejected', detail: summarise(res, 300) };
    const capabilities = get(res.json, 'capabilities');
    const can = (name: string) => get(capabilities, name) === true;
    if (!can('edit_posts'))
      return { ok: false, reason: 'rejected', detail: 'the user cannot edit posts on this site' };
    return {
      ok: true,
      displayName: str(get(res.json, 'name')) ?? str(get(res.json, 'slug')) ?? site.username,
      canPublish: can('publish_posts'),
    };
  }

  async readArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsReadResult> {
    let res: ProviderResponse;
    try {
      res = await request(
        io,
        `${api(site, `/posts/${encodeURIComponent(remoteId)}`)}?context=edit`,
        { method: 'GET', headers: { ...basic(site, credentials), accept: 'application/json' } },
        false,
      );
    } catch (err) {
      if (err instanceof ProviderTransportError)
        return {
          outcome: 'retryable_error',
          code: `transport_${err.phase}`,
          message: truncateForTemporal(err.message, 300),
        };
      throw err;
    }
    if (res.status === 404 || res.status === 410) return { outcome: 'absent' };
    if (res.status !== 200) return readFailure(this.classifyError.bind(this), res);
    const article = toArticle(res.json);
    if (!article) return { outcome: 'rejected', code: 'malformed_response', message: summarise(res, 300) };
    return { outcome: 'found', article };
  }

  /**
   * RA-08: the media endpoint takes the file as the request body with its type and a Content-Disposition file
   * name (`POST /media`); the alt text is a field of the created attachment, set with a second call. The bytes are
   * read from the signed release URL through ProviderIO (spec 9.3), never from storage directly.
   */
  async uploadMedia(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    media: CmsMediaInput,
  ): Promise<CmsMediaResult> {
    const boundary = new EffectBoundary();
    try {
      const bytes = await fetchBytes(io, media.url);
      boundary.cross();
      const { res } = await io.request(
        api(site, '/media'),
        {
          method: 'POST',
          headers: {
            ...basic(site, credentials),
            accept: 'application/json',
            'content-type': media.mime,
            'content-disposition': `attachment; filename="${media.filename.replace(/["\\\r\n]/g, '')}"`,
          },
          body: bytes,
        },
        { mutation: true },
      );
      const created = await readResponse(res);
      if (created.status !== 201 && created.status !== 200) return mediaFailure(created, boundary);
      const id = num(get(created.json, 'id'));
      const url = str(get(created.json, 'source_url'));
      if (id === undefined || !url)
        return { outcome: 'unknown', code: 'malformed_response', message: summarise(created, 300) };
      if (media.alt.trim() !== '') {
        const named = await request(
          io,
          api(site, `/media/${encodeURIComponent(String(id))}`),
          {
            method: 'POST',
            headers: {
              ...basic(site, credentials),
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ alt_text: media.alt }),
          },
          true,
        );
        if (named.status !== 200) return mediaFailure(named, boundary);
      }
      return { outcome: 'done', media: { remoteId: String(id), url } };
    } catch (err) {
      if (err instanceof MediaFetchError)
        return { outcome: 'retryable_error', code: 'media_fetch_failed', message: err.message };
      const failed = writeTransportFailure(err, boundary);
      return failed.outcome === 'done' || failed.outcome === 'conflict'
        ? { outcome: 'unknown', code: 'transport_after_send', message: 'unreachable' }
        : failed;
    }
  }

  async createArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    input: CmsArticleInput,
    idempotencyKey: string,
  ): Promise<CmsWriteResult> {
    const boundary = new EffectBoundary();
    try {
      const categories = await this.resolveTerms(site, credentials, io, 'categories', input.categories);
      const tags = await this.resolveTerms(site, credentials, io, 'tags', input.tags);
      boundary.cross();
      const res = await request(
        io,
        api(site, '/posts'),
        {
          method: 'POST',
          headers: {
            ...basic(site, credentials),
            accept: 'application/json',
            'content-type': 'application/json',
            'x-oremedia-idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            title: input.title,
            slug: input.slug,
            excerpt: input.excerpt,
            content: input.html,
            status: input.status,
            categories,
            tags,
            ...featuredMediaField(input.featuredMedia),
          }),
        },
        true,
      );
      if (res.status !== 201 && res.status !== 200)
        return writeFailure(this.classifyError.bind(this), res, boundary);
      const article = toArticle(res.json);
      if (!article) return { outcome: 'unknown', code: 'malformed_response', message: summarise(res, 300) };
      return { outcome: 'done', article };
    } catch (err) {
      return writeTransportFailure(err, boundary);
    }
  }

  async updateArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
    input: Partial<CmsArticleInput>,
    precondition: CmsUpdatePrecondition,
  ): Promise<CmsWriteResult> {
    const boundary = new EffectBoundary();
    try {
      const current = await this.readArticle(site, credentials, io, remoteId);
      if (current.outcome === 'absent')
        return {
          outcome: 'rejected',
          code: 'remote_absent',
          message: 'the article no longer exists on the site',
        };
      if (current.outcome !== 'found') return current;
      // The precondition is the caller's read-back: a remote that moved since is never overwritten.
      // RA-12: WordPress core REST offers no compare-and-swap (no If-Match / ETag on POST /posts/<id>), so this
      // read-then-write only narrows the window in which the site can change under the write; the revisions read
      // after the write detects a change that slipped into it (`overwritten`), it cannot prevent one.
      if (
        (precondition.expectedHash !== undefined &&
          precondition.expectedHash !== current.article.contentHash) ||
        (precondition.expectedModifiedAt !== undefined &&
          precondition.expectedModifiedAt !== current.article.modifiedAt)
      )
        return { outcome: 'conflict', current: current.article };
      const body: Record<string, unknown> = {};
      if (input.title !== undefined) body['title'] = input.title;
      if (input.slug !== undefined) body['slug'] = input.slug;
      if (input.excerpt !== undefined) body['excerpt'] = input.excerpt;
      if (input.html !== undefined) body['content'] = input.html;
      if (input.status !== undefined) body['status'] = input.status;
      Object.assign(body, featuredMediaField(input.featuredMedia));
      if (input.categories)
        body['categories'] = await this.resolveTerms(site, credentials, io, 'categories', input.categories);
      if (input.tags) body['tags'] = await this.resolveTerms(site, credentials, io, 'tags', input.tags);
      boundary.cross();
      const res = await request(
        io,
        api(site, `/posts/${encodeURIComponent(remoteId)}`),
        {
          method: 'POST',
          headers: {
            ...basic(site, credentials),
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        true,
      );
      if (res.status !== 200) return writeFailure(this.classifyError.bind(this), res, boundary);
      const article = toArticle(res.json);
      if (!article) return { outcome: 'unknown', code: 'malformed_response', message: summarise(res, 300) };
      const overwritten = await this.replacedRevision(site, credentials, io, current.article);
      return { outcome: 'done', article, previous: current.article, ...(overwritten ? { overwritten } : {}) };
    } catch (err) {
      return writeTransportFailure(err, boundary);
    }
  }

  /**
   * RA-12: after an update, the revision the write replaced. WordPress saves a revision of a post on every update
   * (the original too, when the first update is made), newest first; the second-newest after the write is the
   * state the write replaced. When its modified instant is not the pre-write read's, the site changed between the
   * read and the write and that revision is what was lost. A listing that cannot be read (revisions off, refused)
   * proves nothing: null, never a claim either way. modified_gmt is second-granular, so a site save within the same
   * second as the pre-write read is not told apart from it: the window is narrowed and detected, not closed.
   */
  private async replacedRevision(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    previous: CmsRemoteArticle,
  ): Promise<CmsRemoteArticle | null> {
    let res: ProviderResponse;
    try {
      res = await request(
        io,
        `${api(site, `/posts/${encodeURIComponent(previous.remoteId)}/revisions`)}?context=edit&per_page=2`,
        { method: 'GET', headers: { ...basic(site, credentials), accept: 'application/json' } },
        false,
      );
    } catch (err) {
      if (err instanceof ProviderTransportError) return null;
      throw err;
    }
    if (res.status !== 200) return null;
    const replaced = arr(res.json)[1];
    if (replaced === undefined) return null;
    const article = toRevisionArticle(replaced, previous.remoteId, previous.remoteUrl);
    if (!article || article.modifiedAt === null || article.modifiedAt === previous.modifiedAt) return null;
    return article;
  }

  async unpublishArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsRemoveResult> {
    const current = await this.readArticle(site, credentials, io, remoteId);
    if (current.outcome === 'absent') return { outcome: 'already_absent' };
    if (current.outcome !== 'found') return current;
    if (current.article.status === 'draft') return { outcome: 'done', article: current.article };
    // RA-12: the revert matches what it just read, never a remote that moved in between.
    const written = await this.updateArticle(
      site,
      credentials,
      io,
      remoteId,
      { status: 'draft' },
      { expectedHash: current.article.contentHash, expectedModifiedAt: current.article.modifiedAt },
    );
    if (written.outcome === 'done') return written;
    if (written.outcome === 'conflict')
      return {
        outcome: 'retryable_error',
        code: 'conflict',
        message: 'the article changed while it was being reverted',
      };
    if (written.outcome === 'unknown')
      return { outcome: 'retryable_error', code: written.code, message: written.message };
    return written;
  }

  async deleteArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsRemoveResult> {
    let res: ProviderResponse;
    try {
      res = await request(
        io,
        api(site, `/posts/${encodeURIComponent(remoteId)}`),
        { method: 'DELETE', headers: { ...basic(site, credentials), accept: 'application/json' } },
        true,
      );
    } catch (err) {
      if (err instanceof ProviderTransportError)
        return {
          outcome: 'retryable_error',
          code: `transport_${err.phase}`,
          message: truncateForTemporal(err.message, 300),
        };
      throw err;
    }
    if (res.status === 404 || res.status === 410) return { outcome: 'already_absent' };
    if (res.status !== 200) return removeFailure(this.classifyError.bind(this), res);
    return { outcome: 'done', article: toArticle(res.json) };
  }

  /**
   * Validation without credentials: the page as the public sees it, through the shared bounded fetch (every hop
   * re-checked against the SSRF policy and the site's host; the body read against the cap, truncated beyond).
   */
  async fetchRendered(
    site: CmsSite,
    io: ProviderIO,
    url: string,
    maxBytes: number,
  ): Promise<CmsRenderedPage> {
    const page = await fetchPageBounded(io, url, {
      host: assertSafeUrl(site.siteUrl).host,
      maxBytes,
      maxHops: WP_RENDERED_MAX_HOPS,
    });
    return {
      status: page.status,
      html: page.html,
      bytes: page.bytes,
      truncated: page.truncated,
      url: page.url,
    };
  }

  /** A site has no documented quota: a 429 (a plugin or CDN) is a throttle before any effect, the rest is the default. */
  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    if (input.status === 429 && input.phase === 'before_send')
      return { kind: 'rate_limited', phase: 'before_send' };
    return classifyByStatus(input);
  }

  /** Term ids by exact name (case-insensitive) over the paged listing; a missing term is created (mutation). */
  async resolveTerms(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    taxonomy: 'categories' | 'tags',
    names: readonly string[],
  ): Promise<number[]> {
    const ids: number[] = [];
    for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
      let id: number | undefined;
      for (let page = 1; page <= WP_TERMS_MAX_PAGES && id === undefined; page++) {
        const u = new URL(api(site, `/${taxonomy}`));
        u.searchParams.set('search', name);
        u.searchParams.set('per_page', String(WP_TERMS_PER_PAGE));
        u.searchParams.set('page', String(page));
        const res = await request(
          io,
          u.toString(),
          { method: 'GET', headers: { ...basic(site, credentials), accept: 'application/json' } },
          false,
        );
        if (res.status !== 200) throw new TermError(taxonomy, res);
        for (const term of arr(res.json)) {
          const termName = str(get(term, 'name'));
          const termId = num(get(term, 'id'));
          if (termId !== undefined && termName?.toLowerCase() === name.toLowerCase()) id = termId;
        }
        const pages = Number(res.headers.get('x-wp-totalpages') ?? '1');
        if (page >= pages) break;
      }
      if (id === undefined) {
        const res = await request(
          io,
          api(site, `/${taxonomy}`),
          {
            method: 'POST',
            headers: {
              ...basic(site, credentials),
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name }),
          },
          true,
        );
        // term_exists: the listing's search missed it (a different spelling); the API names the existing id.
        const existing =
          res.status === 400 && get(res.json, 'code') === 'term_exists'
            ? num(get(res.json, 'data', 'term_id'))
            : undefined;
        id = res.status === 201 ? num(get(res.json, 'id')) : existing;
        if (id === undefined) throw new TermError(taxonomy, res);
      }
      ids.push(id);
    }
    return ids;
  }
}

/** The post field naming the featured attachment (its numeric id as the media endpoint returned it). */
const featuredMediaField = (media: CmsArticleInput['featuredMedia']): Record<string, number> =>
  media && /^\d+$/.test(media.remoteId) ? { featured_media: Number(media.remoteId) } : {};

/** A refused media upload, classified as a write: the upload is the effect, so a failure after it is ambiguous. */
function mediaFailure(res: ProviderResponse, boundary: EffectBoundary): CmsMediaResult {
  const failed = writeFailure(classifyByStatus, res, boundary);
  return failed.outcome === 'done' || failed.outcome === 'conflict'
    ? { outcome: 'unknown', code: `http_${res.status}`, message: summarise(res, 300) }
    : failed;
}

/** A term listing or creation the site refused: carries the response so the write maps it like its own failure. */
class TermError extends Error {
  constructor(
    readonly taxonomy: string,
    readonly res: ProviderResponse,
  ) {
    super(`${taxonomy} could not be resolved (HTTP ${res.status})`);
    this.name = 'TermError';
  }
}

/** Kept here for the adapter's callers; the class lives with the shared fetch (page-fetch.ts). */
export { RenderedPageError };

type Classifier = WordPressCmsAdapter['classifyError'];

function readFailure(classify: Classifier, res: ProviderResponse): CmsReadResult {
  const cls = classify({ status: res.status, body: res.body, phase: 'after_send' });
  const message = summarise(res, 300);
  switch (cls.kind) {
    case 'rejected':
      return { outcome: 'rejected', code: cls.code, message };
    case 'refresh_token':
    case 'reconnect_required':
      return { outcome: 'rejected', code: 'reconnect_required', message };
    case 'rate_limited':
      return {
        outcome: 'retryable_error',
        code: 'rate_limited',
        message,
        retryAfterMs: cls.retryAfterMs ?? retryAfterMs(res.headers.get('retry-after'), 60_000),
      };
    case 'unknown':
      return { outcome: 'retryable_error', code: `http_${res.status}`, message };
  }
}

/** A refused write: an application password is not refreshed, so a 401 is a reconnect like a 403 (spec 14.5). */
function writeFailure(classify: Classifier, res: ProviderResponse, boundary: EffectBoundary): CmsWriteResult {
  const cls = classify({ status: res.status, body: res.body, phase: 'after_send' });
  const message = summarise(res, 300);
  switch (cls.kind) {
    case 'rejected':
      return { outcome: 'rejected', code: cls.code, message };
    case 'refresh_token':
    case 'reconnect_required':
      return { outcome: 'rejected', code: 'reconnect_required', message };
    case 'rate_limited':
      return {
        outcome: 'retryable_error',
        code: 'rate_limited',
        message,
        retryAfterMs: cls.retryAfterMs ?? retryAfterMs(res.headers.get('retry-after'), 60_000),
      };
    case 'unknown':
      return boundary.isCrossed
        ? { outcome: 'unknown', code: `http_${res.status}`, message }
        : { outcome: 'retryable_error', code: `pre_write_http_${res.status}`, message };
  }
}

/** A refused delete converges on a repeat, so what would be ambiguous for a write is retryable here. */
function removeFailure(classify: Classifier, res: ProviderResponse): CmsRemoveResult {
  const f = writeFailure(classify, res, new EffectBoundary()); // boundary not crossed: `unknown` reads retryable
  if (f.outcome === 'rejected' || f.outcome === 'retryable_error') return f;
  return { outcome: 'retryable_error', code: `http_${res.status}`, message: summarise(res, 300) };
}

/** A transport failure or a term refusal: before the article write it is retryable, after it ambiguous (spec 14.3). */
function writeTransportFailure(err: unknown, boundary: EffectBoundary): CmsWriteResult {
  if (err instanceof TermError)
    return boundary.isCrossed
      ? { outcome: 'unknown', code: 'term_failed', message: summarise(err.res, 300) }
      : writeFailure(classifyByStatus, err.res, boundary);
  if (err instanceof ProviderTransportError) {
    const message = truncateForTemporal(err.message, 300);
    if (!boundary.isCrossed || err.phase === 'before_send')
      return { outcome: 'retryable_error', code: `transport_${err.phase}`, message };
    return { outcome: 'unknown', code: 'transport_after_send', message };
  }
  throw err;
}

export const wordpressCmsAdapter = new WordPressCmsAdapter();
