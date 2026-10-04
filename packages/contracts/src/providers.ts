import { z } from 'zod';

/** Spec 14.6: versioned capability register read by the UI, the adaptation skill and validateVariant. */
export const ProviderCapabilityV1 = z.object({
  key: z.string(),
  version: z.number().int(),
  text: z.object({
    maxLength: z.number(),
    weighted: z.boolean(),
    supportsLinks: z.boolean(),
    supportsMentions: z.boolean(),
    supportsHashtags: z.boolean(),
  }),
  media: z.object({
    image: z
      .object({
        mimes: z.array(z.string()),
        minWidth: z.number(),
        maxWidth: z.number(),
        aspectRatios: z.array(z.object({ min: z.number(), max: z.number() })),
        maxBytes: z.number(),
        maxCount: z.number(),
      })
      .optional(),
    video: z
      .object({ mimes: z.array(z.string()), maxDurationSec: z.number(), maxBytes: z.number() })
      .optional(),
    carousel: z.object({ min: z.number(), max: z.number() }).optional(),
    altText: z.boolean(),
    publicUrlFetch: z.object({ required: z.boolean(), processingWindowSec: z.number() }),
  }),
  threading: z.enum(['none', 'comments', 'thread']),
  asyncProcessing: z.boolean(),
  idempotencyKeySupported: z.boolean(),
  reconciliation: z.enum(['by_id_lookup', 'by_recent_posts_scan', 'none']),
  analytics: z.object({ post: z.array(z.string()), account: z.array(z.string()), latencyHours: z.number() }),
  comments: z.object({ read: z.boolean(), reply: z.boolean() }),
  edit: z.boolean(),
  delete: z.boolean(),
  rateLimits: z.array(
    z.object({ scope: z.enum(['app', 'account', 'tenant']), limit: z.number(), windowSec: z.number() }),
  ),
  requiredScopes: z.array(z.string()),
  certifiedAt: z.string().datetime().nullable(), // null = not certified; cannot be enabled for tenants
  /** RA-01: the platform the person authorises at ("Meta", "LinkedIn", "X"), as the settings screens name it. */
  vendor: z.string().optional(),
  /**
   * RA-07: the per-variant provider settings a person may set (ChannelVariantInput.settings), as a JSON Schema
   * object the UI renders as fields; absent when the channel takes none. The adapter reads exactly these keys.
   */
  settings: z.record(z.unknown()).optional(),
});
export type ProviderCapabilityV1 = z.infer<typeof ProviderCapabilityV1>;

export type PublishOutcome =
  | { outcome: 'accepted'; remotePostId: string; remoteUrl: string }
  | { outcome: 'pending'; pending: PendingState; remoteJobId?: string }
  | { outcome: 'rejected'; code: string; message: string }
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number } // only when phase === 'before_send' or platform guarantees no effect
  | { outcome: 'unknown'; code: string; message: string };

/**
 * The classified result of changing or removing a post that is already live (ProviderAdapter.editPost/deletePost).
 * Both mutations converge (repeating a delete or an edit leaves the same remote state), so an ambiguous failure
 * after send is `retryable_error`, never a separate unknown outcome. A delete of a post that is already gone is
 * `already_absent`, which counts as success.
 */
export type RemoteMutationOutcome =
  | { outcome: 'done' }
  | { outcome: 'already_absent' }
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number }
  | { outcome: 'rejected'; code: string; message: string };

export type ProviderErrorClass =
  | { kind: 'refresh_token' }
  | { kind: 'reconnect_required' }
  | { kind: 'rate_limited'; retryAfterMs?: number; phase: 'before_send' }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown' };

export const PendingState = z.object({
  remoteJobId: z.string().optional(),
  containerId: z.string().optional(),
  data: z.record(z.unknown()).default({}),
});
export type PendingState = z.infer<typeof PendingState>;

export type PendingCheck =
  | { status: 'completed'; remotePostId: string; remoteUrl: string }
  | { status: 'ready' } // ready to finalise; once finalised, checkStatus must report 'completed'
  | { status: 'processing'; retryAfterMs?: number }
  | { status: 'failed'; code: string; message: string };

export type ReconcileResult =
  | { status: 'found'; remotePostId: string; remoteUrl: string; matchedBy: 'id' | 'fingerprint' }
  | { status: 'definitely_absent' }
  | { status: 'cannot_determine'; reason: string };

export const ChannelVariantInput = z.object({
  text: z.string(),
  altTexts: z.array(z.string()),
  media: z.array(
    z.object({
      mime: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      bytes: z.number().int(),
      durationMs: z.number().int().optional(),
      /** STU-2a: a video's frame rate, carried with its duration so a capability can check both. */
      fps: z.number().positive().optional(),
    }),
  ),
  settings: z.record(z.unknown()),
});
export type ChannelVariantInput = z.infer<typeof ChannelVariantInput>;

export const ValidationIssue = z.object({ path: z.string().optional(), issue: z.string() });
export const ValidationResult = z.object({ ok: z.boolean(), issues: z.array(ValidationIssue) });
export type ValidationResult = z.infer<typeof ValidationResult>;

export interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface DecryptedCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  extra?: Record<string, string>;
}

export interface AccountGrant {
  remoteAccountId: string;
  displayName: string;
  grantedScopes: string[];
  credentials: DecryptedCredentials;
  tokenExpiresAt?: string;
  /** Other accounts (pages, organisations) the same grant can address; names only, never tokens. */
  alternatives?: Array<{ remoteAccountId: string; displayName: string }>;
}

export type RefreshResult =
  | { ok: true; credentials: DecryptedCredentials; tokenExpiresAt?: string }
  | { ok: false; reason: 'reconnect_required' | 'transient' };

export interface MetricWindow {
  start: string;
  end: string;
}

export interface RawMetricPoint {
  nativeName: string;
  value: number | null;
  unit?: string;
  windowStart: string;
  windowEnd: string;
  completeness: 'complete' | 'partial' | 'unavailable';
  series?: Array<{ at: string; value: number }>;
}

export interface CommentPage {
  items: Array<{
    remoteCommentId: string;
    authorHandle: string;
    text: string;
    createdAt: string;
    parentRemoteId?: string;
    /**
     * The author's platform id in the form of a connection's `remoteAccountId`, so a comment written by the connected
     * account itself (the brand's own reply) is recognised as outbound. Absent when the platform does not say.
     */
    authorRemoteId?: string;
  }>;
  nextCursor?: string;
}

export const ChannelConnectionStatus = z.enum(['active', 'refresh_needed', 'reconnect_needed', 'disabled']);
export type ChannelConnectionStatus = z.infer<typeof ChannelConnectionStatus>;

// ---------------------------------------------------------------------------------------------------------------
// RA-01 provider activation (appended; additive only): channel health, remote revoke and the activation state of
// every registered provider (channel, source and CMS adapters alike).
// ---------------------------------------------------------------------------------------------------------------

/**
 * What the last check found about a channel connection's remote access (beside `status`, which says what the
 * product does with it): `unknown` until a refresh or a read ran; `ok`; `token_expiring` when a refresh due before
 * expiry failed transiently; `token_expired` when the platform refused a read for an expired token (401 class);
 * `revoked` when the grant itself is gone (403 class, or a refresh refused for good); `unreachable` when the
 * platform could not be reached at all. Set by the token refresh workflow and by the comment and metrics pulls
 * through the adapter's own error classification, never by a provider-specific branch.
 */
export const ChannelHealth = z.enum([
  'unknown',
  'ok',
  'token_expiring',
  'token_expired',
  'revoked',
  'unreachable',
]);
export type ChannelHealth = z.infer<typeof ChannelHealth>;

/** The result of asking the platform to revoke the grant (ProviderAdapter.revokeAccess). */
export type RevokeResult =
  { outcome: 'revoked' } | { outcome: 'not_supported' } | { outcome: 'failed'; reason: string };

/** What the disconnect recorded about the remote side, as the audit event and `channel.disconnected` carry it. */
export const RemoteRevokeOutcome = z.enum(['requested', 'revoked', 'not_supported', 'failed']);
export type RemoteRevokeOutcome = z.infer<typeof RemoteRevokeOutcome>;

/** The three adapter families the registries hold (packages/providers). */
export const ProviderKind = z.enum(['channel', 'source', 'cms']);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * Whether a registered provider can be connected on this deployment, in the order the reasons are checked:
 * `uncertified` (capability.certifiedAt is null: the registry refuses it for tenants, spec 14.6), `disabled`
 * (listed in OREMEDIA_DISABLED_CHANNELS / OREMEDIA_DISABLED_SOURCES, or its opt-in setting is off),
 * `credentials_missing` (an app credential reference the process reads is not set), else `ready`.
 */
export const ProviderActivationState = z.enum(['uncertified', 'disabled', 'credentials_missing', 'ready']);
export type ProviderActivationState = z.infer<typeof ProviderActivationState>;

/** A credential reference the deployment must set for the provider: its variable name and whether it is set. Never a value. */
export interface ProviderCredentialRefV1 {
  name: string;
  present: boolean;
}

/** One registered provider as `operations.providers.list` reports it (tenant owners and admins): the facts the settings chips use, nothing of the capability register itself. */
export interface ProviderActivationV1 {
  key: string;
  kind: ProviderKind;
  /** The platform the person authorises at or the site runs (as the settings screens name it). */
  vendor: string;
  capabilityVersion: number;
  certifiedAt: string | null;
  /** Listed in the disabled-* configuration of this environment, or behind an opt-in setting that is off. */
  disabled: boolean;
  credentialRefs: ProviderCredentialRefV1[];
  state: ProviderActivationState;
  /** The machine-readable reason behind `state` (`provider_not_certified:<key>`, ...); null when ready. */
  reason: string | null;
}

/** The activation state from its facts, in the order the reasons are checked (uncertified first). */
export function providerActivationState(
  p: Pick<ProviderActivationV1, 'key' | 'certifiedAt' | 'disabled' | 'credentialRefs'>,
): { state: ProviderActivationState; reason: string | null } {
  if (!p.certifiedAt) return { state: 'uncertified', reason: `provider_not_certified:${p.key}` };
  if (p.disabled) return { state: 'disabled', reason: `provider_disabled:${p.key}` };
  const missing = p.credentialRefs.filter((c) => !c.present).map((c) => c.name);
  if (missing.length > 0)
    return { state: 'credentials_missing', reason: `credentials_missing:${missing.join(',')}` };
  return { state: 'ready', reason: null };
}
