import type { ArticleReadbackV1, DestinationKind } from '@oremedia/contracts/destinations';
import type {
  DecryptedCredentials,
  ProviderCapabilityV1,
  ProviderErrorClass,
} from '@oremedia/contracts/providers';
import type { ProviderIO } from './io';

/**
 * Ledger R2-3 (D-16): the CMS-agnostic write contract behind a `cms_site` destination. An adapter verifies the
 * site's integration identity, reads the current remote revision of an article, creates one (a draft by default:
 * preview/staging publication, D-16), updates one only when the remote has not moved since it was read back
 * (never an overwrite), sets one back to a draft (the rollback) or deletes it, and fetches the rendered page for
 * validation. Credentials are passed in explicitly (never a DB row); every outbound call goes through ProviderIO
 * (SSRF-safe, rate-limited, logged); errors are classified the same way as a channel's (spec 14.5). Certification
 * gates tenant use exactly as for channels and sources (14.6).
 */
export interface CmsCapabilityV1 {
  key: DestinationKind;
  version: number;
  /** The platform the site runs, as the settings screen names it. */
  vendor: string;
  /** How the integration identity authenticates (the connect screen's copy). */
  credential: { label: string; hint: string };
  rateLimits: ProviderCapabilityV1['rateLimits'];
  /** What the adapter can do to a live article (the publication screen's actions). */
  edit: boolean;
  delete: boolean;
  unpublish: boolean;
  certifiedAt: string | null;
}

/** The site an adapter addresses: its origin (https) and the integration identity it authenticates as. */
export interface CmsSite {
  siteUrl: string;
  username: string;
}

/** What a write sends: the rendered body (already sanitised), the identity fields and the terms. */
export interface CmsArticleInput {
  title: string;
  slug: string;
  excerpt: string;
  html: string;
  categories: string[];
  tags: string[];
  /** `draft` unless the publication's effective publish mode is `publish` (D-16). */
  status: 'draft' | 'publish';
}

/** The remote article as the adapter reads it: identity, state, content hash; the body for a diff, never stored. */
export interface CmsRemoteArticle extends ArticleReadbackV1 {
  html: string;
}

export type CmsVerifyResult =
  | { ok: true; displayName: string; canPublish: boolean }
  | { ok: false; reason: 'reconnect_required' | 'transient' | 'rejected'; detail: string };

export type CmsReadResult =
  | { outcome: 'found'; article: CmsRemoteArticle }
  | { outcome: 'absent' }
  | { outcome: 'rejected'; code: string; message: string }
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number };

/**
 * The classified result of a write. `conflict` is the refusal of an update whose precondition (the hash or the
 * modified timestamp the caller read back) no longer matches the remote: nothing was written, the current remote
 * revision is returned so the person can decide. The outcomes otherwise follow PublishOutcome (spec 14.5).
 *
 * RA-12: an update's `done` carries `previous`, the remote revision read immediately before the write (the
 * precondition was checked against it), and `overwritten` when the adapter could prove that the revision the write
 * replaced was not `previous` (the remote changed between the read and the write): that replaced revision, so the
 * caller records what was lost. A CMS without compare-and-swap cannot close that window, only narrow and detect it.
 */
export type CmsWriteResult =
  | {
      outcome: 'done';
      article: CmsRemoteArticle;
      previous?: CmsRemoteArticle;
      overwritten?: CmsRemoteArticle;
    }
  | { outcome: 'conflict'; current: CmsRemoteArticle }
  | { outcome: 'rejected'; code: string; message: string }
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number }
  | { outcome: 'unknown'; code: string; message: string };

export type CmsRemoveResult =
  | { outcome: 'done'; article: CmsRemoteArticle | null }
  | { outcome: 'already_absent' }
  | { outcome: 'rejected'; code: string; message: string }
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number };

/** A rendered page fetched for validation: the status and the body up to the byte cap (truncated beyond it). */
export interface CmsRenderedPage {
  status: number;
  html: string;
  bytes: number;
  truncated: boolean;
  /** The URL the page was finally read from (after re-checked redirects). */
  url: string;
}

/**
 * What an update must match on the remote before it writes: the hash read back and the modified timestamp (both,
 * when the caller has both: the hash covers the content and identity, the timestamp a change that kept them).
 */
export interface CmsUpdatePrecondition {
  expectedHash?: string;
  expectedModifiedAt?: string | null;
}

export interface CmsAdapter {
  readonly key: DestinationKind;
  readonly capability: CmsCapabilityV1;

  /** Proves the identity can write articles on the site; read-only (the connect flow's health check). */
  verify(site: CmsSite, credentials: DecryptedCredentials, io: ProviderIO): Promise<CmsVerifyResult>;
  /** The current remote revision of an article by its remote id (read-only; the read-back after a write). */
  readArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsReadResult>;
  /** Creates the article (a draft unless `status` is `publish`); the returned article is read back after the write. */
  createArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    input: CmsArticleInput,
    idempotencyKey: string,
  ): Promise<CmsWriteResult>;
  /** Updates the article only when the remote still matches the precondition; otherwise `conflict`, nothing written. */
  updateArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
    input: Partial<CmsArticleInput>,
    precondition: CmsUpdatePrecondition,
  ): Promise<CmsWriteResult>;
  /** Sets a live article back to a draft (the rollback of a publish); a draft already is `done`. */
  unpublishArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsRemoveResult>;
  /** Removes the article (to the site's bin); one already gone is `already_absent`. */
  deleteArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsRemoveResult>;
  /**
   * Fetches a rendered page of the site for validation, without credentials: https only, the site's own host,
   * redirects followed hop by hop with the same checks, the body read against `maxBytes`.
   */
  fetchRendered(site: CmsSite, io: ProviderIO, url: string, maxBytes: number): Promise<CmsRenderedPage>;

  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass;
}
