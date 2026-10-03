import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { AssetIngestInputV1, AssetKind, IngestStepRejection } from '@oremedia/contracts/assets';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { MediaProbeV1, VideoIngestActivitiesV1 } from '@oremedia/contracts/media';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { assetDerivatives, assetVersions, uploadIntents } from '@oremedia/db/schema/assets';
import { brands } from '@oremedia/db/schema/brand';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import {
  FakeScanner,
  MemoryStorageProvider,
  assetService,
  configureStorage,
  mediaToolsAvailable,
  registerAssetOutboxRoutes,
  runTool,
  storageKeys,
} from '@oremedia/module-assets';
import { outboxRouteFor, type OutboxEventRecord } from '@oremedia/module-operations';
import { createVideoIngestActivities } from './video-ingest';

/**
 * STU-2a video and audio ingest activities against MySQL, real ffmpeg/ffprobe and the in-memory store: a person's
 * video upload is accepted (no longer refused at intent), routed to videoIngestWorkflowV1, probed, given its
 * derivatives and catalogued with its duration and probe; damaged and over-long media are rejected with a reason and
 * a detail the uploader sees; foreign inputs are NOT_FOUND. The steps run in the workflow's order (the orchestration
 * itself is tested in packages/workflows).
 */
const hasTools = await mediaToolsAvailable();
if (!hasTools)
  console.error('video-ingest.integration.test.ts: ffmpeg/ffprobe not found; the suite is skipped');

describe.skipIf(!hasTools)('video ingest activities (MockActivityEnvironment, MySQL, ffmpeg)', () => {
  let tdb: TestDatabase;
  let dir: string;
  const mem = new MemoryStorageProvider();
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const ownerA = newId('user');
  const ownerB = newId('user');
  const acts: VideoIngestActivitiesV1 = createVideoIngestActivities({
    storage: mem,
    scanner: new FakeScanner(),
  });

  const actorFor = (userId: string, tenantId: string): ResolvedActor => ({
    kind: 'user',
    id: userId,
    tenantId,
    membershipId: `mem_${userId}`,
    membershipStatus: 'active',
    role: 'owner',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  });
  const ctxFor = (a: ResolvedActor): TenantContext => ({
    tenantId: a.tenantId,
    actor: { kind: 'user', id: a.id },
    brandIds: 'all',
    correlationId: 'corr_video',
  });
  const inputFor = (userId: string, tenantId: string, intentId: string): AssetIngestInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    correlationId: 'corr_video',
    intentId,
    brandId: brandA,
  });
  const ff = async (args: string[]) => {
    const r = await runTool('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };

  async function upload(file: string, kind: AssetKind, mime: string): Promise<string> {
    const bytes = await readFile(join(dir, file));
    const actor = actorFor(ownerA, tenantA);
    return runInTenant(ctxFor(actor), async () => {
      const intent = await withTransaction((tx) =>
        assetService.createIntent(
          actor,
          { brandId: brandA, kind, declaredMime: mime, declaredBytes: bytes.length, originalFilename: file },
          tx,
        ),
      );
      await mem.putObject(storageKeys.quarantine(tenantA, intent.intentId), bytes, { contentType: mime });
      await withTransaction((tx) => assetService.completeUpload(actor, { intentId: intent.intentId }, tx));
      return intent.intentId;
    });
  }

  /** The workflow's steps in order, stopping at the first rejection (finalised as videoIngestWorkflowV1 does). */
  async function ingest(intentId: string) {
    const input = inputFor(ownerA, tenantA, intentId);
    const begin = await run(acts.beginIngest, input);
    const cleanupKeys = [begin.storageKey];
    const reject = async (r: IngestStepRejection) => {
      await run(acts.finaliseMediaUpload, {
        ...input,
        outcome: 'rejected' as const,
        reason: r.reason,
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.duplicateOfAssetId ? { duplicateOfAssetId: r.duplicateOfAssetId } : {}),
        cleanupKeys,
      });
      return r;
    };
    const verified = await run(acts.verifyUpload, input);
    if (!verified.ok) return reject(verified);
    const sniffed = await run(acts.sniffUpload, input);
    if (!sniffed.ok) return reject(sniffed);
    const group = sniffed.group as 'video' | 'audio';
    const scanned = await run(acts.scanMediaUpload, input);
    if (!scanned.ok) return reject(scanned);
    const inspected = await run(acts.inspectMediaUpload, { ...input, mime: sniffed.mime, group });
    if (!inspected.ok) return reject(inspected);
    const started = Date.now();
    const built = await run(acts.buildMediaDerivatives, {
      ...input,
      mime: sniffed.mime,
      group,
      probe: inspected.probe,
    });
    const derivativesMs = Date.now() - started;
    if (!built.ok) return reject(built);
    cleanupKeys.push(...built.derivatives.map((d) => d.key));
    const moved = await run(acts.moveToImmutable, {
      ...input,
      sanitisedKey: begin.storageKey,
      derivatives: built.derivatives,
    });
    const catalogued = await run(acts.catalogueMediaAsset, {
      ...input,
      ...moved,
      contentHash: inspected.contentHash,
      mime: sniffed.mime,
      bytes: verified.bytes,
      width: inspected.probe.video?.width ?? null,
      height: inspected.probe.video?.height ?? null,
      colourProfile: null,
      sanitised: false,
      probe: inspected.probe,
    });
    await run(acts.finaliseMediaUpload, { ...input, outcome: 'accepted' as const, cleanupKeys });
    return { ok: true as const, ...catalogued, derivativesMs };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    registerAssetOutboxRoutes();
    dir = await mkdtemp(join(tmpdir(), 'video-ingest-it-'));
    // A 4 s 1280×720 phone-style clip (portrait by rotation), an M4A, a damaged faststart MP4 and an 11-minute clip.
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      join(dir, 'landscape.mp4'),
    ]);
    await ff([
      '-display_rotation',
      '90',
      '-i',
      join(dir, 'landscape.mp4'),
      '-c',
      'copy',
      join(dir, 'clip.mp4'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=44100',
      '-t',
      '3',
      '-c:a',
      'aac',
      join(dir, 'voice.m4a'),
    ]);
    const whole = await readFile(join(dir, 'landscape.mp4'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'damaged.mp4'), whole.subarray(0, Math.floor(whole.length * 0.6)));
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:size=32x32:rate=1',
      '-t',
      '660',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(dir, 'long.mp4'),
    ]);
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: `vid-a-${tenantA.slice(-6).toLowerCase()}` },
      { id: tenantB, name: 'B', slug: `vid-b-${tenantB.slice(-6).toLowerCase()}` },
    ]);
    await tdb.db.insert(users).values([
      { id: ownerA, email: `${ownerA.toLowerCase()}@example.test`, name: 'owner a' },
      { id: ownerB, email: `${ownerB.toLowerCase()}@example.test`, name: 'owner b' },
    ]);
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(memberships).values([
      {
        id: newId('membership'),
        tenantId: tenantA,
        userId: ownerA,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
      {
        id: newId('membership'),
        tenantId: tenantB,
        userId: ownerB,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
    ]);
  }, 300_000);
  afterAll(async () => {
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a person’s video upload is accepted at intent and routed to videoIngestWorkflowV1 on task queue video', async () => {
    const intentId = await upload('clip.mp4', 'video', 'video/mp4');
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, intentId));
    expect(rows).toHaveLength(1);
    const evt = rows[0] as unknown as OutboxEventRecord;
    expect(evt.payload).toMatchObject({ kind: 'video', uploadIntentId: intentId });
    expect(outboxRouteFor('asset.upload_completed')?.(evt)).toMatchObject({
      workflowType: 'videoIngestWorkflowV1',
      taskQueue: 'video',
      workflowId: `ingest:${intentId}`,
    });
    // An event recorded before `kind` existed keeps going to v1 (in-flight generated media).
    const { kind: _k, ...legacy } = evt.payload;
    expect(outboxRouteFor('asset.upload_completed')?.({ ...evt, payload: legacy })).toMatchObject({
      workflowType: 'assetIngestWorkflowV1',
      taskQueue: 'media',
    });
  });

  it('ingests a rotated phone clip: probe on the version, derivatives with immutable keys and hashes, quarantine emptied', async () => {
    const intentId = await upload('clip.mp4', 'video', 'video/mp4');
    const r = await ingest(intentId);
    expect(r).toMatchObject({ ok: true, state: 'approved' });
    if (!('assetVersionId' in r)) return;
    const [version] = await tdb.db.select().from(assetVersions).where(eq(assetVersions.id, r.assetVersionId));
    expect(version).toMatchObject({ mime: 'video/mp4', width: 720, height: 1280 });
    expect(version?.durationMs).toBeGreaterThan(3_900);
    const media = version?.mediaInfo as MediaProbeV1;
    expect(media.video).toMatchObject({ codec: 'h264', rotation: 270, codedWidth: 1280, fps: 30 });
    expect(media.audio[0]).toMatchObject({ codec: 'aac' });
    const derivatives = await tdb.db
      .select()
      .from(assetDerivatives)
      .where(eq(assetDerivatives.assetVersionId, r.assetVersionId));
    expect(derivatives.map((d) => d.purpose).sort()).toEqual(
      ['poster', 'preview', 'proxy', 'strip', 'strip_map', 'thumbnail', 'waveform'].sort(),
    );
    for (const d of derivatives) {
      expect(d.storageKey).toBe(`assets/${tenantA}/${brandA}/${r.assetId}/${r.assetVersionId}/${d.purpose}`);
      expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(mem.has(d.storageKey)).toBe(true);
    }
    const proxy = derivatives.find((d) => d.purpose === 'proxy');
    expect(proxy).toMatchObject({ mime: 'video/mp4', width: 720, height: 1280 });
    expect(mem.keys().filter((k) => k.includes(intentId))).toEqual([]);
    // The library and pickers sign the poster frame as the thumbnail.
    const signed = await runInTenant(ctxFor(actorFor(ownerA, tenantA)), () =>
      assetService.signedUrl(actorFor(ownerA, tenantA), {
        assetVersionId: r.assetVersionId,
        derivative: 'proxy',
      }),
    );
    expect(signed.mime).toBe('video/mp4');
    console.error(`video-ingest: 4 s 720p clip derivatives in ${r.derivativesMs} ms`);
  }, 120_000);

  it('ingests audio with a proxy, waveform and waveform images', async () => {
    const r = await ingest(await upload('voice.m4a', 'audio', 'audio/mp4'));
    expect(r).toMatchObject({ ok: true });
    if (!('assetVersionId' in r)) return;
    const derivatives = await tdb.db
      .select()
      .from(assetDerivatives)
      .where(eq(assetDerivatives.assetVersionId, r.assetVersionId));
    expect(derivatives.map((d) => d.purpose).sort()).toEqual(['preview', 'proxy', 'thumbnail', 'waveform']);
    const [version] = await tdb.db.select().from(assetVersions).where(eq(assetVersions.id, r.assetVersionId));
    expect(version).toMatchObject({ width: null, height: null });
  }, 120_000);

  it('rejects a damaged MP4 with media_malformed and keeps a user-safe detail on the intent', async () => {
    const intentId = await upload('damaged.mp4', 'video', 'video/mp4');
    const r = await ingest(intentId);
    expect(r).toMatchObject({ ok: false, reason: 'media_malformed' });
    const status = await runInTenant(ctxFor(actorFor(ownerA, tenantA)), () =>
      assetService.uploadStatus(actorFor(ownerA, tenantA), { intentId }),
    );
    expect(status).toMatchObject({ state: 'rejected', rejectionReason: 'media_malformed', kind: 'video' });
    expect(status.rejectionDetail).toBeTruthy();
    expect(status.rejectionDetail).not.toContain('/tmp');
    expect(mem.keys().filter((k) => k.includes(intentId))).toEqual([]);
  }, 120_000);

  it('rejects a video over 10 minutes with the limit in the detail', async () => {
    const intentId = await upload('long.mp4', 'video', 'video/mp4');
    expect(await ingest(intentId)).toMatchObject({ ok: false, reason: 'duration_exceeds_cap' });
    const [row] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, intentId));
    expect(row?.rejectionDetail).toContain('10 minute');
  }, 120_000);

  it('the same bytes again are a duplicate of the first asset', async () => {
    const intentId = await upload('clip.mp4', 'video', 'video/mp4');
    expect(await ingest(intentId)).toMatchObject({
      ok: false,
      reason: 'duplicate_of',
      duplicateOfAssetId: expect.any(String),
    });
  }, 120_000);

  it('cross-tenant inputs are NOT_FOUND before any media work', async () => {
    const intentId = await upload('voice.m4a', 'audio', 'audio/mp4');
    await expect(
      run(acts.inspectMediaUpload, {
        ...inputFor(ownerB, tenantB, intentId),
        mime: 'audio/mp4',
        group: 'audio' as const,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a video intent above the 1 GiB cap at intent time', async () => {
    const actor = actorFor(ownerA, tenantA);
    await expect(
      runInTenant(ctxFor(actor), () =>
        withTransaction((tx) =>
          assetService.createIntent(
            actor,
            {
              brandId: brandA,
              kind: 'video',
              declaredMime: 'video/mp4',
              declaredBytes: 1024 ** 3 + 1,
              originalFilename: 'big.mp4',
            },
            tx,
          ),
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'declaredBytes', issue: `exceeds_cap_${1024 ** 3}` }] });
  });
});
