import {
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varbinary,
  varchar,
} from 'drizzle-orm/mysql-core';
import { brandId, createdAt, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

/**
 * Ledger R2-0: a brand's non-social destinations (analytics property, Search Console site, Business Profile
 * location, website CMS, Discord webhook). One row per remote identity per tenant; the credential, when a connect
 * flow has stored one, lives in credential_refs (the column is a plain reference: a destination registered before
 * its grant has none, and the composite key cannot be nullable).
 */
export const brandDestinations = mysqlTable(
  'brand_destinations',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: varchar('kind', { length: 40 }).notNull(),
    externalId: varchar('external_id', { length: 200 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    ownerUserId: ref('owner_user_id').notNull(),
    credentialRefId: ref('credential_ref_id'),
    /** When the stored access token expires (R2-1): the daily refresh renews the ones due within a day. */
    tokenExpiresAt: ts('token_expires_at'),
    grantedScopes: json('granted_scopes').$type<string[]>().notNull().default([]),
    health: mysqlEnum('health', ['unknown', 'healthy', 'degraded', 'unreachable'])
      .notNull()
      .default('unknown'),
    healthCheckedAt: ts('health_checked_at'),
    capabilityVersion: int('capability_version').notNull(),
    status: mysqlEnum('status', ['active', 'disconnected']).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_destination_remote').on(t.tenantId, t.kind, t.externalId),
    uniqueIndex('uq_destination_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_destination_brand',
    }),
  ],
);

/**
 * R2-1 connect flow: a source grant the person has authorised but not yet attached to a target, sealed for the
 * destination it becomes (AAD `${tenantId}:${destinationId}`, the id pre-allocated here), with the targets the
 * grant can read as names. One row per flow (one Google grant serves every target it lists), mirroring
 * pending_channel_grants: one-shot (select or cancel deletes it), expired rows deleted by the next connect flow in
 * the tenant and on tenant or brand deletion.
 */
export const pendingDestinationGrants = mysqlTable(
  'pending_destination_grants',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: varchar('kind', { length: 40 }).notNull(),
    actorKind: varchar('actor_kind', { length: 24 }).notNull(),
    actorId: ref('actor_id').notNull(),
    destinationId: ref('destination_id').notNull(),
    grantedScopes: json('granted_scopes').$type<string[]>().notNull(),
    tokenExpiresAt: ts('token_expires_at'),
    targets: json('targets').$type<Array<{ externalId: string; displayName: string }>>().notNull(),
    kmsKeyId: varchar('kms_key_id', { length: 200 }).notNull(),
    wrappedDataKey: varbinary('wrapped_data_key', { length: 512 }).notNull(),
    ciphertext: varbinary('ciphertext', { length: 8192 }).notNull(),
    iv: varbinary('iv', { length: 12 }).notNull(),
    authTag: varbinary('auth_tag', { length: 16 }).notNull(),
    aad: varchar('aad', { length: 200 }).notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_pending_destination_grant_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_pending_destination_grant_expiry').on(t.tenantId, t.expiresAt),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_pending_destination_grant_brand',
    }),
  ],
);

/**
 * D-17: per destination kind and data type, what the product may do with the data (read, retain, write) and for
 * how long a copy may be kept; every change is a new version with who reviewed it and when the next review is
 * due. A use without a current policy is refused.
 */
export const sourceUsePolicies = mysqlTable(
  'source_use_policies',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    destinationKind: varchar('destination_kind', { length: 40 }).notNull(),
    dataType: varchar('data_type', { length: 80 }).notNull(),
    allowedUses: json('allowed_uses').$type<string[]>().notNull(),
    retentionDays: int('retention_days'),
    version: version(), // the service writes 1 on the first record: a policy is never version 0
    reviewedAt: ts('reviewed_at').notNull(),
    reviewDueAt: ts('review_due_at').notNull(),
    reviewedById: ref('reviewed_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_source_use_policy').on(t.tenantId, t.brandId, t.destinationKind, t.dataType),
    uniqueIndex('uq_source_use_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_source_use_policy_brand',
    }),
  ],
);

/**
 * R2-1 part B: one day's row of a source report (GA4 Data API, Search Console search analytics) a destination's
 * daily sweep stored, keyed by report, day and the hash of its sorted dimensions so a re-fetch of a window
 * replaces its rows in one transaction (delete range + insert; no update, no updatedAt). Only the metrics the
 * platform returned are stored: an absent day or metric is absent, never zero (D-15). Retention follows the
 * brand's source-use policy for `<prefix>.reports` (`retain` with its retentionDays), else the operational cache
 * of REPORT_CACHE_DAYS (D-17 working default); the sweep prunes either way.
 */
export const destinationReportRows = mysqlTable(
  'destination_report_rows',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    destinationId: ref('destination_id').notNull(),
    reportKey: varchar('report_key', { length: 60 }).notNull(),
    /** The UTC day the row covers, as YYYY-MM-DD (the platforms report by calendar day). */
    date: varchar('date', { length: 10 }).notNull(),
    dimensions: json('dimensions').$type<Record<string, string>>().notNull(),
    /** hashCanonical of the dimensions: the deterministic identity of a row within (destination, report, day). */
    dimensionKey: varchar('dimension_key', { length: 200 }).notNull(),
    metrics: json('metrics').$type<Record<string, number>>().notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    source: varchar('source', { length: 40 }).notNull().default('provider'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_destination_report_row').on(
      t.tenantId,
      t.destinationId,
      t.reportKey,
      t.date,
      t.dimensionKey,
    ),
    uniqueIndex('uq_destination_report_row_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_destination_report_window').on(t.tenantId, t.brandId, t.destinationId, t.reportKey, t.date),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_destination_report_row_brand',
    }),
  ],
);
