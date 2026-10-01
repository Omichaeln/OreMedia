import { sql } from 'drizzle-orm';
import { brandDestinations, sourceUsePolicies } from '@oremedia/db/schema/destinations';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * One destination and one source-use policy per tenant, so a foreign caller has every destinations.* id to try
 * (spec 19.3). The tables arrive with migration 0015: the roll-forward suites seed earlier heads, where they do not
 * exist yet, so the rows are written only when they do (the harness fixtures that need them run at head).
 */
export const DESTINATIONS_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const destinationId = newId('destination');
  const sourceUsePolicyId = newId('sourceUsePolicy');
  const present = await db.execute(
    sql`select 1 as present from information_schema.tables where table_schema = database() and table_name = 'brand_destinations'`,
  );
  const hasDestinations = Array.isArray(present[0]) && present[0].length > 0;
  if (!hasDestinations) return { destinationId, sourceUsePolicyId };
  const now = new Date();
  await db.insert(brandDestinations).values({
    id: destinationId,
    tenantId,
    brandId,
    kind: 'ga4_property',
    externalId: `properties/${destinationId.slice(-8)}`,
    displayName: 'Seeded property',
    ownerUserId,
    credentialRefId: null,
    grantedScopes: [],
    health: 'unknown',
    healthCheckedAt: null,
    capabilityVersion: 1,
    status: 'active',
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
  return { destinationId, sourceUsePolicyId };
};
