import {
  foreignKey,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type {
  AssistSection,
  BrandAssistProgressV1,
  BrandAssistQuestionV1,
  BrandSourcePageV1,
  SuggestionBasis,
  SuggestionConflict,
  SuggestionEvidence,
} from '@oremedia/contracts/brand-assist';
import type {
  BrandSystemDocumentV1,
  GuidanceProvenance,
  DesignTokenSetV1,
  EvidenceRef,
  FactConflict,
  FactSource,
  PolicyDocumentV1,
} from '@oremedia/contracts/brand';
import { brandId, createdAt, hash, id, micros, ref, tenantId, ts, updatedAt, version } from './_columns';
import { tenants } from './access';

export const brands = mysqlTable(
  'brands',
  {
    id: id(),
    tenantId: tenantId(),
    name: varchar('name', { length: 200 }).notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    defaultLocale: varchar('default_locale', { length: 16 }).notNull(),
    publishedVersionId: ref('published_version_id'),
    activePolicyVersionId: ref('active_policy_version_id'),
    status: mysqlEnum('status', ['setup', 'active', 'archived']).notNull(),
    /**
     * D-11: a client brand needs a distinct approver unless its active release policy says otherwise; an internal
     * brand does not. The column default is internal, so brands that existed before migration 0009 keep their
     * approval behaviour; the API's BrandCreate defaults to client, so every brand created through it is a client
     * brand unless the creator chooses internal.
     */
    classification: mysqlEnum('classification', ['client', 'internal']).notNull().default('internal'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brand_tenant_id').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'fk_brand_tenant' }),
  ],
);

export const brandVersions = mysqlTable(
  'brand_versions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    number: int('number').notNull(),
    state: mysqlEnum('state', ['draft', 'in_review', 'published', 'retired']).notNull(),
    document: json('document').$type<BrandSystemDocumentV1>().notNull(), // tokens, voice, logo rules, patterns, channel guidance
    contentHash: hash('content_hash').notNull(),
    publishedAt: ts('published_at'),
    publishedByUserId: ref('published_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brand_version_number').on(t.tenantId, t.brandId, t.number),
    uniqueIndex('uq_brand_version_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_brand_version_brand',
    }),
  ],
);

/**
 * Who last changed a brand version's guidelines (import or edit), one row per version (id = the version's id):
 * the audit trail of what agents will follow. Since 2 October 2026 the author may publish the version themselves;
 * the row is kept for the record. Kept beside brand_versions so that table's shape is unchanged.
 */
export const brandGuidelineAuthors = mysqlTable(
  'brand_guideline_authors',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    authorKind: mysqlEnum('author_kind', ['user', 'service_principal']).notNull(),
    authorId: ref('author_id').notNull(),
    /** The imported package's hash; null when the guidelines were last changed by an edit. */
    packageHash: hash('package_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.brandId, t.id],
      foreignColumns: [brandVersions.tenantId, brandVersions.brandId, brandVersions.id],
      name: 'fk_guideline_author_version',
    }),
  ],
);

export const designTokens = mysqlTable(
  'design_tokens',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    brandVersionId: ref('brand_version_id').notNull(),
    tokenSet: json('token_set').$type<DesignTokenSetV1>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_design_tokens_version').on(t.tenantId, t.brandVersionId),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.brandVersionId],
      foreignColumns: [brandVersions.tenantId, brandVersions.brandId, brandVersions.id],
      name: 'fk_design_tokens_version',
    }),
  ],
);

export const approvedFacts = mysqlTable(
  'approved_facts',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', [
      'product',
      'claim',
      'offer',
      'contact',
      'price',
      'statistic',
      'legal',
    ]).notNull(),
    statement: text('statement').notNull(),
    evidence: json('evidence').$type<EvidenceRef[]>().notNull(), // source doc/asset refs, URLs, reviewer
    validFrom: ts('valid_from'),
    validUntil: ts('valid_until'), // expired offers block release
    state: mysqlEnum('state', ['proposed', 'approved', 'revoked', 'superseded']).notNull(),
    proposedByKind: mysqlEnum('proposed_by_kind', ['user', 'agent']).notNull(),
    proposedById: ref('proposed_by_id').notNull(),
    approvedByUserId: ref('approved_by_user_id'),
    revokedByUserId: ref('revoked_by_user_id'),
    // BSC-3 (migration 0023). Nullable so a row written by the previous release during a rolling deploy is valid;
    // readers fall back to the category of the same name as `kind` and to the origin `proposed_by_kind` implies.
    category: mysqlEnum('category', [
      'company',
      'product',
      'service',
      'location',
      'contact',
      'differentiator',
      'audience',
      'terminology',
      'claim',
      'faq',
      'offer',
      'price',
      'statistic',
      'legal',
    ]),
    /** null: brand-wide; otherwise a channel or market note (e.g. "UK only", "LinkedIn"). */
    scope: varchar('scope', { length: 200 }),
    origin: mysqlEnum('origin', ['user', 'extracted', 'inferred', 'suggested']),
    /** Sources with titles and excerpts; null on rows written before 0023 (the migration copies `evidence`). */
    sources: json('sources').$type<FactSource[]>(),
    reviewDueAt: ts('review_due_at'),
    reviewedByUserId: ref('reviewed_by_user_id'),
    reviewedAt: ts('reviewed_at'),
    /** Set when the fact became superseded: its approved correction, or the fact it was merged into. */
    supersededByFactId: ref('superseded_by_fact_id'),
    /** On a correction: the approved fact it replaces once approved. */
    supersedesFactId: ref('supersedes_fact_id'),
    revokeReason: varchar('revoke_reason', { length: 500 }),
    conflicts: json('conflicts').$type<FactConflict[]>(),
    /** sha256 of the normalised statement (packages/domain/src/facts.ts); null until computed (the sweep backfills). */
    dedupeKey: hash('dedupe_key'),
    /** The daily sweep's markers: the review-due flag and the one expiry event (exactly once). */
    reviewFlaggedAt: ts('review_flagged_at'),
    expiryNotifiedAt: ts('expiry_notified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_fact_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_fact_state').on(t.tenantId, t.brandId, t.state),
    index('ix_fact_dedupe').on(t.tenantId, t.brandId, t.dedupeKey),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_fact_brand',
    }),
  ],
);

export const brandObjectives = mysqlTable(
  'brand_objectives',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    name: varchar('name', { length: 160 }).notNull(),
    primaryMetricKey: varchar('primary_metric_key', { length: 80 }).notNull(), // e.g. 'qualified_enquiries'
    guardrailMetricKeys: json('guardrail_metric_keys').$type<string[]>().notNull(),
    engagementQualityWeights: json('engagement_quality_weights').$type<Record<string, number>>(),
    activeFrom: ts('active_from').notNull(),
    activeUntil: ts('active_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_objective_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_objective_brand',
    }),
  ],
);

export const policyVersions = mysqlTable(
  'policy_versions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    number: int('number').notNull(),
    document: json('document').$type<PolicyDocumentV1>().notNull(), // review_thresholds, restricted_topics, require_distinct_approver, prohibited_terms
    state: mysqlEnum('state', ['draft', 'active', 'retired']).notNull(),
    createdByUserId: ref('created_by_user_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_policy_version_number').on(t.tenantId, t.brandId, t.number),
    uniqueIndex('uq_policy_version_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_policy_version_brand',
    }),
  ],
);

/**
 * BSC-4: material a brand supplied for AI-assisted setup: a website (crawled within caps), an uploaded document (text
 * extracted on the isolated worker; the upload itself is deleted once read), pasted text or one of the brand's assets.
 * The extracted text is bounded (SOURCE_TEXT_MAX_CHARS) and is untrusted evidence wherever it is used. A removed
 * source keeps its row (removed_at) so suggestions that cite it still name it.
 */
export const brandSources = mysqlTable(
  'brand_sources',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', ['url', 'document', 'text', 'brand_asset']).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    url: varchar('url', { length: 1000 }),
    fileName: varchar('file_name', { length: 255 }),
    mime: varchar('mime', { length: 120 }),
    assetId: ref('asset_id'),
    assetVersionId: ref('asset_version_id'),
    /** Object store key of an uploaded document (or an asset's original) until its text is extracted. */
    storageKey: varchar('storage_key', { length: 300 }),
    status: mysqlEnum('status', ['pending', 'captured', 'unsupported', 'inaccessible', 'failed']).notNull(),
    reason: varchar('reason', { length: 40 }),
    detail: varchar('detail', { length: 300 }),
    /** sha256 of the extracted text: the same text twice is one source (the later one names the earlier). */
    contentHash: hash('content_hash'),
    duplicateOfSourceId: ref('duplicate_of_source_id'),
    byteSize: int('byte_size'),
    charCount: int('char_count'),
    truncated: mysqlEnum('truncated', ['yes', 'no']).notNull().default('no'),
    text: mediumtext('text'),
    pages: json('pages').$type<BrandSourcePageV1[]>(),
    capturedAt: ts('captured_at'),
    removedAt: ts('removed_at'),
    createdByKind: mysqlEnum('created_by_kind', ['user', 'service_principal']).notNull(),
    createdById: ref('created_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brand_source_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_brand_source_hash').on(t.tenantId, t.brandId, t.contentHash),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_brand_source_brand',
    }),
  ],
);

/**
 * BSC-4 / BSC-5: one AI assist request (a guided setup over sources, or a section request from the section or overall
 * assistant) and its run through brandAssistWorkflowV1 (workflow id `brand-assist:<id>`): stages, per-section
 * progress, questions, the budget reserved and spent. Its output is brand_suggestions; it never edits the brand system.
 */
export const brandAssistJobs = mysqlTable(
  'brand_assist_jobs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', ['setup', 'section']).notNull(),
    sections: json('sections').$type<AssistSection[]>().notNull(),
    instruction: text('instruction'),
    sourceIds: json('source_ids').$type<string[]>().notNull(),
    preserve: json('preserve').$type<string[]>().notNull(),
    /** Answers to an earlier job's questions this job was started with (people's words, not evidence). */
    answers: json('answers').$type<Array<{ question: string; answer: string }>>(),
    parentJobId: ref('parent_job_id'),
    alternativesForJobId: ref('alternatives_for_job_id'),
    state: mysqlEnum('state', [
      'queued',
      'capturing',
      'extracting',
      'proposing',
      'ready',
      'partially_ready',
      'failed',
      'cancelled',
    ]).notNull(),
    progress: json('progress').$type<BrandAssistProgressV1>().notNull(),
    questions: json('questions').$type<BrandAssistQuestionV1[]>().notNull(),
    estimateMicros: micros('estimate_micros').notNull().default(0),
    reservedMicros: micros('reserved_micros').notNull().default(0),
    spentMicros: micros('spent_micros').notNull().default(0),
    /** The billing reservation the job's model calls are charged to (budget_reservations.run_id = the job id). */
    budgetReservationId: ref('budget_reservation_id'),
    error: varchar('error', { length: 500 }),
    /** sha256 of the request: an identical request while one is running joins it instead of starting another. */
    requestKey: hash('request_key').notNull(),
    cancelRequestedAt: ts('cancel_requested_at'),
    createdByKind: mysqlEnum('created_by_kind', ['user', 'service_principal']).notNull(),
    createdById: ref('created_by_id').notNull(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brand_assist_job_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_brand_assist_job_request').on(t.tenantId, t.brandId, t.requestKey, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_brand_assist_job_brand',
    }),
  ],
);

/**
 * BSC-4: one proposed change to the brand system from an assist job: where (section, path), what (op, value), why
 * (rationale, evidence with verified excerpts, uncertainty, conflicts) and what a person decided. Accepting writes
 * the value into the pending proposal (`applied_proposal_version_id`; `applied_before` is the value it replaced, for
 * undo); a fact suggestion becomes a proposed fact (`fact_id`). A rejected fingerprint is never suggested again.
 */
export const brandSuggestions = mysqlTable(
  'brand_suggestions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    jobId: ref('job_id').notNull(),
    section: mysqlEnum('section', [
      'voice',
      'messaging',
      'vocabulary',
      'writing',
      'examples',
      'templates',
      'channels',
      'facts',
    ]).notNull(),
    path: varchar('path', { length: 400 }).notNull(),
    op: mysqlEnum('op', ['add', 'replace', 'remove']).notNull(),
    payload: json('payload').$type<unknown>(),
    provenance: json('provenance').$type<GuidanceProvenance>().notNull(),
    rationale: varchar('rationale', { length: 1000 }).notNull(),
    uncertainty: varchar('uncertainty', { length: 500 }),
    conflicts: json('conflicts').$type<SuggestionConflict[]>().notNull(),
    evidence: json('evidence').$type<SuggestionEvidence[]>().notNull(),
    fingerprint: hash('fingerprint').notNull(),
    againstUserItem: mysqlEnum('against_user_item', ['yes', 'no']).notNull().default('no'),
    /** What the item was when the suggestion was made (value and origin): accept refuses if it has changed since. */
    basedOn: json('based_on').$type<SuggestionBasis>(),
    status: mysqlEnum('status', ['pending', 'accepted', 'edited', 'rejected', 'superseded']).notNull(),
    decidedById: ref('decided_by_id'),
    decidedAt: ts('decided_at'),
    batchId: ref('batch_id'),
    appliedProposalVersionId: ref('applied_proposal_version_id'),
    appliedBefore: json('applied_before').$type<unknown>(),
    appliedValue: json('applied_value').$type<unknown>(),
    factId: ref('fact_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brand_suggestion_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_brand_suggestion_job').on(t.tenantId, t.brandId, t.jobId, t.section),
    index('ix_brand_suggestion_fingerprint').on(t.tenantId, t.brandId, t.fingerprint, t.status),
    index('ix_brand_suggestion_batch').on(t.tenantId, t.brandId, t.batchId),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.jobId],
      foreignColumns: [brandAssistJobs.tenantId, brandAssistJobs.brandId, brandAssistJobs.id],
      name: 'fk_brand_suggestion_job',
    }),
  ],
);
