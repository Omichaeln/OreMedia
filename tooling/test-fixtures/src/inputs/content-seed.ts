import { defaultPolicyDocument } from '@oremedia/contracts/brand';
import type { CopyDocumentV1 } from '@oremedia/contracts/content';
import type { Db } from '@oremedia/db';
import { policyVersions } from '@oremedia/db/schema/brand';
import {
  briefs,
  campaigns,
  channelVariants,
  contentPackages,
  contentRevisions,
  planItems,
} from '@oremedia/db/schema/content';
import { channelConnections, credentialRefs } from '@oremedia/db/schema/publishing';
import { sql } from 'drizzle-orm';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

export const seedCopy = (text = 'Seeded caption'): CopyDocumentV1 => ({
  schemaVersion: 1,
  master: { text, factRefs: [] },
});

/**
 * A package with revision 1 (draft) and one channel variant on a placeholder channel connection of the brand
 * (provider `fixture_provider`, placeholder credential). Shared by the content and review seeds.
 */
export async function seedContentPackage(
  db: Db,
  tenant: {
    tenantId: string;
    brandId: string;
    ownerUserId: string;
    brandVersionId: string;
    policyVersionId: string;
  },
  label: string,
) {
  const { tenantId, brandId } = tenant;
  const credentialRefId = newId('credentialRef');
  const channelConnectionId = newId('channelConnection');
  await db.insert(credentialRefs).values({
    id: credentialRefId,
    tenantId,
    kmsKeyId: 'fixture-kms-key',
    // VARBINARY columns travel as text (see the publishing envelope); placeholders within each column's length.
    wrappedDataKey: 'fixture-wrapped-key',
    ciphertext: 'fixture-ciphertext',
    iv: 'fixture-iv',
    authTag: 'fixture-authtag',
    aad: `${tenantId}:${channelConnectionId}`,
  });
  // sql``, not insert(channelConnections).values(): Drizzle would name health and health_checked_at (0022), which
  // the roll-forward suites' earlier heads do not have; the columns named here exist at every head.
  const seededAt = new Date();
  await db.execute(
    sql`insert into ${channelConnections} (id, tenant_id, brand_id, provider_key, remote_account_id, display_name, credential_ref_id, granted_scopes, missing_scopes, status, token_expires_at, capability_version, created_at, updated_at) values (${channelConnectionId}, ${tenantId}, ${brandId}, 'fixture_provider', ${`${label}-${channelConnectionId.slice(-8)}`}, ${`Seeded ${label} channel`}, ${credentialRefId}, '[]', '[]', 'active', null, 1, ${seededAt}, ${seededAt})`,
  );
  const contentPackageId = newId('contentPackage');
  const contentRevisionId = newId('contentRevision');
  const copy = seedCopy(`Seeded ${label} caption`);
  await db.insert(contentPackages).values({
    id: contentPackageId,
    tenantId,
    brandId,
    briefId: null,
    title: `Seeded ${label} package`,
    currentRevisionId: contentRevisionId,
    state: 'draft',
    version: 1,
  });
  await db.insert(contentRevisions).values({
    id: contentRevisionId,
    tenantId,
    brandId,
    packageId: contentPackageId,
    number: 1,
    brandVersionId: tenant.brandVersionId,
    policyVersionId: tenant.policyVersionId,
    copy,
    creativeRevisionIds: [],
    factRefs: [],
    contentHash: hashCanonical({
      copy,
      creativeRevisionIds: [],
      factRefs: [],
      brandVersionId: tenant.brandVersionId,
      policyVersionId: tenant.policyVersionId,
    }),
    state: 'draft',
    authorKind: 'user',
    authorId: tenant.ownerUserId,
  });
  const channelVariantId = newId('channelVariant');
  // sql``, not insert(channelVariants).values(): Drizzle would name destination_id (0018), which the roll-forward
  // suites' earlier heads do not have; the columns named here exist at every head, later ones take their defaults.
  const at = new Date();
  await db.execute(
    sql`insert into ${channelVariants} (id, tenant_id, brand_id, content_revision_id, channel_connection_id, text, alt_texts, settings, export_ids, capability_version, validation, created_at, updated_at) values (${channelVariantId}, ${tenantId}, ${brandId}, ${contentRevisionId}, ${channelConnectionId}, ${copy.master.text}, ${'[]'}, ${'{}'}, ${'[]'}, 1, ${JSON.stringify({ ok: true, issues: [] })}, ${at}, ${at})`,
  );
  return { channelConnectionId, contentPackageId, contentRevisionId, channelVariantId };
}

/**
 * Per tenant, on brand 1: an active policy version (the brand seed's is a draft), a campaign, a brief, and a
 * package with revision 1 and one channel variant, so a foreign caller has every content id to try (spec 19.3).
 * The published brand version comes from CREATIVE_SEED; the revision only references its id.
 */
export const CONTENT_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const contentPolicyVersionId = newId('policyVersion');
  await db.insert(policyVersions).values({
    id: contentPolicyVersionId,
    tenantId,
    brandId,
    number: 2,
    document: defaultPolicyDocument(),
    state: 'active',
    createdByUserId: ownerUserId,
  });
  const campaignId = newId('campaign');
  await db.insert(campaigns).values({
    id: campaignId,
    tenantId,
    brandId,
    objectiveId: null,
    name: 'Seeded campaign',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2026-12-31T00:00:00Z'),
    state: 'draft',
  });
  const briefId = newId('brief');
  await db.insert(briefs).values({
    id: briefId,
    tenantId,
    brandId,
    campaignId,
    audience: 'Seeded audience',
    message: 'Seeded message',
    offerFactIds: [],
    channelConnectionIds: [],
    constraints: [],
    state: 'draft',
    createdByKind: 'user',
    createdById: ownerUserId,
  });
  // plan_items arrives with migration 0014: the roll-forward suites seed earlier heads, where the table does not
  // exist yet, so the row is written only when it does (the harness fixtures that need it run at head).
  const planItemId = newId('planItem');
  const planItemsTable = await db.execute(
    sql`select 1 as present from information_schema.tables where table_schema = database() and table_name = 'plan_items'`,
  );
  const hasPlanItems = Array.isArray(planItemsTable[0]) && planItemsTable[0].length > 0;
  if (hasPlanItems)
    await db.insert(planItems).values({
      id: planItemId,
      tenantId,
      brandId,
      briefId,
      date: '2026-03-01',
      channelKey: 'fixture_provider',
      channelConnectionId: null,
      theme: 'Seeded plan item',
      formatKey: 'post',
      factIds: [],
      state: 'proposed',
      contentPackageId: null,
      createdByKind: 'user',
      createdById: ownerUserId,
      agentRunId: null,
    });
  const pkg = await seedContentPackage(
    db,
    {
      tenantId,
      brandId,
      ownerUserId,
      brandVersionId: newId('brandVersion'),
      policyVersionId: contentPolicyVersionId,
    },
    'content',
  );
  return { contentPolicyVersionId, campaignId, briefId, planItemId, ...pkg };
};
