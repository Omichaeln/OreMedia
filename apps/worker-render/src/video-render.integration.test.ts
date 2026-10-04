import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { AssetKind } from '@oremedia/contracts/assets';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import type { MediaProbeV1 } from '@oremedia/contracts/media';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { RenderJobInputV1, VideoRenderJobActivitiesV1 } from '@oremedia/contracts/render';
import type { VideoClipItem, VideoOperation } from '@oremedia/contracts/video';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { assetDerivatives, assetVersions, assets, usageRights } from '@oremedia/db/schema/assets';
import { brandVersions, brands } from '@oremedia/db/schema/brand';
import { renderJobs, renderedExports } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createVideoRenderActivities } from '@oremedia/activities';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { FIXTURE_FONTS } from '@oremedia/editor/renderer/fixtures';
import {
  MemoryStorageProvider,
  assetService,
  configureStorage,
  mediaToolsAvailable,
  probeFile,
  runTool,
  storageKeys,
} from '@oremedia/module-assets';
import {
  creativeService,
  registerAssetAuthoriser,
  registerCreativeAssetCatalog,
} from '@oremedia/module-creative';
import { runVideoRender } from '@oremedia/workflows/video-render.workflow.v1';
import { createChromiumRenderer } from './chromium-renderer';
import { creativeRenderJobStore } from './creative-store';
import { loadFixtureFont } from './fixture-assets';

/**
 * STU-2b video render end to end against MySQL, the real creative/brand/asset modules, the real Chromium scene
 * renderer and real ffmpeg 6.1: a video document is created and edited with timeline operations; renders.request
 * → videoRenderJobWorkflowV1 orchestration (runVideoRender with the real activities) → render_jobs pending →
 * rendering → ready with one video/mp4 export (duration, fps, poster, WebVTT captions, dedupe key) whose bytes hash
 * as recorded; the text overlay drawn by Chromium and the caption are in the picture only in their windows and the
 * audio is in sync; rendering the same revision again reuses the export (dedupe); a person's cancel stops a running
 * encode; and a 30 s 1080p project's render time is measured. Needs ffmpeg, Chromium and the renderer bundle.
 */
const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];
const hasTools = await mediaToolsAvailable();
if (!hasTools)
  console.error('video-render.integration.test.ts: ffmpeg/ffprobe not found; the suite is skipped');

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (kind: IdKind): string =>
  `${ID_PREFIXES[kind]}_${[...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join('')}`;
const hashCanonical = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));

const ctx = (tenantId: string, userId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: userId },
  brandIds: 'all',
  correlationId: 'corr_video_e2e',
});
const owner = (tenantId: string, userId: string): ResolvedActor => ({
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

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  tokens: {
    colours: [
      { key: 'ink', value: '#000000', role: 'text' },
      { key: 'paper', value: '#FFFFFF', role: 'background' },
      { key: 'accent', value: '#FF00FF', role: 'accent' },
    ],
    typeRoles: [
      { role: 'display', fontAssetId: 'ast_font', weight: 700, minSizePx: 40 },
      { role: 'heading', fontAssetId: 'ast_font', weight: 600, minSizePx: 28 },
      { role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 18 },
      { role: 'caption', fontAssetId: 'ast_font', weight: 400, minSizePx: 12 },
    ],
    spacingScale: [4, 8, 16],
    radii: [0, 8],
    contrastTarget: 'AA',
  },
});

describe.skipIf(!hasTools)('video render end to end (MySQL + creative module + Chromium + ffmpeg)', () => {
  let tdb: TestDatabase;
  let dir: string;
  const mem = new MemoryStorageProvider();
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const ownerA = newId('user');
  const A = owner(tenantA, ownerA);
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(tenantA, ownerA), () => withTransaction(fn));
  const read = <T>(fn: () => Promise<T>) => runInTenant(ctx(tenantA, ownerA), fn);
  const renderer = createChromiumRenderer({
    ...(executablePath ? { executablePath } : {}),
    timeoutMs: 120_000,
  });
  const composeCalls: string[] = [];
  const makeActs = (encoder: {
    preset: string;
    crf?: number;
    threads?: number;
  }): VideoRenderJobActivitiesV1 => {
    const acts = createVideoRenderActivities({
      store: creativeRenderJobStore(),
      overlays: renderer,
      rendererVersion: RENDERER_VERSION,
      storage: mem,
      encoder,
    });
    return {
      ...acts,
      composeVideo: async (i) => {
        composeCalls.push(i.renderJobId);
        return acts.composeVideo(i);
      },
    };
  };
  const acts = makeActs({ preset: 'superfast', crf: 18 });
  const inputFor = (renderJobId: string): RenderJobInputV1 => ({
    tenantId: tenantA,
    actor: { kind: 'user', id: ownerA },
    correlationId: 'corr_video_e2e',
    renderJobId,
  });
  const noCancel = {
    cancellable: <T>(fn: () => Promise<T>) => fn(),
    shielded: <T>(fn: () => Promise<T>) => fn(),
    cancelled: () => false,
  };
  const seeded: Record<string, { versionId: string; contentHash: string }> = {};
  let fontVersion = '';

  const ff = async (args: string[]) => {
    const r = await runTool('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };

  async function seedAsset(
    key: string,
    kind: AssetKind,
    mime: string,
    file: string | Buffer,
    w: number | null,
    h: number | null,
  ) {
    const bytes = typeof file === 'string' ? await readFile(file) : file;
    const id = newId('asset');
    const versionId = newId('assetVersion');
    const storageKey = storageKeys.original(tenantA, brandA, id, versionId);
    let mediaInfo: MediaProbeV1 | null = null;
    if (typeof file === 'string' && (kind === 'video' || kind === 'audio')) {
      const p = await probeFile(file, bytes.length, { mime });
      if ('ok' in p) throw new Error(`probe ${key}`);
      mediaInfo = p;
    }
    await tdb.db.insert(assets).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      kind,
      name: key,
      currentVersionId: versionId,
      state: 'approved',
      rightsState: 'recorded',
    });
    await tdb.db.insert(assetVersions).values({
      id: versionId,
      tenantId: tenantA,
      brandId: brandA,
      assetId: id,
      number: 1,
      storageKey,
      contentHash: sha256(bytes),
      mime,
      bytes: bytes.length,
      width: w ?? mediaInfo?.video?.width ?? null,
      height: h ?? mediaInfo?.video?.height ?? null,
      durationMs: mediaInfo?.durationMs ?? null,
      mediaInfo,
      provenance: { kind: 'upload', uploadedByUserId: ownerA, originalFilename: key },
    });
    await tdb.db.insert(usageRights).values({
      id: newId('usageRights'),
      tenantId: tenantA,
      brandId: brandA,
      assetId: id,
      owner: 'owner',
      permittedChannels: 'all',
      territories: 'all',
      expiresAt: null,
      releases: [],
      restrictions: [],
    });
    await read(() => mem.putObject(storageKey, bytes, { contentType: mime }));
    seeded[key] = { versionId, contentHash: sha256(bytes) };
    return { id, versionId };
  }

  /** RGB of a 2×2 block at (x, y) of decoded frame n of an MP4 held in memory storage. */
  async function pixel(file: string, n: number, x: number, y: number) {
    const r = await runTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-vf',
        `select=eq(n\\,${n}),crop=2:2:${x}:${y}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { timeoutMs: 60_000 },
    );
    return [r.stdout[0] ?? -1, r.stdout[1] ?? -1, r.stdout[2] ?? -1];
  }
  async function exportFile(storageKey: string, name: string) {
    const bytes = await read(() => mem.getObject(storageKey));
    if (!bytes) throw new Error(`missing ${storageKey}`);
    const path = join(dir, name);
    await writeFile(path, bytes);
    return { path, bytes };
  }

  const clip = (id: string, assetVersionId: string, over: Partial<VideoClipItem> = {}): VideoClipItem => ({
    id,
    assetVersionId,
    sourceInMs: 0,
    sourceOutMs: 2_000,
    startMs: 0,
    frame: { fit: 'fill', focalX: 0.5, focalY: 0.5, zoom: 1 },
    gainDb: 0,
    muted: true,
    locked: false,
    ...over,
  });

  async function createVideo(
    video: { formatKey: 'video_9x16' | 'video_16x9'; fps: 30; durationMs: number },
    ops: VideoOperation[],
  ) {
    const created = await run((tx) =>
      creativeService.documents.create(A, { brandId: brandA, title: 'Reel', kind: 'video', video }, tx),
    );
    const applied = await run((tx) =>
      creativeService.videoOperations.apply(
        A,
        {
          documentId: created.documentId,
          baseRevisionId: created.revisionId,
          operations: ops,
          summary: 'build',
          origin: 'user',
        },
        tx,
      ),
    );
    return { documentId: created.documentId, revisionId: applied.revision.id, findings: applied.findings };
  }
  const request = (documentId: string, revisionId: string, formatKey: string) =>
    run((tx) => creativeService.renders.request(A, { documentId, revisionId, formatKeys: [formatKey] }, tx));
  const jobRow = async (id: string) =>
    (await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, id)))[0]!;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'video-render-e2e-'));
    configureStorage(mem);
    registerAssetAuthoriser(async (assetVersionId, c, tx) => {
      await assetService.authoriseUse(
        assetVersionId,
        c.purpose,
        { brandId: c.brandId, ...(c.kinds ? { kinds: c.kinds } : {}) },
        tx,
      );
    });
    registerCreativeAssetCatalog({
      mediaInfo: (ids, tx) => assetService.mediaSummaries(ids, tx),
      currentVersionIds: (ids, tx) => assetService.currentVersionIds(ids, tx),
    });
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: `video-e2e-${tenantA.slice(-6).toLowerCase()}` });
    await tdb.db
      .insert(users)
      .values({ id: ownerA, email: `${ownerA.toLowerCase()}@example.test`, name: 'owner a' });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A1',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId: tenantA,
      userId: ownerA,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    // The brand's type roles name the fixture font asset, so captions bind to it.
    const font = await loadFixtureFont(FIXTURE_FONTS.karla);
    const fontAsset = await seedAsset('font', 'font', font.mime, font.bytes, null, null);
    fontVersion = fontAsset.versionId;
    const doc = brandDocument();
    doc.tokens.typeRoles = doc.tokens.typeRoles.map((t) => ({ ...t, fontAssetId: fontAsset.id }));
    const bvId = newId('brandVersion');
    await tdb.db.insert(brandVersions).values({
      id: bvId,
      tenantId: tenantA,
      brandId: brandA,
      number: 1,
      state: 'published',
      document: doc,
      contentHash: hashCanonical(doc),
      publishedAt: new Date(),
      publishedByUserId: ownerA,
    });
    await tdb.db.update(brands).set({ publishedVersionId: bvId }).where(eq(brands.id, brandA));
    // Sources: solid-colour clips whose green channel counts frames, a still, and a beep at 1.0 s.
    await ff([
      '-f',
      'lavfi',
      '-i',
      "color=c=black:s=640x360:r=30,format=gbrp,geq=r='0':g='mod(N*8,256)':b='0'",
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv444p',
      '-movflags',
      '+faststart',
      join(dir, 'a.mp4'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x0000ff:s=640x360:r=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:sample_rate=48000',
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
      join(dir, 'b.mp4'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc=exprs='if(between(t,1,1.1),0.8*sin(2*PI*1000*t),0)':s=48000:d=3",
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      join(dir, 'beep.mp3'),
    ]);
    await seedAsset('clipA', 'video', 'video/mp4', join(dir, 'a.mp4'), null, null);
    await seedAsset('clipB', 'video', 'video/mp4', join(dir, 'b.mp4'), null, null);
    await seedAsset('beep', 'audio', 'audio/mpeg', join(dir, 'beep.mp3'), null, null);
  }, 300_000);
  afterAll(async () => {
    await renderer.close();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  let firstExport: typeof renderedExports.$inferSelect;
  let doc1 = { documentId: '', revisionId: '' };

  it('request → pending → rendering → ready: one MP4 export with poster, captions, dedupe key and the stored bytes’ hash', async () => {
    const a = seeded['clipA']!.versionId;
    const b = seeded['clipB']!.versionId;
    doc1 = await createVideo({ formatKey: 'video_9x16', fps: 30, durationMs: 4_000 }, [
      {
        op: 'insertClip',
        trackId: 'trk_video',
        item: clip('c1', a, { sourceInMs: 1_000, sourceOutMs: 3_000 }),
      },
      { op: 'insertClip', trackId: 'trk_video', item: clip('c2', b, { startMs: 2_000, muted: true }) },
      {
        op: 'setTransition',
        trackId: 'trk_video',
        itemId: 'c2',
        transition: { kind: 'fade_black', durationMs: 400 },
      },
      {
        op: 'setOverlay',
        trackId: 'trk_titles',
        overlay: {
          id: 'ov_title',
          startMs: 500,
          endMs: 1_500,
          locked: false,
          element: {
            id: newId('element'),
            name: 'Title',
            type: 'text',
            locked: false,
            visible: true,
            opacity: 1,
            protected: false,
            transform: { x: 100, y: 400, width: 880, height: 300, rotation: 0 },
            text: 'MMMMMM',
            factRefs: [],
            style: {
              typeRole: 'display',
              fontAssetVersionId: fontVersion,
              weight: 700,
              sizePx: 200,
              lineHeight: 1.1,
              tracking: 0,
              colourToken: 'paper',
              align: 'center',
              overflow: 'shrink_to_fit',
            },
          },
        },
      },
      {
        op: 'upsertCaption',
        trackId: 'trk_captions',
        caption: { id: 'cap_1', startMs: 2_500, endMs: 3_500, text: 'Captions are burnt in', locked: false },
      },
      {
        op: 'insertClip',
        trackId: 'trk_music',
        item: {
          id: 'beep',
          assetVersionId: seeded['beep']!.versionId,
          sourceInMs: 500,
          sourceOutMs: 2_500,
          startMs: 1_000,
          gainDb: 0,
          fadeInMs: 0,
          fadeOutMs: 0,
          muted: false,
          locked: false,
        },
      },
    ]);
    const queued = await request(doc1.documentId, doc1.revisionId, 'video_9x16');
    expect((await jobRow(queued.renderJobId)).state).toBe('pending');
    const result = await runVideoRender(acts, inputFor(queued.renderJobId), noCancel);
    expect(result).toEqual({ outcome: 'ready', exportIds: expect.any(Array), reused: false });
    const job = await jobRow(queued.renderJobId);
    expect(job).toMatchObject({ state: 'ready', error: null });
    const [row] = await tdb.db
      .select()
      .from(renderedExports)
      .where(eq(renderedExports.revisionId, doc1.revisionId));
    firstExport = row!;
    expect(row).toMatchObject({
      mime: 'video/mp4',
      pageId: 'timeline',
      formatKey: 'video_9x16',
      width: 1080,
      height: 1920,
      durationMs: 4_000,
      fps: 30,
    });
    expect(row!.rendererVersion).toBe(`${RENDERER_VERSION}+video.1`);
    expect(row!.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.posterStorageKey).toMatch(/\.poster\.webp$/);
    expect(row!.captionsStorageKey).toMatch(/\.vtt$/);
    expect(row!.manifest.assets.map((x) => x.assetVersionId).sort()).toEqual(
      [seeded['clipA']!.versionId, seeded['clipB']!.versionId, seeded['beep']!.versionId].sort(),
    );
    expect(row!.manifest.fonts.map((f) => f.assetVersionId)).toEqual([fontVersion]);
    const mp4 = await exportFile(row!.storageKey, 'first.mp4');
    expect(sha256(mp4.bytes)).toBe(row!.contentHash);
    const vtt = await read(() => mem.getObject(row!.captionsStorageKey!));
    expect(vtt?.toString()).toContain('00:00:02.500 --> 00:00:03.500\nCaptions are burnt in');
    // The overlay frames were working files: removed after the encode.
    expect(mem.keys().filter((k) => k.includes(`/${queued.renderJobId}/work/`))).toEqual([]);

    // Picture: the Chromium-drawn white title over clip A in its window only; clip B (blue) after its transition.
    const white = (p: number[]) => p.every((c) => c > 200);
    const textAt = async (n: number) => {
      for (const [x, y] of [
        [300, 520],
        [400, 520],
        [540, 520],
        [680, 520],
        [760, 520],
        [540, 560],
      ] as const)
        if (white(await pixel(mp4.path, n, x, y))) return true;
      return false;
    };
    expect(await textAt(10)).toBe(false);
    expect(await textAt(15)).toBe(true);
    expect(await textAt(44)).toBe(true);
    expect(await textAt(45)).toBe(false);
    const blue = await pixel(mp4.path, 90, 540, 900);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]! + blue[1]!).toBeLessThan(30);
    // Fade through black centred on the 2.0 s cut (6 frames each side): A out to black, B in from black.
    expect((await pixel(mp4.path, 53, 540, 900))[1] ?? 0).toBeGreaterThan(100);
    expect((await pixel(mp4.path, 60, 540, 900)).every((c) => c < 12)).toBe(true);
    const halfIn = await pixel(mp4.path, 63, 540, 900);
    expect(halfIn[2]).toBeGreaterThan(90);
    expect(halfIn[2]).toBeLessThan(170);
    expect((await pixel(mp4.path, 66, 540, 900))[2]).toBeGreaterThan(240);
    // Clip A at source 1.0 s: green = 8 × (30 + n).
    expect(Math.abs(((await pixel(mp4.path, 0, 540, 900))[1] ?? 0) - 240)).toBeLessThanOrEqual(8);
    // The caption box (brand text colour, 60 % opacity) under burnt-in text, only in its window.
    const captionBand = async (n: number) => (await pixel(mp4.path, n, 70, 1520)).reduce((s, c) => s + c, 0);
    const blueBand = await captionBand(70); // B alone: blue
    const withCaption = await captionBand(80);
    expect(withCaption).toBeLessThan(blueBand - 60);

    // Sound: the beep (1.0 s into its source, trimmed by 0.5 s, placed at 1.0 s) sounds at 1.5 s.
    const pcm = await runTool(
      'ffmpeg',
      ['-v', 'error', '-i', mp4.path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
      { timeoutMs: 60_000, maxStdoutBytes: 64 * 1024 * 1024 },
    );
    const samples = new Int16Array(
      pcm.stdout.buffer,
      pcm.stdout.byteOffset,
      Math.floor(pcm.stdout.length / 2),
    );
    const onset = samples.findIndex((s) => Math.abs(s) > 3_000);
    expect(Math.abs(onset / 48 - 1_500)).toBeLessThanOrEqual(15);
  }, 600_000);

  it('rendering the same revision again reuses the export (same dedupe key): no encode, the same file', async () => {
    const before = composeCalls.length;
    const queued = await request(doc1.documentId, doc1.revisionId, 'video_9x16');
    const result = await runVideoRender(acts, inputFor(queued.renderJobId), noCancel);
    expect(result).toMatchObject({ outcome: 'ready', reused: true });
    expect(composeCalls.length).toBe(before);
    const rows = await tdb.db
      .select()
      .from(renderedExports)
      .where(eq(renderedExports.revisionId, doc1.revisionId));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.storageKey).toBe(firstExport.storageKey);
    expect(rows[1]!.dedupeKey).toBe(firstExport.dedupeKey);
  }, 300_000);

  it('a person’s cancel stops a running encode: the job stays cancelled and nothing is exported', async () => {
    const a = seeded['clipA']!.versionId;
    const long = await createVideo({ formatKey: 'video_9x16', fps: 30, durationMs: 60_000 }, [
      { op: 'insertClip', trackId: 'trk_video', item: clip('c1', a, { sourceOutMs: 4_000 }) },
      {
        op: 'insertClip',
        trackId: 'trk_video',
        item: { ...clip('c2', a, { sourceOutMs: 4_000, startMs: 4_000 }), assetVersionId: a },
      },
      { op: 'setDuration', durationMs: 60_000 },
      {
        op: 'upsertCaption',
        trackId: 'trk_captions',
        caption: { id: 'cap_long', startMs: 0, endMs: 3_000, text: 'Long take', locked: false },
      },
    ]);
    const slow = makeActs({ preset: 'medium', crf: 18, threads: 1 });
    const queued = await request(long.documentId, long.revisionId, 'video_9x16');
    const running = runVideoRender(slow, inputFor(queued.renderJobId), noCancel);
    // Wait until the encode reports progress, then cancel as a person would.
    const started = Date.now();
    while (!(await jobRow(queued.renderJobId)).progress && Date.now() - started < 120_000)
      await new Promise((r) => setTimeout(r, 200));
    await run((tx) => creativeService.renders.cancel(A, { renderJobId: queued.renderJobId }, tx));
    const cancelledAt = Date.now();
    expect(await running).toEqual({ outcome: 'cancelled' });
    expect(Date.now() - cancelledAt).toBeLessThan(15_000); // ffmpeg was killed, not waited for
    expect((await jobRow(queued.renderJobId)).state).toBe('cancelled');
    expect(
      await tdb.db.select().from(renderedExports).where(eq(renderedExports.revisionId, long.revisionId)),
    ).toEqual([]);
    // Its working files (the caption frame) were deleted: nothing is left under the job's prefix.
    expect(mem.keys().filter((k) => k.includes(`/${queued.renderJobId}/`))).toEqual([]);
  }, 600_000);

  it('a HEIC still is read from its WebP rendition; one without a rendition is refused as unsupported_source', async () => {
    await ff(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=800x600', '-frames:v', '1', join(dir, 'still.webp')]);
    const heic = await seedAsset(
      'heic',
      'photo',
      'image/heic',
      Buffer.from('not decodable by ffmpeg'),
      800,
      600,
    );
    const webp = await readFile(join(dir, 'still.webp'));
    const key = storageKeys.derivative(tenantA, brandA, heic.id, heic.versionId, 'web');
    await read(() => mem.putObject(key, webp, { contentType: 'image/webp' }));
    await tdb.db.insert(assetDerivatives).values({
      id: newId('assetDerivative'),
      tenantId: tenantA,
      brandId: brandA,
      assetVersionId: heic.versionId,
      purpose: 'web',
      transform: { op: 'resize', format: 'webp' },
      storageKey: key,
      contentHash: sha256(webp),
      mime: 'image/webp',
      width: 800,
      height: 600,
      bytes: webp.length,
    });
    const ok = await createVideo({ formatKey: 'video_9x16', fps: 30, durationMs: 1_000 }, [
      { op: 'insertClip', trackId: 'trk_video', item: clip('still', heic.versionId, { sourceOutMs: 1_000 }) },
    ]);
    const queued = await request(ok.documentId, ok.revisionId, 'video_9x16');
    expect(await runVideoRender(acts, inputFor(queued.renderJobId), noCancel)).toMatchObject({
      outcome: 'ready',
    });
    const [row] = await tdb.db
      .select()
      .from(renderedExports)
      .where(eq(renderedExports.revisionId, ok.revisionId));
    const mp4 = await exportFile(row!.storageKey, 'heic.mp4');
    const [r, , b] = await pixel(mp4.path, 10, 540, 960);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(40);

    const bare = await seedAsset('heic2', 'photo', 'image/heic', Buffer.from('no rendition'), 800, 600);
    const refused = await createVideo({ formatKey: 'video_9x16', fps: 30, durationMs: 1_000 }, [
      { op: 'insertClip', trackId: 'trk_video', item: clip('bare', bare.versionId, { sourceOutMs: 1_000 }) },
    ]);
    const job = await request(refused.documentId, refused.revisionId, 'video_9x16');
    expect(await runVideoRender(acts, inputFor(job.renderJobId), noCancel)).toEqual({
      outcome: 'failed',
      reason: 'unsupported_source',
    });
  }, 300_000);

  it('measures a 30 s 1080p (16:9) render at production settings', async () => {
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '16',
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
      join(dir, 'hd.mp4'),
    ]);
    const hd = await seedAsset('hd', 'video', 'video/mp4', join(dir, 'hd.mp4'), null, null);
    const ops: VideoOperation[] = [];
    for (let k = 0; k < 3; k++)
      ops.push({
        op: 'insertClip',
        trackId: 'trk_video',
        item: clip(`hd${k}`, hd.versionId, {
          sourceInMs: k * 2_000,
          sourceOutMs: k * 2_000 + 10_000,
          startMs: k * 10_000,
          muted: false,
        }),
      });
    ops.push({
      op: 'setTransition',
      trackId: 'trk_video',
      itemId: 'hd1',
      transition: { kind: 'crossfade', durationMs: 1_000 },
    });
    ops.push({
      op: 'setTransition',
      trackId: 'trk_video',
      itemId: 'hd2',
      transition: { kind: 'slide', durationMs: 1_000 },
    });
    for (let k = 0; k < 6; k++)
      ops.push({
        op: 'upsertCaption',
        trackId: 'trk_captions',
        caption: {
          id: `cap_${k}`,
          startMs: k * 5_000,
          endMs: k * 5_000 + 4_000,
          text: `Caption number ${k + 1} for the demo`,
          locked: false,
        },
      });
    const p = await createVideo({ formatKey: 'video_16x9', fps: 30, durationMs: 30_000 }, ops);
    const production = makeActs({ preset: 'veryfast', crf: 20, threads: 2 });
    const queued = await request(p.documentId, p.revisionId, 'video_16x9');
    const t0 = Date.now();
    const result = await runVideoRender(production, inputFor(queued.renderJobId), noCancel);
    const ms = Date.now() - t0;
    expect(result).toMatchObject({ outcome: 'ready' });
    const [row] = await tdb.db
      .select()
      .from(renderedExports)
      .where(eq(renderedExports.revisionId, p.revisionId));
    expect(row).toMatchObject({ width: 1920, height: 1080, durationMs: 30_000, fps: 30 });
    console.info(
      `[measure] 30 s 1920x1080 30 fps, 3 clips, 2 transitions, 6 captions, veryfast/CRF 20/2 threads: ${ms} ms end to end, ${row!.bytes} bytes`,
    );
  }, 900_000);
});
