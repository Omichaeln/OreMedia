import type { ActivityHooks } from '@oremedia/contracts/agents';
import {
  RENDERED_PAGE_MAX_BYTES,
  RENDERED_PAGE_TIMEOUT_MS,
  RenderedCheckKey,
  articleFirstParagraph,
  renderArticleHtml,
  renderedValidationOk,
  sanitizeArticleHtml,
  validateRenderedPage,
  type RenderedValidationV1,
} from '@oremedia/contracts/article';
import {
  CMS_ARTICLES_DATA_TYPE,
  CMS_SCOPE_PUBLISH,
  CmsPublishMode,
  DESTINATION_KIND_CAPABILITIES,
  type ArticleReadbackV1,
} from '@oremedia/contracts/destinations';
import { CapabilityUnsupportedError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type {
  DecryptedCredentials,
  RemoteMutationOutcome,
  ValidationResult,
} from '@oremedia/contracts/providers';
import type { ChannelVariantForPublishing } from '@oremedia/contracts/publishing';
import type { Tx } from '@oremedia/db';
import {
  aadFor,
  credentialBroker,
  type DestinationEditInput,
  type DestinationMutationResult,
  type DestinationPublishInput,
  type DestinationPublishResult,
  type DestinationPublisher,
  type DestinationTargetDescription,
  type DestinationValidateInput,
} from '@oremedia/module-publishing';
import { logger } from '@oremedia/observability';
import {
  BlockedAddressError,
  ProviderTransportError,
  RenderedPageError,
  truncateForTemporal,
  type CmsAdapter,
  type CmsRemoteArticle,
  type CmsSite,
} from '@oremedia/providers';
import { cmsAdapterFor, cmsIO } from './cms';
import { BrandDestinationRepository, SourceUsePolicyRepository } from './repositories';
import { StoredKind, cmsWritable, enabledCmsAdapter, sourceUseDecision } from './service';

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

/** The effective publish mode: `publish` only when asked for and granted at connect time; otherwise a draft. */
export function effectivePublishMode(
  settings: Record<string, unknown>,
  grantedScopes: readonly string[],
): 'draft' | 'publish' {
  const asked = CmsPublishMode.safeParse(settings['publishMode']);
  return asked.success && asked.data === 'publish' && grantedScopes.includes(CMS_SCOPE_PUBLISH)
    ? 'publish'
    : 'draft';
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

/** The site an adapter addresses, from the destination row and the opened credential (never the row's secret). */
const siteOf = (row: DestinationRow, creds: DecryptedCredentials): CmsSite => ({
  siteUrl: row.externalId,
  username: creds.extra?.['username'] ?? '',
});

const failedValidation = (url: string, error: string): RenderedValidationV1 => ({
  url,
  fetchedAt: new Date().toISOString(),
  status: null,
  bytes: 0,
  truncated: false,
  ok: false,
  checks: RenderedCheckKey.options.map((key) => ({ key, ok: false })),
  error,
});

/** Fetches the page without credentials and runs the pure checks; a page that cannot be read is a failed result. */
async function validateWith(
  adapter: CmsAdapter,
  site: CmsSite,
  tenantId: string,
  input: Pick<DestinationValidateInput, 'url' | 'title' | 'firstParagraph' | 'draft'>,
  hooks?: ActivityHooks,
): Promise<RenderedValidationV1> {
  const io = cmsIO(adapter.key, tenantId, {
    timeoutMs: RENDERED_PAGE_TIMEOUT_MS,
    ...(hooks ? { hooks } : {}),
  });
  try {
    const page = await adapter.fetchRendered(site, io, input.url, RENDERED_PAGE_MAX_BYTES);
    const checks = validateRenderedPage({
      status: page.status,
      html: page.html,
      title: input.title,
      firstParagraph: input.firstParagraph,
      draft: input.draft,
    });
    return {
      url: page.url,
      fetchedAt: new Date().toISOString(),
      status: page.status,
      bytes: page.bytes,
      truncated: page.truncated,
      ok: renderedValidationOk(checks),
      checks,
      error: null,
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
    return await credentialBroker.withCredentialRef(
      { tenantId, credentialRefId: row.credentialRefId, aad: aadFor(tenantId, row.id) },
      (creds) => fn(adapter, siteOf(row, creds), creds),
    );
  } catch (err) {
    if (err instanceof PolicyDeniedError && err.reason === 'credential_destroyed') return onReconnect();
    throw err;
  }
}

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
        const written = await adapter.createArticle(
          site,
          creds,
          io,
          {
            title: article.title,
            slug: article.slug,
            excerpt: article.excerpt,
            html: renderArticleHtml(article),
            categories: article.categories,
            tags: article.tags,
            status,
          },
          input.idempotencyKey,
        );
        if (written.outcome === 'conflict')
          return {
            outcome: 'rejected',
            code: 'conflict',
            message: 'the site refused the new article as a conflict',
          };
        if (written.outcome !== 'done') return written;
        // Read-back (D-16): the remote revision as evidence, when the policy allows a read; else what the write returned.
        let remote = written.article;
        if (readAllowed) {
          const read = await adapter.readArticle(site, creds, io, written.article.remoteId);
          if (read.outcome === 'found') remote = read.article;
        }
        const readback = toReadback(remote);
        const validation = await validateWith(
          adapter,
          site,
          input.tenantId,
          {
            url: remote.remoteUrl,
            title: article.title,
            firstParagraph: articleFirstParagraph(article),
            draft: remote.status !== 'publish',
          },
          hooks,
        );
        return {
          outcome: 'accepted',
          remotePostId: remote.remoteId,
          remoteUrl: remote.remoteUrl,
          readback,
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
    return withSite(
      input.tenantId,
      row,
      async (adapter, site, creds) => {
        const io = cmsIO(adapter.key, input.tenantId, hooks ? { hooks } : {});
        const result = await adapter.updateArticle(
          site,
          creds,
          io,
          input.remoteId,
          { html: sanitizeArticleHtml(input.html) },
          input.expectedHash ? { expectedHash: input.expectedHash } : {},
        );
        switch (result.outcome) {
          case 'done':
            return { outcome: 'done', readback: toReadback(result.article) };
          case 'conflict':
            logger()
              .child('destinations')
              .warn(
                { destinationId: row.id, reason: 'remote_changed_since_readback' },
                'article edit refused: the remote moved',
              );
            return {
              outcome: 'rejected',
              code: 'conflict',
              message: `the article changed on the site since it was last read back (now ${result.current.modifiedAt ?? 'unknown'})`,
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
    return withSite(
      input.tenantId,
      row,
      async (adapter, site, creds) => {
        const result = await adapter.unpublishArticle(
          site,
          creds,
          cmsIO(adapter.key, input.tenantId, hooks ? { hooks } : {}),
          input.remoteId,
        );
        return result.outcome === 'done'
          ? { outcome: 'done', ...(result.article ? { readback: toReadback(result.article) } : {}) }
          : result;
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
        input,
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
