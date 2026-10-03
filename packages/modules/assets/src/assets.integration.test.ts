import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { AssetIngestInputV1, IngestSanitiseResult, IngestStepResult } from '@oremedia/contracts/assets';
import {
  NotFoundError,
  PolicyDeniedError,
  ProviderUnavailableError,
  RightsIneligibleError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import {
  assetDerivatives,
  assetVersions,
  assets,
  generatedUploads,
  uploadIntents,
  usageRights,
} from '@oremedia/db/schema/assets';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { configureGoogleFonts } from './google-fonts';
import { karlaTtf, notoNaskhTtf, toWoff2, woff2Bomb } from './ingest/font.fixtures';
import { assetIngest, type IngestDeps } from './ingest/pipeline';
import { mp4 } from './ingest/media.fixtures';
import { FakeScanner } from './ingest/scanner';
import { assetService } from './service';
import { MemoryStorageProvider, configureStorage, storageKeys } from './storage';

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svgWithScript = `<svg ${SVG_NS} width="100" height="100"><script>alert(1)</script><rect width="100" height="100"/></svg>`;
const png = () =>
  sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 200, b: 20, alpha: 1 } } })
    .png()
    .toBuffer();

const actor = (
  tenantId: string,
  id: string,
  role: 'owner' | 'creator',
  brandIds: string[] | 'all',
): ResolvedActor => ({
  kind: 'user',
  id,
  tenantId,
  membershipId: `mem_${id}`,
  membershipStatus: 'active',
  role,
  allBrands: brandIds === 'all',
  brandGrants: brandIds === 'all' ? [] : brandIds.map((brandId) => ({ brandId, roles: [] })),
  mfaEnrolled: false,
});
const ctxFor = (a: ResolvedActor): TenantContext => ({
  tenantId: a.tenantId,
  actor: { kind: a.kind, id: a.id },
  brandIds: a.kind === 'user' && !a.allBrands ? new Set(a.brandGrants.map((g) => g.brandId)) : 'all',
  correlationId: `corr_${a.id}`,
});
const hours = (n: number) => new Date(Date.now() + n * 3600_000);

describe('assets module against MySQL 8 (spec 9)', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const deps: IngestDeps = { storage: mem, scanner: new FakeScanner() };
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA1 = newId('brand');
  const brandA2 = newId('brand');
  const brandB1 = newId('brand');
  const ownerA = actor(tenantA, newId('user'), 'owner', 'all');
  const creatorA1 = actor(tenantA, newId('user'), 'creator', [brandA1]);
  const ownerB = actor(tenantB, newId('user'), 'owner', 'all');

  /** Direct seed of an approved (or otherwise) asset with one version and optional rights. */
  async function seedAsset(opts: {
    brandId: string;
    kind?: 'photo' | 'font' | 'logo';
    state?: 'approved' | 'pending_review' | 'retired';
    rights?: null | { expiresAt?: Date | null; channels?: 'all' | string[]; territories?: 'all' | string[] };
    tenantId?: string;
    name?: string;
  }) {
    const tenantId = opts.tenantId ?? tenantA;
    const id = newId('asset');
    const versionId = newId('assetVersion');
    await tdb.db.insert(assets).values({
      id,
      tenantId,
      brandId: opts.brandId,
      kind: opts.kind ?? 'photo',
      name: opts.name ?? `asset ${id}`,
      currentVersionId: versionId,
      state: opts.state ?? 'approved',
      rightsState: opts.rights === null ? 'unknown' : 'recorded',
    });
    await tdb.db.insert(assetVersions).values({
      id: versionId,
      tenantId,
      brandId: opts.brandId,
      assetId: id,
      number: 1,
      storageKey: storageKeys.original(tenantId, opts.brandId, id, versionId),
      contentHash: sha256Hex(id),
      mime: opts.kind === 'font' ? 'font/ttf' : 'image/png',
      bytes: 100,
      width: 64,
      height: 48,
      provenance: { kind: 'upload', uploadedByUserId: ownerA.id, originalFilename: 'seed.png' },
    });
    if (opts.rights !== null)
      await tdb.db.insert(usageRights).values({
        id: newId('usageRights'),
        tenantId,
        brandId: opts.brandId,
        assetId: id,
        owner: 'owner',
        permittedChannels: opts.rights?.channels ?? 'all',
        territories: opts.rights?.territories ?? 'all',
        expiresAt: opts.rights?.expiresAt ?? null,
        releases: [],
        restrictions: [],
      });
    return { id, versionId };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: `assets-a-${tenantA.slice(-6).toLowerCase()}` },
      { id: tenantB, name: 'B', slug: `assets-b-${tenantB.slice(-6).toLowerCase()}` },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA1, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB1, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  /** Runs the pipeline exactly as the workflow does (packages/workflows asset-ingest.workflow.v1). */
  async function runPipeline(input: AssetIngestInputV1, autoApprove: boolean) {
    const begin = await assetIngest.begin(input);
    const cleanupKeys = [begin.storageKey];
    const finish = async (
      reason: string,
      outcome: 'rejected' | 'quarantined',
      duplicateOfAssetId?: string,
    ) => {
      await assetIngest.finalise(deps, {
        ...input,
        outcome,
        reason: reason as never,
        duplicateOfAssetId,
        cleanupKeys,
      });
      return { outcome, reason, duplicateOfAssetId };
    };
    const verified = await assetIngest.verify(deps, input);
    if (!verified.ok) return finish(verified.reason, 'rejected');
    const sniffed = await assetIngest.sniff(deps, input);
    if (!sniffed.ok) return finish(sniffed.reason, 'rejected');
    const scanned = await assetIngest.scan(deps, input);
    if (!scanned.ok) return finish(scanned.reason, scanned.retryable ? 'quarantined' : 'rejected');
    const sanitised: IngestStepResult<IngestSanitiseResult> = await assetIngest.sanitise(deps, {
      ...input,
      ...sniffed,
    });
    if (!sanitised.ok) return finish(sanitised.reason, 'rejected');
    cleanupKeys.push(sanitised.sanitisedKey);
    if (sanitised.previewKey) cleanupKeys.push(sanitised.previewKey);
    const hashed = await assetIngest.hash(deps, { ...input, sanitisedKey: sanitised.sanitisedKey });
    if (!hashed.ok) return finish(hashed.reason, 'rejected', hashed.duplicateOfAssetId);
    const built = await assetIngest.derivatives(deps, {
      ...input,
      sanitisedKey: sanitised.sanitisedKey,
      mime: sanitised.mime,
      group: sniffed.group,
      previewKey: sanitised.previewKey,
    });
    if (!built.ok) return finish(built.reason, 'rejected');
    cleanupKeys.push(...built.derivatives.map((d) => d.key));
    const moved = await assetIngest.move(deps, {
      ...input,
      sanitisedKey: sanitised.sanitisedKey,
      derivatives: built.derivatives,
    });
    const catalogued = await assetIngest.catalogue({
      ...input,
      ...moved,
      contentHash: hashed.contentHash,
      mime: sanitised.mime,
      bytes: sanitised.bytes,
      width: sanitised.width,
      height: sanitised.height,
      colourProfile: sanitised.colourProfile,
      fontMetadata: sanitised.fontMetadata,
      sanitised: sanitised.sanitised,
      autoApprove,
    });
    await assetIngest.finalise(deps, { ...input, outcome: 'accepted', cleanupKeys });
    return { outcome: 'accepted' as const, ...catalogued };
  }

  async function uploadAs(
    a: ResolvedActor,
    brandId: string,
    kind: 'photo' | 'logo',
    mime: string,
    bytes: Buffer,
    name: string,
  ) {
    return runInTenant(ctxFor(a), async () => {
      const intent = await withTransaction((tx) =>
        assetService.createIntent(
          a,
          { brandId, kind, declaredMime: mime, declaredBytes: bytes.length, originalFilename: name },
          tx,
        ),
      );
      expect(intent.uploadUrl).toContain(storageKeys.quarantine(a.tenantId, intent.intentId));
      await mem.putObject(storageKeys.quarantine(a.tenantId, intent.intentId), bytes, { contentType: mime });
      const completed = await withTransaction((tx) =>
        assetService.completeUpload(a, { intentId: intent.intentId }, tx),
      );
      expect(completed.state).toBe('uploaded');
      return intent.intentId;
    });
  }

  describe('ingestion pipeline (spec 9.1)', () => {
    it('a valid PNG travels intent → quarantine → sanitised original, derivatives and catalogue rows', async () => {
      const intentId = await uploadAs(ownerA, brandA1, 'photo', 'image/png', await png(), 'hero.png');
      const outboxRows = await tdb.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, intentId));
      expect(outboxRows.map((r) => r.eventType)).toEqual(['asset.upload_completed']);
      const input: AssetIngestInputV1 = {
        tenantId: tenantA,
        actor: { kind: 'user', id: ownerA.id },
        correlationId: 'corr_ingest',
        intentId,
        brandId: brandA1,
      };
      const result = await runInTenant(ctxFor(ownerA), () => runPipeline(input, true));
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') return;
      const [asset] = await tdb.db.select().from(assets).where(eq(assets.id, result.assetId));
      expect(asset).toMatchObject({
        tenantId: tenantA,
        brandId: brandA1,
        state: 'approved',
        rightsState: 'unknown',
        currentVersionId: result.assetVersionId,
        name: 'hero.png',
      });
      const [version] = await tdb.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, result.assetVersionId));
      expect(version).toMatchObject({ mime: 'image/png', width: 64, height: 48, number: 1 });
      expect(version?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(version?.provenance).toMatchObject({
        kind: 'upload',
        uploadedByUserId: ownerA.id,
        sanitised: true,
      });
      const derivs = await tdb.db
        .select()
        .from(assetDerivatives)
        .where(eq(assetDerivatives.assetVersionId, result.assetVersionId));
      expect(derivs.map((d) => d.purpose).sort()).toEqual(['preview', 'thumbnail', 'web']);
      const [intent] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, intentId));
      expect(intent).toMatchObject({ state: 'accepted', resultAssetId: result.assetId });
      // The uploader's client follows the intent to its asset (assets.uploads.get).
      await expect(
        runInTenant(ctxFor(ownerA), () => assetService.uploadStatus(ownerA, { intentId })),
      ).resolves.toEqual({
        intentId,
        state: 'accepted',
        assetId: result.assetId,
        rejectionReason: null,
        rejectionDetail: null,
        kind: 'photo',
      });
      // Storage: immutable keys exist, quarantine is empty.
      expect(mem.has(storageKeys.original(tenantA, brandA1, result.assetId, result.assetVersionId))).toBe(
        true,
      );
      expect(mem.keys().filter((k) => k.startsWith(`quarantine/${tenantA}/${intentId}`))).toEqual([]);
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, result.assetId));
      expect(events.map((e) => e.eventType)).toEqual(['asset.ingested']);
      // The library reads it back and mints a 5-minute signed URL for a derivative.
      await runInTenant(ctxFor(ownerA), async () => {
        const got = await assetService.get(ownerA, { assetId: result.assetId });
        expect(got.derivatives.length).toBe(3);
        const signed = await assetService.signedUrl(ownerA, {
          assetVersionId: result.assetVersionId,
          derivative: 'preview',
        });
        expect(signed.url).toContain(
          `assets/${tenantA}/${brandA1}/${result.assetId}/${result.assetVersionId}/preview`,
        );
        expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
        expect(signed.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
      });
    });

    it('a creator without asset.approve gets pending_review; an SVG with a script is rejected and cleaned up', async () => {
      const okIntent = await uploadAs(
        creatorA1,
        brandA1,
        'photo',
        'image/png',
        await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } })
          .png()
          .toBuffer(),
        'small.png',
      );
      const okResult = await runInTenant(ctxFor(creatorA1), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: creatorA1.id },
            correlationId: 'c',
            intentId: okIntent,
            brandId: brandA1,
          },
          false,
        ),
      );
      expect(okResult).toMatchObject({ outcome: 'accepted', state: 'pending_review' });

      const badIntent = await uploadAs(
        ownerA,
        brandA1,
        'logo',
        'image/svg+xml',
        Buffer.from(svgWithScript),
        'evil.svg',
      );
      const bad = await runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: ownerA.id },
            correlationId: 'c',
            intentId: badIntent,
            brandId: brandA1,
          },
          true,
        ),
      );
      expect(bad).toMatchObject({ outcome: 'rejected', reason: 'svg_unsafe_content' });
      const [intent] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, badIntent));
      expect(intent).toMatchObject({
        state: 'rejected',
        rejectionReason: 'svg_unsafe_content',
        resultAssetId: null,
      });
      await expect(
        runInTenant(ctxFor(ownerA), () => assetService.uploadStatus(ownerA, { intentId: badIntent })),
      ).resolves.toEqual({
        intentId: badIntent,
        state: 'rejected',
        assetId: null,
        rejectionReason: 'svg_unsafe_content',
        rejectionDetail: null,
        kind: 'logo',
      });
      expect(mem.keys().filter((k) => k.includes(badIntent))).toEqual([]);
      expect((await tdb.db.select().from(assets).where(eq(assets.name, 'evil.svg'))).length).toBe(0);
    });

    it('identical content in the same brand is a duplicate_of proposal, not a second asset', async () => {
      const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#abcdef' } })
        .png()
        .toBuffer();
      const first = await uploadAs(ownerA, brandA2, 'photo', 'image/png', bytes, 'dup.png');
      const r1 = await runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: ownerA.id },
            correlationId: 'c',
            intentId: first,
            brandId: brandA2,
          },
          true,
        ),
      );
      expect(r1.outcome).toBe('accepted');
      const second = await uploadAs(ownerA, brandA2, 'photo', 'image/png', bytes, 'dup-again.png');
      const r2 = await runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: ownerA.id },
            correlationId: 'c',
            intentId: second,
            brandId: brandA2,
          },
          true,
        ),
      );
      expect(r2).toMatchObject({
        outcome: 'rejected',
        reason: 'duplicate_of',
        duplicateOfAssetId: (r1 as { assetId: string }).assetId,
      });
      const [intent] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, second));
      expect(intent).toMatchObject({
        state: 'rejected',
        rejectionReason: 'duplicate_of',
        resultAssetId: (r1 as { assetId: string }).assetId,
      });
    });

    it('createIntent enforces kind/mime/cap, refuses archives, and foreign brands are NOT_FOUND', async () => {
      await runInTenant(ctxFor(ownerA), async () => {
        const bad = (input: Record<string, unknown>) =>
          withTransaction((tx) => assetService.createIntent(ownerA, input as never, tx));
        await expect(
          bad({
            brandId: brandA1,
            kind: 'photo',
            declaredMime: 'application/zip',
            declaredBytes: 10,
            originalFilename: 'a.zip',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        await expect(
          bad({
            brandId: brandA1,
            kind: 'font',
            declaredMime: 'image/png',
            declaredBytes: 10,
            originalFilename: 'a.png',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        await expect(
          bad({
            brandId: brandA1,
            kind: 'logo',
            declaredMime: 'image/svg+xml',
            declaredBytes: 3 * 1024 * 1024,
            originalFilename: 'a.svg',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        // STU-2a: a person may upload video, within the 1 GiB cap.
        await expect(
          bad({
            brandId: brandA1,
            kind: 'video',
            declaredMime: 'video/mp4',
            declaredBytes: 1024 ** 3 + 1,
            originalFilename: 'a.mp4',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        await expect(
          bad({
            brandId: brandB1,
            kind: 'photo',
            declaredMime: 'image/png',
            declaredBytes: 10,
            originalFilename: 'a.png',
          }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
      await runInTenant(ctxFor(creatorA1), async () => {
        await expect(
          withTransaction((tx) =>
            assetService.createIntent(
              creatorA1,
              {
                brandId: brandA2,
                kind: 'photo',
                declaredMime: 'image/png',
                declaredBytes: 10,
                originalFilename: 'a.png',
              },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });
  });

  describe('generated uploads (ADR-11)', () => {
    const agentA1: ResolvedActor = {
      kind: 'service_principal',
      id: newId('servicePrincipal'),
      tenantId: tenantA,
      status: 'active',
      maxAutonomy: 'create',
      grants: [
        { action: 'creative.edit', brandIds: [brandA1] },
        { action: 'asset.upload', brandIds: [brandA1] },
      ],
    };
    const provenance = {
      kind: 'generated' as const,
      model: 'openrouter:vendor/image-model',
      promptHash: sha256Hex('a prompt'),
      inputs: [],
      agentRunId: 'run_gen_1',
    };
    const generate = async (opts: { autonomyMode?: 'assist' | 'create' }, brandId = brandA1) =>
      runInTenant(ctxFor(agentA1), async () =>
        withTransaction(async (tx) =>
          assetService.uploadGenerated(
            agentA1,
            {
              brandId,
              kind: 'illustration',
              mime: 'image/png',
              // Distinct pixels: identical content in the brand would be a duplicate_of rejection.
              bytes: await sharp({
                create: { width: 64, height: 48, channels: 4, background: { r: 90, g: 40, b: 30, alpha: 1 } },
              })
                .png()
                .toBuffer(),
              originalFilename: 'generated-run_gen_1-1.png',
              provenance,
            },
            tx,
            opts,
          ),
        ),
      );

    it('an agent cannot upload outright, but its generated image enters ingest and lands pending with provenance', async () => {
      await expect(
        runInTenant(ctxFor(agentA1), () =>
          withTransaction((tx) =>
            assetService.createIntent(
              agentA1,
              {
                brandId: brandA1,
                kind: 'illustration',
                declaredMime: 'image/png',
                declaredBytes: 100,
                originalFilename: 'x.png',
              },
              tx,
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const { intentId } = await generate({ autonomyMode: 'create' });
      const outboxRows = await tdb.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, intentId));
      expect(outboxRows.map((r) => r.eventType)).toEqual(['asset.upload_completed']);
      await runInTenant(ctxFor(agentA1), async () => {
        expect(await assetService.generatedUploadStatus([intentId])).toEqual([
          { intentId, state: 'pending' },
        ]);
      });
      const input: AssetIngestInputV1 = {
        tenantId: tenantA,
        actor: { kind: 'service_principal', id: agentA1.id },
        correlationId: 'corr_generated',
        intentId,
        brandId: brandA1,
      };
      // Agents never hold asset.approve, so the workflow catalogues it for a person's review.
      const result = await runInTenant(ctxFor(ownerA), () => runPipeline(input, false));
      expect(result).toMatchObject({ outcome: 'accepted' });
      if (result.outcome !== 'accepted') return;
      const [asset] = await tdb.db.select().from(assets).where(eq(assets.id, result.assetId));
      expect(asset).toMatchObject({ state: 'pending_review', kind: 'illustration' });
      const [version] = await tdb.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, result.assetVersionId));
      expect(version?.provenance).toEqual(provenance);
      await runInTenant(ctxFor(agentA1), async () => {
        expect(await assetService.generatedUploadStatus([intentId])).toEqual([
          {
            intentId,
            state: 'accepted',
            assetId: result.assetId,
            storageKey: version?.storageKey,
            contentHash: version?.contentHash,
            width: 64,
            height: 48,
          },
        ]);
      });
    });

    it('needs the run to hold create autonomy and the brand to be granted', async () => {
      await expect(generate({})).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(generate({ autonomyMode: 'assist' })).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(generate({ autonomyMode: 'create' }, brandA2)).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('a generated video still passes the v1 structural ingest (in-flight events); a person may now upload video (STU-2a)', async () => {
      // STU-2a: a person's video intent is issued (capped at 1 GiB) and processed by videoIngestWorkflowV1.
      const personIntent = await runInTenant(ctxFor(ownerA), () =>
        withTransaction((tx) =>
          assetService.createIntent(
            ownerA,
            {
              brandId: brandA1,
              kind: 'video',
              declaredMime: 'video/mp4',
              declaredBytes: 1000,
              originalFilename: 'clip.mp4',
            },
            tx,
          ),
        ),
      );
      expect(personIntent.maxBytes).toBe(1024 ** 3);
      const clip = mp4({ seconds: 6, width: 720, height: 1280 });
      const { intentId } = await runInTenant(ctxFor(agentA1), () =>
        withTransaction((tx) =>
          assetService.uploadGenerated(
            agentA1,
            {
              brandId: brandA1,
              kind: 'video',
              mime: 'video/mp4',
              bytes: clip,
              originalFilename: 'generated-run_gen_1-1.mp4',
              provenance,
            },
            tx,
            { autonomyMode: 'create' },
          ),
        ),
      );
      const result = await runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'service_principal', id: agentA1.id },
            correlationId: 'corr_generated_video',
            intentId,
            brandId: brandA1,
          },
          false,
        ),
      );
      expect(result).toMatchObject({ outcome: 'accepted' });
      if (result.outcome !== 'accepted') return;
      const [asset] = await tdb.db.select().from(assets).where(eq(assets.id, result.assetId));
      expect(asset).toMatchObject({ state: 'pending_review', kind: 'video' });
      const [version] = await tdb.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, result.assetVersionId));
      expect(version).toMatchObject({
        mime: 'video/mp4',
        width: 720,
        height: 1280,
        bytes: clip.length,
        contentHash: sha256Hex(clip),
        provenance,
      });
      expect(
        await tdb.db
          .select()
          .from(assetDerivatives)
          .where(eq(assetDerivatives.assetVersionId, result.assetVersionId)),
      ).toEqual([]);
    });
  });

  describe('eligibility (spec 9.2): ineligible assets never appear in search', () => {
    let eligible: { id: string; versionId: string };
    let pending: { id: string; versionId: string };
    let expired: { id: string; versionId: string };
    let font: { id: string; versionId: string };
    let otherBrand: { id: string; versionId: string };
    let unknownRights: { id: string; versionId: string };
    let channelBound: { id: string; versionId: string };
    let expiringLater: { id: string; versionId: string };
    const brandE = newId('brand');
    const brandF = newId('brand');

    beforeAll(async () => {
      await tdb.db.insert(brands).values([
        { id: brandE, tenantId: tenantA, name: 'E', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
        { id: brandF, tenantId: tenantA, name: 'F', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      ]);
      eligible = await seedAsset({ brandId: brandE, name: 'eligible' });
      pending = await seedAsset({ brandId: brandE, state: 'pending_review' });
      expired = await seedAsset({ brandId: brandE, rights: { expiresAt: hours(1) } });
      font = await seedAsset({ brandId: brandE, kind: 'font' });
      otherBrand = await seedAsset({ brandId: brandF });
      unknownRights = await seedAsset({ brandId: brandE, rights: null });
      channelBound = await seedAsset({
        brandId: brandE,
        rights: { channels: ['cc_1'], territories: ['GB'] },
      });
      expiringLater = await seedAsset({ brandId: brandE, rights: { expiresAt: hours(48) } });
      await seedAsset({ brandId: brandB1, tenantId: tenantB, name: 'eligible' });
    });

    const searchIds = (a: ResolvedActor, query: Record<string, unknown>) =>
      runInTenant(ctxFor(a), async () =>
        (await assetService.search(a, { query: query as never, page: { limit: 50 } })).items
          .map((i) => i.assetId)
          .sort(),
      );

    it('returns only approved, in-brand, rights-bearing, kind-compatible assets', async () => {
      const ids = await searchIds(ownerA, { brandId: brandE, purpose: 'creative' });
      expect(ids).toEqual([eligible.id, channelBound.id, expiringLater.id].sort());
      for (const excluded of [pending, expired, font, otherBrand, unknownRights])
        expect(ids).not.toContain(excluded.id);
    });
    it('font purpose returns the font; reference purpose returns unknown-rights assets too, never pending ones', async () => {
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'font' })).toEqual([font.id]);
      const ref = await searchIds(ownerA, { brandId: brandE, purpose: 'reference' });
      expect(ref).toContain(unknownRights.id);
      expect(ref).toContain(font.id);
      expect(ref).not.toContain(pending.id);
      expect(ref).not.toContain(expired.id);
    });
    it('channels, territory and scheduledFor narrow the result', async () => {
      expect(
        await searchIds(ownerA, { brandId: brandE, purpose: 'creative', channelConnectionIds: ['cc_2'] }),
      ).toEqual([eligible.id, expiringLater.id].sort());
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'creative', territory: 'US' })).toEqual(
        [eligible.id, expiringLater.id].sort(),
      );
      expect(
        await searchIds(ownerA, {
          brandId: brandE,
          purpose: 'creative',
          territory: 'GB',
          channelConnectionIds: ['cc_1'],
        }),
      ).toEqual([eligible.id, channelBound.id, expiringLater.id].sort());
      expect(
        await searchIds(ownerA, {
          brandId: brandE,
          purpose: 'creative',
          scheduledFor: hours(20).toISOString(),
        }),
      ).toEqual([eligible.id, channelBound.id, expiringLater.id].sort());
      // 48h rights, scheduled at +30h: the 24h processing window pushes past expiry → held out.
      expect(
        await searchIds(ownerA, {
          brandId: brandE,
          purpose: 'creative',
          scheduledFor: hours(30).toISOString(),
        }),
      ).toEqual([eligible.id, channelBound.id].sort());
    });
    it('another brand’s asset appears only through an active grant for that purpose', async () => {
      await runInTenant(ctxFor(ownerA), () =>
        withTransaction((tx) =>
          assetService.createGrant(
            ownerA,
            { assetId: otherBrand.id, granteeBrandId: brandE, purpose: 'creative' },
            tx,
          ),
        ),
      );
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'creative' })).toContain(otherBrand.id);
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'reference' })).not.toContain(otherBrand.id);
      const expiredGrant = await seedAsset({ brandId: brandF });
      await runInTenant(ctxFor(ownerA), () =>
        withTransaction((tx) =>
          assetService.createGrant(
            ownerA,
            {
              assetId: expiredGrant.id,
              granteeBrandId: brandE,
              purpose: 'creative',
              expiresAt: new Date(Date.now() - 1000).toISOString(),
            },
            tx,
          ),
        ),
      );
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'creative' })).not.toContain(
        expiredGrant.id,
      );
    });
    it('list names every asset of the brand with its issues; needsAttention keeps the ones with any; foreign brands are NOT_FOUND', async () => {
      const listIds = (input: Record<string, unknown>) =>
        runInTenant(
          ctxFor(ownerA),
          async () =>
            (await assetService.list(ownerA, { brandId: brandE, page: { limit: 50 }, ...input })).items,
        );
      const all = await listIds({});
      const byId = new Map(all.map((i) => [i.id, i]));
      expect(byId.get(eligible.id)?.issues).toEqual([]);
      expect(byId.get(pending.id)?.issues).toEqual(['pending_review']);
      expect(byId.get(expired.id)?.issues).toEqual(['rights_expiring']); // expires in 1 h: inside the window
      expect(byId.get(unknownRights.id)?.issues).toEqual(['rights_unknown']);
      expect(byId.get(expiringLater.id)?.issues).toEqual(['rights_expiring']);
      const lapsed = await seedAsset({ brandId: brandE, rights: { expiresAt: hours(-1) } });
      expect((await listIds({})).find((i) => i.id === lapsed.id)?.issues).toEqual(['rights_expired']);
      expect(byId.has(otherBrand.id)).toBe(false); // another brand's asset, grant or not
      expect(byId.get(eligible.id)?.currentVersion?.id).toBe(eligible.versionId);
      const attention = await listIds({ needsAttention: true });
      expect(attention.map((i) => i.id).sort()).toEqual(
        [pending.id, expired.id, unknownRights.id, expiringLater.id, lapsed.id].sort(),
      );
      expect((await listIds({ state: 'pending_review' })).map((i) => i.id)).toEqual([pending.id]);
      expect((await listIds({ kinds: ['font'] })).map((i) => i.id)).toEqual([font.id]);
      expect((await listIds({ query: 'eligible' })).map((i) => i.id)).toEqual([eligible.id]);
      // Paging: newest first, the cursor continues without repeating.
      const first = await runInTenant(ctxFor(ownerA), () =>
        assetService.list(ownerA, { brandId: brandE, page: { limit: 2 } }),
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await runInTenant(ctxFor(ownerA), () =>
        assetService.list(ownerA, { brandId: brandE, page: { limit: 2, cursor: first.nextCursor! } }),
      );
      expect(second.items.map((i) => i.id)).not.toContain(first.items[0]?.id);
      await expect(
        runInTenant(ctxFor(ownerB), () =>
          assetService.list(ownerB, { brandId: brandE, page: { limit: 50 } }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A creator restricted to other brands cannot list this one either (brand visibility, spec 5.3).
      await expect(
        runInTenant(ctxFor(creatorA1), () =>
          assetService.list(creatorA1, { brandId: brandE, page: { limit: 50 } }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('brand visibility and tenancy: a restricted creator and a foreign tenant get NOT_FOUND', async () => {
      await expect(searchIds(creatorA1, { brandId: brandE, purpose: 'creative' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(searchIds(ownerB, { brandId: brandE, purpose: 'creative' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await runInTenant(ctxFor(ownerB), async () => {
        await expect(assetService.get(ownerB, { assetId: eligible.id })).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(
          assetService.authoriseUse(eligible.versionId, 'creative', { brandId: brandB1 }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });
    it('authoriseUse re-runs the rule and throws RIGHTS_INELIGIBLE with the reason', async () => {
      await runInTenant(ctxFor(ownerA), async () => {
        const ok = await assetService.authoriseUse(eligible.versionId, 'creative', { brandId: brandE });
        expect(ok).toMatchObject({
          assetId: eligible.id,
          assetVersionId: eligible.versionId,
          brandId: brandE,
        });
        const reason = async (
          versionId: string,
          purpose: 'creative' | 'reference' | 'logo',
          opts: Record<string, unknown> = {},
        ) => {
          try {
            await assetService.authoriseUse(versionId, purpose, { brandId: brandE, ...opts });
            return 'eligible';
          } catch (err) {
            expect(err).toBeInstanceOf(RightsIneligibleError);
            return (err as RightsIneligibleError).details?.[0]?.issue;
          }
        };
        expect(await reason(pending.versionId, 'creative')).toBe('state_not_approved');
        expect(await reason(expired.versionId, 'creative')).toBe('rights_expired');
        expect(await reason(unknownRights.versionId, 'creative')).toBe('rights_unknown');
        expect(await reason(unknownRights.versionId, 'reference')).toBe('eligible');
        expect(await reason(font.versionId, 'creative')).toBe('kind_incompatible');
        expect(await reason(channelBound.versionId, 'creative', { channelConnectionIds: ['cc_9'] })).toBe(
          'channel_not_permitted',
        );
        expect(await reason(channelBound.versionId, 'creative', { territory: 'FR' })).toBe(
          'territory_not_permitted',
        );
        expect(await reason(expiringLater.versionId, 'creative', { scheduledFor: hours(30) })).toBe(
          'rights_expired',
        );
        expect(await reason(otherBrand.versionId, 'creative')).toBe('eligible'); // granted above
        expect(await reason(otherBrand.versionId, 'reference')).toBe('brand_not_permitted');
      });
    });
  });

  describe('grants, rights, approval and delivery', () => {
    it('a grant can only target a brand of the same tenant, never the owner brand or a foreign one', async () => {
      const a = await seedAsset({ brandId: brandA1 });
      await runInTenant(ctxFor(ownerA), async () => {
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(
              ownerA,
              { assetId: a.id, granteeBrandId: brandB1, purpose: 'creative' },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(
              ownerA,
              { assetId: a.id, granteeBrandId: brandA1, purpose: 'creative' },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        const g = await withTransaction((tx) =>
          assetService.createGrant(ownerA, { assetId: a.id, granteeBrandId: brandA2, purpose: 'logo' }, tx),
        );
        expect(g.grantId).toMatch(/^ag_/);
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(ownerA, { assetId: a.id, granteeBrandId: brandA2, purpose: 'logo' }, tx),
          ),
        ).rejects.toBeInstanceOf(ValidationFailedError);
      });
      await runInTenant(ctxFor(creatorA1), async () => {
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(
              creatorA1,
              { assetId: a.id, granteeBrandId: brandA2, purpose: 'logo' },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(PolicyDeniedError);
      });
    });
    it('rights.set records rights; approve/retire follow the state machine and roles', async () => {
      const p = await seedAsset({ brandId: brandA1, state: 'pending_review', rights: null });
      await runInTenant(ctxFor(creatorA1), async () => {
        await expect(
          withTransaction((tx) => assetService.approve(creatorA1, { assetId: p.id, expectedVersion: 0 }, tx)),
        ).rejects.toBeInstanceOf(PolicyDeniedError);
      });
      await runInTenant(ctxFor(ownerA), async () => {
        await withTransaction((tx) =>
          assetService.setRights(
            ownerA,
            {
              assetId: p.id,
              owner: 'Studio',
              permittedChannels: 'all',
              territories: 'all',
              releases: [],
              restrictions: [],
            },
            tx,
          ),
        );
        let got = await assetService.get(ownerA, { assetId: p.id });
        expect(got.rightsState).toBe('recorded');
        expect(got.rights?.owner).toBe('Studio');
        // Upsert: a second call updates the same row.
        await withTransaction((tx) =>
          assetService.setRights(
            ownerA,
            {
              assetId: p.id,
              owner: 'Studio 2',
              permittedChannels: ['cc_1'],
              territories: 'all',
              releases: [],
              restrictions: [],
            },
            tx,
          ),
        );
        got = await assetService.get(ownerA, { assetId: p.id });
        expect(got.rights?.owner).toBe('Studio 2');
        expect((await tdb.db.select().from(usageRights).where(eq(usageRights.assetId, p.id))).length).toBe(1);
        const approved = await withTransaction((tx) =>
          assetService.approve(ownerA, { assetId: p.id, expectedVersion: got.version }, tx),
        );
        expect(approved.state).toBe('approved');
        await expect(
          withTransaction((tx) =>
            assetService.approve(ownerA, { assetId: p.id, expectedVersion: approved.version }, tx),
          ),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        const retired = await withTransaction((tx) =>
          assetService.retire(
            ownerA,
            { assetId: p.id, expectedVersion: approved.version, reason: 'superseded' },
            tx,
          ),
        );
        expect(retired.state).toBe('retired');
        const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, p.id));
        expect(events.map((e) => e.eventType)).toEqual(['asset.retired']);
        expect(
          (
            await assetService.search(ownerA, {
              query: { brandId: brandA1, purpose: 'creative', channelConnectionIds: [] },
              page: { limit: 50 },
            })
          ).items.map((i) => i.assetId),
        ).not.toContain(p.id);
      });
    });
    it('releaseDerivative copies to releases/ with a URL covering the provider window and records the release', async () => {
      const a = await seedAsset({ brandId: brandA1 });
      await runInTenant(ctxFor(ownerA), async () => {
        await mem.putObject(
          storageKeys.original(tenantA, brandA1, a.id, a.versionId),
          Buffer.from('original-bytes'),
          { contentType: 'image/png' },
        );
        const rel = await withTransaction((tx) =>
          assetService.releaseDerivative(a.versionId, 24 * 3600, {}, tx),
        );
        expect(rel.storageKey).toMatch(
          new RegExp(`^releases/${tenantA}/${brandA1}/${a.versionId}/original/ad_`),
        );
        expect(mem.has(rel.storageKey)).toBe(true);
        expect(rel.expiresAt.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
        const rows = await tdb.db
          .select()
          .from(assetDerivatives)
          .where(eq(assetDerivatives.assetVersionId, a.versionId));
        expect(rows.map((r) => r.purpose)).toEqual(['release']);
        await withTransaction((tx) => assetService.recordUsage(a.versionId, 'publication', 'pub_1', tx));
        const usages = await assetService.listUsages(ownerA, { assetId: a.id, page: { limit: 10 } });
        expect(usages.items).toMatchObject([{ usedByType: 'publication', usedById: 'pub_1' }]);
      });
    });
  });

  describe('brand fonts: Google Fonts import and typography listing', () => {
    const brandF = newId('brand');
    // Distinct valid WOFF2 files: Karla and Noto Naskh stand in for the subset files of every fixture family.
    const FILES: Record<string, Buffer> = {
      '/s/karla/v31/lat.woff2': toWoff2(karlaTtf()),
      '/s/karla/v31/ext.woff2': toWoff2(notoNaskhTtf()),
      '/s/vari/v7/lat.woff2': toWoff2(karlaTtf(), 5),
      '/s/vari/v7/ext.woff2': toWoff2(notoNaskhTtf(), 5),
      '/s/twin/v1/lat.woff2': toWoff2(karlaTtf(), 6),
      '/s/twin/v1/ext.woff2': toWoff2(notoNaskhTtf(), 6),
      '/s/gone/v1/lat.woff2': toWoff2(karlaTtf(), 7),
    };
    let css: Server;
    let files: Server;
    let fontOrigin = '';
    const fontHits: string[] = [];
    const listen = async (server: Server) => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const block = (family: string, subset: string, path: string, range: string, weight = 400) =>
      `/* ${subset} */\n@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(${fontOrigin}${path}) format('woff2');\n  unicode-range: ${range};\n}\n`;
    const LAT = 'U+0000-00FF';
    const EXT = 'U+0100-02AF';
    /** css2 answers: Karla static (one file per subset); Vari variable (the same file for 400 and 700). */
    const stylesheet = (family: string): string | null => {
      const slug = family.toLowerCase();
      const version = { karla: 'v31', vari: 'v7', twin: 'v1', gone: 'v1' }[slug];
      if (!version) return null;
      const base = `/s/${slug}/${version}`;
      if (slug === 'vari')
        return [400, 700]
          .map(
            (w) =>
              block('Vari', 'latin-ext', `${base}/ext.woff2`, EXT, w) +
              block('Vari', 'latin', `${base}/lat.woff2`, LAT, w),
          )
          .join('');
      const name = family[0]?.toUpperCase() + slug.slice(1);
      return (
        block(name, 'cyrillic', `${base}/cyr.woff2`, 'U+0400-045F') +
        block(name, 'latin-ext', `${base}/ext.woff2`, EXT) +
        block(name, 'latin', `${base}/lat.woff2`, LAT)
      );
    };

    beforeAll(async () => {
      await tdb.db.insert(brands).values({
        id: brandF,
        tenantId: tenantA,
        name: 'F',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
      });
      files = createServer((req, res) => {
        fontHits.push(req.url ?? '');
        const body = FILES[req.url ?? ''];
        if (!body) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'font/woff2' }).end(body);
      });
      fontOrigin = await listen(files);
      css = createServer((req, res) => {
        const family = /^\/css2\?family=([A-Za-z]+):/.exec(req.url ?? '')?.[1];
        const body = family ? stylesheet(family) : null;
        if (!body) return res.writeHead(400).end();
        res.writeHead(200, { 'content-type': 'text/css' }).end(body);
      });
      configureGoogleFonts({ cssOrigin: await listen(css), fontOrigin, insecureAllowLoopback: true });
    });
    afterAll(() => {
      configureGoogleFonts({});
      css?.close();
      files?.close();
    });

    const importAs = (a: ResolvedActor, family = 'Karla', weights = [400]) =>
      runInTenant(ctxFor(a), () =>
        assetService.importGoogleFont(a, { brandId: brandF, family, weights, styles: ['normal'] }),
      );
    const ingest = (intentId: string) =>
      runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: ownerA.id },
            correlationId: 'corr_font_import',
            intentId,
            brandId: brandF,
          },
          true,
        ),
      );
    const recordedIntents = async () =>
      (await tdb.db.select().from(generatedUploads).where(eq(generatedUploads.brandId, brandF))).length;

    it('needs the brand kit permission, refuses agents and foreign tenants, and an unknown family is a validation error', async () => {
      const creatorF = actor(tenantA, newId('user'), 'creator', [brandF]);
      await expect(importAs(creatorF)).rejects.toBeInstanceOf(PolicyDeniedError);
      const agent: ResolvedActor = {
        kind: 'service_principal',
        id: newId('servicePrincipal'),
        tenantId: tenantA,
        status: 'active',
        maxAutonomy: 'create',
        grants: [
          { action: 'brand.edit_standards', brandIds: [brandF] },
          { action: 'asset.upload', brandIds: [brandF] },
        ],
      };
      await expect(
        runInTenant(ctxFor(agent), () =>
          assetService.importGoogleFont(agent, {
            brandId: brandF,
            family: 'Karla',
            weights: [400],
            styles: ['normal'],
          }),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(importAs(ownerB)).rejects.toBeInstanceOf(NotFoundError);
      await expect(importAs(ownerA, 'Nope')).rejects.toMatchObject({
        details: [{ path: 'family', issue: 'google_fonts_family_unknown' }],
      });
      expect(fontHits).toEqual([]);
    });

    it('a file that fails part-way (404) leaves nothing behind', async () => {
      const objectsBefore = mem.keys().length;
      await expect(importAs(ownerA, 'Gone')).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(fontHits).toContain('/s/gone/v1/ext.woff2'); // the missing file was asked for
      expect(await recordedIntents()).toBe(0);
      expect(mem.keys().length).toBe(objectsBefore);
    });

    it('holds no connection while downloading: the command runs after every file is in hand', async () => {
      let seenAtCommand = -1;
      const result = await runInTenant(ctxFor(ownerA), () =>
        assetService.importGoogleFont(
          ownerA,
          { brandId: brandF, family: 'Karla', weights: [400], styles: ['normal'] },
          (command) => {
            seenAtCommand = fontHits.length;
            return withTransaction(command);
          },
        ),
      );
      expect(seenAtCommand).toBe(fontHits.length); // no download happened inside or after the command
      for (const f of result.files) {
        const [intent] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, f.intentId!));
        expect(intent?.state).toBe('uploaded'); // bytes in quarantine and completed after the command committed
      }
      // Ingest them so the next test starts from a brand holding Karla.
      for (const f of result.files) expect(await ingest(f.intentId!)).toMatchObject({ outcome: 'accepted' });
    });

    it('ingests each kept subset as a font asset with provenance, and a second import reuses them', async () => {
      const again = await importAs(ownerA);
      expect(again.files.map((f) => [f.subset, f.outcome, f.intentId])).toEqual([
        ['latin-ext', 'existing', null],
        ['latin', 'existing', null],
      ]);
      for (const f of again.files) {
        const [version] = await tdb.db
          .select()
          .from(assetVersions)
          .where(eq(assetVersions.contentHash, f.contentHash));
        expect(version?.assetId).toBe(f.assetId);
        expect(version).toMatchObject({ mime: 'font/woff2' });
        expect(version?.provenance).toMatchObject({
          kind: 'imported',
          source: 'google_fonts',
          externalRef: `${fontOrigin}/s/karla/v31/${f.subset === 'latin' ? 'lat' : 'ext'}.woff2`,
          font: {
            family: 'Karla',
            weight: 400,
            style: 'normal',
            subset: f.subset,
            unicodeRange: f.unicodeRange,
          },
          licence: expect.stringContaining('fonts.google.com'),
          // What the file itself declares is recorded too, as for an upload.
          fontMetadata: { family: f.subset === 'latin' ? 'Karla' : 'Noto Naskh Arabic' },
        });
      }
      expect(await recordedIntents()).toBe(2);
    });

    it('a retired font with the same bytes is not "existing": the file is ingested anew', async () => {
      const [latin] = await tdb.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.contentHash, sha256Hex(FILES['/s/karla/v31/lat.woff2']!)));
      await tdb.db.update(assets).set({ state: 'retired' }).where(eq(assets.id, latin!.assetId));
      const result = await importAs(ownerA);
      expect(result.files.map((f) => [f.subset, f.outcome])).toEqual([
        ['latin-ext', 'existing'],
        ['latin', 'queued'],
      ]);
      const renewed = await ingest(result.files[1]!.intentId!);
      expect(renewed).toMatchObject({ outcome: 'accepted' });
      if (renewed.outcome === 'accepted') expect(renewed.assetId).not.toBe(latin!.assetId);
    });

    it('a variable family is one file per subset covering its weight range, however many weights were asked for', async () => {
      const result = await importAs(ownerA, 'Vari', [400, 700]);
      // Karla's wght axis runs 200–800: the range is the file's own, not just the weights asked for.
      expect(result.files.map((f) => [f.subset, f.outcome, f.weight, f.weightRange])).toEqual([
        ['latin-ext', 'queued', 400, { min: 400, max: 700 }],
        ['latin', 'queued', 200, { min: 200, max: 800 }],
      ]);
      expect(fontHits.filter((h) => h.startsWith('/s/vari/'))).toHaveLength(2); // each file fetched once
      for (const f of result.files) expect(await ingest(f.intentId!)).toMatchObject({ outcome: 'accepted' });
    });

    it('two concurrent imports (different idempotency keys) end with one asset per file', async () => {
      const [a, b] = await Promise.all([importAs(ownerA, 'Twin'), importAs(ownerA, 'Twin')]);
      const outcomes = [];
      for (const f of [...a.files, ...b.files]) if (f.intentId) outcomes.push(await ingest(f.intentId));
      expect(outcomes.filter((o) => o.outcome === 'accepted')).toHaveLength(2);
      expect(outcomes.filter((o) => o.outcome !== 'accepted')).toEqual(
        outcomes
          .filter((o) => o.outcome !== 'accepted')
          .map(() => expect.objectContaining({ outcome: 'rejected', reason: 'duplicate_of' })),
      );
      const faces = await runInTenant(ctxFor(ownerA), () =>
        assetService.listFonts(ownerA, { brandId: brandF }),
      );
      expect(faces.items.filter((f) => f.family === 'Twin').map((f) => f.files.length)).toEqual([2]);
    });

    it('lists imported subsets as one face beside an uploaded font; the render worker gets the whole face', async () => {
      const uploaded = await seedAsset({ brandId: brandF, kind: 'font', name: 'Brand Serif.ttf' });
      const faces = await runInTenant(ctxFor(ownerA), () =>
        assetService.listFonts(ownerA, { brandId: brandF }),
      );
      const karla = faces.items.find((f) => f.family === 'Karla');
      expect(karla).toMatchObject({
        source: 'google_fonts',
        weight: 400,
        weightRange: null,
        style: 'normal',
        format: 'woff2',
      });
      expect(karla?.files.map((f) => f.subset)).toEqual(['latin', 'latin-ext']);
      expect(karla?.assetId).toBe(karla?.files[0]?.assetId);
      // Vari's two subset files carry different axis ranges here (the fixtures are two different fonts), so they
      // are two faces; a real variable family's subset files share one range and list as one face.
      const vari = faces.items.filter((f) => f.family === 'Vari');
      expect(vari.map((f) => f.weightRange)).toEqual([
        { min: 200, max: 800 },
        { min: 400, max: 700 },
      ]);
      expect(faces.items.find((f) => f.assetId === uploaded.id)).toMatchObject({
        source: 'upload',
        weightRange: null,
        files: [{}],
      });
      await runInTenant(ctxFor(ownerA), async () => {
        const whole = await assetService.fontFaceFiles(karla?.assetVersionId as string);
        expect(whole).toEqual(karla?.files.map((f) => f.assetVersionId));
        // The same ref resolves the same files every time.
        expect(await assetService.fontFaceFiles(karla?.assetVersionId as string)).toEqual(whole);
        expect(await assetService.fontFaceFiles(uploaded.versionId)).toEqual([uploaded.versionId]);
      });
      await expect(
        runInTenant(ctxFor(ownerB), () => assetService.listFonts(ownerB, { brandId: brandF })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runInTenant(ctxFor(creatorA1), () => assetService.listFonts(creatorA1, { brandId: brandF })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a WOFF2 decompression bomb under the upload cap is refused at once, never decompressed', async () => {
      const bomb = woff2Bomb(256 * 1024 * 1024);
      expect(bomb.length).toBeLessThan(1024 * 1024);
      const intentId = await runInTenant(ctxFor(ownerA), async () => {
        const intent = await withTransaction((tx) =>
          assetService.createIntent(
            ownerA,
            {
              brandId: brandF,
              kind: 'font',
              declaredMime: 'font/woff2',
              declaredBytes: bomb.length,
              originalFilename: 'bomb.woff2',
            },
            tx,
          ),
        );
        await mem.putObject(storageKeys.quarantine(tenantA, intent.intentId), bomb, {
          contentType: 'font/woff2',
        });
        await withTransaction((tx) => assetService.completeUpload(ownerA, { intentId: intent.intentId }, tx));
        return intent.intentId;
      });
      const started = Date.now();
      expect(await ingest(intentId)).toMatchObject({ outcome: 'rejected', reason: 'exceeds_cap' });
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  describe('brand kit references (kindsForBrand)', () => {
    it("returns the kind of this brand's live assets only: never another brand's, another tenant's or a retired one", async () => {
      const logo = await seedAsset({ brandId: brandA1, kind: 'logo' });
      const photo = await seedAsset({ brandId: brandA1 });
      const retired = await seedAsset({ brandId: brandA1, kind: 'logo', state: 'retired' });
      const otherBrand = await seedAsset({ brandId: brandA2, kind: 'logo' });
      const otherTenant = await seedAsset({ brandId: brandB1, kind: 'logo', tenantId: tenantB });
      const kinds = await runInTenant(ctxFor(ownerA), () =>
        assetService.kindsForBrand(brandA1, [
          logo.id,
          photo.id,
          retired.id,
          otherBrand.id,
          otherTenant.id,
          'ast_missing',
        ]),
      );
      expect([...kinds.entries()]).toEqual([
        [logo.id, 'logo'],
        [photo.id, 'photo'],
      ]);
    });
  });

  describe('cursor pagination bounds (spec 7.4)', () => {
    it('pages through eligible assets with an opaque cursor and rejects out-of-range limits', async () => {
      const brandP = newId('brand');
      await tdb.db.insert(brands).values({
        id: brandP,
        tenantId: tenantA,
        name: 'P',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
      });
      const seeded = new Set<string>();
      for (let i = 0; i < 5; i++) seeded.add((await seedAsset({ brandId: brandP })).id);
      await runInTenant(ctxFor(ownerA), async () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await assetService.search(ownerA, {
            query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
            page: { limit: 2, cursor },
          });
          expect(page.items.length).toBeLessThanOrEqual(2);
          seen.push(...page.items.map((i) => i.assetId));
          cursor = page.nextCursor ?? undefined;
          pages++;
        } while (cursor);
        expect(pages).toBe(3);
        expect(new Set(seen)).toEqual(seeded);
        expect(seen.length).toBe(5);
        await expect(
          assetService.search(ownerA, {
            query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
            page: { limit: 500 },
          }),
        ).rejects.toThrow();
        await expect(
          assetService.search(ownerA, {
            query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
            page: { limit: 0 },
          }),
        ).rejects.toThrow();
        const garbage = await assetService.search(ownerA, {
          query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
          page: { limit: 10, cursor: 'not-a-cursor' },
        });
        expect(garbage.items.length).toBe(5);
      });
    });
  });
});
