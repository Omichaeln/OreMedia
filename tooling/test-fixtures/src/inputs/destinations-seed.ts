import { sql } from 'drizzle-orm';
import {
  brandDestinations,
  destinationReportRows,
  pendingDestinationGrants,
  seoAuditRuns,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * One destination (with two days of report rows), one source-use policy and one pending connect flow per tenant,
 * so a foreign caller has every destinations.* id to try (spec 19.3). The tables arrive with migrations 0015, 0016
 * (which also adds brand_destinations.token_expires_at) and 0017: the roll-forward suites seed earlier heads, where
 * they do not exist yet, so the rows are written only when the schema at head is there (the harness fixtures that
 * need them run at head).
 */
export const DESTINATIONS_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const destinationId = newId('destination');
  const sourceUsePolicyId = newId('sourceUsePolicy');
  const pendingDestinationGrantId = newId('pendingDestinationGrant');
  const seoAuditRunId = newId('seoAuditRun');
  const ids = { destinationId, sourceUsePolicyId, pendingDestinationGrantId, seoAuditRunId };
  const present = await db.execute(
    sql`select 1 as present from information_schema.tables where table_schema = database() and table_name = 'destination_report_rows'`,
  );
  const atHead = Array.isArray(present[0]) && present[0].length > 0;
  if (!atHead) return ids;
  const now = new Date();
  // sql``, not insert(brandDestinations).values(): Drizzle would name reporting_time_zone and currency_code
  // (0021), which the roll-forward suites' earlier heads do not have; the columns named here exist at every head
  // the seed runs at (0017 on), later ones take their defaults (null: a UTC-day destination, RA-10).
  await db.execute(
    sql`insert into ${brandDestinations} (id, tenant_id, brand_id, kind, external_id, display_name, owner_user_id, credential_ref_id, token_expires_at, granted_scopes, health, health_checked_at, capability_version, status, created_at, updated_at) values (${destinationId}, ${tenantId}, ${brandId}, 'ga4_property', ${`properties/${destinationId.slice(-8)}`}, 'Seeded property', ${ownerUserId}, null, null, '[]', 'unknown', null, 1, 'active', ${now}, ${now})`,
  );
  // R2-4 (migration 0019): one audit run of the destination, so a foreign crawl or finish names a real run id.
  const auditAtHead = await db.execute(
    sql`select 1 as present from information_schema.tables where table_schema = database() and table_name = 'seo_audit_runs'`,
  );
  if (Array.isArray(auditAtHead[0]) && auditAtHead[0].length > 0)
    await db.insert(seoAuditRuns).values({
      id: seoAuditRunId,
      tenantId,
      brandId,
      destinationId,
      origin: 'https://site.example',
      trigger: 'scheduled',
      requestedById: null,
      startedAt: now,
      outcome: 'running',
    });
  await db.insert(sourceUsePolicies).values({
    id: sourceUsePolicyId,
    tenantId,
    brandId,
    destinationKind: 'ga4_property',
    dataType: 'ga4.reports',
    allowedUses: ['read'],
    retentionDays: null,
    version: 1,
    reviewedAt: now,
    reviewDueAt: new Date(now.getTime() + 90 * 86_400_000),
    reviewedById: ownerUserId,
  });
  // Two days of one report (R2-1 part B), so a foreign summary or drill-down would have rows to leak if it could.
  // sql`` for the same reason: time_zone and quality (0021) are not there at the earlier heads; without them the
  // rows are UTC days without flags, as rows stored before the migration read.
  for (const date of ['2026-09-27', '2026-09-28'])
    await db.execute(
      sql`insert into ${destinationReportRows} (id, tenant_id, brand_id, destination_id, report_key, date, dimensions, dimension_key, metrics, fetched_at, source, created_at) values (${newId('destinationReportRow')}, ${tenantId}, ${brandId}, ${destinationId}, 'ga4.acquisition', ${date}, ${JSON.stringify({ sessionDefaultChannelGroup: 'Organic Search' })}, ${hashCanonical({ sessionDefaultChannelGroup: 'Organic Search' })}, ${JSON.stringify({ sessions: 100, totalUsers: 80, engagedSessions: 60, keyEvents: 2 })}, ${now}, 'provider', ${now})`,
    );
  // A sealed grant stands in by its row shape only: the harness never opens it (a foreign actor is refused first).
  await db.insert(pendingDestinationGrants).values({
    id: pendingDestinationGrantId,
    tenantId,
    brandId,
    kind: 'ga4_property',
    actorKind: 'user',
    actorId: ownerUserId,
    destinationId: newId('destination'),
    grantedScopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    tokenExpiresAt: new Date(now.getTime() + 3600_000),
    targets: [{ externalId: 'properties/424242', displayName: 'Seeded property' }],
    kmsKeyId: 'local-kms',
    wrappedDataKey: 'c2VlZA==',
    ciphertext: 'c2VlZA==',
    iv: 'seedseedseed',
    authTag: 'in_ciphertext',
    aad: `${tenantId}:seed`,
    expiresAt: new Date(now.getTime() + 600_000),
  });
  return ids;
};
