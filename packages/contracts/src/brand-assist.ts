import { z } from 'zod';
import type { EvidenceItem } from './agents';
import type { GuidanceProvenance } from './brand';
import {
  CopyContentType,
  FactCategory,
  StyleRuleTopic,
  VocabularyUsage,
  WRITING_PARTS,
  type BrandSystemDocumentV1,
} from './brand';
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';

/**
 * BSC-4 / BSC-5: sources a brand supplies (websites, documents, pasted text, its own assets), AI assist jobs that read
 * them and propose updates section by section, the suggestions a person accepts, edits or rejects, and the brand
 * system's applied history. Nothing here applies anything: accepted suggestions land in the pending proposal, which a
 * person applies with brand.system.save (D-22). Source text is untrusted evidence everywhere it travels.
 */

// ---- sources ----

export const BrandSourceKind = z.enum(['url', 'document', 'text', 'brand_asset']);
export type BrandSourceKind = z.infer<typeof BrandSourceKind>;
export const BrandSourceStatus = z.enum(['pending', 'captured', 'unsupported', 'inaccessible', 'failed']);
export type BrandSourceStatus = z.infer<typeof BrandSourceStatus>;

/** Same-site pages one website source reads (the start page included), chosen from its navigation and sitemap. */
export const SOURCE_URL_MAX_PAGES = 10;
export const SOURCE_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const SOURCE_FETCH_TIMEOUT_MS = 20_000;
/** The whole crawl of one website source stops here, whatever is left. */
export const SOURCE_CRAWL_DEADLINE_MS = 2 * 60_000;
export const SOURCE_MAX_HOPS = 3;
export const SOURCE_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const SOURCE_PDF_MAX_PAGES = 300;
/** Text kept per source (the rest is cut and the source says so). */
export const SOURCE_TEXT_MAX_CHARS = 400_000;
export const SOURCE_PASTE_MAX_CHARS = 200_000;
export const SOURCES_PER_BRAND_MAX = 50;
/** What a person may upload as a document source, by MIME type, with the extension shown to people. */
export const SOURCE_DOCUMENT_TYPES = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (.docx)',
  'text/markdown': 'Markdown',
  'text/plain': 'Text',
} as const;
export const SourceDocumentMime = z.enum([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
]);
export type SourceDocumentMime = z.infer<typeof SourceDocumentMime>;

/**
 * Why a source cannot be used, as a code the screen words for people (with what to do about it). `detail` on the
 * source may add a short specific, never page content.
 */
export const BrandSourceReason = z.enum([
  'not_https',
  'blocked_address',
  'robots_disallowed',
  'http_error',
  'timeout',
  'too_large',
  'not_html',
  'no_text',
  'redirect_elsewhere',
  'unreachable',
  'scanned_pdf',
  'encrypted',
  'corrupt',
  'unsupported_type',
  'not_uploaded',
  'asset_not_usable',
  'capture_failed',
]);
export type BrandSourceReason = z.infer<typeof BrandSourceReason>;

export const BrandSourceAdd = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    brandId: z.string(),
    url: z.string().url().max(1000),
    title: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('text'),
    brandId: z.string(),
    title: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(SOURCE_PASTE_MAX_CHARS),
  }),
  z.object({
    kind: z.literal('document'),
    brandId: z.string(),
    fileName: z.string().trim().min(1).max(255),
    mime: SourceDocumentMime,
    byteSize: z.number().int().min(1).max(SOURCE_DOCUMENT_MAX_BYTES),
    title: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({ kind: z.literal('brand_asset'), brandId: z.string(), assetVersionId: z.string().max(32) }),
]);
export type BrandSourceAdd = z.infer<typeof BrandSourceAdd>;
export const BrandSourceList = z.object({ brandId: z.string(), page: PageRequest });
export const BrandSourceGet = z.object({ brandId: z.string(), sourceId: z.string().max(32) });
export const BrandSourceRemove = z.object({
  brandId: z.string(),
  sourceId: z.string().max(32),
  expectedVersion: z.number().int(),
});

/** One page a website source read: its address, title and canonical URL as the page states them. */
export interface BrandSourcePageV1 {
  url: string;
  title: string | null;
  canonicalUrl: string | null;
  chars: number;
}

export interface BrandSourceDto {
  id: string;
  brandId: string;
  kind: BrandSourceKind;
  title: string;
  url: string | null;
  fileName: string | null;
  mime: string | null;
  assetVersionId: string | null;
  status: BrandSourceStatus;
  reason: BrandSourceReason | null;
  detail: string | null;
  byteSize: number | null;
  charCount: number | null;
  truncated: boolean;
  pages: BrandSourcePageV1[];
  duplicateOfSourceId: string | null;
  capturedAt: string | null;
  createdAt: string;
  version: number;
}

// ---- assist jobs ----

/** The Brand System sections an assist job proposes for, one bounded model call each. */
export const AssistSection = z.enum([
  'voice',
  'messaging',
  'vocabulary',
  'writing',
  'examples',
  'templates',
  'channels',
  'facts',
]);
export type AssistSection = z.infer<typeof AssistSection>;
export const ASSIST_SECTION_LABEL: Record<AssistSection, string> = {
  voice: 'Voice & personality',
  messaging: 'Messaging',
  vocabulary: 'Vocabulary',
  writing: 'Writing patterns',
  examples: 'Examples',
  templates: 'Templates',
  channels: 'Channel guidance',
  facts: 'Facts',
};
export const BrandAssistJobKind = z.enum(['setup', 'section']);
export type BrandAssistJobKind = z.infer<typeof BrandAssistJobKind>;
export const BrandAssistJobState = z.enum([
  'queued',
  'capturing',
  'extracting',
  'proposing',
  'ready',
  'partially_ready',
  'failed',
  'cancelled',
]);
export type BrandAssistJobState = z.infer<typeof BrandAssistJobState>;
export const ASSIST_TERMINAL_STATES: readonly BrandAssistJobState[] = [
  'ready',
  'partially_ready',
  'failed',
  'cancelled',
];
export const AssistStage = z.enum(['capturing', 'extracting', 'proposing']);
export type AssistStage = z.infer<typeof AssistStage>;
/** At most this many questions per job; each one must materially improve the result. */
export const ASSIST_MAX_QUESTIONS = 5;

/**
 * What an assist job is asked to do. A setup job reads the sources for every chosen section; a section job (the
 * section assistant, the overall assistant, "request alternatives", answers to questions) may run on the current
 * guidance alone. `preserve` names items of the current guidance (suggestion paths) that must stay as they are.
 */
export const BrandAssistRequest = z.object({
  brandId: z.string(),
  kind: BrandAssistJobKind,
  sections: z
    .array(AssistSection)
    .min(1)
    .max(8)
    .refine((s) => new Set(s).size === s.length, 'sections must be unique'),
  instruction: z.string().trim().max(2000).optional(),
  sourceIds: z.array(z.string().max(32)).max(SOURCES_PER_BRAND_MAX).default([]),
  preserve: z.array(z.string().min(1).max(300)).max(40).optional(),
  /** "Request alternatives": the job whose rejected suggestions this one must not repeat. */
  alternativesForJobId: z.string().max(32).optional(),
});
export type BrandAssistRequest = z.input<typeof BrandAssistRequest>;
export const BrandAssistGet = z.object({ brandId: z.string(), jobId: z.string().max(32) });
export const BrandAssistList = z.object({ brandId: z.string(), page: PageRequest });
export const BrandAssistCancel = z.object({ brandId: z.string(), jobId: z.string().max(32) });
export const BrandAssistAnswer = z.object({
  brandId: z.string(),
  jobId: z.string().max(32),
  answers: z
    .array(z.object({ questionId: z.string().max(40), answer: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(ASSIST_MAX_QUESTIONS),
});

export const AssistBlockerCode = z.enum([
  'kill_switch_engaged',
  'model_routing_denied',
  'entitlement_exhausted',
  'budget_exhausted_month',
  'budget_exhausted_day',
  'no_usable_sources',
  'model_unavailable',
]);
export type AssistBlockerCode = z.infer<typeof AssistBlockerCode>;

export interface BrandAssistEstimateV1 {
  estimateMicros: number;
  sections: Array<{ section: AssistSection; inputTokens: number; outputTokens: number; costMicros: number }>;
  sources: { usable: number; pending: number; unusable: number };
  blockers: Array<{ code: AssistBlockerCode; message: string }>;
  remaining: { monthMicros: number; dayMicros: number };
}

export const AssistSectionStatus = z.enum(['pending', 'running', 'ready', 'failed', 'skipped', 'cancelled']);
export type AssistSectionStatus = z.infer<typeof AssistSectionStatus>;
export const AssistStageStatus = z.enum(['pending', 'running', 'done', 'skipped']);
export interface BrandAssistProgressV1 {
  stages: Record<AssistStage, { status: z.infer<typeof AssistStageStatus>; done: number; total: number }>;
  sections: Partial<
    Record<AssistSection, { status: AssistSectionStatus; suggestions: number; reason: string | null }>
  >;
}

export interface BrandAssistQuestionV1 {
  id: string;
  section: AssistSection;
  question: string;
  why: string;
  answer: string | null;
}

export interface BrandAssistJobDto {
  id: string;
  brandId: string;
  kind: BrandAssistJobKind;
  sections: AssistSection[];
  instruction: string | null;
  sourceIds: string[];
  preserve: string[];
  state: BrandAssistJobState;
  progress: BrandAssistProgressV1;
  questions: BrandAssistQuestionV1[];
  estimateMicros: number;
  reservedMicros: number;
  spentMicros: number;
  error: string | null;
  parentJobId: string | null;
  cancelRequested: boolean;
  createdByName: string | null;
  suggestionCounts: Record<'pending' | 'accepted' | 'edited' | 'rejected' | 'superseded', number>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  version: number;
}

// ---- suggestions ----

export const SuggestionOp = z.enum(['add', 'replace', 'remove']);
export type SuggestionOp = z.infer<typeof SuggestionOp>;
export const SuggestionStatus = z.enum(['pending', 'accepted', 'edited', 'rejected', 'superseded']);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

/** A passage of a source a suggestion relies on; `verified` when the passage was found in the captured text. */
export const SuggestionEvidence = z.object({
  sourceId: z.string().max(32),
  excerpt: z.string().max(1000),
  verified: z.boolean(),
});
export type SuggestionEvidence = z.infer<typeof SuggestionEvidence>;
export const SuggestionConflict = z.object({
  note: z.string().max(500),
  sourceIds: z.array(z.string().max(32)).max(5),
});
export type SuggestionConflict = z.infer<typeof SuggestionConflict>;

export const BrandSuggestionList = z.object({
  brandId: z.string(),
  jobId: z.string().max(32).optional(),
  section: AssistSection.optional(),
  status: SuggestionStatus.optional(),
  page: PageRequest,
});
export const BrandSuggestionAccept = z.object({
  brandId: z.string(),
  suggestionIds: z.array(z.string().max(32)).min(1).max(100),
});
export const BrandSuggestionEdit = z.object({
  brandId: z.string(),
  suggestionId: z.string().max(32),
  /** The value to write instead of the suggested one; checked against the item's schema. */
  value: z.unknown(),
});
export const BrandSuggestionReject = z.object({
  brandId: z.string(),
  suggestionIds: z.array(z.string().max(32)).min(1).max(100),
});
export const BrandSuggestionAcceptAll = z.object({
  brandId: z.string(),
  jobId: z.string().max(32),
  section: AssistSection,
});
export const BrandSuggestionUndo = z.object({ brandId: z.string(), batchId: z.string().max(32).optional() });

export interface BrandSuggestionDto {
  id: string;
  jobId: string;
  brandId: string;
  section: AssistSection;
  path: string;
  /** What the item is, in words ("Principle", "Term \"roast\"", "Positioning"). */
  label: string;
  op: SuggestionOp;
  /** The suggested value (an item, a text, a list of texts); null for a removal. */
  value: unknown;
  /** The value in the pending proposal (or the applied brand system) now; null when there is none. */
  current: unknown;
  /** The same two as readable text, for the diff. */
  valueText: string | null;
  currentText: string | null;
  provenance: GuidanceProvenance;
  rationale: string;
  uncertainty: string | null;
  conflicts: SuggestionConflict[];
  evidence: Array<SuggestionEvidence & { sourceTitle: string | null; sourceUrl: string | null }>;
  /** A person wrote the current item: accepting replaces or removes their wording. */
  againstUserItem: boolean;
  status: SuggestionStatus;
  decidedByName: string | null;
  decidedAt: string | null;
  batchId: string | null;
  factId: string | null;
  createdAt: string;
  version: number;
}

export interface BrandSuggestionDecisionResult {
  batchId: string | null;
  proposalVersionId: string | null;
  decided: string[];
  factIds: string[];
  skipped: Array<{ suggestionId: string; reason: string }>;
}

// ---- history ----

export const BrandHistoryList = z.object({ brandId: z.string(), page: PageRequest });
export const BrandHistoryCompare = z.object({
  brandId: z.string(),
  versionId: z.string().max(32),
  /** Compared against the applied brand system when omitted. */
  againstVersionId: z.string().max(32).optional(),
});
export const BrandHistoryRestore = z.object({
  brandId: z.string(),
  versionId: z.string().max(32),
  /** The applied version the restore starts from (as brand.system.save): a newer one is a conflict. */
  basedOnVersionId: z.string().max(32).nullable(),
});

export const DocumentChangeKind = z.enum(['added', 'removed', 'changed']);
export type DocumentChangeKind = z.infer<typeof DocumentChangeKind>;
export interface DocumentChangeV1 {
  change: DocumentChangeKind;
  item: string;
  before: string | null;
  after: string | null;
}
export interface DocumentSectionDiffV1 {
  section: string;
  label: string;
  changes: DocumentChangeV1[];
}

export interface BrandHistoryEntryDto {
  versionId: string;
  number: number;
  current: boolean;
  appliedAt: string | null;
  appliedByName: string | null;
  /** The sections this version changed against the one applied before it. */
  changedSections: string[];
}

// ---- model output (strict: anything else is refused, never repaired) ----

const ModelEvidence = z
  .object({ sourceId: z.string().min(1).max(40), excerpt: z.string().min(1).max(600) })
  .strict();
/** `stated`: the sources say it; `inferred`: a pattern across examples; `suggested`: a proposal with no source. */
export const ModelBasis = z.enum(['stated', 'inferred', 'suggested']);
export type ModelBasis = z.infer<typeof ModelBasis>;
const meta = {
  rationale: z.string().max(600),
  basis: ModelBasis,
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(ModelEvidence).max(5),
  uncertainty: z.string().max(400).optional(),
  conflicts: z
    .array(z.object({ note: z.string().max(400), sourceIds: z.array(z.string().max(40)).max(5) }).strict())
    .max(3)
    .optional(),
};
const item = <T extends z.ZodTypeAny>(value: T) => z.object({ value, ...meta }).strict();
const removal = z
  .object({ collection: z.string().max(40), key: z.string().min(1).max(300), ...meta })
  .strict();
const questions = z
  .array(z.object({ question: z.string().min(1).max(300), why: z.string().max(300) }).strict())
  .max(2);
const shortText = (max: number) => z.string().min(1).max(max);
const lines = (max: number, len = 300) => z.array(shortText(len)).max(max);

export const ModelVoiceOutput = z
  .object({
    summary: item(z.string().max(2000)).optional(),
    tone: item(lines(12, 60)).optional(),
    personality: z
      .array(item(z.object({ trait: shortText(60), note: z.string().max(300).optional() }).strict()))
      .max(12),
    principles: z
      .array(item(z.object({ statement: shortText(300), rationale: z.string().max(1000) }).strict()))
      .max(12),
    spelling: item(
      z.object({ locale: z.string().min(2).max(20), notes: z.string().max(1000) }).strict(),
    ).optional(),
    styleRules: z.array(item(z.object({ topic: StyleRuleTopic, rule: shortText(500) }).strict())).max(20),
    claimRules: z.array(item(z.object({ rule: shortText(500) }).strict())).max(10),
    remove: z.array(removal).max(10),
    questions,
  })
  .strict();
export const ModelMessagingOutput = z
  .object({
    positioning: item(z.string().max(2000)).optional(),
    valueProposition: item(z.string().max(2000)).optional(),
    pillars: z
      .array(
        item(
          z
            .object({
              key: z.string().min(1).max(60),
              title: shortText(120),
              statement: z.string().max(1000),
            })
            .strict(),
        ),
      )
      .max(8),
    keyMessages: z
      .array(item(z.object({ text: shortText(500), pillarKey: z.string().max(60).optional() }).strict()))
      .max(12),
    audiences: z
      .array(
        item(
          z
            .object({
              key: z.string().min(1).max(60),
              description: z.string().max(500),
              needs: lines(10).optional(),
              objections: lines(10).optional(),
            })
            .strict(),
        ),
      )
      .max(8),
    remove: z.array(removal).max(10),
    questions,
  })
  .strict();
export const ModelVocabularyOutput = z
  .object({
    terms: z
      .array(
        item(
          z
            .object({
              term: shortText(120),
              definition: z.string().max(500).optional(),
              usage: VocabularyUsage,
              alternatives: z.array(shortText(120)).max(10),
              note: z.string().max(500).optional(),
            })
            .strict(),
        ),
      )
      .max(60),
    remove: z.array(removal).max(10),
    questions,
  })
  .strict();
export const ModelWritingOutput = z
  .object({
    patterns: z
      .array(
        z
          .object({
            part: z.enum(WRITING_PARTS),
            value: z
              .object({
                guidance: z.string().max(2000),
                dos: lines(12),
                donts: lines(12),
                examples: z.array(shortText(1000)).max(6),
              })
              .strict(),
            ...meta,
          })
          .strict(),
      )
      .max(5),
    questions,
  })
  .strict();
export const ModelExamplesOutput = z
  .object({
    examples: z
      .array(
        item(
          z
            .object({
              text: shortText(1000),
              verdict: z.enum(['on_brand', 'off_brand']),
              note: z.string().max(500),
              channelKey: z.string().min(1).max(40).optional(),
              contentType: CopyContentType.optional(),
              rationale: z.string().max(1000).optional(),
              rewrite: z.string().max(1000).optional(),
            })
            .strict(),
        ),
      )
      .max(12),
    remove: z.array(removal).max(10),
    questions,
  })
  .strict();
export const ModelTemplatesOutput = z
  .object({
    templates: z
      .array(
        item(
          z
            .object({
              key: z.string().min(1).max(60),
              name: shortText(120),
              contentType: CopyContentType,
              channelKeys: z.array(z.string().min(1).max(40)).max(20),
              purpose: z.string().max(1000),
              structure: z
                .array(
                  z
                    .object({
                      slot: shortText(60),
                      guidance: z.string().max(1000),
                      maxLength: z.number().int().positive().max(100_000).optional(),
                    })
                    .strict(),
                )
                .min(1)
                .max(12),
              example: z.string().max(4000).optional(),
            })
            .strict(),
        ),
      )
      .max(8),
    remove: z.array(removal).max(10),
    questions,
  })
  .strict();
export const CHANNEL_BASELINE_MODEL_FIELDS = [
  'objectives',
  'toneAdaptation',
  'conventions',
  'cta',
  'accessibility',
  'hashtags',
  'mentions',
  'links',
  'frequency',
] as const;
export const ModelChannelsOutput = z
  .object({
    baseline: z
      .array(
        z
          .object({ field: z.enum(CHANNEL_BASELINE_MODEL_FIELDS), value: z.string().max(1000), ...meta })
          .strict(),
      )
      .max(9),
    channels: z
      .array(
        z
          .object({
            providerKey: z.string().min(1).max(40),
            value: z
              .object({
                captionStyle: z.string().max(1000).optional(),
                ctaConventions: z.string().max(1000).optional(),
                preferredFormats: z.array(shortText(60)).max(10).optional(),
                objectives: z.string().max(1000).optional(),
                conventions: z.string().max(1000).optional(),
                accessibility: z.string().max(1000).optional(),
                hashtags: z.string().max(1000).optional(),
                mentions: z.string().max(1000).optional(),
                links: z.string().max(1000).optional(),
                frequency: z.string().max(1000).optional(),
                audience: z.string().max(1000).optional(),
                formats: z.string().max(1000).optional(),
              })
              .strict(),
            ...meta,
          })
          .strict(),
      )
      .max(10),
    questions,
  })
  .strict();
export const ModelFactsOutput = z
  .object({
    facts: z
      .array(
        z
          .object({
            statement: shortText(1000),
            category: FactCategory,
            scope: z.string().max(200).optional(),
            ...meta,
          })
          .strict(),
      )
      .max(30),
    questions,
  })
  .strict();

export const MODEL_SECTION_OUTPUT = {
  voice: ModelVoiceOutput,
  messaging: ModelMessagingOutput,
  vocabulary: ModelVocabularyOutput,
  writing: ModelWritingOutput,
  examples: ModelExamplesOutput,
  templates: ModelTemplatesOutput,
  channels: ModelChannelsOutput,
  facts: ModelFactsOutput,
} as const satisfies Record<AssistSection, z.ZodTypeAny>;
export type ModelSectionOutput<S extends AssistSection = AssistSection> = z.infer<
  (typeof MODEL_SECTION_OUTPUT)[S]
>;

// ---- workflow (brandAssistWorkflowV1 on task queue `agents`; capture on `ingest-metrics`, extraction on `media`) ----

export const BrandAssistInputV1 = TenantContextInput.extend({ brandId: z.string(), jobId: z.string() });
export type BrandAssistInputV1 = z.infer<typeof BrandAssistInputV1>;
export type BrandAssistSourceInputV1 = BrandAssistInputV1 & { sourceId: string };
export type BrandAssistSectionInputV1 = BrandAssistInputV1 & { section: AssistSection };

export interface BrandAssistPlanV1 {
  outcome: 'run' | 'skipped';
  reason: string | null;
  urlSourceIds: string[];
  documentSourceIds: string[];
  sections: AssistSection[];
}
export interface BrandSourceCaptureResultV1 {
  sourceId: string;
  status: BrandSourceStatus;
  reason: BrandSourceReason | null;
}
export interface BrandAssistPrepareResultV1 {
  outcome: 'run' | 'failed' | 'cancelled';
  reason: string | null;
  sections: AssistSection[];
}
export interface BrandAssistSectionResultV1 {
  section: AssistSection;
  outcome: 'ready' | 'failed' | 'skipped';
  suggestions: number;
  reason: string | null;
}
export interface BrandAssistFinishResultV1 {
  state: BrandAssistJobState;
  suggestions: number;
}

/** Control activities (worker-core, task queue `agents`): the job row, the budget, the model calls. */
export interface BrandAssistActivitiesV1 {
  beginBrandAssist(input: BrandAssistInputV1): Promise<BrandAssistPlanV1>;
  markBrandAssistStage(input: BrandAssistInputV1 & { stage: AssistStage }): Promise<void>;
  recordBrandSourceFailure(input: BrandAssistSourceInputV1 & { reason: BrandSourceReason }): Promise<void>;
  prepareBrandAssistProposals(input: BrandAssistInputV1): Promise<BrandAssistPrepareResultV1>;
  proposeBrandAssistSection(input: BrandAssistSectionInputV1): Promise<BrandAssistSectionResultV1>;
  recordBrandAssistSectionFailure(input: BrandAssistSectionInputV1 & { reason: string }): Promise<void>;
  /** `failure`: why the run stopped early (an activity that kept failing), recorded when no section finished. */
  finishBrandAssist(
    input: BrandAssistInputV1 & { cancelled: boolean; failure: string | null },
  ): Promise<BrandAssistFinishResultV1>;
}
/** Website capture (worker-ingest, task queue `ingest-metrics`: the workers with outbound fetch). */
export interface BrandSourceCaptureActivitiesV1 {
  captureBrandSourceUrl(input: BrandAssistSourceInputV1): Promise<BrandSourceCaptureResultV1>;
}
/** Document text extraction (worker-render, task queue `media`: untrusted-input parsers and the object store). */
export interface BrandSourceExtractActivitiesV1 {
  extractBrandSourceDocument(input: BrandAssistSourceInputV1): Promise<BrandSourceCaptureResultV1>;
}

export const BrandAssistSignalV1 = z.object({
  workflowId: z.string(),
  signal: z.literal('cancelBrandAssist'),
});
export type BrandAssistSignalV1 = z.infer<typeof BrandAssistSignalV1>;

// ---- the model behind an assist job (implemented in @oremedia/ai; the brand module only sees this) ----

export interface AssistModelDescriptionV1 {
  provider: string;
  model: string;
  maxOutputTokens: number;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}
/** Reads the deployment's model and checks the tenant's routing policy (spec 12.7) before anything is spent. */
export interface AssistModelGateV1 {
  describe(): AssistModelDescriptionV1;
  assertRouting(tenantId: string): Promise<void>;
}

/** One bounded section call: the approved guidance, the untrusted evidence and what the person asked for. */
export interface BrandAssistModelRequestV1 {
  tenantId: string;
  jobId: string;
  section: AssistSection;
  brandName: string;
  defaultLocale: string;
  /** The applied (approved) brand system: suggestions are reviewable updates to it. */
  guidance: BrandSystemDocumentV1;
  facts: Array<{ id: string; statement: string }>;
  evidence: EvidenceItem[];
  instruction: string | null;
  /** Items the person chose to keep as they are, in words. */
  preserve: string[];
  /** Answers people gave to an earlier job's questions. */
  answers: Array<{ question: string; answer: string }>;
  /** Suggestions people rejected: not to be offered again. */
  avoid: string[];
  /** Channel keys guidance may name. */
  channelKeys: string[];
  maxOutputTokens: number;
}
export interface BrandAssistModelResultV1 {
  /** The JSON the model answered with (not yet checked against the section schema), or null when it was not JSON. */
  raw: unknown;
  parseError: string | null;
  usage: { inputTokens: number; outputTokens: number };
  costMicros: number;
}
export interface BrandAssistModelV1 {
  propose(req: BrandAssistModelRequestV1): Promise<BrandAssistModelResultV1>;
}
