import { z } from 'zod';
import type { ActivityHooks } from './agents';
import { ContentType, Finding, Operation } from './creative';
import type { ResolvedActor } from './policy';
import { TenantContextInput } from './tenancy';

/**
 * STU-1b: generation and targeted refinement of graphic documents (architecture "Generation", principles 1-3, 7, 8).
 * A person describes the work (a brief or a plain-language change with an explicit scope); a durable job makes one
 * bounded model call whose strict JSON output is compiled on the server into an operation batch against the current
 * document. The batch goes through the same guards (locks, protected elements, scope), asset authorisation, reducer
 * and brand validation as every other batch, and lands as an immutable revision (a fresh document) or a proposal.
 */

// ---- the request ---------------------------------------------------------------------------------------------

export const GenerationKind = z.enum(['generate', 'refine']);
export type GenerationKind = z.infer<typeof GenerationKind>;

const Line = (max: number) => z.string().trim().max(max);
const Ids = (max: number) => z.array(z.string().min(1).max(64)).max(max);

/**
 * The generate panel's brief. Everything is optional except what the person must decide: defaults come from the
 * document (content type, pages), its template's slots and the published brand system (copy templates, channel
 * guidance, voice), and the panel shows them rather than asking again.
 */
export const GenerationBrief = z
  .object({
    objective: Line(500).default(''),
    audience: Line(300).default(''),
    keyMessage: Line(500).default(''),
    /** Defaults to the document's content type. */
    contentType: ContentType.optional(),
    /** Destination channels (provider keys); the first is the one the brand guidance is rendered for. */
    channelKeys: z.array(z.string().min(1).max(40)).max(10).default([]),
    /** The pages to fill; empty means every page that is not locked. */
    pageIds: z.array(z.string().min(1).max(60)).max(20).default([]),
    /**
     * `current`: fill and adapt the document's own layout. `template`: apply this approved brand template version to
     * the pages first (slots bound by element type and role), then fill it.
     */
    layout: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('current') }),
        z.object({ kind: z.literal('template'), templateVersionId: z.string().min(1).max(64) }),
      ])
      .default({ kind: 'current' }),
    /** Copy the person requires verbatim (headline, body, call to action); the model keeps it as written. */
    requiredCopy: z
      .object({ headline: Line(300).optional(), body: Line(1000).optional(), cta: Line(80).optional() })
      .strict()
      .default({}),
    /** A copy template of the brand system (BSC-1) to follow; defaults to the first that fits type and channel. */
    copyTemplateKey: z.string().min(1).max(60).optional(),
    /** Approved facts the copy may state, picked by statement; each must be effective when the job runs. */
    factIds: Ids(20).default([]),
    assets: z
      .object({ include: Ids(20).default([]), exclude: Ids(50).default([]), prioritise: Ids(20).default([]) })
      .default({}),
    visualDirection: Line(1000).default(''),
    referenceAssetVersionIds: Ids(10).default([]),
    /** 1: generate into this document; 2-4: also into copies of it, one variation per copy (format-identical). */
    variations: z.number().int().min(1).max(4).default(1),
    /** Only when the images capability, the brand's generation restrictions and the budget permit it. */
    generateImages: z.boolean().default(false),
  })
  .strict();
export type GenerationBrief = z.infer<typeof GenerationBrief>;
export type GenerationBriefInput = z.input<typeof GenerationBrief>;

/**
 * What a refinement may touch (principle 2): the selected elements of one page, or the whole page when no element is
 * selected. Enforced by the server guard on every operation the job proposes, never only by the prompt.
 */
export const GenerationScope = z
  .object({
    pageId: z.string().min(1).max(60),
    elementIds: z.array(z.string().min(1).max(64)).max(100).default([]),
  })
  .strict();
export type GenerationScope = z.infer<typeof GenerationScope>;

/**
 * A plain-language change. `edit` changes the scope in place; `alternatives` duplicates the page `count` times and
 * reworks only the copies; `adapt` makes a format variant of the page (e.g. a vertical story) and reworks only the
 * new page. The original page is never touched by the last two.
 */
export const RefineRequest = z
  .object({
    instruction: z.string().trim().min(1).max(2000),
    scope: GenerationScope,
    action: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('edit') }),
        z.object({ kind: z.literal('alternatives'), count: z.number().int().min(1).max(3) }),
        z.object({ kind: z.literal('adapt'), formatKey: z.string().min(1).max(40) }),
      ])
      .default({ kind: 'edit' }),
    /** Approved facts the change may state (effective when the job runs). */
    factIds: Ids(20).default([]),
    /** Eligible assets the change may place (e.g. "replace this image with an approved product photograph"). */
    assetVersionIds: Ids(20).default([]),
  })
  .strict();
export type RefineRequest = z.infer<typeof RefineRequest>;

export const GenerationRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('generate'), brief: GenerationBrief }),
  z.object({ kind: z.literal('refine'), refine: RefineRequest }),
]);
export type GenerationRequest = z.infer<typeof GenerationRequest>;

// ---- router DTOs ---------------------------------------------------------------------------------------------

export const GenerationPreflight = z.object({
  documentId: z.string(),
  baseRevisionId: z.string(),
  request: GenerationRequest,
});
export const GenerationStart = GenerationPreflight;
export const GenerationGet = z.object({ jobId: z.string() });
/** The document's jobs that are not finished, and its last finished one: the studio reattaches after a reload. */
export const GenerationActive = z.object({ documentId: z.string() });
export const GenerationCancel = z.object({ jobId: z.string(), expectedVersion: z.number().int() });
export const GenerationRetry = z.object({ jobId: z.string(), expectedVersion: z.number().int() });

export const GenerationIssueSeverity = z.enum(['blocking', 'warning', 'info']);
export const GenerationIssue = z.object({
  code: z.string(),
  severity: GenerationIssueSeverity,
  message: z.string(),
  /** What the issue is about, for the panel to point at (a fact, an asset, a page, an element, a channel). */
  ref: z.string().optional(),
});
export type GenerationIssue = z.infer<typeof GenerationIssue>;

/** One applicable constraint, in words, with its source (channel capability, logo rule, safe area, lock...). */
export const GenerationConstraint = z.object({
  kind: z.enum([
    'channel',
    'format',
    'logo_rule',
    'safe_area',
    'lock',
    'protected',
    'slot',
    'asset',
    'fact',
    'scope',
  ]),
  text: z.string(),
});
export type GenerationConstraint = z.infer<typeof GenerationConstraint>;

export const GenerationCostEstimate = z.object({
  modelCalls: z.number().int().min(0),
  modelMicros: z.number().int().min(0),
  images: z.number().int().min(0),
  imageUnitMicros: z.number().int().min(0),
  totalMicros: z.number().int().min(0),
  /** The lesser of the brand's day and the company's month remaining; null when it cannot be read. */
  remainingMicros: z.number().int().nullable(),
});
export type GenerationCostEstimate = z.infer<typeof GenerationCostEstimate>;

// ---- the model's strict output -------------------------------------------------------------------------------

const ModelBox = z
  .object({
    x: z.number().min(-4096).max(8192),
    y: z.number().min(-4096).max(8192),
    width: z.number().positive().max(8192),
    height: z.number().positive().max(8192),
  })
  .strict();

/**
 * One element's change as the model may express it: text (with the fact ids it states), an eligible asset, a palette
 * colour token, a new box within the page, or type adjustments. Nothing else: no new elements, no free layout.
 */
export const ModelElementEdit = z
  .object({
    label: z.string().min(1).max(80),
    pageId: z.string().min(1).max(60),
    elementId: z.string().min(1).max(64),
    text: z.string().max(5000).optional(),
    factIds: z.array(z.string().min(1).max(64)).max(10).optional(),
    assetVersionId: z.string().min(1).max(64).optional(),
    colourToken: z.string().min(1).max(60).optional(),
    box: ModelBox.optional(),
    sizePx: z.number().positive().max(1000).optional(),
    weight: z.number().int().min(100).max(900).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    /** Hide (true) or show (false) the element: compiled into a setVisibility operation. */
    hidden: z.boolean().optional(),
  })
  .strict();
export type ModelElementEdit = z.infer<typeof ModelElementEdit>;

export const ModelFill = z
  .object({
    summary: z.string().min(1).max(300),
    edits: z.array(ModelElementEdit).max(80),
  })
  .strict();
export type ModelFill = z.infer<typeof ModelFill>;

/** The single tool the model must call: one fill per requested variation. */
export const ModelGenerationOutput = z.object({ variations: z.array(ModelFill).min(1).max(4) }).strict();
export type ModelGenerationOutput = z.infer<typeof ModelGenerationOutput>;

/** An item of the model's output the server refused, and why (shown to the person; never silently dropped). */
export const RefusedEdit = z.object({
  variation: z.number().int().min(0),
  elementId: z.string(),
  pageId: z.string(),
  reason: z.string(),
});
export type RefusedEdit = z.infer<typeof RefusedEdit>;

/**
 * Principle 8: what produced a revision, stored on creative_revisions.generation_inputs. The request is the brief or
 * the refinement as the person sent it; asset versions are those the batch placed; the model call reference is the
 * job's ledger key, never a prompt or a model identifier. The column is shared with video documents (STU-3 writes
 * `documentKind: 'video'` inputs), so graphic inputs carry `documentKind: 'graphic'`; rows written before the field
 * existed have none and read as graphic.
 */
export const GenerationInputs = z.object({
  documentKind: z.literal('graphic').default('graphic'),
  jobId: z.string(),
  kind: GenerationKind,
  request: GenerationRequest,
  inputsHash: z.string(),
  templateVersionId: z.string().nullable(),
  brandVersionId: z.string(),
  scope: GenerationScope.nullable(),
  assetVersionIds: z.array(z.string()),
  factIds: z.array(z.string()),
  modelCallRefs: z.array(z.string()),
  costMicros: z.number().int().min(0),
  variation: z.number().int().min(0),
  /** Set when a person accepted part of a proposal: the groups they kept. */
  acceptedGroupIds: z.array(z.string()).optional(),
});
export type GenerationInputs = z.infer<typeof GenerationInputs>;

/**
 * A stored generation_inputs value read as a graphic revision's inputs: null when the row holds none, or holds inputs
 * of another document kind (a video revision's) or of a shape this release does not know. Never throws, so a revision
 * list stays readable whatever the column holds.
 */
export function graphicGenerationInputs(stored: unknown): GenerationInputs | null {
  if (stored === null || stored === undefined) return null;
  const parsed = GenerationInputs.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/**
 * A proposal group: operations that belong together (one element's change, or a page the job created) and are
 * accepted or left out as one. Accepting some groups applies their operations in proposal order.
 */
export const ProposalGroup = z.object({
  id: z.string(),
  label: z.string(),
  operationIndexes: z.array(z.number().int().min(0)),
  elementIds: z.array(z.string()),
});
export type ProposalGroup = z.infer<typeof ProposalGroup>;

export const GenerationProposal = z.object({
  documentId: z.string(),
  baseRevisionId: z.string(),
  operations: z.array(Operation).min(1).max(100),
  summary: z.string().max(500),
  groups: z.array(ProposalGroup).min(1),
  findings: z.array(Finding),
  contentHash: z.string(),
  /** The scope the batch was checked against; accept checks it again. */
  scope: GenerationScope.nullable(),
  /**
   * The first operations are the person's own request (apply a template, copy or adapt a page) and are checked as
   * theirs (an agent may not copy a page with a logo; the person may); the rest are the model's, checked as an agent's.
   */
  requestedOperations: z.number().int().min(0).default(0),
  /** What produced it; recorded on the revision an accept creates (with the groups kept). */
  inputs: GenerationInputs,
});
export type GenerationProposal = z.infer<typeof GenerationProposal>;

export const GenerationResult = z.object({
  /** Revisions saved (a fresh document's, and each variation copy's). */
  revisions: z.array(z.object({ documentId: z.string(), revisionId: z.string(), variation: z.number() })),
  /** A proposal for a document that already had a person's edits, or for every refinement. */
  proposal: GenerationProposal.nullable(),
  refused: z.array(RefusedEdit),
  findings: z.array(Finding),
});
export type GenerationResult = z.infer<typeof GenerationResult>;

export const GenerationJobState = z.enum([
  'queued',
  'generating',
  'validating',
  'saving',
  'completed',
  'failed',
  'cancelled',
]);
export type GenerationJobState = z.infer<typeof GenerationJobState>;

/** Progress shown per state (the job row stores it; the panel reads it). */
export const GENERATION_PROGRESS: Record<GenerationJobState, number> = {
  queued: 5,
  generating: 30,
  validating: 70,
  saving: 85,
  completed: 100,
  failed: 100,
  cancelled: 100,
};

export const GenerationErrorCode = z.enum([
  'budget_exhausted',
  'policy_denied',
  'model_failed',
  'model_output_invalid',
  'validation_failed',
  'stale_document',
  'not_found',
  'failed',
]);
export type GenerationErrorCode = z.infer<typeof GenerationErrorCode>;

// ---- workflow contract (studioGenerationWorkflowV1 on task queue `agents`) -----------------------------------

/**
 * Workflow id `studio-gen:<jobId>:<attempt>`; a retry is a new attempt of the same job. Activity parameters are
 * frozen once deployed: a change ships as new activities and a new workflow version.
 */
export const StudioGenerationInputV1 = TenantContextInput.extend({
  jobId: z.string(),
  attempt: z.number().int().min(1),
});
export type StudioGenerationInputV1 = z.infer<typeof StudioGenerationInputV1>;

export type GenerationStepOutcomeV1 =
  { proceed: true } | { proceed: false; reason: 'cancelled' | 'finished' };

/** `stopped`: the attempt ended early because the job was cancelled, finished or superseded by a newer attempt. */
export interface StudioGenerationResultV1 {
  jobId: string;
  state: GenerationJobState | 'stopped';
}

export interface StudioGenerationFailInputV1 extends StudioGenerationInputV1 {
  code: GenerationErrorCode;
  detail?: string;
}

/**
 * begin: queued → generating (no-op answer when the attempt is cancelled or over). reserveBudget: before any model
 * or image call; non-retryable BudgetExhausted. callModel: one bounded call, its output stored on the job (a retried
 * activity after a stored output returns at once). save: compile, guard, validate and write revisions or the proposal
 * in one transaction; the job completes only after that commit. fail: the job's terminal failure. settle: releases
 * what the attempt did not spend.
 */
export interface StudioGenerationActivitiesV1 {
  beginGeneration(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1>;
  reserveGenerationBudget(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1>;
  callGenerationModel(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1>;
  saveGeneration(input: StudioGenerationInputV1): Promise<StudioGenerationResultV1>;
  failGeneration(input: StudioGenerationFailInputV1): Promise<StudioGenerationResultV1>;
  settleGenerationBudget(input: StudioGenerationInputV1): Promise<void>;
}

/**
 * The module-side implementation the activities wrap (apps/worker-core wires the agents module's runtime). The host
 * establishes tenant context and resolves the requesting person as they are now for the steps that act on the
 * document.
 */
export interface StudioGenerationRuntimeV1 {
  begin(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1>;
  reserve(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1>;
  callModel(
    input: StudioGenerationInputV1,
    actor: ResolvedActor,
    hooks?: ActivityHooks,
  ): Promise<GenerationStepOutcomeV1>;
  save(input: StudioGenerationInputV1, actor: ResolvedActor): Promise<StudioGenerationResultV1>;
  fail(
    input: StudioGenerationInputV1,
    code: GenerationErrorCode,
    detail?: string,
  ): Promise<StudioGenerationResultV1>;
  settle(input: StudioGenerationInputV1): Promise<void>;
}

export const StudioGenerationSignalV1 = z.object({ workflowId: z.string(), signal: z.literal('cancel') });
export type StudioGenerationSignalV1 = z.infer<typeof StudioGenerationSignalV1>;
