import {
  assetDerivatives,
  assetVersions,
  assets,
  uploadIntents,
  usageRights,
} from '@oremedia/db/schema/assets';
import { sql } from 'drizzle-orm';
import { sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { CrossTenantFixture, SeedExtension } from '../cross-tenant-inputs';

/** One entry per assets.* procedure, every id pointing at the foreign tenant (spec 19.3). */
export const ASSETS_INPUTS: Record<string, CrossTenantFixture> = {
  'assets.uploads.createIntent': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'photo',
      declaredMime: 'image/png',
      declaredBytes: 1024,
      originalFilename: 'foreign.png',
    }),
  },
  'assets.uploads.complete': { buildInput: (f) => ({ intentId: f['uploadIntentId'] }) },
  'assets.uploads.get': { buildInput: (f) => ({ intentId: f['uploadIntentId'] }) },
  'assets.search': {
    buildInput: (f) => ({ query: { brandId: f['brandId'], purpose: 'creative' }, page: { limit: 50 } }),
  },
  'assets.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'assets.get': { buildInput: (f) => ({ assetId: f['assetId'] }) },
  'assets.versions.list': { buildInput: (f) => ({ assetId: f['assetId'], page: { limit: 50 } }) },
  'assets.rights.set': {
    buildInput: (f) => ({ assetId: f['assetId'], owner: 'x', permittedChannels: 'all', territories: 'all' }),
  },
  'assets.approve': { buildInput: (f) => ({ assetId: f['pendingAssetId'], expectedVersion: 0 }) },
  'assets.retire': { buildInput: (f) => ({ assetId: f['assetId'], expectedVersion: 0 }) },
  'assets.usages.list': { buildInput: (f) => ({ assetId: f['assetId'], page: { limit: 50 } }) },
  'assets.grants.create': {
    buildInput: (f) => ({ assetId: f['assetId'], granteeBrandId: f['brandId2'], purpose: 'creative' }),
  },
  'assets.fonts.list': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  // A foreign brand is NOT_FOUND before anything is fetched from Google Fonts.
  'assets.fonts.importGoogle': {
    buildInput: (f) => ({ brandId: f['brandId'], family: 'Inter', weights: [400], styles: ['normal'] }),
  },
  'assets.media.signedUrl': {
    buildInput: (f) => ({ assetVersionId: f['assetVersionId'], derivative: 'original' }),
  },
  // BSC-2: a foreign version is NOT_FOUND before any rendition is drawn or URL signed.
  'assets.media.download': {
    buildInput: (f) => ({ assetVersionId: f['assetVersionId'], format: 'png', width: 512 }),
  },
};

/**
 * Per tenant: one approved asset with a version, a preview derivative and recorded rights, one pending asset with
 * a version, and one issued upload intent, all in brand 1. Returns the ids a foreign caller might try to use.
 */
export const ASSETS_SEED: SeedExtension | null = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const assetId = newId('asset');
  const assetVersionId = newId('assetVersion');
  const pendingAssetId = newId('asset');
  const pendingVersionId = newId('assetVersion');
  const uploadIntentId = newId('uploadIntent');
  const usageRightsId = newId('usageRights');
  const version = (id: string, asset: string) => ({
    id,
    tenantId,
    brandId,
    assetId: asset,
    number: 1,
    storageKey: `assets/${tenantId}/${brandId}/${asset}/${id}/original`,
    contentHash: sha256Hex(id),
    mime: 'image/png',
    bytes: 1234,
    width: 64,
    height: 64,
    provenance: { kind: 'upload' as const, uploadedByUserId: ownerUserId, originalFilename: 'seed.png' },
  });
  await db.insert(assets).values([
    {
      id: assetId,
      tenantId,
      brandId,
      kind: 'photo',
      name: 'Seed approved photo',
      currentVersionId: assetVersionId,
      state: 'approved',
      rightsState: 'recorded',
    },
    {
      id: pendingAssetId,
      tenantId,
      brandId,
      kind: 'photo',
      name: 'Seed pending photo',
      currentVersionId: pendingVersionId,
      state: 'pending_review',
      rightsState: 'unknown',
    },
  ]);
  // sql``, not insert(…).values(): Drizzle would name media_info (0024) on asset_versions and rejection_detail (0024)
  // on upload_intents, which the roll-forward suites' earlier heads do not have; the columns named here exist at
  // every head, later ones take their defaults.
  for (const v of [version(assetVersionId, assetId), version(pendingVersionId, pendingAssetId)])
    await db.execute(
      sql`insert into ${assetVersions} (id, tenant_id, brand_id, asset_id, number, storage_key, content_hash, mime, bytes, width, height, provenance, created_at) values (${v.id}, ${v.tenantId}, ${v.brandId}, ${v.assetId}, ${v.number}, ${v.storageKey}, ${v.contentHash}, ${v.mime}, ${v.bytes}, ${v.width}, ${v.height}, ${JSON.stringify(v.provenance)}, ${new Date()})`,
    );
  await db.insert(assetDerivatives).values({
    id: newId('assetDerivative'),
    tenantId,
    brandId,
    assetVersionId,
    purpose: 'preview',
    transform: { op: 'resize', maxSide: 1024 },
    storageKey: `assets/${tenantId}/${brandId}/${assetId}/${assetVersionId}/preview`,
    contentHash: sha256Hex(`${assetVersionId}:preview`),
    mime: 'image/webp',
    width: 64,
    height: 64,
    bytes: 512,
  });
  await db.insert(usageRights).values({
    id: usageRightsId,
    tenantId,
    brandId,
    assetId,
    owner: 'Seed owner',
    permittedChannels: 'all',
    territories: 'all',
    releases: [],
    restrictions: [],
  });
  const at = new Date();
  await db.execute(
    sql`insert into ${uploadIntents} (id, tenant_id, brand_id, kind, declared_mime, declared_bytes, max_bytes, storage_key, original_filename, state, created_by_user_id, expires_at, created_at, updated_at) values (${uploadIntentId}, ${tenantId}, ${brandId}, 'photo', 'image/png', 1024, ${50 * 1024 * 1024}, ${`quarantine/${tenantId}/${uploadIntentId}`}, 'seed-intent.png', 'issued', ${ownerUserId}, ${new Date(Date.now() + 3600_000)}, ${at}, ${at})`,
  );
  return { assetId, assetVersionId, pendingAssetId, uploadIntentId, usageRightsId };
};
