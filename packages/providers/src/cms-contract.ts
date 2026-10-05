import type { ArticleReadbackV1, DestinationKind } from '@oremedia/contracts/destinations';
import type {
  CapabilityCertifications,
  DecryptedCredentials,
  ProviderCapabilityV1,
  ProviderErrorClass,
  RevokeResult,
} from '@oremedia/contracts/providers';
import type { ProviderIO } from './io';

/**
 * Ledger R2-3 (D-16): the CMS-agnostic write contract behind a `cms_site` destination. An adapter verifies the
 * site's integration identity, reads the current remote revision of an article, creates one (a draft by default:
 * preview/staging publication, D-16), updates one only when the remote has not moved since it was read back,
 * compared and written atomically on the site (PR-03; never an overwrite, and no update at all where the site
 * cannot do that), sets one back to a draft (the rollback) or deletes it, and fetches the rendered page for
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
  /**
   * PR-03: how an update of an existing article can be made atomic. `native`: the platform itself compares a
   * precondition and writes in one step; `extension`: only with a server-side extension the adapter detects per site
   * (`writeSafety`), else the site is in limited mode; `none`: never (every update of an existing article refused).
   */
  conditionalWrite: 'native' | 'extension' | 'none';
  certifiedAt: string | null;
  /** PR-06: the capabilities certified one by one; absent or without an entry means uncertified. */
  certifications?: CapabilityCertifications;
}

/**
 * PR-03: what a site offers for updating an existing article, as the adapter's handshake found it right now.
 * `conditional`: the site compares the stored precondition (`writeToken`) and writes in one atomic step, refusing a
 * stale write with the current revision; `limited`: it cannot (no extension, or storage that cannot lock), so an
 * update that would replace content is refused and nothing is written; `unknown`: the handshake could not be read
 * (transient), so nothing is decided and a write is retried later, never sent unconditionally.
 */
export type CmsWriteSafety =
  | { mode: 'conditional'; mechanism: string; version: string | null }
  | { mode: 'limited'; reason: string }
  | { mode: 'unknown'; reason: string };

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
  /** RA-08: the media item the site uploaded (`uploadMedia`) to feature on the page; absent leaves it unset. */
  featuredMedia?: CmsMediaRef;
}

/**
 * RA-08: an image the article carries, as the publisher hands it to the adapter: a signed release URL the assets
 * module minted for the publishing window (spec 9.3; the adapter fetches it through ProviderIO, never raw bytes
 * from storage), its type and hash, the alt text the page carries and the file name the site should keep.
 */
export interface CmsMediaInput {
  url: string;
  mime: string;
  contentHash: string;
  alt: string;
  filename: string;
}
/** RA-08: the most bytes an article image may weigh on its way to the site (the ingest cap for a web image). */
export const CMS_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/** A media item as the site holds it: its remote id and the public address the article's markup references. */
export interface CmsMediaRef {
  remoteId: string;
  url: string;
}
export type CmsMediaResult =
  | { outcome: 'done'; media: CmsMediaRef }
  | { outcome: 'rejected'; code: string; message: string }
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number }
  | { outcome: 'unknown'; code: string; message: string };

/** The remote article as the adapter reads it: identity, state, content hash; the body for a diff, never stored. */
export interface CmsRemoteArticle extends ArticleReadbackV1 {
  html: string;
  /** PR-03: where a person opens the article in the site's own editor (shown when an update is refused). */
  editUrl?: string;
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
 * The classified result of a write. `conflict` is the refusal of an update whose precondition (the write token, or
 * for a read-back stored before PR-03 the hash and modified timestamp) no longer matches the remote: nothing was
 * written, the current remote revision is returned so the person can decide. `limited` (PR-03) is the refusal of
 * an update the site cannot apply atomically (CmsWriteSafety `limited`): nothing was written; `current` is the
 * remote revision when it could be read, for the person to reconcile on the site. The outcomes otherwise follow
 * PublishOutcome (spec 14.5).
 *
 * An update's `done` carries `previous` when the adapter read the remote before the write (to compare a legacy
 * precondition). `overwritten` is for an adapter that can only detect, after the write, that it replaced a revision
 * other than `previous`; an adapter with conditional writes never needs it (RA-12, PR-03).
 */
export type CmsWriteResult =
  | {
      outcome: 'done';
      article: CmsRemoteArticle;
      previous?: CmsRemoteArticle;
      overwritten?: CmsRemoteArticle;
    }
  | { outcome: 'conflict'; current: CmsRemoteArticle }
  | { outcome: 'limited'; reason: string; current: CmsRemoteArticle | null }
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
  /** PR-04: the `X-Robots-Tag` and `Link` response headers (live visibility, canonical identity); null when absent. */
  headers: { xRobotsTag: string | null; link: string | null };
}

/**
 * What an update must match on the remote. `expectedWriteToken` (PR-03) is the site's own precondition stored with
 * the read-back: the site compares it and writes in one atomic step. A read-back stored before PR-03 has none; its
 * hash and modified timestamp are then compared with a fresh read whose own write token carries the write, so a
 * change after that read is still refused by the site.
 */
export interface CmsUpdatePrecondition {
  expectedWriteToken?: string;
  expectedHash?: string;
  expectedModifiedAt?: string | null;
}

export interface CmsAdapter {
  readonly key: DestinationKind;
  readonly capability: CmsCapabilityV1;

  /** Proves the identity can write articles on the site; read-only (the connect flow's health check). */
  verify(site: CmsSite, credentials: DecryptedCredentials, io: ProviderIO): Promise<CmsVerifyResult>;
  /**
   * RA-01: revokes the integration identity's secret on the site (as ProviderAdapter.revokeAccess), so a
   * disconnect ends the access on the remote side too; optional, never throws.
   */
  revokeAccess?(site: CmsSite, credentials: DecryptedCredentials, io: ProviderIO): Promise<RevokeResult>;
  /** The current remote revision of an article by its remote id (read-only; the read-back after a write). */
  readArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    remoteId: string,
  ): Promise<CmsReadResult>;
  /**
   * RA-08: uploads one image to the site's media library from its signed release URL, so the article's markup can
   * reference the site's own copy and the page can feature it. Runs before the article write; a failure is
   * classified like a write's (the upload is itself an effect on the site).
   */
  uploadMedia(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    media: CmsMediaInput,
  ): Promise<CmsMediaResult>;
  /** Creates the article (a draft unless `status` is `publish`); the returned article is read back after the write. */
  createArticle(
    site: CmsSite,
    credentials: DecryptedCredentials,
    io: ProviderIO,
    input: CmsArticleInput,
    idempotencyKey: string,
  ): Promise<CmsWriteResult>;
  /**
   * PR-03: the site's conditional-write support right now (a read-only handshake before any update, and on
   * verification so the destination records it). Never throws.
   */
  writeSafety(site: CmsSite, credentials: DecryptedCredentials, io: ProviderIO): Promise<CmsWriteSafety>;
  /**
   * Updates the article only when the remote still matches the precondition, atomically on the site (PR-03);
   * otherwise `conflict`, nothing written. On a site without conditional writes an update that would replace
   * content is `limited`, nothing written; a status-only update (the revert to a draft) still runs there, since it
   * replaces no content.
   */
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
