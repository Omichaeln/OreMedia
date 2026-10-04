import {
  bigint,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { GenerationInputs, GenerationRequest, GenerationResult } from '@oremedia/contracts/generation';
import type {
  CreativeDocumentV1,
  OperationBatch,
  RenderManifest,
  RenderProgress,
  RenderValidationResult,
} from '@oremedia/contracts/creative';
import { brandId, createdAt, hash, id, micros, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const creativeDocuments = mysqlTable(
  'creative_documents',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    contentPackageId: ref('content_package_id'),
    title: varchar('title', { length: 200 }).notNull(),
    currentRevisionId: ref('current_revision_id'),
    schemaVersion: int('schema_version').notNull(),
    /**
     * G12: when the document was archived (hidden from the Studio's default index, still readable and restorable);
     * null while it is in use. Added in 0027, nullable, so every existing document stays in use.
     */
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_creative_doc_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_creative_doc_brand',
    }),
  ],
);

/** Insert-only. */
export const creativeRevisions = mysqlTable(
  'creative_revisions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    documentId: ref('document_id').notNull(),
    parentRevisionId: ref('parent_revision_id'),
    number: int('number').notNull(),
    brandVersionId: ref('brand_version_id').notNull(),
    agentRunId: ref('agent_run_id'),
    authorKind: mysqlEnum('author_kind', ['user', 'agent']).notNull(),
    authorId: ref('author_id').notNull(),
    changeSummary: varchar('change_summary', { length: 500 }).notNull(),
    operations: json('operations').$type<OperationBatch>().notNull(), // what changed from parent
    snapshot: json('snapshot').$type<CreativeDocumentV1>().notNull(), // full document at this revision
    contentHash: hash('content_hash').notNull(),
    /**
     * STU-1b (principle 8): what produced an AI-generated revision; null for people's edits and older rows. Graphic
     * inputs; video revisions store another document kind here, so reads go through graphicGenerationInputs.
     */
    generationInputs: json('generation_inputs').$type<GenerationInputs>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_rev_number').on(t.tenantId, t.documentId, t.number),
    uniqueIndex('uq_rev_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.documentId],
      foreignColumns: [creativeDocuments.tenantId, creativeDocuments.brandId, creativeDocuments.id],
      name: 'fk_rev_document',
    }),
  ],
);

/** Insert-only. Approved exports are immutable and are what gets published (spec 2.1.8). */
export const renderedExports = mysqlTable(
  'rendered_exports',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    revisionId: ref('revision_id').notNull(),
    pageId: varchar('page_id', { length: 40 }).notNull(),
    formatKey: varchar('format_key', { length: 40 }).notNull(), // 'ig_feed_4x5', 'li_1200x627', ...
    mime: varchar('mime', { length: 40 }).notNull(),
    width: int('width').notNull(),
    height: int('height').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    contentHash: hash('content_hash').notNull(),
    rendererVersion: varchar('renderer_version', { length: 40 }).notNull(),
    manifest: json('manifest').$type<RenderManifest>().notNull(), // fonts + asset versions + hashes
    validation: json('validation').$type<RenderValidationResult>().notNull(),
    // STU-2a video exports (video/mp4): null for stills.
    durationMs: int('duration_ms'),
    fps: int('fps'),
    posterStorageKey: varchar('poster_storage_key', { length: 300 }),
    captionsStorageKey: varchar('captions_storage_key', { length: 300 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_export_revision').on(t.tenantId, t.revisionId, t.formatKey),
    uniqueIndex('uq_export_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.revisionId],
      foreignColumns: [creativeRevisions.tenantId, creativeRevisions.brandId, creativeRevisions.id],
      name: 'fk_export_revision',
    }),
  ],
);

export const elementComments = mysqlTable(
  'element_comments',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    documentId: ref('document_id').notNull(),
    revisionId: ref('revision_id').notNull(),
    elementId: varchar('element_id', { length: 40 }).notNull(),
    body: text('body').notNull(),
    authorKind: mysqlEnum('author_kind', ['user', 'external_reviewer', 'agent']).notNull(),
    authorId: ref('author_id').notNull(),
    state: mysqlEnum('state', ['open', 'resolved', 'outdated']).notNull().default('open'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_comment_document').on(t.tenantId, t.documentId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.documentId],
      foreignColumns: [creativeDocuments.tenantId, creativeDocuments.brandId, creativeDocuments.id],
      name: 'fk_comment_document',
    }),
  ],
);

export const templates = mysqlTable(
  'templates',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    name: varchar('name', { length: 200 }).notNull(),
    currentVersionId: ref('current_version_id'),
    state: mysqlEnum('state', ['draft', 'active', 'retired']).notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_template_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_template_brand',
    }),
  ],
);

export const templateVersions = mysqlTable(
  'template_versions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    templateId: ref('template_id').notNull(),
    number: int('number').notNull(),
    slots: json('slots')
      .$type<Array<{ key: string; elementId: string; kind: string; required: boolean }>>()
      .notNull(),
    constraints: json('constraints').$type<Record<string, unknown>>().notNull(),
    formats: json('formats').$type<string[]>().notNull(),
    document: json('document').$type<CreativeDocumentV1>().notNull(),
    contentHash: hash('content_hash').notNull(),
    state: mysqlEnum('state', ['draft', 'approved', 'retired']).notNull().default('draft'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_template_version_number').on(t.tenantId, t.templateId, t.number),
    uniqueIndex('uq_template_version_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.templateId],
      foreignColumns: [templates.tenantId, templates.brandId, templates.id],
      name: 'fk_template_version_template',
    }),
  ],
);

export const renderJobs = mysqlTable(
  'render_jobs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    revisionId: ref('revision_id').notNull(),
    formatKeys: json('format_keys').$type<string[]>().notNull(),
    state: mysqlEnum('state', ['pending', 'rendering', 'ready', 'failed', 'cancelled'])
      .notNull()
      .default('pending'),
    attempts: int('attempts').notNull().default(0),
    error: varchar('error', { length: 2000 }),
    progress: json('progress').$type<RenderProgress>(), // STU-2a: phase and fraction of a long (video) render
    requestedByKind: mysqlEnum('requested_by_kind', ['user', 'agent', 'system']).notNull(),
    requestedById: ref('requested_by_id').notNull(),
    exportIds: json('export_ids').$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_render_job_revision').on(t.tenantId, t.revisionId),
    uniqueIndex('uq_render_job_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.revisionId],
      foreignColumns: [creativeRevisions.tenantId, creativeRevisions.brandId, creativeRevisions.id],
      name: 'fk_render_job_revision',
    }),
  ],
);

/**
 * Spec 11.4 proposal preview (operations.propose with a preview render): the proposed snapshot a preview render job
 * draws. It is not a committed revision; the job's revision_id is the committed base the proposal was made against.
 * A render job with a row here is a preview job; its output goes to preview_exports, never to rendered_exports.
 */
export const renderPreviews = mysqlTable(
  'render_previews',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    renderJobId: ref('render_job_id').notNull(),
    baseRevisionId: ref('base_revision_id').notNull(),
    snapshot: json('snapshot').$type<CreativeDocumentV1>().notNull(),
    contentHash: hash('content_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_render_preview_job').on(t.tenantId, t.renderJobId),
    uniqueIndex('uq_render_preview_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_render_preview_job').on(t.tenantId, t.brandId, t.renderJobId),
    index('ix_render_preview_revision').on(t.tenantId, t.brandId, t.baseRevisionId),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.renderJobId],
      foreignColumns: [renderJobs.tenantId, renderJobs.brandId, renderJobs.id],
      name: 'fk_render_preview_job',
    }),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.baseRevisionId],
      foreignColumns: [creativeRevisions.tenantId, creativeRevisions.brandId, creativeRevisions.id],
      name: 'fk_render_preview_revision',
    }),
  ],
);

/**
 * What a preview render produced. Deliberately a separate table from rendered_exports: approvals, channel variants
 * and releases only ever resolve rendered_exports ids, so a preview export is structurally never publishable.
 */
export const previewExports = mysqlTable(
  'preview_exports',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    renderJobId: ref('render_job_id').notNull(),
    pageId: varchar('page_id', { length: 40 }).notNull(),
    formatKey: varchar('format_key', { length: 40 }).notNull(),
    mime: varchar('mime', { length: 40 }).notNull(),
    width: int('width').notNull(),
    height: int('height').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    contentHash: hash('content_hash').notNull(),
    rendererVersion: varchar('renderer_version', { length: 40 }).notNull(),
    manifest: json('manifest').$type<RenderManifest>().notNull(),
    validation: json('validation').$type<RenderValidationResult>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_preview_export_job').on(t.tenantId, t.brandId, t.renderJobId),
    uniqueIndex('uq_preview_export_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.renderJobId],
      foreignColumns: [renderJobs.tenantId, renderJobs.brandId, renderJobs.id],
      name: 'fk_preview_export_job',
    }),
  ],
);

/**
 * STU-1b: a durable generation or refinement job for one document (studioGenerationWorkflowV1). Start is idempotent
 * per (document, base revision, inputs hash); a retry is a new attempt of the same row. The model's output and the
 * result (revisions saved, or a proposal) are stored here so a retried activity never calls the model twice and the
 * studio can reattach after a reload.
 */
export const studioGenerationJobs = mysqlTable(
  'studio_generation_jobs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    documentId: ref('document_id').notNull(),
    baseRevisionId: ref('base_revision_id').notNull(),
    kind: mysqlEnum('kind', ['generate', 'refine']).notNull(),
    state: mysqlEnum('state', [
      'queued',
      'generating',
      'validating',
      'saving',
      'completed',
      'failed',
      'cancelled',
    ])
      .notNull()
      .default('queued'),
    progress: int('progress').notNull().default(0),
    request: json('request').$type<GenerationRequest>().notNull(),
    inputsHash: hash('inputs_hash').notNull(),
    attempt: int('attempt').notNull().default(1),
    /** The current attempt's budget reservation key (budget_reservations.run_id). */
    budgetRunId: ref('budget_run_id'),
    /** That reservation's id (charges are recorded against it). */
    budgetReservationId: ref('budget_reservation_id'),
    costReservedMicros: micros('cost_reserved_micros').notNull().default(0),
    costSpentMicros: micros('cost_spent_micros').notNull().default(0),
    /** The model's validated output for the current attempt, with the ledger key of the call. */
    modelOutput: json('model_output').$type<{ output: unknown; callRef: string; structure: unknown }>(),
    result: json('result').$type<GenerationResult>(),
    errorCode: varchar('error_code', { length: 40 }),
    error: varchar('error', { length: 500 }),
    requestedByKind: mysqlEnum('requested_by_kind', ['user', 'agent', 'system']).notNull(),
    requestedById: ref('requested_by_id').notNull(),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_generation_job_inputs').on(t.tenantId, t.documentId, t.baseRevisionId, t.inputsHash),
    index('ix_generation_job_document').on(t.tenantId, t.documentId, t.state),
    uniqueIndex('uq_generation_job_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.documentId],
      foreignColumns: [creativeDocuments.tenantId, creativeDocuments.brandId, creativeDocuments.id],
      name: 'fk_generation_job_document',
    }),
  ],
);
