import { sql } from 'drizzle-orm';
import {
  channelConnections,
  credentialRefs,
  publicationAttempts,
  publications,
} from '@oremedia/db/schema/publishing';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * Per tenant, on brand 1: an active fixture channel with a placeholder credential row, one scheduled publication
 * with an open attempt, so a foreign caller has every publishing id to try (spec 19.3 publishing.*). The
 * placeholders are not a real envelope (VARBINARY columns travel as base64 text); nothing here decrypts.
 */
export const PUBLISHING_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const publishingCredentialRefId = newId('credentialRef');
  const publishingChannelConnectionId = newId('channelConnection');
  const publicationId = newId('publication');
  const publicationAttemptId = newId('publicationAttempt');
  await db.insert(credentialRefs).values({
    id: publishingCredentialRefId,
    tenantId,
    kmsKeyId: 'fixture-kms-key',
    wrappedDataKey: 'Zml4dHVyZQ==',
    ciphertext: 'Zml4dHVyZQ==',
    iv: 'Zml4dHVyZQ==',
    authTag: 'Zml4dHVyZQ==',
    aad: `${tenantId}:${publishingChannelConnectionId}`,
  });
  // sql``, not insert(…).values(): Drizzle would name destination_id (0018) on publications and health /
  // health_checked_at (0022) on channel_connections, which the roll-forward suites' earlier heads do not have; the
  // columns named here exist at every head, later ones take their defaults.
  const at = new Date();
  await db.execute(
    sql`insert into ${channelConnections} (id, tenant_id, brand_id, provider_key, remote_account_id, display_name, credential_ref_id, granted_scopes, missing_scopes, status, token_expires_at, capability_version, created_at, updated_at) values (${publishingChannelConnectionId}, ${tenantId}, ${brandId}, 'fixture_provider', ${`pub-${publishingChannelConnectionId.slice(-8)}`}, 'Seeded publishing channel', ${publishingCredentialRefId}, '["w_post"]', '[]', 'active', ${new Date(Date.now() + 3600_000)}, 1, ${at}, ${at})`,
  );
  await db.execute(
    sql`insert into ${publications} (id, tenant_id, brand_id, content_package_id, content_revision_id, channel_variant_id, channel_connection_id, occurrence_key, authority, approval_id, mandate_id, scheduled_for, state, claimant, scheduled_by_kind, scheduled_by_id, created_at, updated_at) values (${publicationId}, ${tenantId}, ${brandId}, ${newId('contentPackage')}, ${newId('contentRevision')}, ${newId('channelVariant')}, ${publishingChannelConnectionId}, ${`seed:${publicationId}`}, 'approval', ${newId('releaseApproval')}, null, ${new Date(Date.now() + 3600_000)}, 'scheduled', ${`pub:${publicationId}`}, 'user', ${ownerUserId}, ${at}, ${at})`,
  );
  await db.insert(publicationAttempts).values({
    id: publicationAttemptId,
    tenantId,
    publicationId,
    attemptNumber: 1,
    fencingToken: 1,
    requestFingerprint: hashCanonical({ seed: publicationId }),
    providerIdempotencyKey: publicationAttemptId,
    startedAt: new Date(),
    outcome: 'unknown',
  });
  return { publishingCredentialRefId, publishingChannelConnectionId, publicationId, publicationAttemptId };
};
