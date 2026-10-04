import type { DecryptedCredentials, ProviderErrorClass, RevokeResult } from '@oremedia/contracts/providers';
import { classifyByStatus, retryAfterMs, truncateForTemporal } from '../../base';
import {
  CMS_MEDIA_MAX_BYTES,
  type CmsAdapter,
  type CmsArticleInput,
  type CmsMediaInput,
  type CmsMediaResult,
  type CmsReadResult,
  type CmsRemoteArticle,
  type CmsRemoveResult,
  type CmsRenderedPage,
  type CmsSite,
  type CmsUpdatePrecondition,
  type CmsVerifyResult,
  type CmsWriteResult,
  type CmsWriteSafety,
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
  revokeFromError,
  revokeFromResponse,
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
/**
 * PR-03: the Oremedia conditional-write plugin (infra/wordpress/oremedia-conditional-write) under the site's REST
 * root: its handshake, its conditional update, the protocol this adapter speaks and the token scheme it stores.
 */
export const WP_EXTENSION_ROOT = '/wp-json/oremedia/v1';
export const WP_EXTENSION_PLUGIN = 'oremedia-conditional-write';
export const WP_EXTENSION_PROTOCOL = 1;
const WRITE_TOKEN_PREFIX = 'wpcw1';

/** HTTP Basic with the application password (WordPress strips the spaces it shows; sent as given either way). */
const basic = (site: CmsSite, credentials: DecryptedCredentials): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${site.username}:${credentials.accessToken}`, 'utf8').toString('base64')}`,
});
const siteOrigin = (site: CmsSite): string => assertSafeUrl(site.siteUrl).origin;
const api = (site: CmsSite, path: string): string => `${siteOrigin(site)}${WP_REST_ROOT}${path}`;
const extension = (site: CmsSite, path: string): string => `${siteOrigin(site)}${WP_EXTENSION_ROOT}${path}`;

/**
 * PR-03: the plugin's precondition as stored with a read-back (`wpcw1:<version>:<fingerprint>`): the post's write
 * counter and the SHA-256 fingerprint of its row. Opaque to everything but this adapter.
 */
export const wpWriteToken = (version: number, fingerprint: string): string =>
  `${WRITE_TOKEN_PREFIX}:${version}:${fingerprint}`;
const parseWriteToken = (token: string): { version: number; fingerprint: string } | null => {
  const m = /^wpcw1:(\d{1,15}):([0-9a-f]{64})$/.exec(token);
  return m ? { version: Number(m[1]), fingerprint: m[2] as string } : null;
};
/** The `oremedia_write` field a post carries (context=edit) where the plugin is active; null elsewhere. */
const writeTokenOf = (json: unknown): string | null => {
  const version = num(get(json, 'version'));
  const fingerprint = str(get(json, 'fingerprint'));
  return version !== undefined && fingerprint && /^[0-9a-f]{64}$/.test(fingerprint)
    ? wpWriteToken(version, fingerprint)
    : null;
};

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

/**
 * The post object as the API returns it with `context=edit` (raw title and content); never the rendered HTML only.
 * With the site's origin, the article names its edit screen (`/wp-admin/post.php?post=<id>&action=edit`).
 */
function toArticle(json: unknown, origin?: string): CmsRemoteArticle | null {
  const id = num(get(json, 'id'));
  if (id === undefined) return null;
  const html = str(get(json, 'content', 'raw')) ?? str(get(json, 'content', 'rendered')) ?? '';
  const title = str(get(json, 'title', 'raw')) ?? str(get(json, 'title', 'rendered')) ?? '';
  const slug = str(get(json, 'slug')) ?? '';
  const status = str(get(json, 'status')) ?? 'unknown';
  const writeToken = writeTokenOf(get(json, 'oremedia_write'));
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
    ...(writeToken ? { writeToken } : {}),
    ...(origin ? { editUrl: `${origin}/wp-admin/post.php?post=${id}&action=edit` } : {}),
  };
}

/**
 * WordPress REST (ledger R2-3, D-16 working assumption): posts under `/wp-json/wp/v2/posts` with an application
 * password over HTTP Basic. Writes land as drafts unless asked to publish. PR-03: core WordPress applies
 * `POST /wp/v2/posts/<id>` unconditionally (no ETag, no If-Match), so an update of an existing post goes through the
 * Oremedia conditional-write plugin, compared and written atomically on the site against the precondition stored
 * with the read-back; a site without the plugin is in limited mode and no update that replaces content is sent.
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

  /**
   * RA-01: revokes the application password the connection authenticates with. WordPress names the password in use
   * at `GET /users/me/application-passwords/introspect` (its uuid) and deletes it at
   * `DELETE /users/me/application-passwords/<uuid>` (`{"deleted": true}`); a password the site no longer accepts
   * (401 / 403 on introspect) is already revoked.
   */
  async revokeAccess(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RevokeResult> {
    try {
      const headers = { ...basic(site, credentials), accept: 'application/json' };
      const current = await request(
        io,
        api(site, '/users/me/application-passwords/introspect'),
        { method: 'GET', headers },
        false,
      );
      if (current.status === 401 || current.status === 403) return { outcome: 'revoked' };
      const uuid = str(get(current.json, 'uuid'));
      if (current.status !== 200 || !uuid) return revokeFromResponse(current, () => false);
      const deleted = await request(
        io,
        api(site, `/users/me/application-passwords/${encodeURIComponent(uuid)}`),
        { method: 'DELETE', headers },
        true,
      );
      return revokeFromResponse(deleted, (r) => r.status === 200 && get(r.json, 'deleted') === true);
    } catch (err) {
      return revokeFromError(err);
    }
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
    const article = toArticle(res.json, siteOrigin(site));
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
      // The release is read bounded and must be an image: the site never receives what the release did not describe.
      const bytes = await fetchBytes(io, media.url, { maxBytes: CMS_MEDIA_MAX_BYTES, expectType: 'image/' });
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
        return err.reason === 'status'
          ? { outcome: 'retryable_error', code: 'media_fetch_failed', message: err.message }
          : { outcome: 'rejected', code: `media_${err.reason}`, message: err.message };
      const failed = writeTransportFailure(err, boundary);
      return failed.outcome === 'done' || failed.outcome === 'conflict' || failed.outcome === 'limited'
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
      const article = toArticle(res.json, siteOrigin(site));
      if (!article) return { outcome: 'unknown', code: 'malformed_response', message: summarise(res, 300) };
      return { outcome: 'done', article };
    } catch (err) {
      return writeTransportFailure(err, boundary);
    }
  }

  /**
   * PR-03: the handshake with the conditional-write plugin (`GET /wp-json/oremedia/v1/capabilities`). `conditional`
   * only when the plugin answers with this adapter's protocol and reports conditional updates available (InnoDB
   * storage); absent (404), refused or not transactional is `limited`; a transport failure or a 5xx is `unknown`
   * (nothing is decided on it, and no write is sent unconditionally because of it).
   */
  async writeSafety(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<CmsWriteSafety> {
    let res: ProviderResponse;
    try {
      res = await request(
        io,
        extension(site, '/capabilities'),
        { method: 'GET', headers: { ...basic(site, credentials), accept: 'application/json' } },
        false,
      );
    } catch (err) {
      if (err instanceof ProviderTransportError) return { mode: 'unknown', reason: `transport_${err.phase}` };
      throw err;
    }
    if (res.status >= 500 || res.status === 429) return { mode: 'unknown', reason: `http_${res.status}` };
    if (res.status === 404) return { mode: 'limited', reason: 'extension_absent' };
    if (res.status !== 200) return { mode: 'limited', reason: `extension_http_${res.status}` };
    if (str(get(res.json, 'plugin')) !== WP_EXTENSION_PLUGIN)
      return { mode: 'limited', reason: 'extension_unrecognised' };
    if (num(get(res.json, 'protocol')) !== WP_EXTENSION_PROTOCOL)
      return { mode: 'limited', reason: 'extension_protocol_unsupported' };
    if (get(res.json, 'features', 'conditional_update') !== true)
      return { mode: 'limited', reason: 'extension_not_transactional' };
    return {
      mode: 'conditional',
      mechanism: WP_EXTENSION_PLUGIN,
      version: str(get(res.json, 'version')) ?? null,
    };
  }

  /**
   * PR-03: an update is sent only as the plugin's conditional write: the site compares the precondition (the write
   * token stored with the caller's read-back) with the post's write counter and row fingerprint under a row lock and
   * applies the write in the same transaction, or answers 412 with the current post and writes nothing. A read-back
   * stored before PR-03 carries no token: its hash and modified instant are compared with a fresh read, whose own
   * token then carries the write (a change after that read is still refused by the site). Without the plugin
   * (limited mode) an update that would replace content is refused here and nothing is sent; a status-only update
   * (the revert to a draft) replaces no content and is still written under the compared read.
   */
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
      const safety = await this.writeSafety(site, credentials, io);
      if (safety.mode === 'unknown')
        return {
          outcome: 'retryable_error',
          code: 'write_safety_unknown',
          message: `the site's conditional-write support could not be read (${safety.reason})`,
        };
      const statusOnly = Object.keys(input).every((k) => k === 'status') && input.status !== undefined;
      let previous: CmsRemoteArticle | undefined;
      let token = precondition.expectedWriteToken;
      if (safety.mode === 'limited' || token === undefined) {
        const current = await this.readArticle(site, credentials, io, remoteId);
        if (current.outcome === 'absent')
          return {
            outcome: 'rejected',
            code: 'remote_absent',
            message: 'the article no longer exists on the site',
          };
        if (current.outcome !== 'found') return current;
        if (safety.mode === 'limited' && !statusOnly)
          return { outcome: 'limited', reason: safety.reason, current: current.article };
        // A legacy precondition (no token stored): the read-back must still describe the remote.
        if (
          (precondition.expectedHash !== undefined &&
            precondition.expectedHash !== current.article.contentHash) ||
          (precondition.expectedModifiedAt !== undefined &&
            precondition.expectedModifiedAt !== current.article.modifiedAt)
        )
          return { outcome: 'conflict', current: current.article };
        previous = current.article;
        token = current.article.writeToken ?? undefined;
      }
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
      if (safety.mode === 'limited') {
        // Status only (checked above): core's update replaces no content when only the status is sent.
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
        const article = toArticle(res.json, siteOrigin(site));
        if (!article) return { outcome: 'unknown', code: 'malformed_response', message: summarise(res, 300) };
        return { outcome: 'done', article, ...(previous ? { previous } : {}) };
      }
      const expected = token === undefined ? null : parseWriteToken(token);
      if (!expected)
        return {
          outcome: 'rejected',
          code: 'write_token_missing',
          message: 'the site reports conditional writes but the article carries no valid write precondition',
        };
      boundary.cross();
      const res = await request(
        io,
        extension(site, `/posts/${encodeURIComponent(remoteId)}`),
        {
          method: 'POST',
          headers: {
            ...basic(site, credentials),
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expected_version: expected.version,
            expected_fingerprint: expected.fingerprint,
            post: body,
          }),
        },
        true,
      );
      if (res.status === 412) {
        const current = toArticle(get(res.json, 'data', 'current', 'post'), siteOrigin(site));
        if (!current) return { outcome: 'unknown', code: 'malformed_response', message: summarise(res, 300) };
        // The 412 names the precondition the site holds now (its counter and fingerprint at the refusal).
        const now = writeTokenOf(get(res.json, 'data', 'current'));
        return { outcome: 'conflict', current: now ? { ...current, writeToken: now } : current };
      }
      if (res.status === 404 && get(res.json, 'code') === 'rest_post_invalid_id')
        return {
          outcome: 'rejected',
          code: 'remote_absent',
          message: 'the article no longer exists on the site',
        };
      if (res.status !== 200) return writeFailure(this.classifyError.bind(this), res, boundary);
      const written = toArticle(get(res.json, 'post'), siteOrigin(site));
      if (!written) return { outcome: 'unknown', code: 'malformed_response', message: summarise(res, 300) };
      // The precondition after the write is the one the response names (the counter the commit left).
      const after = writeTokenOf(res.json);
      return {
        outcome: 'done',
        article: after ? { ...written, writeToken: after } : written,
        ...(previous ? { previous } : {}),
      };
    } catch (err) {
      return writeTransportFailure(err, boundary);
    }
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
    // RA-12, PR-03: the revert matches what it just read (atomically on the site where the plugin is active), never
    // a remote that moved in between; it sends the status alone, so no content is replaced either way.
    const written = await this.updateArticle(
      site,
      credentials,
      io,
      remoteId,
      { status: 'draft' },
      current.article.writeToken
        ? { expectedWriteToken: current.article.writeToken }
        : { expectedHash: current.article.contentHash, expectedModifiedAt: current.article.modifiedAt },
    );
    if (written.outcome === 'done') return written;
    if (written.outcome === 'conflict')
      return {
        outcome: 'retryable_error',
        code: 'conflict',
        message: 'the article changed while it was being reverted',
      };
    if (written.outcome === 'limited')
      return { outcome: 'rejected', code: 'limited_mode', message: written.reason };
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
    return { outcome: 'done', article: toArticle(res.json, siteOrigin(site)) };
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
      headers: { xRobotsTag: page.xRobotsTag, link: page.link },
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
  return failed.outcome === 'done' || failed.outcome === 'conflict' || failed.outcome === 'limited'
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
