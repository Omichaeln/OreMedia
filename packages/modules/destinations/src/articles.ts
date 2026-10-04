import type { ActivityHooks } from '@oremedia/contracts/agents';
import {
  RENDERED_PAGE_MAX_BYTES,
  RENDERED_PAGE_TIMEOUT_MS,
  RenderedCheckKey,
  articleHtmlChars,
  articleManifest,
  articlePlainText,
  renderArticleHtml,
  sanitizeArticleHtml,
  validateRenderedPage,
  type RenderedValidationV1,
} from '@oremedia/contracts/article';
import {
  CMS_ARTICLES_DATA_TYPE,
  CMS_SCOPE_PUBLISH,
  CmsPublishMode,
  DESTINATION_KIND_CAPABILITIES,
  effectivePublishMode,
  type ArticleReadbackField,
  type ArticleReadbackV1,
  type ArticleReadbackVerificationV1,
} from '@oremedia/contracts/destinations';
import {
  ARTICLE_BODY_MAX_CHARS,
  ARTICLE_IMAGE_MIMES,
  articleImages,
  type ArticleDocumentV1,
  type ArticleImageV1,
} from '@oremedia/contracts/content';
import { CapabilityUnsupportedError, OremediaError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type {
  DecryptedCredentials,
  RemoteMutationOutcome,
  ValidationResult,
} from '@oremedia/contracts/providers';
import type { ChannelVariantForPublishing } from '@oremedia/contracts/publishing';
import type { Tx } from '@oremedia/db';
import {
  type DestinationEditInput,
  type DestinationMutationResult,
  type DestinationPublishInput,
  type DestinationPublishResult,
  type DestinationPublisher,
  type DestinationTargetDescription,
  type DestinationValidateInput,
} from '@oremedia/module-publishing';
import { assetService } from '@oremedia/module-assets';
import { logger } from '@oremedia/observability';
import {
  BlockedAddressError,
  ProviderTransportError,
  RenderedPageError,
  textFingerprint,
  truncateForTemporal,
  type CmsAdapter,
  type CmsArticleInput,
  type CmsMediaRef,
  type CmsReadResult,
  type CmsRemoteArticle,
  type CmsSite,
} from '@oremedia/providers';
import { cmsAdapterFor, cmsIO } from './cms';
import { BrandDestinationRepository, SourceUsePolicyRepository } from './repositories';
import {
  StoredKind,
  cmsWritable,
  enabledCmsAdapter,
  openDestinationCredential,
  sourceUseDecision,
} from './service';

const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();

type DestinationRow = Awaited<ReturnType<BrandDestinationRepository['getById']>>;

/**
 * Ledger R2-3: the publishing module's destination publisher, implemented here where the CMS adapters and the
 * destination's sealed secret live. A publish renders the article (one sanitised HTML, article.ts), writes it as a
 * draft unless the variant asks for a live publish and the grant allows it (D-16), reads it back and validates
 * the rendered page; an edit reads the remote first and refuses on drift (conflict, nothing overwritten); an
 * unpublish sets the article back to a draft. Every outcome is classified as a channel's (spec 14.5); the secret
 * is opened only inside the broker in a process whose KMS may decrypt (worker-core).
 */
const usable = (row: DestinationRow): boolean =>
  row.status === 'active' &&
  row.credentialRefId !== null &&
  row.health !== 'unreachable' &&
  cmsWritable(row.kind);

/** The effective publish mode (contracts/destinations): `publish` only when asked for and granted; else a draft. */
export { effectivePublishMode };

/**
 * RA-08: how long the signed release URL of an article's image must stay readable: the site fetches the bytes as
 * the adapter uploads them, one image at a time, before the article is written.
 */
export const ARTICLE_MEDIA_RELEASE_WINDOW_SEC = 15 * 60;

/** The file name the site keeps for an image: the article's slug, the image's position and the type's extension. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};
const mediaFilename = (slug: string, index: number, mime: string): string =>
  `${slug}-${index + 1}.${EXTENSION_BY_MIME[mime.toLowerCase()] ?? 'bin'}`;

/**
 * RA-08: every image the article carries, released and uploaded before the article is written. Each asset version
 * is released once (a signed URL for the publishing window, minted by the assets module: spec 9.3, never raw
 * bytes), handed to the adapter, and the site's own address for it is what the rendered markup references. The
 * first failure stops the publish with the adapter's classification; nothing was written as an article yet.
 */
async function uploadArticleMedia(
  adapter: CmsAdapter,
  site: CmsSite,
  creds: DecryptedCredentials,
  io: ReturnType<typeof cmsIO>,
  article: ArticleDocumentV1,
): Promise<{ media: Map<string, CmsMediaRef> } | { failed: DestinationPublishResult }> {
  const media = new Map<string, CmsMediaRef>();
  const images: ArticleImageV1[] = [];
  for (const image of articleImages(article))
    if (!images.some((i) => i.assetVersionId === image.assetVersionId)) images.push(image);
  for (const [index, image] of images.entries()) {
    let release: Awaited<ReturnType<typeof assetService.releaseDerivative>>;
    try {
      // BSC-2: an SVG (a vector logo) goes to the site as its PNG rendition; a raster as it is.
      release = await assetService.releaseDerivative(image.assetVersionId, ARTICLE_MEDIA_RELEASE_WINDOW_SEC, {
        raster: true,
      });
    } catch (err) {
      // A version gone since the revision was written (the release check holds this earlier; never a throw here).
      if (!(err instanceof OremediaError)) throw err;
      return {
        failed: {
          outcome: 'rejected',
          code: 'article_image_unavailable',
          message: `the image ${image.assetVersionId} cannot be released: ${err.code}`,
        },
      };
    }
    // Raster images only (contracts ARTICLE_IMAGE_MIMES): an SVG (released above as its PNG) or a video never lands
    // on a website's page; one that could not be drawn is still refused here.
    if (!(ARTICLE_IMAGE_MIMES as readonly string[]).includes(release.mime.toLowerCase()))
      return {
        failed: {
          outcome: 'rejected',
          code: 'article_image_not_raster',
          message: `the image ${image.assetVersionId} is ${release.mime}, not a raster image`,
        },
      };
    const uploaded = await adapter.uploadMedia(site, creds, io, {
      url: release.url,
      mime: release.mime,
      contentHash: release.contentHash,
      alt: image.alt,
      filename: mediaFilename(article.slug, index, release.mime),
    });
    if (uploaded.outcome !== 'done')
      return {
        failed:
          uploaded.outcome === 'unknown'
            ? { outcome: 'retryable_error', code: uploaded.code, message: uploaded.message }
            : uploaded,
      };
    media.set(image.assetVersionId, uploaded.media);
  }
  return { media };
}

const toReadback = (a: CmsRemoteArticle): ArticleReadbackV1 => ({
  remoteId: a.remoteId,
  remoteUrl: a.remoteUrl,
  title: a.title,
  slug: a.slug,
  status: a.status,
  modifiedAt: a.modifiedAt,
  contentHash: a.contentHash,
});

/**
 * RA-04: what the read-back proved. Each field of `sent` that is given is compared with the remote revision read
 * back; `modifiedAt` is compared with the write's own response (RA-12: the remote was touched again since the
 * write when they differ). Nothing is assumed from the write response alone.
 */
export function verifyReadback(
  remote: CmsRemoteArticle,
  sent: Partial<Pick<CmsArticleInput, 'html' | 'title' | 'slug' | 'status'>>,
  written: Pick<CmsRemoteArticle, 'modifiedAt'>,
): ArticleReadbackVerificationV1 {
  const sentHash = textFingerprint(sent.html ?? '');
  const checks: Array<[ArticleReadbackField, boolean | null]> = [
    ['content', sent.html === undefined ? null : textFingerprint(remote.html) === sentHash],
    ['title', sent.title === undefined ? null : remote.title === sent.title],
    ['slug', sent.slug === undefined ? null : remote.slug === sent.slug],
    ['status', sent.status === undefined ? null : remote.status === sent.status],
    ['modifiedAt', written.modifiedAt === null ? null : remote.modifiedAt === written.modifiedAt],
  ];
  const matched = checks.filter(([, ok]) => ok === true).map(([field]) => field);
  const mismatched = checks.filter(([, ok]) => ok === false).map(([field]) => field);
  return {
    outcome: mismatched.length === 0 ? 'verified' : 'mismatch',
    matched,
    mismatched,
    reason: null,
    sentHash,
  };
}

/** Nothing could be compared: the policy allows no read, or the read-back came back other than `found`. */
const unverifiedReadback = (sentHtml: string | undefined, reason: string): ArticleReadbackVerificationV1 => ({
  outcome: 'unverified',
  matched: [],
  mismatched: [],
  reason,
  sentHash: textFingerprint(sentHtml ?? ''),
});

/**
 * The remote revision after a write with what the read-back proved: the read when the policy allows one and it
 * found the article, else the write's own response marked `unverified` with the reason (never silently as proof).
 */
async function readBackAfterWrite(
  adapter: CmsAdapter,
  site: CmsSite,
  creds: DecryptedCredentials,
  io: ReturnType<typeof cmsIO>,
  readAllowed: boolean,
  written: CmsRemoteArticle,
  sent: Partial<Pick<CmsArticleInput, 'html' | 'title' | 'slug' | 'status'>>,
): Promise<{ remote: CmsRemoteArticle; verification: ArticleReadbackVerificationV1 }> {
  if (!readAllowed)
    return { remote: written, verification: unverifiedReadback(sent.html, 'read_not_allowed') };
  const read: CmsReadResult = await adapter.readArticle(site, creds, io, written.remoteId);
  if (read.outcome !== 'found')
    return { remote: written, verification: unverifiedReadback(sent.html, `readback_${read.outcome}`) };
  return { remote: read.article, verification: verifyReadback(read.article, sent, written) };
}

/** The site an adapter addresses, from the destination row and the opened credential (never the row's secret). */
const siteOf = (row: DestinationRow, creds: DecryptedCredentials): CmsSite => ({
  siteUrl: row.externalId,
  username: creds.extra?.['username'] ?? '',
});

/**
 * A page that could not be read at all. PR-04: nothing was proven, so it is `unverified` (a timeout, a transport
 * failure, an address the policy refuses), never a pass; a redirect off the site's host or past the hop limit is the
 * site answering with another page, so it is `failed`.
 */
const failedValidation = (url: string, error: string): RenderedValidationV1 => {
  const outcome = error === 'other_host' || error === 'redirect_limit' ? 'failed' : 'unverified';
  return {
    url,
    fetchedAt: new Date().toISOString(),
    status: null,
    bytes: 0,
    truncated: false,
    ok: false,
    checks: RenderedCheckKey.options
      .filter((key) => key !== 'body_present' && key !== 'last_paragraph_present')
      .map((key) => ({ key, ok: false })),
    error,
    outcome,
    reason: outcome === 'failed' ? error : `page_unavailable_${error}`,
  };
};

/**
 * Fetches the page without credentials (bounded in bytes and time, SSRF-checked per hop) and runs the pure checks:
 * PR-04, the manifest against the article region (the destination's own selector first), the canonical identity and
 * the live visibility from the meta tags and the X-Robots-Tag header. A page that cannot be read is `unverified`.
 */
async function validateWith(
  adapter: CmsAdapter,
  site: CmsSite,
  tenantId: string,
  input: Pick<DestinationValidateInput, 'url' | 'title' | 'slug' | 'manifest' | 'draft'> & {
    regionSelector: string | null;
  },
  hooks?: ActivityHooks,
): Promise<RenderedValidationV1> {
  const io = cmsIO(adapter.key, tenantId, {
    timeoutMs: RENDERED_PAGE_TIMEOUT_MS,
    ...(hooks ? { hooks } : {}),
  });
  try {
    const page = await adapter.fetchRendered(site, io, input.url, RENDERED_PAGE_MAX_BYTES);
    const result = validateRenderedPage({
      status: page.status,
      html: page.html,
      title: input.title,
      slug: input.slug,
      remoteUrl: input.url,
      manifest: input.manifest,
      draft: input.draft,
      regionSelector: input.regionSelector,
      headers: page.headers,
      truncated: page.truncated,
    });
    return {
      url: page.url,
      fetchedAt: new Date().toISOString(),
      status: page.status,
      bytes: page.bytes,
      truncated: page.truncated,
      ok: result.outcome === 'verified',
      checks: result.checks,
      error: null,
      outcome: result.outcome,
      reason: result.reason,
      content: result.content,
      indexability: result.indexability,
    };
  } catch (err) {
    if (err instanceof RenderedPageError) return failedValidation(input.url, err.code);
    if (err instanceof BlockedAddressError) return failedValidation(input.url, 'blocked_address');
    if (err instanceof ProviderTransportError) return failedValidation(input.url, `transport_${err.phase}`);
    throw err;
  }
}

/** Opens the destination's secret for one adapter call; a destroyed credential reads as a reconnect. */
async function withSite<T>(
  tenantId: string,
  row: DestinationRow,
  fn: (adapter: CmsAdapter, site: CmsSite, creds: DecryptedCredentials) => Promise<T>,
  onReconnect: () => T,
): Promise<T> {
  if (!row.credentialRefId) return onReconnect();
  const adapter = enabledCmsAdapter(StoredKind.parse(row.kind));
  try {
    return await openDestinationCredential(
      tenantId,
      { ...row, credentialRefId: row.credentialRefId },
      (creds) => fn(adapter, siteOf(row, creds), creds),
    );
  } catch (err) {
    if (err instanceof PolicyDeniedError && err.reason === 'credential_destroyed') return onReconnect();
    throw err;
  }
}

/**
 * An edit's `text` override (publications.editRemote → validateVariantDetailed) is the HTML the site receives; the
 * variant's own text is the article's plain text and needs no check here. The override must still sanitise to a
 * body and stay under the article limit measured as the article is (RA-03: the characters the body carries once
 * rendered, never the HTML's own length), or an edit would land an empty or oversized article.
 */
export const articleTextIssues = (
  variant: Pick<ChannelVariantForPublishing, 'text' | 'article'>,
): ValidationResult['issues'] => {
  if (!variant.article || variant.text === articlePlainText(variant.article)) return [];
  const html = sanitizeArticleHtml(variant.text);
  if (html.trim() === '') return [{ path: 'text', issue: 'body_empty' }];
  const chars = articleHtmlChars(html);
  if (chars > ARTICLE_BODY_MAX_CHARS)
    return [{ path: 'text', issue: `body_too_long:${chars}>${ARTICLE_BODY_MAX_CHARS}` }];
  return [];
};

export const destinationArticles: DestinationPublisher = {
  async describe(destinationId: string, tx?: Tx): Promise<DestinationTargetDescription | null> {
    const row = await destinationsRepo.findById(destinationId, tx);
    if (!row) return null;
    const capability = cmsAdapterCapability(row.kind);
    return {
      id: row.id,
      brandId: row.brandId,
      kind: row.kind,
      displayName: row.displayName,
      capabilityVersion: row.capabilityVersion,
      usable: usable(row),
      actions: {
        edit: capability?.edit ?? false,
        delete: capability?.delete ?? false,
        unpublish: capability?.unpublish ?? false,
      },
    };
  },

  /** Spec 13.4 for a destination variant: the article is present and the publish mode is one the grant allows. */
  async validateVariant(variant: ChannelVariantForPublishing, tx?: Tx): Promise<ValidationResult> {
    const row = await destinationsRepo.getById(variant.destinationId ?? '', tx); // foreign → NOT_FOUND
    if (!cmsWritable(row.kind))
      throw new CapabilityUnsupportedError([
        { path: 'destinationId', issue: `destination_not_writable:${row.kind}` },
      ]);
    const issues: ValidationResult['issues'] = [];
    if (!variant.article) issues.push({ path: 'article', issue: 'article_missing' });
    const mode = variant.settings['publishMode'];
    if (mode !== undefined && !CmsPublishMode.safeParse(mode).success)
      issues.push({ path: 'settings.publishMode', issue: 'publish_mode_invalid' });
    if (mode === 'publish' && !row.grantedScopes.includes(CMS_SCOPE_PUBLISH))
      issues.push({ path: 'settings.publishMode', issue: 'publish_not_granted' });
    issues.push(...articleTextIssues(variant));
    if (!usable(row)) issues.push({ path: 'destinationId', issue: 'destination_unavailable' });
    return { ok: issues.length === 0, issues };
  },

  /** D-17 default deny: the brand's policy for the kind's article data type, read for the use now. */
  async useAllowed(brandId: string, kind: string, use: 'read' | 'write', tx?: Tx): Promise<boolean> {
    const parsed = StoredKind.safeParse(kind);
    if (!parsed.success || !DESTINATION_KIND_CAPABILITIES[parsed.data].uses.includes(use)) return false;
    const policy = await policiesRepo.findByKey(brandId, parsed.data, CMS_ARTICLES_DATA_TYPE, tx);
    return sourceUseDecision(policy, use, new Date()).allowed;
  },

  async publish(
    input: DestinationPublishInput,
    hooks?: ActivityHooks,
    beforeSend?: () => Promise<void>,
  ): Promise<DestinationPublishResult> {
    const row = await destinationsRepo.getById(input.destinationId);
    if (!usable(row))
      return {
        outcome: 'rejected',
        code: 'destination_not_usable',
        message: 'the destination cannot be written to',
      };
    if (!(await destinationArticles.useAllowed(row.brandId, row.kind, 'write')))
      return {
        outcome: 'rejected',
        code: 'source_use_denied',
        message: 'the source-use policy does not allow a write',
      };
    const article = input.variant.article;
    if (!article)
      return { outcome: 'rejected', code: 'article_missing', message: 'the revision carries no article' };
    const status = effectivePublishMode(input.variant.settings, row.grantedScopes);
    const readAllowed = await destinationArticles.useAllowed(row.brandId, row.kind, 'read');
    return withSite(
      input.tenantId,
      row,
      async (adapter, site, creds) => {
        const io = cmsIO(adapter.key, input.tenantId, {
          ...(hooks ? { hooks } : {}),
          ...(beforeSend ? { beforeSend } : {}),
        });
        // RA-08: the images go up first (released through the assets module, uploaded by the adapter); the body
        // then references the site's copies, and the featured image is the site's media item for it.
        const uploaded = await uploadArticleMedia(adapter, site, creds, io, article);
        if ('failed' in uploaded) return uploaded.failed;
        const featured = article.featuredImage
          ? uploaded.media.get(article.featuredImage.assetVersionId)
          : undefined;
        const sent: CmsArticleInput = {
          title: article.title,
          slug: article.slug,
          excerpt: article.excerpt,
          html: renderArticleHtml(article, {
            imageUrl: (image) => uploaded.media.get(image.assetVersionId)?.url ?? null,
          }),
          categories: article.categories,
          tags: article.tags,
          status,
          ...(featured ? { featuredMedia: featured } : {}),
        };
        const written = await adapter.createArticle(site, creds, io, sent, input.idempotencyKey);
        if (written.outcome === 'conflict')
          return {
            outcome: 'rejected',
            code: 'conflict',
            message: 'the site refused the new article as a conflict',
          };
        if (written.outcome !== 'done') return written;
        // Read-back (D-16, RA-04): the remote revision as evidence, compared with what was sent; when the policy
        // allows no read (or the read-back is missing) the write's response is recorded as unverified, never as proof.
        const { remote, verification } = await readBackAfterWrite(
          adapter,
          site,
          creds,
          io,
          readAllowed,
          written.article,
          sent,
        );
        const readback = toReadback(remote);
        const validation = await validateWith(
          adapter,
          site,
          input.tenantId,
          {
            url: remote.remoteUrl,
            title: article.title,
            slug: article.slug,
            // PR-04: the page must carry every block of what was sent (the approved revision's rendering).
            manifest: articleManifest(sent.html),
            draft: remote.status !== 'publish',
            regionSelector: row.articleSelector,
          },
          hooks,
        );
        return {
          outcome: 'accepted',
          remotePostId: remote.remoteId,
          remoteUrl: remote.remoteUrl,
          readback,
          readbackVerification: verification,
          validation,
        };
      },
      () => ({
        outcome: 'rejected',
        code: 'reconnect_required',
        message: 'the destination credential was revoked',
      }),
    );
  },

  async edit(input: DestinationEditInput, hooks?: ActivityHooks): Promise<DestinationMutationResult> {
    const row = await destinationsRepo.getById(input.destinationId);
    if (!usable(row))
      return {
        outcome: 'rejected',
        code: 'destination_not_usable',
        message: 'the destination cannot be written to',
      };
    if (!(await destinationArticles.useAllowed(row.brandId, row.kind, 'write')))
      return {
        outcome: 'rejected',
        code: 'source_use_denied',
        message: 'the source-use policy does not allow a write',
      };
    // D-16: never an overwrite. Without a read-back hash there is nothing to compare the remote against.
    if (input.expectedHash === null)
      return {
        outcome: 'rejected',
        code: 'no_readback',
        message: 'the article was never read back from the site; reconcile it before editing',
      };
    const expectedHash = input.expectedHash;
    const readAllowed = await destinationArticles.useAllowed(row.brandId, row.kind, 'read');
    return withSite(
      input.tenantId,
      row,
      async (adapter, site, creds) => {
        const io = cmsIO(adapter.key, input.tenantId, hooks ? { hooks } : {});
        const sent = { html: sanitizeArticleHtml(input.html) };
        // RA-12: both halves of the read-back are the precondition; the adapter reads, compares and only then writes.
        const result = await adapter.updateArticle(site, creds, io, input.remoteId, sent, {
          expectedHash,
          ...(input.expectedModifiedAt !== null ? { expectedModifiedAt: input.expectedModifiedAt } : {}),
        });
        switch (result.outcome) {
          case 'done': {
            const { remote, verification } = await readBackAfterWrite(
              adapter,
              site,
              creds,
              io,
              readAllowed,
              result.article,
              sent,
            );
            return {
              outcome: 'done',
              readback: toReadback(remote),
              readbackVerification: verification,
              // The site changed between the adapter's read and its write: what was read and what was lost.
              ...(result.overwritten && result.previous
                ? {
                    overwritten: {
                      previous: toReadback(result.previous),
                      replaced: toReadback(result.overwritten),
                    },
                  }
                : {}),
            };
          }
          case 'conflict':
            logger()
              .child('destinations')
              .warn(
                { destinationId: row.id, reason: 'remote_changed_since_readback' },
                'article edit refused: the remote moved',
              );
            // The current remote travels with the refusal, so the stored read-back is refreshed (RA-12).
            return {
              outcome: 'rejected',
              code: 'conflict',
              message: `the article changed on the site since it was last read back (now ${result.current.modifiedAt ?? 'unknown'})`,
              readback: toReadback(result.current),
            };
          case 'unknown':
            return { outcome: 'retryable_error', code: result.code, message: result.message };
          default:
            return result;
        }
      },
      () => ({
        outcome: 'rejected',
        code: 'reconnect_required',
        message: 'the destination credential was revoked',
      }),
    );
  },

  async unpublish(input, hooks?: ActivityHooks): Promise<DestinationMutationResult> {
    const row = await destinationsRepo.getById(input.destinationId);
    if (!usable(row))
      return {
        outcome: 'rejected',
        code: 'destination_not_usable',
        message: 'the destination cannot be written to',
      };
    if (!(await destinationArticles.useAllowed(row.brandId, row.kind, 'write')))
      return {
        outcome: 'rejected',
        code: 'source_use_denied',
        message: 'the source-use policy does not allow a write',
      };
    const readAllowed = await destinationArticles.useAllowed(row.brandId, row.kind, 'read');
    return withSite(
      input.tenantId,
      row,
      async (adapter, site, creds) => {
        const io = cmsIO(adapter.key, input.tenantId, hooks ? { hooks } : {});
        const result = await adapter.unpublishArticle(site, creds, io, input.remoteId);
        if (result.outcome !== 'done') return result;
        if (!result.article) return { outcome: 'done' };
        // RA-02: the revert is proven by reading the article back as a draft, never by the write's own answer.
        const { remote, verification } = await readBackAfterWrite(
          adapter,
          site,
          creds,
          io,
          readAllowed,
          result.article,
          { status: 'draft' },
        );
        return { outcome: 'done', readback: toReadback(remote), readbackVerification: verification };
      },
      () => ({
        outcome: 'rejected',
        code: 'reconnect_required',
        message: 'the destination credential was revoked',
      }),
    );
  },

  async delete(input, hooks?: ActivityHooks): Promise<RemoteMutationOutcome> {
    const row = await destinationsRepo.getById(input.destinationId);
    if (!usable(row))
      return {
        outcome: 'rejected',
        code: 'destination_not_usable',
        message: 'the destination cannot be written to',
      };
    if (!(await destinationArticles.useAllowed(row.brandId, row.kind, 'write')))
      return {
        outcome: 'rejected',
        code: 'source_use_denied',
        message: 'the source-use policy does not allow a write',
      };
    return withSite(
      input.tenantId,
      row,
      async (adapter, site, creds) => {
        const result = await adapter.deleteArticle(
          site,
          creds,
          cmsIO(adapter.key, input.tenantId, hooks ? { hooks } : {}),
          input.remoteId,
        );
        return result.outcome === 'done' ? { outcome: 'done' } : result;
      },
      () => ({
        outcome: 'rejected',
        code: 'reconnect_required',
        message: 'the destination credential was revoked',
      }),
    );
  },

  /** No credential: the page as the public sees it, on the site's own host, bounded (any process may run it). */
  async validateRendered(
    input: DestinationValidateInput,
    hooks?: ActivityHooks,
  ): Promise<RenderedValidationV1> {
    const row = await destinationsRepo.getById(input.destinationId);
    const adapter = cmsAdapterFor(row.kind);
    try {
      return await validateWith(
        adapter,
        { siteUrl: row.externalId, username: '' },
        input.tenantId,
        { ...input, regionSelector: row.articleSelector },
        hooks,
      );
    } catch (err) {
      return failedValidation(input.url, truncateForTemporal((err as Error)?.name ?? 'error', 80));
    }
  },
};

/** The kind's CMS capability when registered (certified or not), for the actions a screen may offer. */
function cmsAdapterCapability(kind: string) {
  try {
    return cmsAdapterFor(kind).capability;
  } catch (err) {
    if (err instanceof CapabilityUnsupportedError) return undefined;
    throw err;
  }
}
