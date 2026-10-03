import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  ACCEPTED_MIMES,
  ARCHIVE_MIMES,
  AssetApprove,
  AssetGet,
  AssetGrantCreate,
  AssetList,
  AssetRetire,
  type AssetIssue,
  AssetSearch,
  AssetUsagesList,
  AssetVersionsList,
  BrandFontsList,
  EligibilityQuery,
  GOOGLE_FONTS_LICENCE_NOTE,
  GOOGLE_FONTS_SOURCE,
  GoogleFontImport,
  KIND_MIME_GROUPS,
  AssetDownloadRequest,
  MediaSignedUrlRequest,
  RIGHTS_ATTENTION_DAYS,
  SIGNED_URL_TTL_SEC,
  UPLOAD_CAPS_BYTES,
  UPLOAD_INTENT_TTL_SEC,
  UploadIntentComplete,
  UploadIntentCreate,
  UploadIntentGet,
  UsageRightsInput,
  type AssetKind,
  type AssetPurpose,
  type AssetRef,
  type BrandFontFace,
  type DerivativePurpose,
  ingestRejectionMessage,
  type GoogleFontImportFile,
  type GoogleFontImportResult,
  type Provenance,
} from '@oremedia/contracts/assets';
import {
  NotFoundError,
  PolicyDeniedError,
  ReleaseIntegrityError,
  RightsIneligibleError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import { ID_LIST_MAX, type Page, type PageRequest } from '@oremedia/contracts/pagination';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { assetMachine, uploadIntentMachine } from '@oremedia/domain';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { audit, outbox } from '@oremedia/module-operations';
import { logger } from '@oremedia/observability';
import { compatibleKinds, evaluateEligibility, rightsExpiryThreshold, rightsRequired } from './eligibility';
import { fontFileIdentity, groupFontFaces, isFaceFile, type FontFileRow } from './fonts';
import { fetchGoogleFontFiles, type GoogleFontFile } from './google-fonts';
import {
  AssetDerivativeRepository,
  AssetGrantRepository,
  AssetRepository,
  AssetUsageRepository,
  AssetVersionRepository,
  GeneratedUploadRepository,
  UploadIntentRepository,
  UsageRightsRepository,
  type AssetRow,
  type AssetVersionRow,
  type UploadIntentRow,
  type UsageRightsRow,
} from './repositories';
import { PNG_RENDITION_MAX_SIDE, rasterPngRendition, svgPngRendition } from './ingest/steps';
import { hashStoredObject, storage, storageKeys } from './storage';

const assetsRepo = new AssetRepository();
const versionsRepo = new AssetVersionRepository();
const derivativesRepo = new AssetDerivativeRepository();
const rightsRepo = new UsageRightsRepository();
const grantsRepo = new AssetGrantRepository();
const usagesRepo = new AssetUsageRepository();
const intentsRepo = new UploadIntentRepository();
const generatedRepo = new GeneratedUploadRepository();

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const brandResource = (brandId: string) => ({
  type: 'brand',
  tenantId: requireTenant().tenantId,
  brandId,
  id: brandId,
});

/** The issues the library names on an asset (spec 21.2), derived from the same rows the eligibility rule reads. */
function assetIssues(
  a: AssetRow,
  v: AssetVersionRow | null,
  r: UsageRightsRow | null,
  now: Date,
  attentionBefore: Date,
): AssetIssue[] {
  const out: AssetIssue[] = [];
  if (a.state === 'pending_review' || a.state === 'rejected' || a.state === 'retired') out.push(a.state);
  if (a.rightsState !== 'recorded' || !r) out.push('rights_unknown');
  else if (r.expiresAt && r.expiresAt.getTime() < now.getTime()) out.push('rights_expired');
  else if (r.expiresAt && r.expiresAt.getTime() < attentionBefore.getTime()) out.push('rights_expiring');
  if (!v) out.push('no_version');
  return out;
}

const assetResource = (a: AssetRow) => ({
  type: 'asset',
  tenantId: requireTenant().tenantId,
  brandId: a.brandId,
  id: a.id,
  state: a.state,
});

const toRef = (a: AssetRow, v: AssetVersionRow): AssetRef => ({
  assetId: a.id,
  assetVersionId: v.id,
  kind: a.kind,
  semanticRole: a.semanticRole,
  altText: v.altText,
  contentHash: v.contentHash,
  width: v.width,
  height: v.height,
  durationMs: v.durationMs,
});

const fontFileRow = (r: { asset: AssetRow; version: AssetVersionRow }): FontFileRow => ({
  assetId: r.asset.id,
  assetName: r.asset.name,
  assetState: r.asset.state,
  assetVersionId: r.version.id,
  mime: r.version.mime,
  bytes: r.version.bytes,
  provenance: r.version.provenance,
});

/** Provenance a server-side upload records with its intent (generated media, imported files). */
type IntentProvenance = Extract<Provenance, { kind: 'generated' | 'imported' }>;

const versionView = (v: AssetVersionRow) => ({
  id: v.id,
  assetId: v.assetId,
  number: v.number,
  mime: v.mime,
  bytes: v.bytes,
  width: v.width,
  height: v.height,
  durationMs: v.durationMs,
  /** STU-2a: what ffprobe found in a video or audio source (codecs, frame rate, rotation, streams). */
  media: v.mediaInfo ?? null,
  colourProfile: v.colourProfile,
  focalPoint: v.focalPoint,
  altText: v.altText,
  contentHash: v.contentHash,
  provenance: v.provenance,
  createdAt: v.createdAt,
});

const SVG_MIME = 'image/svg+xml';
const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'font/otf': 'otf',
  'font/ttf': 'ttf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'application/pdf': 'pdf',
};
/** A file name people recognise: the asset's name without its old extension, a suffix, the type's extension. */
function downloadFilename(name: string, mime: string, suffix = ''): string {
  const base =
    name
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\p{Cc}+/gu, '')
      .trim()
      .slice(0, 120) || 'asset';
  return `${base}${suffix}.${FILE_EXTENSIONS[mime] ?? 'bin'}`;
}
/** Versions a PNG can be drawn from: an SVG, or a raster image ingest re-encoded. */
const drawable = (mime: string): boolean =>
  mime === SVG_MIME || (ACCEPTED_MIMES['image'] ?? []).includes(mime);

interface StoredRendition {
  key: string;
  mime: string;
  contentHash: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

/**
 * BSC-2: a PNG rendition of a version, transparency kept: `png` (the one ingest keeps for an SVG, longer side 2048) or
 * `png-<width>` for a download. One already recorded is reused; otherwise it is drawn from the original now, written
 * under the version's immutable prefix and recorded as a derivative row (tenant and brand deletion find objects by
 * their rows). Null when the original cannot be drawn.
 */
async function pngRendition(
  v: AssetVersionRow,
  width: number | null,
  tx?: Tx,
): Promise<StoredRendition | null> {
  if (!tx) return withTransaction((t) => pngRendition(v, width, t));
  // Concurrent requests for the same rendition wait here, then find the row the first one recorded.
  await versionsRepo.lockInTenant(v.id, tx);
  const purpose = width ? `png-${width}` : 'png';
  const existing = await derivativesRepo.find(v.id, purpose, tx);
  if (existing)
    return {
      key: existing.storageKey,
      mime: existing.mime,
      contentHash: existing.contentHash,
      width: existing.width,
      height: existing.height,
      bytes: existing.bytes,
    };
  const original = await storage().getObject(v.storageKey);
  if (!original) throw new NotFoundError('AssetObject', v.storageKey);
  const drawn =
    v.mime === SVG_MIME
      ? await svgPngRendition(
          original,
          width ?? PNG_RENDITION_MAX_SIDE,
          undefined,
          width ? { side: 'width' } : {},
        )
      : await rasterPngRendition(original, width ?? v.width ?? PNG_RENDITION_MAX_SIDE);
  if (!drawn) return null;
  const { tenantId } = requireTenant();
  const key = storageKeys.derivative(tenantId, v.brandId, v.assetId, v.id, purpose);
  await storage().putObject(key, drawn.bytes, { contentType: drawn.mime });
  const rendition = {
    key,
    mime: drawn.mime,
    contentHash: sha256(drawn.bytes),
    width: drawn.width,
    height: drawn.height,
    bytes: drawn.bytes.length,
  };
  await derivativesRepo.createRelease(
    {
      id: newId('assetDerivative'),
      brandId: v.brandId,
      assetVersionId: v.id,
      purpose,
      transform: drawn.transform,
      storageKey: key,
      contentHash: rendition.contentHash,
      mime: rendition.mime,
      width: rendition.width,
      height: rendition.height,
      bytes: rendition.bytes,
    },
    tx,
  );
  return rendition;
}

export interface AuthoriseUseOptions {
  /** The brand the asset is being used for (its own brand, or a grantee brand). */
  brandId: string;
  /** RA-08: the asset kinds and types the use accepts (a website page takes raster images only); any when absent. */
  kinds?: readonly AssetKind[];
  mimes?: readonly string[];
  channelConnectionIds?: readonly string[];
  territory?: string;
  scheduledFor?: Date;
  now?: Date;
}

export const assetService = {
  /** Spec 9.1: declared mime and size are checked against the kind's accepted list and cap; returns a presigned PUT. */
  async createIntent(actor: ResolvedActor, input: z.infer<typeof UploadIntentCreate>, tx: Tx) {
    const parsed = UploadIntentCreate.parse(input);
    await brandService.assertExist([parsed.brandId], tx);
    assetsRepo.assertBrandVisible(parsed.brandId); // an invisible brand behaves like a missing one (spec 5.3)
    const decision = await policy.assert(actor, 'asset.upload', brandResource(parsed.brandId), {}, tx);
    if (decision.obligations?.some((o) => o.type === 'propose_only'))
      throw new PolicyDeniedError('propose_only', 'Agents may only propose uploads');
    const { id, storageKey, mime, maxBytes, expiresAt } = await issueIntent(actor, parsed, null, tx);
    const upload = await storage().signUploadUrl(storageKey, {
      contentType: mime,
      expiresInSec: UPLOAD_INTENT_TTL_SEC,
    });
    return { intentId: id, uploadUrl: upload.url, expiresAt, maxBytes };
  },

  /** issued → uploaded; the outbox event's consumer is assetIngestWorkflowV1 (spec 9.1 "complete → Temporal"). */
  async completeUpload(actor: ResolvedActor, input: z.infer<typeof UploadIntentComplete>, tx: Tx) {
    const parsed = UploadIntentComplete.parse(input);
    const intent = await intentsRepo.getById(parsed.intentId, tx);
    await policy.assert(actor, 'asset.upload', brandResource(intent.brandId), {}, tx);
    return markUploaded(actor, intent, tx);
  },

  /**
   * Where an upload stands (spec 9.1): issued, uploaded, quarantined while ingest runs, then accepted with the asset it
   * became or rejected with the reason. For the uploader's client (the web app, a smoke check) to follow ingest; the
   * same read permission as the asset library, in the intent's brand.
   */
  async uploadStatus(actor: ResolvedActor, input: z.infer<typeof UploadIntentGet>, tx?: Tx) {
    const parsed = UploadIntentGet.parse(input);
    const intent = await intentsRepo.getById(parsed.intentId, tx);
    assetsRepo.assertBrandVisible(intent.brandId);
    await policy.assert(actor, 'asset.read', brandResource(intent.brandId), {}, tx);
    return {
      intentId: intent.id,
      state: intent.state,
      assetId: intent.resultAssetId ?? null,
      rejectionReason: intent.rejectionReason ?? null,
      /** BSC-2: what the uploader is told, and what to do about it (null while not rejected). */
      rejectionMessage: ingestRejectionMessage(intent.rejectionReason),
      /** STU-2a: what was found and the limit it broke (video and audio ingest), when the step recorded one. */
      rejectionDetail: intent.rejectionDetail ?? null,
      kind: intent.kind,
    };
  },

  /**
   * ADR-11: bytes from a generation provider enter exactly like an upload. The intent is issued with the generated
   * provenance, the bytes are written to its quarantine key and the intent completes, so assetIngestWorkflowV1 runs
   * every step an upload gets (sniff, scan, sanitise, hash, derivatives) and catalogues a pending asset whose
   * version records the provenance. Authorised as creative.edit, the images tool's action: an agent may not upload
   * outright (asset.upload is propose_only), and a pending asset is the proposal a person approves. Generated video
   * and audio (D-06) go through videoIngestWorkflowV1 like a person's own (STU-2a) and keep the generated duration
   * caps (MEDIA_DURATION_CAPS_SECONDS).
   */
  async uploadGenerated(
    actor: ResolvedActor,
    input: {
      brandId: string;
      kind: 'photo' | 'illustration' | 'video' | 'audio';
      mime: string;
      bytes: Buffer;
      originalFilename: string;
      provenance: Extract<Provenance, { kind: 'generated' }>;
    },
    tx: Tx,
    opts: { autonomyMode?: AutonomyMode } = {},
  ): Promise<{ intentId: string }> {
    const parsed = UploadIntentCreate.parse({
      brandId: input.brandId,
      kind: input.kind,
      declaredMime: input.mime,
      declaredBytes: input.bytes.length,
      originalFilename: input.originalFilename,
    });
    await brandService.assertExist([parsed.brandId], tx);
    assetsRepo.assertBrandVisible(parsed.brandId);
    await policy.assert(actor, 'creative.edit', brandResource(parsed.brandId), opts, tx);
    const { id, storageKey, mime } = await issueIntent(actor, parsed, input.provenance, tx);
    await storage().putObject(storageKey, input.bytes, { contentType: mime });
    await markUploaded(actor, await intentsRepo.getById(id, tx), tx);
    return { intentId: id };
  },

  /**
   * Where generated uploads stand: accepted ones carry their asset version; a rejection carries its reason. Internal
   * to the image generator's poll (no router exposes it); reads stay tenant- and brand-scoped through the repositories.
   */
  async generatedUploadStatus(intentIds: readonly string[], tx?: Tx) {
    const out: Array<
      | { intentId: string; state: 'pending' }
      | { intentId: string; state: 'rejected'; reason: string }
      | {
          intentId: string;
          state: 'accepted';
          assetId: string;
          storageKey: string;
          contentHash: string;
          width: number;
          height: number;
        }
    > = [];
    for (const intentId of intentIds) {
      const intent = await intentsRepo.getById(intentId, tx);
      if (intent.state === 'rejected') {
        out.push({ intentId, state: 'rejected', reason: intent.rejectionReason ?? 'rejected' });
        continue;
      }
      if (intent.state !== 'accepted' || !intent.resultAssetId) {
        out.push({ intentId, state: 'pending' });
        continue;
      }
      const asset = await assetsRepo.getById(intent.resultAssetId, tx);
      const version = asset.currentVersionId ? await versionsRepo.getById(asset.currentVersionId, tx) : null;
      if (!version) {
        out.push({ intentId, state: 'pending' });
        continue;
      }
      out.push({
        intentId,
        state: 'accepted',
        assetId: asset.id,
        storageKey: version.storageKey,
        contentHash: version.contentHash,
        width: version.width ?? 0,
        height: version.height ?? 0,
      });
    }
    return out;
  },

  /**
   * Brand kit typography: the brand's font faces (spec 8.1 type roles name one). An imported face's subset files are
   * one face; an uploaded file is a face of its own, its family and style read from the file at ingest.
   */
  async listFonts(
    actor: ResolvedActor,
    input: z.infer<typeof BrandFontsList>,
    tx?: Tx,
  ): Promise<{ items: BrandFontFace[] }> {
    const { brandId } = BrandFontsList.parse(input);
    await brandService.assertExist([brandId], tx);
    assetsRepo.assertBrandVisible(brandId);
    await policy.assert(actor, 'asset.read', brandResource(brandId), {}, tx);
    const rows = await assetsRepo.listFontFiles(brandId, tx);
    return { items: groupFontFaces(rows.map(fontFileRow)) };
  },

  /**
   * Imports a family from Google Fonts into the brand's fonts: the css2 stylesheet names one WOFF2 file per face and
   * unicode subset (latin and latin-ext unless the input names others; a variable family one file per subset for
   * all its weights), each downloaded from fonts.gstatic.com (google-fonts.ts: two hosts only, SSRF-safe, capped)
   * and handed to the asset pipeline like an upload, so ingest scans, parses and catalogues it as a font asset whose
   * provenance records the source, face, subset, unicode-range, source URL and licence note. The same permission as
   * editing the brand kit; agents may not.
   *
   * Three steps, so no database connection is held while Google answers: (1) a short transaction checks the brand
   * and the permission; (2) every file is downloaded, outside any transaction (a failure part-way writes nothing);
   * (3) `run` (the router's idempotent wrapper) records one upload intent per new file with its provenance and the
   * audit event; then (4) each intent still `issued` gets its bytes in quarantine and is completed in its own short
   * transaction, which starts ingest, exactly as a browser upload does. A replay of the same request re-runs (4) for
   * the recorded intents, so an interrupted import finishes; an intent never completed expires like an abandoned
   * upload. A file whose bytes a live font asset of the brand already holds is reported as existing, not ingested.
   */
  async importGoogleFont(
    actor: ResolvedActor,
    input: z.input<typeof GoogleFontImport>,
    run: <T>(command: (tx: Tx) => Promise<T>) => Promise<T> = (command) => withTransaction(command),
  ): Promise<GoogleFontImportResult> {
    const parsed = GoogleFontImport.parse(input);
    await withTransaction(async (tx) => {
      await brandService.assertExist([parsed.brandId], tx);
      assetsRepo.assertBrandVisible(parsed.brandId);
      const decision = await policy.assert(
        actor,
        'brand.edit_standards',
        brandResource(parsed.brandId),
        {},
        tx,
      );
      if (decision.obligations?.some((o) => o.type === 'propose_only'))
        throw new PolicyDeniedError('propose_only', 'Agents may only propose; a brand manager imports fonts');
    });
    const downloaded = (await fetchGoogleFontFiles(parsed)).map((f) => ({
      ...f,
      contentHash: sha256(f.bytes),
    }));
    const result = await run((tx) => recordFontImport(actor, parsed.brandId, parsed.family, downloaded, tx));
    const bytesByHash = new Map(downloaded.map((f) => [f.contentHash, f.bytes]));
    for (const f of result.files) {
      const bytes = bytesByHash.get(f.contentHash);
      if (f.outcome !== 'queued' || !f.intentId || !bytes) continue;
      const intent = await intentsRepo.getById(f.intentId);
      if (intent.state !== 'issued') continue;
      await storage().putObject(intent.storageKey, bytes, { contentType: intent.declaredMime });
      await withTransaction(async (tx) => {
        const current = await intentsRepo.getById(intent.id, tx);
        if (current.state === 'issued') await markUploaded(actor, current, tx);
      });
    }
    return result;
  },

  /**
   * For the render worker (spec 11.5): the files of the face an asset version belongs to, in the version's own brand
   * (the version itself first). An uploaded font is its only file; an imported face adds its other subset files.
   */
  async fontFaceFiles(assetVersionId: string, tx?: Tx): Promise<string[]> {
    const version = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!version) throw new NotFoundError('AssetVersion', assetVersionId);
    if (!isFaceFile(version.provenance)) return [version.id];
    const own = fontFileIdentity(version.assetId, version.provenance);
    const rows = await assetsRepo.listFontFilesInTenant(version.brandId, tx);
    // One file per other subset of the same face (the key includes the source's release), in a stable order: the
    // same pinned document always resolves the same files for as long as those assets are live.
    const bySubset = new Map<string, string>();
    for (const r of rows
      .map((r) => ({
        id: r.version.id,
        assetId: r.asset.id,
        ...fontFileIdentity(r.asset.id, r.version.provenance),
      }))
      .filter((r) => r.key === own.key && r.subset !== own.subset)
      .sort((a, b) => (a.subset ?? '').localeCompare(b.subset ?? '') || a.assetId.localeCompare(b.assetId)))
      if (!bySubset.has(r.subset ?? '')) bySubset.set(r.subset ?? '', r.id);
    return [version.id, ...bySubset.values()];
  },

  /**
   * The brand module's check of a brand system draft (registered as its BrandAssetKindSource): the kind of each
   * listed asset that belongs to the brand and is not retired. Missing, foreign, other-brand and retired ids are
   * absent. Reads through the scoped repository, so an id outside the caller's tenant is simply not found.
   */
  async kindsForBrand(
    brandId: string,
    assetIds: readonly string[],
    tx?: Tx,
  ): Promise<Map<string, AssetKind>> {
    const out = new Map<string, AssetKind>();
    for (const id of assetIds.slice(0, ID_LIST_MAX)) {
      const a = await assetsRepo.findInTenant(id, tx);
      if (a && a.brandId === brandId && a.state !== 'retired') out.set(a.id, a.kind);
    }
    return out;
  },

  /**
   * The brand module's check of a logo rule's pinned version (registered as its BrandAssetVersionSource): the asset
   * each listed version belongs to, for versions of this brand's assets that are not retired. Anything else is absent.
   */
  async assetsOfVersions(
    brandId: string,
    assetVersionIds: readonly string[],
    tx?: Tx,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of assetVersionIds.slice(0, ID_LIST_MAX)) {
      const v = await versionsRepo.findInTenant(id, tx);
      if (!v || v.brandId !== brandId) continue;
      const a = await assetsRepo.findInTenant(v.assetId, tx);
      if (a && a.brandId === brandId && a.state !== 'retired') out.set(v.id, a.id);
    }
    return out;
  },

  /** Any asset id from a client is loaded through the scoped repository first; a foreign id is NOT_FOUND. */
  async get(actor: ResolvedActor, input: z.infer<typeof AssetGet>, tx?: Tx) {
    const { assetId } = AssetGet.parse(input);
    const a = await assetsRepo.getById(assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    const current = a.currentVersionId ? await versionsRepo.findById(a.currentVersionId, tx) : null;
    const rights = await rightsRepo.findForAsset(a.id, tx);
    const derivatives = current ? await derivativesRepo.listForVersion(current.id, tx) : [];
    return {
      id: a.id,
      brandId: a.brandId,
      kind: a.kind,
      name: a.name,
      semanticRole: a.semanticRole,
      state: a.state,
      rightsState: a.rightsState,
      version: a.version,
      currentVersion: current ? versionView(current) : null,
      derivatives: derivatives.map((d) => ({
        id: d.id,
        purpose: d.purpose,
        mime: d.mime,
        width: d.width,
        height: d.height,
        bytes: d.bytes,
      })),
      rights: rights
        ? {
            id: rights.id,
            owner: rights.owner,
            licenceRef: rights.licenceRef,
            permittedChannels: rights.permittedChannels,
            territories: rights.territories,
            expiresAt: rights.expiresAt,
            releases: rights.releases,
            restrictions: rights.restrictions,
            version: rights.version,
          }
        : null,
    };
  },

  async listVersions(actor: ResolvedActor, input: z.infer<typeof AssetVersionsList>, tx?: Tx) {
    const parsed = AssetVersionsList.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    const p = await versionsRepo.listForAsset(a.id, parsed.page, tx);
    return { items: p.items.map(versionView), nextCursor: p.nextCursor };
  },

  /**
   * The librarian's list (spec 21.2 asset states): every asset of the brand, newest first, each with the issues
   * that keep it out of the eligibility search (or will within the attention window). Read as `search` is.
   */
  async list(actor: ResolvedActor, input: z.infer<typeof AssetList>, tx?: Tx, now: Date = new Date()) {
    const parsed = AssetList.parse(input);
    await brandService.assertExist([parsed.brandId], tx);
    assetsRepo.assertBrandVisible(parsed.brandId);
    await policy.assert(actor, 'asset.read', brandResource(parsed.brandId), {}, tx);
    const attentionBefore = new Date(now.getTime() + RIGHTS_ATTENTION_DAYS * 86_400_000);
    const p = await assetsRepo.list(
      parsed.brandId,
      {
        state: parsed.state,
        kinds: parsed.kinds,
        text: parsed.query,
        needsAttentionBefore: parsed.needsAttention ? attentionBefore : undefined,
      },
      parsed.page,
      tx,
    );
    return {
      items: p.items.map(({ asset: a, version: v, rights: r }) => ({
        id: a.id,
        brandId: a.brandId,
        kind: a.kind,
        name: a.name,
        semanticRole: a.semanticRole,
        state: a.state,
        rightsState: a.rightsState,
        version: a.version,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        currentVersion: v
          ? {
              id: v.id,
              number: v.number,
              mime: v.mime,
              width: v.width,
              height: v.height,
              durationMs: v.durationMs,
              altText: v.altText,
              contentHash: v.contentHash,
            }
          : null,
        rights: r
          ? {
              owner: r.owner,
              permittedChannels: r.permittedChannels,
              territories: r.territories,
              expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
            }
          : null,
        issues: assetIssues(a, v, r, now, attentionBefore),
      })),
      nextCursor: p.nextCursor,
    };
  },

  /** Spec 7.5 `search`: the eligibility filter (9.2) runs before anything else; ineligible assets never appear. */
  async search(actor: ResolvedActor, input: z.infer<typeof AssetSearch>, tx?: Tx): Promise<Page<AssetRef>> {
    const parsed = AssetSearch.parse(input);
    await brandService.assertExist([parsed.query.brandId], tx);
    assetsRepo.assertBrandVisible(parsed.query.brandId);
    await policy.assert(actor, 'asset.read', brandResource(parsed.query.brandId), {}, tx);
    return assetService.findEligibleAssets(parsed.query, parsed.page, tx);
  },

  /**
   * Spec 9.2 `findEligibleAssets(query, purpose)`: tenant ∧ (brand ∨ active grant for purpose) ∧ approved ∧ rights
   * permitting channels, territory and the date range ∧ kind compatible with purpose. Applied BEFORE any ranking
   * or retrieval; the same rule (evaluateEligibility) is re-run per row and again by authoriseUse.
   */
  async findEligibleAssets(
    query: EligibilityQuery,
    req: PageRequest,
    tx?: Tx,
    now: Date = new Date(),
  ): Promise<Page<AssetRef>> {
    const q = EligibilityQuery.parse(query);
    const scheduledFor = q.scheduledFor ? new Date(q.scheduledFor) : undefined;
    const kinds = compatibleKinds(q.purpose, q.kinds);
    const candidates = await assetsRepo.findEligibleCandidates(
      {
        brandId: q.brandId,
        purpose: q.purpose,
        kinds,
        rightsRequired: rightsRequired(q.purpose),
        expiryThreshold: rightsExpiryThreshold(scheduledFor, now),
        now,
        text: q.query,
      },
      req,
      tx,
    );
    const request = {
      brandId: q.brandId,
      purpose: q.purpose,
      channelConnectionIds: q.channelConnectionIds,
      territory: q.territory,
      scheduledFor,
      kinds: q.kinds,
    };
    const items: AssetRef[] = [];
    for (const c of candidates.items) {
      if (!c.version) continue;
      const verdict = evaluateEligibility(
        {
          brandId: c.asset.brandId,
          state: c.asset.state,
          kind: c.asset.kind,
          rightsState: c.asset.rightsState,
          rights: c.rights,
          grantActive: c.grantId !== null,
        },
        request,
        now,
      );
      if (verdict.eligible) items.push(toRef(c.asset, c.version));
    }
    return { items, nextCursor: candidates.nextCursor };
  },

  /**
   * Spec 9.2: re-runs the eligibility rule for one version at the point of effect (render, dispatch). Throws
   * RIGHTS_INELIGIBLE with the reason; rights expiring between approval and publication cause a hold, never a
   * silent publish.
   */
  async authoriseUse(assetVersionId: string, purpose: AssetPurpose, opts: AuthoriseUseOptions, tx?: Tx) {
    assetsRepo.assertBrandVisible(opts.brandId);
    const version = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!version) throw new NotFoundError('AssetVersion', assetVersionId);
    const asset = await assetsRepo.findInTenant(version.assetId, tx);
    if (!asset) throw new NotFoundError('Asset', version.assetId);
    if (asset.currentVersionId !== version.id)
      throw new RightsIneligibleError(version.id, 'version_not_current');
    if (opts.kinds && !opts.kinds.includes(asset.kind))
      throw new RightsIneligibleError(version.id, 'kind_not_allowed');
    if (opts.mimes && !opts.mimes.includes(version.mime.toLowerCase()))
      throw new RightsIneligibleError(version.id, 'mime_not_allowed');
    const now = opts.now ?? new Date();
    const grant =
      asset.brandId === opts.brandId
        ? null
        : await grantsRepo.findActive(asset.id, opts.brandId, purpose, now, tx);
    const rights = await rightsRepo.findForAsset(asset.id, tx);
    const verdict = evaluateEligibility(
      {
        brandId: asset.brandId,
        state: asset.state,
        kind: asset.kind,
        rightsState: asset.rightsState,
        rights,
        grantActive: grant !== null,
      },
      {
        brandId: opts.brandId,
        purpose,
        channelConnectionIds: opts.channelConnectionIds ?? [],
        territory: opts.territory,
        scheduledFor: opts.scheduledFor,
      },
      now,
    );
    if (!verdict.eligible) throw new RightsIneligibleError(version.id, verdict.reason);
    return {
      assetId: asset.id,
      assetVersionId: version.id,
      brandId: asset.brandId,
      contentHash: version.contentHash,
    };
  },

  /** Upsert of the single usage_rights row per asset; marks the asset's rights as recorded. */
  async setRights(actor: ResolvedActor, input: z.infer<typeof UsageRightsInput>, tx: Tx) {
    const parsed = UsageRightsInput.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.manage_rights', assetResource(a), {}, tx);
    const values = {
      owner: parsed.owner,
      licenceRef: parsed.licenceRef ?? null,
      permittedChannels: parsed.permittedChannels,
      territories: parsed.territories,
      expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      releases: parsed.releases,
      restrictions: parsed.restrictions,
    };
    const existing = await rightsRepo.findForAsset(a.id, tx);
    let id: string;
    if (existing) {
      id = existing.id;
      await rightsRepo.update(existing.id, existing.version, values, tx);
    } else {
      id = newId('usageRights');
      await rightsRepo.create({ id, brandId: a.brandId, assetId: a.id, ...values }, tx);
    }
    if (a.rightsState !== 'recorded')
      await assetsRepo.update(a.id, a.version, { rightsState: 'recorded' }, tx);
    await audit.record(
      actorRef(actor),
      'asset.rights_recorded',
      { type: 'usage_rights', id },
      'allowed',
      tx,
      {
        brandId: a.brandId,
      },
    );
    return { usageRightsId: id };
  },

  async approve(actor: ResolvedActor, input: z.infer<typeof AssetApprove>, tx: Tx) {
    const parsed = AssetApprove.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.approve', assetResource(a), {}, tx);
    if (!assetMachine.can(a.state, 'approve'))
      throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
    const next = assetMachine.transition(a.state, 'approve');
    await assetsRepo.update(a.id, parsed.expectedVersion, { state: next }, tx);
    await audit.record(actorRef(actor), 'asset.approved', { type: 'asset', id: a.id }, 'allowed', tx, {
      brandId: a.brandId,
      fromState: a.state,
      toState: next,
    });
    return { assetId: a.id, state: next, version: parsed.expectedVersion + 1 };
  },

  async retire(actor: ResolvedActor, input: z.infer<typeof AssetRetire>, tx: Tx) {
    const parsed = AssetRetire.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.approve', assetResource(a), {}, tx);
    if (!assetMachine.can(a.state, 'retire'))
      throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
    const next = assetMachine.transition(a.state, 'retire');
    await assetsRepo.update(a.id, parsed.expectedVersion, { state: next }, tx);
    await audit.record(actorRef(actor), 'asset.retired', { type: 'asset', id: a.id }, 'allowed', tx, {
      brandId: a.brandId,
      fromState: a.state,
      toState: next,
      reason: parsed.reason ?? null,
    });
    await outbox.add(
      'asset.retired',
      { type: 'asset', id: a.id, version: parsed.expectedVersion + 1 },
      { assetId: a.id, brandId: a.brandId, reason: parsed.reason ?? null },
      tx,
      { brandId: a.brandId },
    );
    return { assetId: a.id, state: next, version: parsed.expectedVersion + 1 };
  },

  async listUsages(actor: ResolvedActor, input: z.infer<typeof AssetUsagesList>, tx?: Tx) {
    const parsed = AssetUsagesList.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    const versionIds = await versionsRepo.idsForAsset(a.id, tx);
    const p = await usagesRepo.listForVersions(versionIds, parsed.page, tx);
    return {
      items: p.items.map((u) => ({
        id: u.id,
        assetVersionId: u.assetVersionId,
        usedByType: u.usedByType,
        usedById: u.usedById,
        createdAt: u.createdAt,
      })),
      nextCursor: p.nextCursor,
    };
  },

  /** Records that a version is used by a revision, export or publication (impact analysis). Idempotent. */
  async recordUsage(assetVersionId: string, usedByType: string, usedById: string, tx: Tx) {
    const version = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!version) throw new NotFoundError('AssetVersion', assetVersionId);
    try {
      await usagesRepo.record(
        {
          id: newId('assetUsage'),
          brandId: version.brandId,
          assetVersionId: version.id,
          usedByType,
          usedById,
        },
        tx,
      );
    } catch (err) {
      const code =
        (err as { code?: string } | undefined)?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== 'ER_DUP_ENTRY') throw err;
    }
  },

  /** Spec 5.1 cross-brand reuse inside one tenant: both brands must exist here; a foreign brand is NOT_FOUND. */
  async createGrant(actor: ResolvedActor, input: z.infer<typeof AssetGrantCreate>, tx: Tx) {
    const parsed = AssetGrantCreate.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.manage_rights', assetResource(a), {}, tx);
    await brandService.assertExist([parsed.granteeBrandId], tx);
    if (parsed.granteeBrandId === a.brandId)
      throw new ValidationFailedError([{ path: 'granteeBrandId', issue: 'grantee_is_owner_brand' }]);
    if (a.state === 'retired' || a.state === 'rejected')
      throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
    if (await grantsRepo.find(a.id, parsed.granteeBrandId, parsed.purpose, tx))
      throw new ValidationFailedError([{ path: 'granteeBrandId', issue: 'grant_exists' }]);
    const id = newId('assetGrant');
    await grantsRepo.create(
      {
        id,
        brandId: a.brandId,
        assetId: a.id,
        granteeBrandId: parsed.granteeBrandId,
        purpose: parsed.purpose,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        createdByUserId: actor.id,
      },
      tx,
    );
    await audit.record(actorRef(actor), 'asset.grant_created', { type: 'asset_grant', id }, 'allowed', tx, {
      brandId: a.brandId,
    });
    return { grantId: id };
  },

  /**
   * A 5-minute signed GET for a storage key another module has already authorised (the review module's frozen
   * exports, spec 13.3); the caller, not this method, decides who may read it.
   */
  async signStorageKey(storageKey: string) {
    const signed = await storage().signDownloadUrl(storageKey, { expiresInSec: SIGNED_URL_TTL_SEC });
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  },

  /**
   * RA-09: a 5-minute signed GET of an asset version's preview (the original when none was derived) for a caller
   * that authorised the read itself (the review module shows a frozen article's images to whoever may see the
   * request, an external reviewer included); null for a version this tenant does not hold. Versions are immutable,
   * so the bytes are the ones the article was frozen with.
   */
  async signVersionPreview(assetVersionId: string, tx?: Tx) {
    const v = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!v) return null;
    const preview = await derivativesRepo.find(v.id, 'preview', tx);
    const source = preview ?? v;
    const signed = await storage().signDownloadUrl(source.storageKey, { expiresInSec: SIGNED_URL_TTL_SEC });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      mime: source.mime,
      contentHash: v.contentHash,
      width: source.width,
      height: source.height,
    };
  },

  /** Spec 9.3: the media endpoint re-checks authorisation and returns a 5-minute signed GET. */
  async signedUrl(actor: ResolvedActor, input: z.infer<typeof MediaSignedUrlRequest>, tx?: Tx) {
    const parsed = MediaSignedUrlRequest.parse(input);
    const v = await versionsRepo.getById(parsed.assetVersionId, tx);
    const a = await assetsRepo.getById(v.assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    let key = v.storageKey;
    let mime = v.mime;
    if (parsed.derivative !== 'original') {
      const d = await derivativesRepo.find(v.id, parsed.derivative, tx);
      if (!d) throw new NotFoundError('AssetDerivative', `${v.id}/${parsed.derivative}`);
      key = d.storageKey;
      mime = d.mime;
    }
    const signed = await storage().signDownloadUrl(key, { expiresInSec: SIGNED_URL_TTL_SEC });
    return { url: signed.url, expiresAt: signed.expiresAt, mime };
  },

  /**
   * BSC-2: a file to save (spec 9.3 rules as for the media endpoint: asset.read re-checked, 5-minute signed GET). The
   * store answers with `Content-Disposition: attachment` and the file's type, so an SVG is saved, never rendered as a
   * page, and nothing is served from the API's origin. `png` draws the version at the chosen width (an SVG from its
   * vector; a raster never enlarged) and keeps that rendition for the next download.
   */
  async downloadUrl(actor: ResolvedActor, input: z.infer<typeof AssetDownloadRequest>, tx: Tx) {
    const parsed = AssetDownloadRequest.parse(input);
    const v = await versionsRepo.getById(parsed.assetVersionId, tx);
    const a = await assetsRepo.getById(v.assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    let source: { key: string; mime: string; width: number | null; height: number | null };
    let filename: string;
    if (parsed.format === 'original') {
      source = { key: v.storageKey, mime: v.mime, width: v.width, height: v.height };
      filename = downloadFilename(a.name, v.mime);
    } else {
      if (!drawable(v.mime))
        throw new ValidationFailedError(
          [{ path: 'format', issue: 'not_an_image' }],
          'Only images download as PNG',
        );
      const r = await pngRendition(v, parsed.width ?? 1024, tx);
      if (!r)
        throw new ValidationFailedError(
          [{ path: 'format', issue: 'not_drawable' }],
          'The file cannot be drawn',
        );
      source = r;
      filename = downloadFilename(a.name, r.mime, r.width ? `-${r.width}px` : '');
    }
    const signed = await storage().signDownloadUrl(source.key, {
      expiresInSec: SIGNED_URL_TTL_SEC,
      download: { filename, contentType: source.mime },
    });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      mime: source.mime,
      filename,
      width: source.width,
      height: source.height,
    };
  },

  /**
   * Spec 9.3: providers that fetch public URLs get a release derivative copied to the releases/ path with a signed
   * URL covering the provider's processing window. Minted at dispatch (after authoriseUse), never at scheduling.
   */
  async releaseDerivative(
    assetVersionId: string,
    providerProcessingWindowSec: number,
    opts: {
      derivative?: 'original' | DerivativePurpose;
      /**
       * BSC-2: the destination takes rasters only (a website article): an SVG version is released as its PNG
       * rendition (transparency kept), drawn now when the version predates the rendition. Rasters release as asked.
       */
      raster?: boolean;
    } = {},
    tx?: Tx,
  ) {
    const v = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!v) throw new NotFoundError('AssetVersion', assetVersionId);
    let source = {
      key: v.storageKey,
      mime: v.mime,
      contentHash: v.contentHash,
      width: v.width,
      height: v.height,
      bytes: v.bytes,
    };
    let which: string = opts.derivative ?? 'original';
    if (opts.raster && v.mime === SVG_MIME && which === 'original') {
      const png = await pngRendition(v, null, tx);
      if (png) {
        source = png;
        which = 'png';
      } else
        // The original is released as it is; a raster-only destination then refuses it (article_image_not_raster).
        logger().warn(
          { assetVersionId: v.id, brandId: v.brandId },
          'svg could not be drawn as a png rendition for a raster-only destination',
        );
    } else if (which !== 'original') {
      const d = await derivativesRepo.find(v.id, which, tx);
      if (!d) throw new NotFoundError('AssetDerivative', `${v.id}/${which}`);
      source = {
        key: d.storageKey,
        mime: d.mime,
        contentHash: d.contentHash,
        width: d.width,
        height: d.height,
        bytes: d.bytes,
      };
    }
    const { tenantId } = requireTenant();
    const id = newId('assetDerivative');
    const releaseKey = storageKeys.release(tenantId, v.brandId, v.id, which, id);
    await storage().copyObject(source.key, releaseKey);
    await derivativesRepo.createRelease(
      {
        id,
        brandId: v.brandId,
        assetVersionId: v.id,
        purpose: 'release',
        transform: { source: which, windowSec: providerProcessingWindowSec },
        storageKey: releaseKey,
        contentHash: source.contentHash,
        mime: source.mime,
        width: source.width,
        height: source.height,
        bytes: source.bytes,
      },
      tx,
    );
    const signed = await storage().signDownloadUrl(releaseKey, { expiresInSec: providerProcessingWindowSec });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      storageKey: releaseKey,
      contentHash: source.contentHash,
      mime: source.mime,
    };
  },

  /**
   * Spec 9.3 / 14.3 for a rendered export (an object under the tenant prefix that is not an asset version): the
   * bytes are re-read and re-hashed against the hash the approval binding pinned (spec 3.g4) before a release
   * copy is minted with a signed URL covering the provider's processing window. A mismatch is a
   * ReleaseIntegrityError: nothing is minted and the caller holds the publication. Audited in the caller's
   * transaction (or its own) as the tenant context's actor.
   */
  async releaseExport(
    input: {
      brandId: string;
      exportId: string;
      storageKey: string;
      contentHash: string;
      mime: string;
      width: number;
      height: number;
      bytes: number;
      /** A video export (STU-2a): carried through to the adapter with the URL. */
      durationMs?: number | null;
      fps?: number | null;
    },
    providerProcessingWindowSec: number,
    tx?: Tx,
  ) {
    const { tenantId } = requireTenant();
    // Streamed (STU-2a): a video export is read once through the hash, never held whole in memory.
    const stored = await hashStoredObject(storage(), input.storageKey);
    if (!stored) throw new NotFoundError('RenderedExportObject', input.storageKey);
    const actual = stored.contentHash;
    if (actual !== input.contentHash || stored.bytes !== input.bytes)
      throw new ReleaseIntegrityError(input.storageKey, input.contentHash, actual);
    const id = newId('assetDerivative');
    const releaseKey = storageKeys.release(tenantId, input.brandId, input.exportId, 'export', id);
    await storage().copyObject(input.storageKey, releaseKey);
    const signed = await storage().signDownloadUrl(releaseKey, {
      expiresInSec: providerProcessingWindowSec,
    });
    await withTransaction(tx, (t) =>
      audit.record(
        requireTenant().actor,
        'asset.release_minted',
        { type: 'rendered_export', id: input.exportId },
        'allowed',
        t,
        { brandId: input.brandId, path: releaseKey, reason: `window:${providerProcessingWindowSec}s` },
      ),
    );
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      storageKey: releaseKey,
      contentHash: input.contentHash,
      mime: input.mime,
      width: input.width,
      height: input.height,
      bytes: input.bytes,
      ...(input.durationMs ? { durationMs: input.durationMs } : {}),
      ...(input.fps ? { fps: input.fps } : {}),
    };
  },
};

/**
 * Issues an upload intent once the caller has authorised it: the kind's mime list and size cap are checked, the
 * quarantine key is allocated and the intent is recorded and audited. Generated and imported uploads carry their
 * provenance.
 */
async function issueIntent(
  actor: ResolvedActor,
  parsed: z.infer<typeof UploadIntentCreate>,
  provenance: IntentProvenance | null,
  tx: Tx,
) {
  const { tenantId } = requireTenant();
  const mime = parsed.declaredMime.toLowerCase();
  if (ARCHIVE_MIMES.includes(mime))
    throw new ValidationFailedError([{ path: 'declaredMime', issue: 'archives_rejected' }]);
  const group = KIND_MIME_GROUPS[parsed.kind].find((g) => ACCEPTED_MIMES[g]?.includes(mime));
  if (!group)
    throw new ValidationFailedError([{ path: 'declaredMime', issue: 'mime_not_accepted_for_kind' }]);
  const maxBytes = UPLOAD_CAPS_BYTES[group] as number;
  if (parsed.declaredBytes > maxBytes)
    throw new ValidationFailedError([{ path: 'declaredBytes', issue: `exceeds_cap_${maxBytes}` }]);
  const id = newId('uploadIntent');
  const storageKey = storageKeys.quarantine(tenantId, id);
  const expiresAt = new Date(Date.now() + UPLOAD_INTENT_TTL_SEC * 1000);
  await intentsRepo.create(
    {
      id,
      brandId: parsed.brandId,
      kind: parsed.kind,
      declaredMime: mime,
      declaredBytes: parsed.declaredBytes,
      maxBytes,
      storageKey,
      originalFilename: parsed.originalFilename,
      state: 'issued',
      createdByUserId: actor.id,
      expiresAt,
    },
    tx,
  );
  if (provenance) await generatedRepo.create({ id, brandId: parsed.brandId, provenance }, tx);
  await audit.record(actorRef(actor), 'upload_intent.created', { type: 'upload_intent', id }, 'allowed', tx, {
    brandId: parsed.brandId,
  });
  return { id, storageKey, mime, maxBytes, expiresAt };
}

/**
 * Step (3) of importGoogleFont, in the caller's (idempotent) transaction: an upload intent per downloaded file the
 * brand does not already hold as a live font, carrying the import's provenance, and the audit event. The first file
 * of a batch with the same bytes stands for the others.
 */
async function recordFontImport(
  actor: ResolvedActor,
  brandId: string,
  family: string,
  downloaded: ReadonlyArray<GoogleFontFile & { contentHash: string }>,
  tx: Tx,
): Promise<GoogleFontImportResult> {
  const files: GoogleFontImportFile[] = [];
  for (const f of downloaded) {
    const face = {
      weight: f.weight,
      weightRange: f.weightRange,
      style: f.style,
      subset: f.subset,
      unicodeRange: f.unicodeRange,
      contentHash: f.contentHash,
    };
    const existing = await versionsRepo.findLiveByHash(brandId, f.contentHash, ['font'], tx);
    if (existing) {
      files.push({ ...face, outcome: 'existing', assetId: existing.assetId, intentId: null });
      continue;
    }
    const queued = files.find((x) => x.contentHash === f.contentHash);
    if (queued) {
      files.push({ ...face, outcome: 'queued', assetId: null, intentId: queued.intentId });
      continue;
    }
    const slug = f.family.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const weights = f.weightRange ? `${f.weightRange.min}-${f.weightRange.max}` : `${f.weight}`;
    const { id } = await issueIntent(
      actor,
      UploadIntentCreate.parse({
        brandId,
        kind: 'font',
        declaredMime: 'font/woff2',
        declaredBytes: f.bytes.length,
        originalFilename: `${slug}-${weights}${f.style === 'italic' ? '-italic' : ''}-${f.subset ?? 'all'}.woff2`,
      }),
      {
        kind: 'imported',
        source: GOOGLE_FONTS_SOURCE,
        externalRef: f.url,
        font: {
          family: f.family,
          weight: f.weight,
          ...(f.weightRange ? { weightRange: f.weightRange } : {}),
          style: f.style,
          subset: f.subset,
          unicodeRange: f.unicodeRange,
        },
        licence: GOOGLE_FONTS_LICENCE_NOTE,
      },
      tx,
    );
    files.push({ ...face, outcome: 'queued', assetId: null, intentId: id });
  }
  const name = downloaded[0]?.family ?? family;
  await audit.record(actorRef(actor), 'asset.font_imported', { type: 'brand', id: brandId }, 'allowed', tx, {
    brandId,
    reason: `${GOOGLE_FONTS_SOURCE}:${name}`,
    count: files.filter((f) => f.outcome === 'queued').length,
  });
  return { family: name, files };
}

/** issued → uploaded once the caller has authorised it; the outbox event starts assetIngestWorkflowV1. */
async function markUploaded(actor: ResolvedActor, intent: UploadIntentRow, tx: Tx) {
  if (intent.expiresAt.getTime() < Date.now())
    throw new ValidationFailedError([{ path: 'intentId', issue: 'intent_expired' }]);
  if (!uploadIntentMachine.can(intent.state, 'complete'))
    throw new ValidationFailedError([{ path: 'intentId', issue: `intent_${intent.state}` }]);
  const next = uploadIntentMachine.transition(intent.state, 'complete');
  await intentsRepo.update(intent.id, intent.version, { state: next }, tx);
  await audit.record(
    actorRef(actor),
    'upload_intent.completed',
    { type: 'upload_intent', id: intent.id },
    'allowed',
    tx,
    { brandId: intent.brandId, fromState: intent.state, toState: next },
  );
  await outbox.add(
    'asset.upload_completed',
    { type: 'upload_intent', id: intent.id, version: intent.version + 1 },
    // `kind` (STU-2a, additive) routes video and audio to videoIngestWorkflowV1 (outbox-routes.ts).
    {
      uploadIntentId: intent.id,
      brandId: intent.brandId,
      actorKind: actor.kind,
      actorId: actor.id,
      kind: intent.kind,
    },
    tx,
    { brandId: intent.brandId },
  );
  return { intentId: intent.id, state: next };
}
