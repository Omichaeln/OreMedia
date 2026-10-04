import { and, eq, sql } from 'drizzle-orm';
import { emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, CreativePage } from '@oremedia/contracts/creative';
import type { VideoProjectV1 } from '@oremedia/contracts/video';
import { brandVersions, brands } from '@oremedia/db/schema/brand';
import {
  creativeDocuments,
  creativeRevisions,
  elementComments,
  renderJobs,
  studioGenerationJobs,
  templateVersions,
  templates,
} from '@oremedia/db/schema/creative';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** A minimal valid creative document (spec 11.2): one square page with one headline element. */
export function seedCreativeDocument(brandVersionId: string, elementId = newElementId()): CreativeDocumentV1 {
  const page: CreativePage = {
    id: 'page_1',
    name: 'Feed',
    formatKey: 'square_1080',
    width: 1080,
    height: 1080,
    layoutConstraints: [],
    elements: [
      {
        id: elementId,
        name: 'Headline',
        type: 'text',
        locked: false,
        visible: true,
        opacity: 1,
        protected: false,
        transform: { x: 80, y: 80, width: 920, height: 120, rotation: 0 },
        text: 'Seeded headline',
        style: {
          typeRole: 'display',
          fontAssetVersionId: 'av_font',
          weight: 600,
          sizePx: 64,
          lineHeight: 1.2,
          tracking: 0,
          align: 'left',
          overflow: 'error',
        },
        factRefs: [],
      },
    ],
  };
  return { schemaVersion: 1, brandVersionId, pages: [page], variants: [] };
}

/** A minimal valid video project (STU-2b): a 9:16 picture track and a caption track with one caption. */
export function seedVideoProject(brandVersionId: string): VideoProjectV1 {
  return {
    schemaVersion: 1,
    kind: 'video',
    brandVersionId,
    format: { key: 'video_9x16', width: 1080, height: 1920, fps: 30 },
    durationMs: 6_000,
    tracks: [
      { id: 'trk_video', kind: 'video', name: 'Video', locked: false, muted: false, items: [] },
      {
        id: 'trk_captions',
        kind: 'caption',
        name: 'Captions',
        locked: false,
        style: {
          fontAssetVersionId: 'av_font',
          sizePx: 48,
          weight: 600,
          boxOpacity: 0.6,
          position: 'bottom',
        },
        items: [{ id: 'cap_seed', startMs: 0, endMs: 2_000, text: 'Seeded caption', locked: false }],
      },
    ],
    scenes: [],
  };
}

/**
 * Per tenant, on brand 1: a published brand version (BRAND_SEED only creates a draft), one document with its
 * revision 1, one open element comment, one template with a draft version and one pending render job, so a
 * foreign caller has every creative id to try (spec 19.3).
 */
export const CREATIVE_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const creativePublishedBrandVersionId = newId('brandVersion');
  const brandDocument = emptyBrandSystemDocument();
  await db.insert(brandVersions).values({
    id: creativePublishedBrandVersionId,
    tenantId,
    brandId,
    number: 2,
    state: 'published',
    document: brandDocument,
    contentHash: hashCanonical(brandDocument),
    publishedAt: new Date(),
    publishedByUserId: ownerUserId,
  });
  await db
    .update(brands)
    .set({ publishedVersionId: creativePublishedBrandVersionId })
    .where(and(eq(brands.tenantId, tenantId), eq(brands.id, brandId)));

  const creativeElementId = newElementId();
  const document = seedCreativeDocument(creativePublishedBrandVersionId, creativeElementId);
  const creativeDocumentId = newId('creativeDocument');
  const creativeRevisionId = newId('creativeRevision');
  // sql``, not insert(creativeDocuments).values(): Drizzle would name kind (0027) and archived_at (0029), which the
  // roll-forward suites' earlier heads do not have; at later heads kind takes its default, graphic, and archived_at null.
  const docAt = new Date();
  await db.execute(
    sql`insert into ${creativeDocuments} (id, tenant_id, brand_id, title, current_revision_id, schema_version, created_at, updated_at, version) values (${creativeDocumentId}, ${tenantId}, ${brandId}, 'Seeded document', ${creativeRevisionId}, 1, ${docAt}, ${docAt}, 0)`,
  );
  // sql``, not insert(creativeRevisions).values(): Drizzle would name generation_inputs (0025), which the
  // roll-forward suites' earlier heads do not have; the columns named here exist at every head, later ones are null.
  const initialBatch = {
    baseRevisionId: '',
    operations: document.pages.map((page, index) => ({ op: 'addPage', page, index })),
    summary: 'Initial document',
    origin: 'user',
  };
  const at = new Date();
  await db.execute(
    sql`insert into ${creativeRevisions} (id, tenant_id, brand_id, document_id, parent_revision_id, number, brand_version_id, author_kind, author_id, change_summary, operations, snapshot, content_hash, created_at) values (${creativeRevisionId}, ${tenantId}, ${brandId}, ${creativeDocumentId}, null, 1, ${creativePublishedBrandVersionId}, 'user', ${ownerUserId}, 'Initial document', ${JSON.stringify(initialBatch)}, ${JSON.stringify(document)}, ${hashCanonical(document)}, ${at})`,
  );
  const commentId = newId('elementComment');
  await db.insert(elementComments).values({
    id: commentId,
    tenantId,
    brandId,
    documentId: creativeDocumentId,
    revisionId: creativeRevisionId,
    elementId: creativeElementId,
    body: 'Seeded comment',
    authorKind: 'user',
    authorId: ownerUserId,
    state: 'open',
  });
  const templateId = newId('template');
  const templateVersionId = newId('templateVersion');
  await db.insert(templates).values({
    id: templateId,
    tenantId,
    brandId,
    name: 'Seeded template',
    currentVersionId: null,
    state: 'draft',
  });
  await db.insert(templateVersions).values({
    id: templateVersionId,
    tenantId,
    brandId,
    templateId,
    number: 1,
    slots: [],
    constraints: {},
    formats: ['square_1080'],
    document,
    contentHash: hashCanonical(document),
    state: 'draft',
  });
  const renderJobId = newId('renderJob');
  // sql``, not insert(renderJobs).values(): Drizzle would name progress (0026), which the roll-forward suites'
  // earlier heads do not have; the columns named here exist at every head, later ones take their defaults.
  await db.execute(
    sql`insert into ${renderJobs} (id, tenant_id, brand_id, revision_id, format_keys, state, attempts, requested_by_kind, requested_by_id, created_at, updated_at) values (${renderJobId}, ${tenantId}, ${brandId}, ${creativeRevisionId}, '["square_1080"]', 'pending', 0, 'user', ${ownerUserId}, ${at}, ${at})`,
  );
  // STU-1b (migration 0025): a failed generation job of the document (retry and cancel need a job id to try).
  const generationJobId = newId('studioGenerationJob');
  const generationAtHead = await db.execute(
    sql`select 1 as present from information_schema.tables where table_schema = database() and table_name = 'studio_generation_jobs'`,
  );
  const generationRequest = {
    kind: 'refine' as const,
    refine: {
      instruction: 'Seeded request',
      scope: { pageId: 'page_1', elementIds: [] },
      action: { kind: 'edit' as const },
      factIds: [],
      assetVersionIds: [],
    },
  };
  if (Array.isArray(generationAtHead[0]) && generationAtHead[0].length > 0)
    await db.insert(studioGenerationJobs).values({
      id: generationJobId,
      tenantId,
      brandId,
      documentId: creativeDocumentId,
      baseRevisionId: creativeRevisionId,
      kind: 'refine',
      state: 'failed',
      progress: 100,
      request: generationRequest,
      inputsHash: hashCanonical(generationRequest),
      attempt: 1,
      errorCode: 'model_failed',
      error: 'Seeded failure',
      requestedByKind: 'user',
      requestedById: ownerUserId,
    });
  // STU-2b: a video document with revision 1 (one clip-less picture track, a caption track and a caption), so a
  // foreign caller has timeline ids to try. Only where creative_documents.kind exists (0027 and later).
  const kindColumn = (await db.execute(
    sql`select column_name from information_schema.columns where table_schema = database() and table_name = 'creative_documents' and column_name = 'kind'`,
  )) as unknown as [unknown[]];
  const video: Record<string, string> = {};
  if (kindColumn[0].length) {
    const videoDocumentId = newId('creativeDocument');
    const videoRevisionId = newId('creativeRevision');
    const project = seedVideoProject(creativePublishedBrandVersionId);
    await db.execute(
      sql`insert into ${creativeDocuments} (id, tenant_id, brand_id, title, current_revision_id, schema_version, kind, created_at, updated_at, version) values (${videoDocumentId}, ${tenantId}, ${brandId}, 'Seeded video', ${videoRevisionId}, 1, 'video', ${docAt}, ${docAt}, 0)`,
    );
    await db.insert(creativeRevisions).values({
      id: videoRevisionId,
      tenantId,
      brandId,
      documentId: videoDocumentId,
      parentRevisionId: null,
      number: 1,
      brandVersionId: creativePublishedBrandVersionId,
      authorKind: 'user',
      authorId: ownerUserId,
      changeSummary: 'Initial video',
      operations: {
        baseRevisionId: '',
        operations: project.tracks.map((track, index) => ({ op: 'addTrack', track, index })),
        summary: 'Initial video',
        origin: 'user',
      },
      snapshot: project,
      contentHash: hashCanonical(project),
    });
    Object.assign(video, { videoDocumentId, videoRevisionId });
    // STU-3: a completed storyboard job on the video, so a foreign caller has a job id to try (0028 and later).
    const jobsTable = (await db.execute(
      sql`select table_name from information_schema.tables where table_schema = database() and table_name = 'studio_video_jobs'`,
    )) as unknown as [unknown[]];
    if (jobsTable[0].length) {
      const videoJobId = newId('studioVideoJob');
      const request = { kind: 'storyboard', brief: { objective: 'Seeded' } };
      await db.execute(
        sql`insert into studio_video_jobs (id, tenant_id, brand_id, document_id, base_revision_id, kind, state, progress, request, inputs_hash, requested_by_kind, requested_by_id, created_at, updated_at) values (${videoJobId}, ${tenantId}, ${brandId}, ${videoDocumentId}, ${videoRevisionId}, 'storyboard', 'completed', 100, ${JSON.stringify(request)}, ${hashCanonical(request)}, 'user', ${ownerUserId}, ${docAt}, ${docAt})`,
      );
      Object.assign(video, { videoJobId });
    }
  }
  return {
    generationJobId,
    ...video,
    creativePublishedBrandVersionId,
    creativeDocumentId,
    creativeRevisionId,
    creativeElementId,
    commentId,
    templateId,
    templateVersionId,
    renderJobId,
  };
};
