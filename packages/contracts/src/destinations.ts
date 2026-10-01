import { z } from 'zod';
import type { ErrorDetail } from './errors';

/**
 * Brand destinations (ledger R2-0): the non-social places a brand reads from or writes to (an analytics property,
 * a Search Console site, a Business Profile location, a website CMS, a Discord webhook), with who connected
 * them, what the grant covers, their last known health and the capability version they were registered under.
 * Source-use policies (D-17) say, per destination kind and data type, what the product may do with the data
 * (`read` through a restricted view, `retain` a copy for a bounded time, `write` back to the destination), as a
 * versioned record with a review date; a use without a current policy is refused.
 */
export const DestinationKind = z.enum([
  'ga4_property',
  'search_console_site',
  'gbp_location',
  'cms_site',
  'discord_webhook',
]);
export type DestinationKind = z.infer<typeof DestinationKind>;

export const DestinationHealth = z.enum(['unknown', 'healthy', 'degraded', 'unreachable']);
export type DestinationHealth = z.infer<typeof DestinationHealth>;

export const DestinationStatus = z.enum(['active', 'disconnected']);
export type DestinationStatus = z.infer<typeof DestinationStatus>;

export const SourceUse = z.enum(['read', 'retain', 'write']);
export type SourceUse = z.infer<typeof SourceUse>;

/** A data type a policy covers, namespaced by its source: `ga4.reports`, `gbp.reviews`, `cms.articles`. */
export const SourceUseDataType = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
  .max(80);

/**
 * What each kind of destination can be used for; the only place the kinds differ. Every service and UI rule reads
 * it generically: a policy may allow only the uses listed here. gbp_location is read-only with no retention
 * (D-17: no permanent ingestion, writes off); cms_site reads and writes (D-16); a Discord webhook only writes
 * (D-18: announcements, no inbound).
 */
export const DESTINATION_KIND_CAPABILITIES: Readonly<
  Record<DestinationKind, { label: string; uses: readonly SourceUse[] }>
> = {
  ga4_property: { label: 'Google Analytics 4 property', uses: ['read', 'retain'] },
  search_console_site: { label: 'Search Console site', uses: ['read', 'retain'] },
  gbp_location: { label: 'Google Business Profile location', uses: ['read'] },
  cms_site: { label: 'Website CMS', uses: ['read', 'write'] },
  discord_webhook: { label: 'Discord webhook', uses: ['write'] },
};

/** Never the credential reference: a destination DTO carries identity, scopes, health and state only. */
export interface DestinationV1 {
  id: string;
  brandId: string;
  kind: DestinationKind;
  externalId: string;
  displayName: string;
  ownerUserId: string;
  grantedScopes: string[];
  health: DestinationHealth;
  healthCheckedAt: string | null;
  capabilityVersion: number;
  status: DestinationStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceUsePolicyV1 {
  id: string;
  brandId: string;
  destinationKind: DestinationKind;
  dataType: string;
  allowedUses: SourceUse[];
  retentionDays: number | null;
  version: number;
  reviewedAt: string;
  reviewDueAt: string;
  reviewedById: string;
  createdAt: string;
  updatedAt: string;
}

// ---- router DTOs (destinations.*) ----

/** A brand has a handful of destinations: the list is not paged. */
export const DestinationList = z.object({ brandId: z.string(), kind: DestinationKind.optional() });
export const DestinationGet = z.object({ brandId: z.string(), destinationId: z.string() });
export const DestinationRegister = z.object({
  brandId: z.string(),
  kind: DestinationKind,
  externalId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  grantedScopes: z.array(z.string().max(200)).max(50).default([]),
  capabilityVersion: z.number().int().min(1).default(1),
});
export const DestinationSetHealth = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  health: DestinationHealth,
  expectedVersion: z.number().int(),
});
export const DestinationDisconnect = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  expectedVersion: z.number().int(),
});

export const SourceUsePolicyList = z.object({
  brandId: z.string(),
  destinationKind: DestinationKind.optional(),
});
/** Retention is bounded: at most ten years, and only when `retain` is allowed. */
export const SOURCE_USE_RETENTION_MAX_DAYS = 3650;
export const SourceUsePolicySet = z.object({
  brandId: z.string(),
  destinationKind: DestinationKind,
  dataType: SourceUseDataType,
  allowedUses: z.array(SourceUse).max(3),
  retentionDays: z.number().int().min(1).max(SOURCE_USE_RETENTION_MAX_DAYS).nullable().optional(),
  reviewDueAt: z.string().datetime(),
  /** Required when a policy for the (kind, data type) already exists; its version then moves on. */
  expectedVersion: z.number().int().optional(),
});
export const SourceUseCheck = z.object({
  brandId: z.string(),
  destinationKind: DestinationKind,
  dataType: SourceUseDataType,
  use: SourceUse,
});

/**
 * The pure rules of a source-use policy (the service and the UI mock apply them, the unit test proves them): every
 * allowed use is one the kind offers, and `retain` carries a retention period. Empty when the policy is valid.
 */
export function sourceUseIssues(
  kind: DestinationKind,
  allowedUses: readonly SourceUse[],
  retentionDays: number | null | undefined,
): ErrorDetail[] {
  const capable = DESTINATION_KIND_CAPABILITIES[kind].uses;
  const issues: ErrorDetail[] = allowedUses
    .filter((u, i) => allowedUses.indexOf(u) === i && !capable.includes(u))
    .map((u) => ({ path: 'allowedUses', issue: `${u}_not_supported_by_${kind}` }));
  if (allowedUses.includes('retain') && !retentionDays)
    issues.push({ path: 'retentionDays', issue: 'required_for_retain' });
  return issues;
}

export const SourceUseCheckReason = z.enum(['no_policy', 'not_allowed', 'review_overdue', 'allowed']);
export type SourceUseCheckReason = z.infer<typeof SourceUseCheckReason>;
export interface SourceUseCheckResult {
  allowed: boolean;
  reason: SourceUseCheckReason;
  policy: SourceUsePolicyV1 | null;
}
