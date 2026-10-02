import type { DecryptedCredentials, ProviderErrorClass } from '@oremedia/contracts/providers';
import {
  classifyByStatus,
  textFingerprint,
  type CmsAdapter,
  type CmsArticleInput,
  type CmsCapabilityV1,
  type CmsReadResult,
  type CmsRemoteArticle,
  type CmsRemoveResult,
  type CmsRenderedPage,
  type CmsSite,
  type CmsUpdatePrecondition,
  type CmsVerifyResult,
  type CmsWriteResult,
  type ProviderIO,
} from '@oremedia/providers';

/**
 * Test fixture only (never registered in production): an in-memory website whose articles live in a map, so what
 * the connect-with-secret, the verification and the article publisher do with a sealed secret is the subject,
 * not the platform. `certifiedAt` is set so the registry's certification gate lets tests through. It makes no
 * network call: the rendered page is what the fixture says the site shows.
 */
export const fixtureCmsCapability = (over: Partial<CmsCapabilityV1> = {}): CmsCapabilityV1 => ({
  key: 'cms_site',
  version: 1,
  vendor: 'Fixture',
  credential: { label: 'Application password', hint: 'fixture' },
  rateLimits: [],
  edit: true,
  delete: true,
  unpublish: true,
  certifiedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export type VerifyBehaviour =
  { kind: 'ok'; canPublish: boolean } | { kind: 'unauthorised' } | { kind: 'transient' };

/** The fixture's revision hash, as the WordPress adapter's (RA-12): identity and state beside the content. */
export const fixtureArticleHash = (a: Pick<CmsRemoteArticle, 'title' | 'slug' | 'status' | 'html'>): string =>
  textFingerprint(JSON.stringify({ title: a.title, slug: a.slug, status: a.status, content: a.html }));

export class FixtureCmsAdapter implements CmsAdapter {
  readonly key = 'cms_site' as const;
  readonly capability: CmsCapabilityV1;
  /** The remote articles by id, as the site holds them. */
  readonly articles = new Map<string, CmsRemoteArticle>();
  /** Every call with the secret it was handed (a test proves the sealed secret was opened in the worker). */
  readonly calls: Array<{ op: string; secret: string; username: string; siteUrl: string }> = [];
  verifyBehaviour: VerifyBehaviour = { kind: 'ok', canPublish: true };
  /** What the next write does: succeed, or fail as the platform would. */
  writeBehaviour: 'ok' | 'forbidden' | 'outage' = 'ok';
  /** The rendered page the site serves for an article's URL (status and HTML); absent: a 404. */
  readonly pages = new Map<string, { status: number; html: string }>();
  /**
   * RA-12 test hook: a change someone makes on the site between an update's pre-write read and its write (the
   * window no compare-and-swap closes). Applied once, then cleared; the write then replaces it and reports it as
   * `overwritten`, as the WordPress adapter reads it from the revisions.
   */
  editInWindow: ((current: CmsRemoteArticle) => Partial<CmsRemoteArticle>) | null = null;
  private nextId = 100;

  constructor(capability?: CmsCapabilityV1) {
    this.capability = capability ?? fixtureCmsCapability();
  }

  private record(op: string, site: CmsSite, creds: DecryptedCredentials): void {
    this.calls.push({ op, secret: creds.accessToken, username: site.username, siteUrl: site.siteUrl });
  }

  async verify(site: CmsSite, credentials: DecryptedCredentials, _io: ProviderIO): Promise<CmsVerifyResult> {
    this.record('verify', site, credentials);
    switch (this.verifyBehaviour.kind) {
      case 'unauthorised':
        return { ok: false, reason: 'reconnect_required', detail: 'HTTP 401' };
      case 'transient':
        return { ok: false, reason: 'transient', detail: 'HTTP 503' };
      case 'ok':
        return { ok: true, displayName: 'Fixture Editor', canPublish: this.verifyBehaviour.canPublish };
    }
  }

  async readArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    _io: ProviderIO,
    remoteId: string,
  ): Promise<CmsReadResult> {
    this.record('read', site, credentials);
    const article = this.articles.get(remoteId);
    return article ? { outcome: 'found', article: { ...article } } : { outcome: 'absent' };
  }

  async createArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    _io: ProviderIO,
    input: CmsArticleInput,
  ): Promise<CmsWriteResult> {
    this.record('create', site, credentials);
    if (this.writeBehaviour === 'forbidden')
      return { outcome: 'rejected', code: 'reconnect_required', message: 'HTTP 403' };
    if (this.writeBehaviour === 'outage')
      return { outcome: 'unknown', code: 'http_502', message: 'HTTP 502' };
    const remoteId = String(this.nextId++);
    const fields = { title: input.title, slug: input.slug, status: input.status, html: input.html };
    const article: CmsRemoteArticle = {
      remoteId,
      remoteUrl: `${site.siteUrl}/${input.status === 'publish' ? input.slug : `?p=${remoteId}`}`,
      ...fields,
      modifiedAt: new Date().toISOString(),
      contentHash: fixtureArticleHash(fields),
    };
    this.articles.set(remoteId, article);
    return { outcome: 'done', article: { ...article } };
  }

  async updateArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    _io: ProviderIO,
    remoteId: string,
    input: Partial<CmsArticleInput>,
    precondition: CmsUpdatePrecondition,
  ): Promise<CmsWriteResult> {
    this.record('update', site, credentials);
    const previous = this.articles.get(remoteId);
    if (!previous) return { outcome: 'rejected', code: 'remote_absent', message: 'gone' };
    if (
      (precondition.expectedHash !== undefined && precondition.expectedHash !== previous.contentHash) ||
      (precondition.expectedModifiedAt !== undefined &&
        precondition.expectedModifiedAt !== previous.modifiedAt)
    )
      return { outcome: 'conflict', current: { ...previous } };
    // The window between the read and the write: a site edit lands here and the write replaces it (RA-12).
    let replaced: CmsRemoteArticle | null = null;
    if (this.editInWindow) {
      const edited = { ...previous, ...this.editInWindow(previous) };
      replaced = {
        ...edited,
        contentHash: fixtureArticleHash(edited),
        modifiedAt: new Date(Date.now() + 500).toISOString(),
      };
      this.articles.set(remoteId, replaced);
      this.editInWindow = null;
    }
    const current = replaced ?? previous;
    const fields = {
      title: input.title ?? current.title,
      slug: input.slug ?? current.slug,
      status: input.status ?? current.status,
      html: input.html ?? current.html,
    };
    const next: CmsRemoteArticle = {
      ...current,
      ...fields,
      contentHash: fixtureArticleHash(fields),
      modifiedAt: new Date(Date.now() + 1000).toISOString(),
    };
    this.articles.set(remoteId, next);
    return {
      outcome: 'done',
      article: { ...next },
      previous: { ...previous },
      ...(replaced ? { overwritten: { ...replaced } } : {}),
    };
  }

  async unpublishArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsRemoveResult> {
    this.record('unpublish', site, credentials);
    const current = this.articles.get(remoteId);
    if (!current) return { outcome: 'already_absent' };
    const written = await this.updateArticle(
      site,
      credentials,
      io,
      remoteId,
      { status: 'draft' },
      { expectedHash: current.contentHash, expectedModifiedAt: current.modifiedAt },
    );
    return written.outcome === 'done'
      ? written
      : { outcome: 'retryable_error', code: 'fixture', message: 'fixture' };
  }

  async deleteArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    _io: ProviderIO,
    remoteId: string,
  ): Promise<CmsRemoveResult> {
    this.record('delete', site, credentials);
    const current = this.articles.get(remoteId);
    if (!current) return { outcome: 'already_absent' };
    this.articles.delete(remoteId);
    return { outcome: 'done', article: { ...current } };
  }

  async fetchRendered(
    _site: CmsSite,
    _io: ProviderIO,
    url: string,
    maxBytes: number,
  ): Promise<CmsRenderedPage> {
    const page = this.pages.get(url) ?? { status: 404, html: '<html><title>Not found</title></html>' };
    const html = page.html.slice(0, maxBytes);
    return { status: page.status, html, bytes: html.length, truncated: html.length < page.html.length, url };
  }

  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    return classifyByStatus(input);
  }
}
