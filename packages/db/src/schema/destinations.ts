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
    /**
     * RA-10: the IANA zone the source reports its days in (a GA4 property's own `timeZone`, read through the
     * adapter's target metadata) and its currency; null until the first sweep learns them (a destination registered
     * before migration 0021, or a kind whose adapter declares none: its days stay UTC days).
     */
    reportingTimeZone: varchar('reporting_time_zone', { length: 64 }),
    currencyCode: varchar('currency_code', { length: 3 }),
    /** When the zone was last read from the platform; the sweep asks again after REPORTING_ZONE_RECHECK_DAYS. */
    reportingZoneCheckedAt: ts('reporting_zone_checked_at'),
    /**
     * PR-03: whether the last verification found the site able to update an existing article atomically
     * (`conditional`: e.g. WordPress with the Oremedia conditional-write plugin) or not (`limited`: updates of
     * existing articles are refused); `unknown` before the first verification and for kinds that do not write.
     * The adapter repeats the handshake before every update; this column is what the settings screen shows.
     */
    writeSafety: mysqlEnum('write_safety', ['unknown', 'conditional', 'limited'])
      .notNull()
      .default('unknown'),
    writeSafetyCheckedAt: ts('write_safety_checked_at'),
    /**
     * PR-04: where a website's theme puts an article's body (simple CSS selectors, contracts ArticleRegionSelector),
     * tried before the common WordPress defaults when a rendered article is verified; null: the defaults only.
     */
    articleSelector: varchar('article_selector', { length: 200 }),
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
    /**
     * The day the row covers, as YYYY-MM-DD: the platform's reporting day in `timeZone` (RA-10), a UTC day when
     * `timeZone` is null (rows stored before migration 0021, or a source that reports no zone).
     */
    date: varchar('date', { length: 10 }).notNull(),
    dimensions: json('dimensions').$type<Record<string, string>>().notNull(),
    /** hashCanonical of the dimensions: the deterministic identity of a row within (destination, report, day). */
    dimensionKey: varchar('dimension_key', { length: 200 }).notNull(),
    metrics: json('metrics').$type<Record<string, number>>().notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    source: varchar('source', { length: 40 }).notNull().default('provider'),
    /** RA-10: the IANA zone `date` is keyed in; null for a UTC day (see `date`). */
    timeZone: varchar('time_zone', { length: 64 }),
    /**
     * RA-10: the quality flags the fetch recorded for the row's report (SourceReportQualityFlag: `sampled`,
     * `thresholded`, `data_loss`, `not_final` as the platform exposed them, `partial_day` when the day had not
     * ended in `timeZone` when it was read); null for a row stored before the flags existed (read as none).
     */
    quality: json('quality').$type<string[]>(),
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

/**
 * RA-11: an SEO finding (one check of one audit run on a website destination) turned into tracked work: the
 * recommendation the intelligence module holds for it (`workType` / `workId`), with its provenance (the run, the
 * check, how many pages failed it and the example URLs at the time). One open row per (destination, check): a
 * second "create work" for the same finding returns it. The audit finish resolves the rows whose check a later
 * completed run no longer reports (`resolvedAt`, `resolvedRunId`); a check that comes back after that gets a new
 * row. Retention follows the runs: a row outlives its run as the record of the work it created.
 */
export const seoFindingWork = mysqlTable(
  'seo_finding_work',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    destinationId: ref('destination_id').notNull(),
    /** The run the finding was read from when the work was created (provenance). */
    runId: ref('run_id').notNull(),
    check: varchar('check_key', { length: 40 }).notNull(),
    severity: mysqlEnum('severity', ['critical', 'major', 'minor']).notNull(),
    pageCount: int('page_count').notNull().default(0),
    /** The example URLs the finding carried when the work was created (bounded, SEO_AUDIT_FINDING_EXAMPLES). */
    examples: json('examples').$type<string[]>().notNull().default([]),
    workType: varchar('work_type', { length: 40 }).notNull(),
    workId: ref('work_id').notNull(),
    createdById: ref('created_by_id').notNull(),
    resolvedAt: ts('resolved_at'),
    resolvedRunId: ref('resolved_run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_seo_finding_work_tbi').on(t.tenantId, t.brandId, t.id),
    uniqueIndex('uq_seo_finding_work_finding').on(t.tenantId, t.destinationId, t.runId, t.check),
    index('ix_seo_finding_work_open').on(t.tenantId, t.brandId, t.destinationId, t.check, t.resolvedAt),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_seo_finding_work_brand',
    }),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.destinationId],
      foreignColumns: [brandDestinations.tenantId, brandDestinations.brandId, brandDestinations.id],
      name: 'fk_seo_finding_work_destination',
    }),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.runId],
      foreignColumns: [seoAuditRuns.tenantId, seoAuditRuns.brandId, seoAuditRuns.id],
      name: 'fk_seo_finding_work_run',
    }),
  ],
);
