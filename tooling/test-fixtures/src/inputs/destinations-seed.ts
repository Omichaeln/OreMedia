import { sql } from 'drizzle-orm';
import {
  brandDestinations,
  pendingDestinationGrants,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * One destination, one source-use policy and one pending connect flow per tenant, so a foreign caller has every
 * destinations.* id to try (spec 19.3). The tables arrive with migrations 0015 and 0016 (which also adds
 * brand_destinations.token_expires_at): the roll-forward suites seed earlier heads, where they do not exist yet,
 * so the rows are written only when the schema at head is there (the harness fixtures that need them run at head).
 */
export const DESTINATIONS_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const destinationId = newId('destination');
  const sourceUsePolicyId = newId('sourceUsePolicy');
  const pendingDestinationGrantId = newId('pendingDestinationGrant');
  const ids = { destinationId, sourceUsePolicyId, pendingDestinationGrantId };
  const present = await db.execute(
    sql`select 1 as present from information_schema.tables where table_schema = database() and table_name = 'pending_destination_grants'`,
  );
  const atHead = Array.isArray(present[0]) && present[0].length > 0;
  if (!atHead) return ids;
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
    tokenExpiresAt: null,
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
