import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { IMAGE_CREATIVE_KINDS, type AssetKind } from '@oremedia/contracts/assets';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import {
  NotFoundError,
  PolicyDeniedError,
  RightsIneligibleError,
  StaleRevisionError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type {
  AudioItem,
  VideoClipItem,
  VideoMediaInfo,
  VideoOperation,
  VideoOperationsApply,
} from '@oremedia/contracts/video';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { creativeDocuments, creativeRevisions, renderJobs } from '@oremedia/db/schema/creative';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import {
  brandService,
  registerBrandAssetKindSource,
  resetBrandAssetKindSource,
} from '@oremedia/module-brand';
import { registerCreativeOutboxRoutes } from './outbox-routes';
import { outboxRouteFor, type OutboxEventRecord } from '@oremedia/module-operations';
import { creativeService, registerAssetAuthoriser, registerRevisionChangeHook } from './service';
import { registerCreativeAssetCatalog } from './video-support';

/**
 * STU-2b video documents against MySQL 8: creation from a preset and from a starter template bound to the brand's
 * fonts, colours and logo; timeline operations through applyVideo/proposeVideo with guards, locks, asset
 * authorisation by kind (clips take video or stills, audio tracks take sound), source limits from the assets
 * module's descriptions, stale checks and agent rules; renders queued for the `video` queue at the project's own
 * format, cancel relayed as a signal; graphic documents unchanged and the two kinds never mixed; foreign ids
 * NOT_FOUND. The assets module is replaced by recording fakes (its own suites test authoriseUse and mediaSummaries).
 */
const USER = 'usr_video_test';
const AGENT = 'sp_video_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_video',
});
const manager = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_video_test',
  membershipStatus: 'active',
  role: 'brand_manager',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: AGENT,
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'creative.read', brandIds: 'all' },
    { action: 'creative.edit', brandIds: 'all' },
    { action: 'creative.render', brandIds: 'all' },
  ],
});
const AGENT_OPTS = { autonomyMode: 'create' as const };
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: {
    ...emptyBrandSystemDocument().voice,
    summary: 'Plain',
    tone: ['plain'],
    prohibitedPhrases: ['cheap'],
  },
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
      { key: 'accent', value: '#0F6E63', role: 'accent' },
    ],
    typeRoles: [
      { role: 'display', fontAssetId: 'ast_font', weight: 600, minSizePx: 40 },
      { role: 'heading', fontAssetId: 'ast_font', weight: 600, minSizePx: 28 },
      { role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 18 },
      { role: 'caption', fontAssetId: 'ast_font', weight: 400, minSizePx: 12 },
    ],
    spacingScale: [4, 8, 16],
    radii: [0, 4],
    contrastTarget: 'AA',
  },
  logoRules: [
    {
      assetId: 'ast_logo',
      variant: 'primary',
      allowedBackgroundColourKeys: ['paper'],
      clearSpaceRatio: 0.2,
      minWidthPx: 120,
    },
  ],
});

async function publishBrand(tenantId: string, brandId: string, document: BrandSystemDocumentV1) {
  const actor = manager(tenantId);
  const draft = await run(tenantId, (tx) => brandService.versions.createDraft(actor, { brandId }, tx));
  await run(tenantId, (tx) =>
    brandService.versions.update(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 0, document },
      tx,
    ),
  );
  await run(tenantId, (tx) =>
    brandService.versions.submitForReview(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 1 },
      tx,
    ),
  );
  await run(tenantId, (tx) =>
    brandService.versions.publish(actor, { brandId, versionId: draft.versionId, expectedVersion: 2 }, tx),
  );
  return draft.versionId;
}

const MEDIA: Record<string, VideoMediaInfo> = {
  av_clip: {
    assetVersionId: 'av_clip',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 8_000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    derivatives: ['proxy', 'strip', 'strip_map', 'waveform'],
  },
  av_clip2: {
    assetVersionId: 'av_clip2',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 3_000,
    width: 1080,
    height: 1920,
    hasAudio: false,
    derivatives: ['proxy'],
  },
  av_music: {
    assetVersionId: 'av_music',
    kind: 'audio',
    mime: 'audio/mpeg',
    durationMs: 30_000,
    width: null,
    height: null,
    hasAudio: true,
    derivatives: ['proxy', 'waveform'],
  },
  av_photo: {
    assetVersionId: 'av_photo',
    kind: 'image',
    mime: 'image/png',
    durationMs: null,
    width: 1200,
    height: 800,
    hasAudio: false,
    derivatives: ['web'],
  },
};

const clip = (id: string, over: Partial<VideoClipItem> = {}): VideoClipItem => ({
  id,
  assetVersionId: 'av_clip',
  sourceInMs: 0,
  sourceOutMs: 4_000,
  startMs: 0,
  frame: { fit: 'fill', focalX: 0.5, focalY: 0.5, zoom: 1 },
  gainDb: 0,
  muted: false,
  locked: false,
  ...over,
});

describe('video documents (STU-2b) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  const agentA = agent(tenantA);
  let docId = '';
  let headRev = '';
  let graphicDocId = '';
  let docB = '';
  let revB = '';
  const authorised: Array<{ assetVersionId: string; purpose: string; kinds?: readonly AssetKind[] }> = [];
  const denied = new Set<string>();
  const hookCalls: string[] = [];

  const apply = (ops: VideoOperation[], over: Partial<VideoOperationsApply> = {}) =>
    run(tenantA, (tx) =>
      creativeService.videoOperations.apply(
        A,
        {
          documentId: docId,
          baseRevisionId: headRev,
          operations: ops,
          summary: 'edit',
          origin: 'user',
          ...over,
        },
        tx,
      ),
    ).then((r) => {
      headRev = r.revision.id;
      return r;
    });
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (err) {
      return err;
    }
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    registerBrandAssetKindSource(
      async (_b, ids) =>
        new Map(ids.map((id) => [id, id === 'ast_font' ? ('font' as const) : ('logo' as const)])),
    );
    registerAssetAuthoriser(async (assetVersionId, c) => {
      authorised.push({ assetVersionId, purpose: c.purpose, ...(c.kinds ? { kinds: c.kinds } : {}) });
      if (denied.has(assetVersionId)) throw new RightsIneligibleError(assetVersionId, 'rights_unknown');
      const kind = MEDIA[assetVersionId]?.kind;
      // The real authoriser refuses a version whose asset kind is not among the accepted kinds.
      const assetKind: AssetKind | undefined = kind === 'image' ? 'photo' : kind;
      if (c.kinds && assetKind && !c.kinds.includes(assetKind))
        throw new RightsIneligibleError(assetVersionId, 'kind_not_allowed');
    });
    registerCreativeAssetCatalog({
      mediaInfo: async (versionIds) => versionIds.flatMap((id) => (MEDIA[id] ? [MEDIA[id]] : [])),
      currentVersionIds: async (assetIds) =>
        Object.fromEntries(
          assetIds.flatMap((id) =>
            id === 'ast_font' ? [[id, 'av_font']] : id === 'ast_logo' ? [[id, 'av_logo']] : [],
          ),
        ),
    });
    registerRevisionChangeHook(async (documentId) => {
      hookCalls.push(documentId);
    });
    registerCreativeOutboxRoutes();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'video-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'video-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    await publishBrand(tenantA, brandA, brandDocument());
    await publishBrand(tenantB, brandB, brandDocument());
    const b = await run(tenantB, (tx) =>
      creativeService.documents.create(
        manager(tenantB),
        { brandId: brandB, title: 'B video', kind: 'video', video: { formatKey: 'video_1x1', fps: 25 } },
        tx,
      ),
    );
    docB = b.documentId;
    revB = b.revisionId;
  }, 120_000);
  afterAll(async () => {
    resetBrandAssetKindSource();
    await tdb?.drop();
  });

  describe('documents.create', () => {
    it('creates a blank video at a preset and frame rate: kind video, revision 1 with addTrack operations', async () => {
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(
          A,
          {
            brandId: brandA,
            title: 'Launch reel',
            kind: 'video',
            video: { formatKey: 'video_9x16', fps: 30, durationMs: 12_000 },
          },
          tx,
        ),
      );
      docId = created.documentId;
      headRev = created.revisionId;
      expect(created).toMatchObject({ number: 1, kind: 'video' });
      const [row] = await tdb.db.select().from(creativeDocuments).where(eq(creativeDocuments.id, docId));
      expect(row?.kind).toBe('video');
      const got = await run(tenantA, () => creativeService.documents.get(A, { documentId: docId }));
      expect(got.kind).toBe('video');
      if (got.revision.kind !== 'video') throw new Error('expected video');
      expect(got.revision.snapshot.format).toEqual({ key: 'video_9x16', width: 1080, height: 1920, fps: 30 });
      expect(got.revision.snapshot.durationMs).toBe(12_000);
      expect(got.revision.snapshot.tracks.map((t) => t.kind)).toEqual([
        'video',
        'overlay',
        'caption',
        'audio',
      ]);
      expect(got.revision.operations.operations.every((o) => o.op === 'addTrack')).toBe(true);
      expect(got.media).toEqual([]);
      // The caption track is bound to the brand's caption font (current version of its font asset).
      expect(authorised).toContainEqual({ assetVersionId: 'av_font', purpose: 'font' });
    });

    it('creates from a starter template with brand-bound titles, captions and the primary logo', async () => {
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(
          A,
          {
            brandId: brandA,
            title: 'Promo',
            kind: 'video',
            video: { formatKey: 'video_9x16', fps: 30, templateKey: 'promo_vertical_15s' },
          },
          tx,
        ),
      );
      const got = await run(tenantA, () =>
        creativeService.documents.get(A, { documentId: created.documentId }),
      );
      if (got.revision.kind !== 'video') throw new Error('expected video');
      const p = got.revision.snapshot;
      expect(p).toMatchObject({ templateKey: 'promo_vertical_15s', durationMs: 15_000 });
      expect(p.scenes.map((s) => s.title)).toEqual(['Hook', 'Product', 'Offer', 'Call to action']);
      const overlays = p.tracks.find((t) => t.kind === 'overlay');
      expect(
        overlays?.kind === 'overlay' && overlays.items.find((o) => o.id === 'ov_logo')?.element,
      ).toMatchObject({ type: 'logo', assetVersionId: 'av_logo' });
      expect(authorised).toContainEqual({
        assetVersionId: 'av_logo',
        purpose: 'creative',
        kinds: IMAGE_CREATIVE_KINDS,
      });
    });

    it('refuses a video without options, video options on a graphic, and unknown templates', async () => {
      for (const input of [
        { brandId: brandA, title: 'x', kind: 'video' as const },
        { brandId: brandA, title: 'x', video: { formatKey: 'video_1x1' as const, fps: 30 as const } },
        {
          brandId: brandA,
          title: 'x',
          kind: 'video' as const,
          video: { formatKey: 'video_1x1' as const, fps: 30 as const, templateKey: 'nope' },
        },
      ])
        expect(
          await failure(run(tenantA, (tx) => creativeService.documents.create(A, input, tx))),
        ).toBeInstanceOf(ValidationFailedError);
    });

    it('existing graphic documents are untouched: created, read and edited exactly as before', async () => {
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(A, { brandId: brandA, title: 'Feed' }, tx),
      );
      graphicDocId = created.documentId;
      const got = await run(tenantA, () => creativeService.documents.get(A, { documentId: graphicDocId }));
      expect(got.kind).toBe('graphic');
      expect(got.revision.kind).toBe('graphic');
      const [rev] = await tdb.db
        .select()
        .from(creativeRevisions)
        .where(eq(creativeRevisions.id, created.revisionId));
      expect(rev?.snapshot).not.toHaveProperty('kind'); // the stored graphic snapshot has no new field
      expect(hashCanonical(rev?.snapshot)).toBe(created.contentHash);
    });
  });

  describe('graphic revisions written before video existed', () => {
    it('a graphic document and revision stored by earlier code read back unchanged (same snapshot and hash)', async () => {
      const documentId = newId('creativeDocument');
      const revisionId = newId('creativeRevision');
      const snapshot = {
        schemaVersion: 1,
        brandVersionId: 'bv_old',
        pages: [
          {
            id: 'page_1',
            name: 'Feed',
            formatKey: 'square_1080',
            width: 1080,
            height: 1080,
            elements: [],
            layoutConstraints: [],
          },
        ],
        variants: [],
      };
      const at = new Date();
      // As 0024-era code wrote them: no kind column value (the default applies), the graphic batch and snapshot.
      await tdb.db.execute(
        sql`insert into ${creativeDocuments} (id, tenant_id, brand_id, title, current_revision_id, schema_version, created_at, updated_at, version) values (${documentId}, ${tenantA}, ${brandA}, 'Old', ${revisionId}, 1, ${at}, ${at}, 1)`,
      );
      await tdb.db.insert(creativeRevisions).values({
        id: revisionId,
        tenantId: tenantA,
        brandId: brandA,
        documentId,
        parentRevisionId: null,
        number: 1,
        brandVersionId: 'bv_old',
        authorKind: 'user',
        authorId: USER,
        changeSummary: 'Initial document',
        operations: {
          baseRevisionId: '',
          operations: snapshot.pages.map((page, index) => ({ op: 'addPage', page, index })),
          summary: 'Initial document',
          origin: 'user',
        },
        snapshot: snapshot as never,
        contentHash: hashCanonical(snapshot),
      });
      const got = await run(tenantA, () => creativeService.documents.get(A, { documentId }));
      expect(got.kind).toBe('graphic');
      expect(got.revision.kind).toBe('graphic');
      expect(got.revision.snapshot).toEqual(snapshot);
      expect(hashCanonical(got.revision.snapshot)).toBe(hashCanonical(snapshot));
      expect(got.media).toEqual([]);
    });
  });

  describe('operations.applyVideo / proposeVideo', () => {
    it('applies a sequence: clips, a ripple insert, a trim, a split, audio and a caption, as one new revision', async () => {
      const music: AudioItem = {
        id: 'aud_1',
        assetVersionId: 'av_music',
        sourceInMs: 0,
        sourceOutMs: 12_000,
        startMs: 0,
        gainDb: -8,
        fadeInMs: 500,
        fadeOutMs: 1_000,
        muted: false,
        locked: false,
      };
      const r = await apply([
        { op: 'insertClip', trackId: 'trk_video', item: clip('c1') },
        {
          op: 'insertClip',
          trackId: 'trk_video',
          item: clip('c2', { assetVersionId: 'av_photo', startMs: 4_000, sourceOutMs: 3_000 }),
        },
        {
          op: 'insertClip',
          trackId: 'trk_video',
          item: clip('c0', { assetVersionId: 'av_clip2', sourceOutMs: 2_000 }),
          ripple: true,
        },
        {
          op: 'trimClip',
          trackId: 'trk_video',
          itemId: 'c1',
          sourceInMs: 1_000,
          sourceOutMs: 4_000,
          ripple: true,
        },
        { op: 'splitClip', trackId: 'trk_video', itemId: 'c2', atMs: 6_500, newItemId: 'c3' },
        {
          op: 'setTransition',
          trackId: 'trk_video',
          itemId: 'c1',
          transition: { kind: 'crossfade', durationMs: 800 },
        },
        { op: 'insertClip', trackId: 'trk_music', item: music },
        {
          op: 'upsertCaption',
          trackId: 'trk_captions',
          caption: { id: 'cap_a', startMs: 0, endMs: 2_000, text: 'Hello there', locked: false },
        },
      ]);
      expect(r.revision.kind).toBe('video');
      expect(r.revision.number).toBe(2);
      const v = r.revision.snapshot.tracks.find((t) => t.kind === 'video');
      expect(v?.items.map((c) => [c.id, c.startMs])).toEqual([
        ['c0', 0],
        ['c1', 2_000],
        ['c2', 5_000],
        ['c3', 6_500],
      ]);
      expect(r.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
      expect(r.media.map((m) => m.assetVersionId).sort()).toEqual([
        'av_clip',
        'av_clip2',
        'av_music',
        'av_photo',
      ]);
      // Clips are authorised as picture sources, audio as sound, by kind.
      expect(authorised).toContainEqual({
        assetVersionId: 'av_clip',
        purpose: 'creative',
        kinds: ['video', ...IMAGE_CREATIVE_KINDS],
      });
      expect(authorised).toContainEqual({
        assetVersionId: 'av_music',
        purpose: 'creative',
        kinds: ['audio', 'video'],
      });
      expect(hookCalls).toContain(docId);
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(
          and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'creative.revision_created')),
        );
      expect(events.some((e) => (e.payload as Record<string, unknown>)['revisionId'] === r.revision.id)).toBe(
        true,
      );
      const got = await run(tenantA, () => creativeService.documents.get(A, { documentId: docId }));
      expect(got.media.map((m) => m.assetVersionId).sort()).toEqual([
        'av_clip',
        'av_clip2',
        'av_music',
        'av_photo',
      ]);
    });

    it('refuses invariant breaks with a clear issue: beyond the source, overlap, too long', async () => {
      const cases: Array<[VideoOperation, string]> = [
        [
          {
            op: 'trimClip',
            trackId: 'trk_video',
            itemId: 'c1',
            sourceInMs: 1_000,
            sourceOutMs: 9_000,
            ripple: true,
          },
          'beyond_source',
        ],
        [{ op: 'moveClip', trackId: 'trk_video', itemId: 'c3', startMs: 1_000 }, 'overlap'],
        [
          {
            op: 'insertClip',
            trackId: 'trk_video',
            item: clip('long', { assetVersionId: 'av_photo', startMs: 170_000, sourceOutMs: 20_000 }),
          },
          'duration_exceeds_max',
        ],
        [
          {
            op: 'insertClip',
            trackId: 'trk_music',
            item: {
              id: 'a2',
              assetVersionId: 'av_photo',
              sourceInMs: 0,
              sourceOutMs: 1_000,
              startMs: 20_000,
              gainDb: 0,
              fadeInMs: 0,
              fadeOutMs: 0,
              muted: false,
              locked: false,
            },
          },
          'kind_not_allowed',
        ],
      ];
      for (const [op, issue] of cases) {
        const err = await failure(apply([op]));
        if (issue === 'kind_not_allowed') expect(err).toBeInstanceOf(RightsIneligibleError);
        else {
          expect(err).toBeInstanceOf(ValidationFailedError);
          expect((err as ValidationFailedError).details?.[0]?.issue).toMatch(new RegExp(`^${issue}`));
        }
      }
    });

    it('an unknown source is refused (strict media on the server)', async () => {
      const err = await failure(
        apply([
          {
            op: 'insertClip',
            trackId: 'trk_video',
            item: clip('x', { assetVersionId: 'av_missing', startMs: 30_000 }),
          },
        ]),
      );
      expect((err as ValidationFailedError).details?.[0]?.issue).toMatch(/^media_unknown/);
    });

    it('a stale base is STALE_REVISION; graphic batches on a video and video batches on a graphic are refused', async () => {
      const stale = await failure(
        run(tenantA, (tx) =>
          creativeService.videoOperations.apply(
            A,
            {
              documentId: docId,
              baseRevisionId: 'rev_old',
              operations: [{ op: 'setDuration', durationMs: 20_000 }],
              summary: 's',
              origin: 'user',
            },
            tx,
          ),
        ),
      );
      expect(stale).toBeInstanceOf(StaleRevisionError);
      const graphicOnVideo = await failure(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            A,
            {
              documentId: docId,
              baseRevisionId: headRev,
              operations: [{ op: 'setLock', pageId: 'page_1', elementId: newElementId(), locked: true }],
              summary: 's',
              origin: 'user',
            },
            tx,
          ),
        ),
      );
      expect((graphicOnVideo as ValidationFailedError).details?.[0]?.issue).toBe('document_is_video');
      const graphicHead = await run(tenantA, () =>
        creativeService.documents.get(A, { documentId: graphicDocId }),
      );
      const videoOnGraphic = await failure(
        run(tenantA, (tx) =>
          creativeService.videoOperations.apply(
            A,
            {
              documentId: graphicDocId,
              baseRevisionId: graphicHead.revision.id,
              operations: [{ op: 'setDuration', durationMs: 20_000 }],
              summary: 's',
              origin: 'user',
            },
            tx,
          ),
        ),
      );
      expect((videoOnGraphic as ValidationFailedError).details?.[0]?.issue).toBe('document_is_graphic');
    });

    it('propose is a dry run with findings; nothing is written', async () => {
      const before = await tdb.db
        .select()
        .from(creativeRevisions)
        .where(eq(creativeRevisions.documentId, docId));
      const proposal = await run(tenantA, (tx) =>
        creativeService.videoOperations.propose(
          A,
          {
            documentId: docId,
            baseRevisionId: headRev,
            operations: [
              {
                op: 'upsertCaption',
                trackId: 'trk_captions',
                caption: {
                  id: 'cap_b',
                  startMs: 1_000,
                  endMs: 1_200,
                  text: 'This is cheap and much too long for its time',
                  locked: false,
                },
              },
            ],
            summary: 'p',
            origin: 'user',
          },
          tx,
        ),
      );
      expect(proposal.blocking).toBe(true);
      expect(proposal.findings.map((f) => f.code)).toEqual(
        expect.arrayContaining(['prohibited_phrase', 'caption_overlap', 'caption_too_fast']),
      );
      expect(proposal.changedItemIds).toEqual(['cap_b']);
      expect(
        await tdb.db.select().from(creativeRevisions).where(eq(creativeRevisions.documentId, docId)),
      ).toHaveLength(before.length);
    });

    it('agents: guarded (no unlocking), clean findings required, and locks bind them like everyone', async () => {
      await apply([{ op: 'setItemLock', trackId: 'trk_video', itemId: 'c0', locked: true }]);
      const asAgent = (ops: VideoOperation[]) =>
        run(tenantA, (tx) =>
          creativeService.videoOperations.apply(
            agentA,
            {
              documentId: docId,
              baseRevisionId: headRev,
              operations: ops,
              summary: 'agent',
              origin: 'agent',
            },
            tx,
            AGENT_OPTS,
          ),
        );
      expect(
        await failure(asAgent([{ op: 'setItemLock', trackId: 'trk_video', itemId: 'c0', locked: false }])),
      ).toBeInstanceOf(PolicyDeniedError);
      const locked = await failure(
        asAgent([{ op: 'moveClip', trackId: 'trk_video', itemId: 'c0', startMs: 20_000 }]),
      );
      // STU-3: the agent guard refuses work on locked items itself (a policy error), before the reducer would.
      expect(locked).toBeInstanceOf(PolicyDeniedError);
      expect((locked as PolicyDeniedError).reason).toBe('locked');
      const dirty = await failure(
        asAgent([
          {
            op: 'upsertCaption',
            trackId: 'trk_captions',
            caption: { id: 'cap_c', startMs: 9_000, endMs: 11_000, text: 'cheap', locked: false },
          },
        ]),
      );
      expect(dirty).toBeInstanceOf(ValidationFailedError);
      const ok = await asAgent([
        {
          op: 'upsertCaption',
          trackId: 'trk_captions',
          caption: { id: 'cap_d', startMs: 9_000, endMs: 11_000, text: 'Clean words', locked: false },
        },
      ]);
      expect(ok.revision.authorKind).toBe('agent');
      headRev = ok.revision.id;
      // A person may not label a batch as an agent's own... and an agent may not label its batch as a person's.
      const mislabelled = await failure(
        run(tenantA, (tx) =>
          creativeService.videoOperations.apply(
            agentA,
            {
              documentId: docId,
              baseRevisionId: headRev,
              operations: [{ op: 'setDuration', durationMs: 20_000 }],
              summary: 'x',
              origin: 'user',
            },
            tx,
            AGENT_OPTS,
          ),
        ),
      );
      expect(mislabelled).toBeInstanceOf(PolicyDeniedError);
    });

    it('rights: an ineligible source is refused at the point of use', async () => {
      denied.add('av_clip2');
      const err = await failure(
        apply([{ op: 'replaceClipSource', trackId: 'trk_video', itemId: 'c3', assetVersionId: 'av_clip2' }]),
      );
      expect(err).toBeInstanceOf(RightsIneligibleError);
      denied.delete('av_clip2');
    });

    it('undo is a new revision applying the inverse; restore keeps history', async () => {
      const before = await run(tenantA, () => creativeService.documents.get(A, { documentId: docId }));
      const r = await apply([{ op: 'removeClip', trackId: 'trk_video', itemId: 'c3', ripple: true }]);
      const back = await apply([
        {
          op: 'insertClip',
          trackId: 'trk_video',
          item: (
            before.revision.snapshot as { tracks: Array<{ items: VideoClipItem[] }> }
          ).tracks[0]!.items.find((c) => c.id === 'c3')!,
          ripple: true,
        },
      ]);
      expect(back.revision.number).toBe(r.revision.number + 1);
      expect(back.revision.contentHash).toBe(before.revision.contentHash);
    });
  });

  describe('renders', () => {
    it('queues a video render at the project format for task queue video; other formats are refused', async () => {
      const wrong = await failure(
        run(tenantA, (tx) =>
          creativeService.renders.request(
            A,
            { documentId: docId, revisionId: headRev, formatKeys: ['square_1080'] },
            tx,
          ),
        ),
      );
      expect((wrong as ValidationFailedError).details?.[0]?.issue).toBe('video_renders_at:video_9x16');
      const queued = await run(tenantA, (tx) =>
        creativeService.renders.request(
          A,
          { documentId: docId, revisionId: headRev, formatKeys: ['video_9x16'] },
          tx,
        ),
      );
      const [evt] = await tdb.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, queued.renderJobId),
            eq(outboxEvents.eventType, 'creative.render_requested'),
          ),
        );
      expect(
        outboxRouteFor('creative.render_requested')?.(evt as unknown as OutboxEventRecord),
      ).toMatchObject({
        workflowType: 'videoRenderJobWorkflowV1',
        taskQueue: 'video',
        workflowId: `render:${queued.renderJobId}`,
      });
      // Cancelling relays a cancelRender signal to that workflow after the cancel commits.
      const cancelled = await run(tenantA, (tx) =>
        creativeService.renders.cancel(A, { renderJobId: queued.renderJobId }, tx),
      );
      expect(cancelled.state).toBe('cancelled');
      const [signal] = await tdb.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, queued.renderJobId),
            eq(outboxEvents.eventType, 'creative.render_cancel_requested'),
          ),
        );
      expect(
        outboxRouteFor('creative.render_cancel_requested')?.(signal as unknown as OutboxEventRecord),
      ).toMatchObject({
        workflowType: 'videoRenderSignalRelayV1',
        taskQueue: 'video',
        args: [{ workflowId: `render:${queued.renderJobId}`, signal: 'cancelRender' }],
      });
      const [job] = await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, queued.renderJobId));
      expect(job?.state).toBe('cancelled');
      // A job that is not ready has no export URLs to offer.
      expect(
        await runInTenant(ctx(tenantA), () =>
          creativeService.renders.exportMedia(A, { renderJobId: queued.renderJobId }),
        ),
      ).toEqual({ items: [] });
    });

    it('a cancel while the worker writes progress never conflicts; progress after the cancel changes nothing', async () => {
      const queued = await run(tenantA, (tx) =>
        creativeService.renders.request(
          A,
          { documentId: docId, revisionId: headRev, formatKeys: ['video_9x16'] },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        creativeService.renders.markRendering({ renderJobId: queued.renderJobId }, tx),
      );
      const [before] = await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, queued.renderJobId));
      const note = (fraction: number) =>
        run(tenantA, (tx) =>
          creativeService.renders.markProgress(
            { renderJobId: queued.renderJobId, progress: { phase: 'encoding', fraction } },
            tx,
          ),
        );
      const first = await note(0.1);
      expect(first.version).toBe(before?.version); // progress does not move the optimistic version
      // Twenty progress notes race the cancel; the cancel always commits.
      const [cancelled] = await Promise.all([
        run(tenantA, (tx) => creativeService.renders.cancel(A, { renderJobId: queued.renderJobId }, tx)),
        ...Array.from({ length: 20 }, (_, i) => note(0.2 + i / 40)),
      ]);
      expect(cancelled.state).toBe('cancelled');
      const late = await note(0.99);
      expect(late.state).toBe('cancelled');
      const [job] = await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, queued.renderJobId));
      expect(job).toMatchObject({ state: 'cancelled', progress: null });
    });
  });

  describe('templates and tenancy', () => {
    it('lists the three starter templates for a visible brand', async () => {
      const list = await runInTenant(ctx(tenantA), () =>
        creativeService.videoTemplates.list(A, { brandId: brandA }),
      );
      expect(list.items.map((t) => t.key)).toEqual([
        'promo_vertical_15s',
        'product_demo_16x9_30s',
        'bumper_6s',
      ]);
    });
    it('every video procedure answers NOT_FOUND for another tenant’s ids', async () => {
      const calls: Array<() => Promise<unknown>> = [
        () => runInTenant(ctx(tenantA), () => creativeService.documents.get(A, { documentId: docB })),
        () =>
          run(tenantA, (tx) =>
            creativeService.videoOperations.apply(
              A,
              {
                documentId: docB,
                baseRevisionId: revB,
                operations: [{ op: 'setDuration', durationMs: 9_000 }],
                summary: 'x',
                origin: 'user',
              },
              tx,
            ),
          ),
        () =>
          run(tenantA, (tx) =>
            creativeService.videoOperations.propose(
              A,
              {
                documentId: docB,
                baseRevisionId: revB,
                operations: [{ op: 'setDuration', durationMs: 9_000 }],
                summary: 'x',
                origin: 'user',
              },
              tx,
            ),
          ),
        () =>
          run(tenantA, (tx) =>
            creativeService.renders.request(
              A,
              { documentId: docB, revisionId: revB, formatKeys: ['video_1x1'] },
              tx,
            ),
          ),
        () => runInTenant(ctx(tenantA), () => creativeService.videoTemplates.list(A, { brandId: brandB })),
      ];
      for (const call of calls) expect(await failure(call())).toBeInstanceOf(NotFoundError);
    });
  });
});
