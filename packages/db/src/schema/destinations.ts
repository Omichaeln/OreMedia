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
import { brandId, createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';
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

/**
 * R2-4: one bounded crawl of a website destination (its origin, never a free URL) under the brand's `cms.audit`
 * source-use policy. The row is created when the run starts (`running`) and closed by the finish activity with
 * the outcome, the caps it hit and the summary counts; its pages live in seo_audit_pages. Retention follows the
 * policy's retentionDays with `retain`, else the last SEO_AUDIT_KEEP_RUNS runs per destination are kept.
 */
export const seoAuditRuns = mysqlTable(
  'seo_audit_runs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    destinationId: ref('destination_id').notNull(),
    /** The authorised origin the crawl stayed on (the destination's externalId origin at the time). */
    origin: varchar('origin', { length: 200 }).notNull(),
    trigger: mysqlEnum('trigger', ['scheduled', 'on_demand']).notNull(),
    /** The person who asked for an on-demand run; null for the weekly sweep. */
    requestedById: ref('requested_by_id'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    outcome: mysqlEnum('outcome', ['running', 'completed', 'failed']).notNull().default('running'),
    reason: varchar('reason', { length: 200 }),
    pagesCrawled: int('pages_crawled').notNull().default(0),
    limitsHit: json('limits_hit').$type<string[]>().notNull().default([]),
    /** robots.txt `Disallow` rules for `*` read at the start (path prefixes with `*` and `$`), bounded. */
    robotsDisallow: json('robots_disallow').$type<string[]>().notNull().default([]),
    summary: json('summary')
      .$type<{ critical: number; major: number; minor: number; byCheck: Record<string, number> }>()
      .notNull()
      .default({ critical: 0, major: 0, minor: 0, byCheck: {} }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_seo_audit_run_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_seo_audit_run_destination').on(t.tenantId, t.brandId, t.destinationId, t.startedAt),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_seo_audit_run_brand',
    }),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.destinationId],
      foreignColumns: [brandDestinations.tenantId, brandDestinations.brandId, brandDestinations.id],
      name: 'fk_seo_audit_run_destination',
    }),
  ],
);

/**
 * R2-4: one page a run fetched, with its lab checks as JSON and the facts the cross-page checks need (the hashes
 * of its title and description, the same-origin links it carried); neither the body nor any text of the page is
 * stored. One row per (run, URL).
 */
export const seoAuditPages = mysqlTable(
  'seo_audit_pages',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    runId: ref('run_id').notNull(),
    url: varchar('url', { length: 2000 }).notNull(),
    /** sha-256 of the URL: the row's identity within the run (the URL itself is too long for a key). */
    urlHash: hash('url_hash').notNull(),
    depth: int('depth').notNull(),
    status: int('status'),
    bytes: int('bytes').notNull().default(0),
    severity: mysqlEnum('severity', ['ok', 'critical', 'major', 'minor']).notNull().default('ok'),
    checks: json('checks')
      .$type<Array<{ key: string; ok: boolean; severity: string | null; detail: string | null }>>()
      .notNull()
      .default([]),
    /** sha-256 of the lower-cased title / meta description (the duplicate checks compare them); null when absent. */
    titleHash: hash('title_hash'),
    metaDescriptionHash: hash('meta_description_hash'),
    links: json('links').$type<string[]>().notNull().default([]),
    fetchedAt: ts('fetched_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_seo_audit_page').on(t.tenantId, t.runId, t.urlHash),
    uniqueIndex('uq_seo_audit_page_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_seo_audit_page_severity').on(t.tenantId, t.brandId, t.runId, t.severity, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_seo_audit_page_brand',
    }),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.runId],
      foreignColumns: [seoAuditRuns.tenantId, seoAuditRuns.brandId, seoAuditRuns.id],
      name: 'fk_seo_audit_page_run',
    }),
  ],
);
