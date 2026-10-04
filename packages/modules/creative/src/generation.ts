import { z } from 'zod';
import { IMAGE_CREATIVE_KINDS, type AssetKind } from '@oremedia/contracts/assets';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import {
  CreativeDocumentV1,
  Operation,
  type Finding,
  type OperationBatch,
} from '@oremedia/contracts/creative';
import {
  BudgetExhaustedError,
  NotFoundError,
  OremediaError,
  StaleRevisionError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { GenerationIssue, GenerationProposal } from '@oremedia/contracts/generation';
import {
  GENERATION_PROGRESS,
  GenerationActive,
  GenerationCancel,
  GenerationGet,
  GenerationPreflight,
  GenerationRequest,
  GenerationResult,
  GenerationRetry,
  GenerationStart,
  ModelGenerationOutput,
  type GenerationCostEstimate,
  type GenerationErrorCode,
  type GenerationInputs,
  type GenerationJobState,
  type GenerationScope,
  type GenerationStepOutcomeV1,
  type RefusedEdit,
  type StudioGenerationInputV1,
} from '@oremedia/contracts/generation';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { withTransaction, type Tx } from '@oremedia/db';
import { copyContentTypeFor, matchingCopyTemplates } from '@oremedia/domain/channel-guidance';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import {
  generationJobMachine,
  type GenerationJobEvent,
} from '@oremedia/domain/state-machines/generation-job';
import {
  compileFill,
  generationSlots,
  groupOperations,
  preflightGeneration,
  structureFor,
  type GenerationSlot,
  type PreflightAsset,
} from '@oremedia/editor/generation';
import { applyBatch, type TemplateDocument } from '@oremedia/editor/reduce';
import { assertTenantCapability, isDemoTenant, policy } from '@oremedia/module-access';
import { budgets } from '@oremedia/module-billing';
import { audit, outbox } from '@oremedia/module-operations';
import { StudioGenerationJobRepository } from './repositories';
import { creativeEngine as engine, type CreativeDocumentRow } from './service';

/**
 * STU-1b: the generation job service (preflight, start, get, active, cancel, retry) and the runtime surface the
 * agents worker drives (studioGenerationWorkflowV1). The model call itself lives in the agents module (it holds the
 * model adapter); everything that reads or writes creative state is here, in the caller's tenant context.
 */

const jobsRepo = new StudioGenerationJobRepository();
type JobRow = Awaited<ReturnType<typeof jobsRepo.getById>>;

// ---- cross-module hooks (registered by the composition roots, as registerAssetAuthoriser) ---------------------

/** An asset the generator may place: eligible for creative use now (spec 9.2), from the assets module. */
export interface GenerationAsset extends PreflightAsset {
  assetId: string;
  semanticRole: string | null;
}
export type GenerationAssetSource = (brandId: string, tx?: Tx) => Promise<GenerationAsset[]>;
const unregisteredAssets: GenerationAssetSource = async () => {
  throw new Error(
    'generation asset source not registered (composition root must call registerGenerationAssetSource)',
  );
};
let assetSource: GenerationAssetSource = unregisteredAssets;
export const registerGenerationAssetSource = (fn: GenerationAssetSource): void => {
  assetSource = fn;
};
export const resetGenerationAssetSource = (): void => {
  assetSource = unregisteredAssets;
};

/** The channel capability register in use (publishing's provider registry). */
export type ChannelCapabilitySource = () => readonly ProviderCapabilityV1[];
const unregisteredChannels: ChannelCapabilitySource = () => {
  throw new Error(
    'channel capability source not registered (composition root must call registerChannelCapabilitySource)',
  );
};
let channelSource: ChannelCapabilitySource = unregisteredChannels;
export const registerChannelCapabilitySource = (fn: ChannelCapabilitySource): void => {
  channelSource = fn;
};
export const resetChannelCapabilitySource = (): void => {
  channelSource = unregisteredChannels;
};

/**
 * Whether generated images can fill empty image slots for this brand. Until a deployment registers a source, it is
 * unavailable: a generated image is a pending asset (rights unknown) and the eligibility rule refuses to place it.
 */
export type GenerationImageAvailability = (
  brandId: string,
  tx?: Tx,
) => Promise<{ available: boolean; reason?: string }>;
const NO_IMAGES: GenerationImageAvailability = async () => ({
  available: false,
  reason:
    'Generated images cannot fill image areas yet: a generated image is held for approval in the asset library before it can be placed.',
});
let imageAvailability: GenerationImageAvailability = NO_IMAGES;
export const registerGenerationImageAvailability = (fn: GenerationImageAvailability | null): void => {
  imageAvailability = fn ?? NO_IMAGES;
};

/** Price list for the estimate (micro-units): the composition root sets it from the model configuration. */
export interface GenerationPricing {
  modelCallMicros: number;
  imageMicros: number;
}
const DEFAULT_PRICING: GenerationPricing = { modelCallMicros: 170_000, imageMicros: 40_000 };
let pricing: GenerationPricing = DEFAULT_PRICING;
export const configureGenerationPricing = (p: Partial<GenerationPricing>): void => {
  pricing = { ...DEFAULT_PRICING, ...p };
};

// ---- helpers -------------------------------------------------------------------------------------------------

const jobResource = (j: JobRow) => ({
  type: 'creative_document',
  tenantId: j.tenantId,
  brandId: j.brandId,
  id: j.documentId,
});

function move(from: GenerationJobState, event: GenerationJobEvent): GenerationJobState {
  try {
    return generationJobMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path: 'state', issue: err.message }],
        `The generation is ${from}; this is not possible now`,
      );
    throw err;
  }
}

const SYSTEM = { kind: 'system' as const, id: 'studio_generation' };

/** Demo workspace (architecture §4.2): what the preflight says instead of a budget figure; start is refused. */
const DEMO_GENERATION_ISSUE: GenerationIssue = {
  code: 'demo_simulated',
  severity: 'blocking',
  message: 'AI generation is not available in the demo workspace: no model is called here.',
};
const LIVE: ReadonlySet<GenerationJobState> = new Set(['queued', 'generating', 'validating', 'saving']);
export const workflowIdFor = (jobId: string, attempt: number): string => `studio-gen:${jobId}:${attempt}`;
export const modelCallRef = (jobId: string, attempt: number): string => `sgj:${jobId}:${attempt}:model`;
/**
 * The budget reservation key of one attempt (budget_reservations.run_id, at most 32 characters): derived from the
 * job and the attempt, so every step of an attempt (and only of that attempt) reaches the same reservation, and a
 * late step of a superseded attempt can never settle or charge the reservation of the attempt that replaced it.
 */
export const budgetRunIdFor = (jobId: string, attempt: number): string =>
  `g${jobId.slice(jobId.indexOf('_') + 1)}${attempt}`.slice(0, 32);

/** The operation contract's batch bound (OperationBatch.operations, GenerationProposal.operations). */
const MAX_BATCH_OPERATIONS = 100;

const StoredModelOutput = z.object({
  output: ModelGenerationOutput,
  callRef: z.string(),
  /** The structural operations the model saw the result of (element ids it may name come from them). */
  structure: z.object({
    operations: z.array(Operation),
    labels: z.array(z.string()),
    targetPageIds: z.array(z.string()),
    createdPageIds: z.array(z.string()),
  }),
});

function toJobDto(j: JobRow) {
  const result = j.result ? GenerationResult.parse(j.result) : null;
  return {
    id: j.id,
    brandId: j.brandId,
    documentId: j.documentId,
    baseRevisionId: j.baseRevisionId,
    kind: j.kind,
    state: j.state,
    progress: j.progress,
    attempt: j.attempt,
    live: LIVE.has(j.state),
    request: GenerationRequest.parse(j.request),
    costReservedMicros: j.costReservedMicros,
    costSpentMicros: j.costSpentMicros,
    error: j.errorCode ? { code: j.errorCode, message: j.error ?? '' } : null,
    resultRevisionIds: result?.revisions.map((r) => r.revisionId) ?? [],
    resultDocumentIds: [...new Set(result?.revisions.map((r) => r.documentId) ?? [])],
    result,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    version: j.version,
  };
}
export type GenerationJobDto = ReturnType<typeof toJobDto>;

async function loadJob(jobId: string, tx?: Tx) {
  return jobsRepo.getById(jobId, tx);
}

/** The request as stored and hashed: parsed with every default, so equal intents hash equally. */
const normalised = (request: z.input<typeof GenerationRequest>) => GenerationRequest.parse(request);
/**
 * The idempotency key of a start: the request with every default, the brand version it is designed against and who
 * asked. `round` tells apart later jobs with the same inputs once an earlier one has finished (the unique key is
 * per document, base revision and hash): only a live job of the same person is reused.
 */
const inputsHashOf = (
  request: z.infer<typeof GenerationRequest>,
  brandVersionId: string,
  requester: string,
  round: number,
) => hashCanonical({ request, brandVersionId, requester, ...(round ? { round } : {}) });
/** How many finished jobs with the same inputs a document and base revision can accumulate before starts refuse. */
const MAX_ROUNDS = 50;

const estimateOf = (request: z.infer<typeof GenerationRequest>, emptyImageSlots: number) => {
  const variations = request.kind === 'generate' ? request.brief.variations : 1;
  const images =
    request.kind === 'generate' && request.brief.generateImages ? emptyImageSlots * variations : 0;
  const modelMicros = pricing.modelCallMicros * Math.max(1, Math.ceil(variations / 2));
  return {
    modelCalls: 1,
    modelMicros,
    images,
    imageUnitMicros: pricing.imageMicros,
    totalMicros: modelMicros + images * pricing.imageMicros,
  };
};

async function remainingBudget(brandId: string, tx?: Tx): Promise<number | null> {
  try {
    const s = await budgets.summary(brandId, tx);
    return Math.min(s.month.remainingMicros, s.day.remainingMicros);
  } catch {
    return null; // shown as unknown; reserving at start is the authority
  }
}

/** Every revision after the first is the generator's: nothing a person did would be replaced. */
async function isFresh(doc: CreativeDocumentRow, tx?: Tx): Promise<boolean> {
  const page = await engine.revisionsRepo.list(doc.brandId, doc.id, { limit: 100 }, tx);
  return page.items.every((r) => r.number === 1 || (r.authorKind === 'agent' && r.generationInputs !== null));
}

/**
 * Everything a request is checked and generated against: the base document, the brand snapshot it is designed
 * against, the structural operations the request implies and the working document after them, the slots of the
 * pages to fill, the eligible assets (minus excluded ones), the destination channels' capabilities and the cost.
 */
async function prepare(
  actor: ResolvedActor,
  doc: CreativeDocumentRow,
  baseRevisionId: string,
  request: z.infer<typeof GenerationRequest>,
  tx?: Tx,
  fixedStructure?: z.infer<typeof StoredModelOutput>['structure'],
) {
  engine.assertGraphic(doc); // STU-2b: generation edits pages; a video document is refused before its snapshot is read
  const base = await engine.loadRevision(doc, baseRevisionId, tx);
  const document = CreativeDocumentV1.parse(base.snapshot);
  const snapshot: BrandSnapshot = await engine.resolveSnapshot(
    actor,
    doc.brandId,
    document.brandVersionId,
    tx,
  );
  const brief = request.kind === 'generate' ? request.brief : null;
  const layoutTemplate =
    brief?.layout.kind === 'template'
      ? await engine.templateVersionOf(
          doc.brandId,
          brief.layout.templateVersionId,
          { approvedOnly: true, formatKey: document.pages[0]?.formatKey },
          tx,
        )
      : null;
  const ownTemplate = document.templateVersionId
    ? await engine.templateVersionOf(doc.brandId, document.templateVersionId, { approvedOnly: false }, tx)
    : null;
  const structure = fixedStructure
    ? {
        operations: fixedStructure.operations,
        labels: fixedStructure.labels,
        targetPageIds: fixedStructure.targetPageIds,
        createdPageIds: fixedStructure.createdPageIds,
      }
    : structureFor(document, request, {
        ...(layoutTemplate ? { template: layoutTemplate } : {}),
        newId: newElementId,
      });
  const templates: Record<string, TemplateDocument> = layoutTemplate
    ? { [layoutTemplate.templateVersionId]: layoutTemplate }
    : {};
  let working = document;
  let structureError: string | null = null;
  try {
    working = structure.operations.length
      ? applyBatch(document, { operations: structure.operations }, { templates })
      : document;
  } catch (err) {
    structureError = err instanceof Error ? err.message : String(err);
  }
  const scope: GenerationScope | null = request.kind === 'refine' ? request.refine.scope : null;
  const createdPageIds = new Set(structure.createdPageIds);
  const templateSlots = layoutTemplate?.slots ?? ownTemplate?.slots;
  const slots: GenerationSlot[] = working.pages
    .filter((p) => structure.targetPageIds.includes(p.id))
    .flatMap((p) =>
      generationSlots(working, p, {
        ...(templateSlots ? { templateSlots } : {}),
        scope: scope && !createdPageIds.has(p.id) ? scope : null,
        createdPageIds,
      }),
    );
  const excluded = new Set(brief?.assets.exclude ?? []);
  // STU-2b: the creative purpose also covers video and audio; generation fills image areas, so it offers stills only.
  const eligible = (await assetSource(doc.brandId, tx)).filter(
    (a) => IMAGE_CREATIVE_KINDS.includes(a.kind as AssetKind) && !excluded.has(a.assetVersionId),
  );
  const channels = channelSource();
  const images = await imageAvailability(doc.brandId, tx);
  const estimate = estimateOf(request, slots.filter((s) => s.kind === 'image_area' && !s.fixed).length);
  return {
    base,
    document,
    working,
    snapshot,
    structure,
    structureError,
    templates,
    scope,
    slots,
    eligible,
    channels,
    images,
    estimate,
    templateVersionId: layoutTemplate?.templateVersionId ?? document.templateVersionId ?? null,
    layoutTemplateResolved: brief?.layout.kind !== 'template' || layoutTemplate !== null,
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

/** The preflight answer: material inputs, constraints, issues and cost (also what start checks). */
async function preflightOf(
  actor: ResolvedActor,
  doc: CreativeDocumentRow,
  prepared: Prepared,
  request: z.infer<typeof GenerationRequest>,
  tx?: Tx,
) {
  // A demo workspace calls no model: its preflight says so instead of showing a (zero) budget figure.
  const demo = await isDemoTenant(tx);
  const remainingMicros = demo ? null : await remainingBudget(doc.brandId, tx);
  const checked = preflightGeneration({
    document: prepared.document,
    working: prepared.working,
    request,
    snapshot: prepared.snapshot,
    slots: prepared.slots,
    targetPageIds: prepared.structure.targetPageIds,
    eligibleAssets: prepared.eligible,
    channels: prepared.channels.filter((c) =>
      request.kind === 'generate' ? request.brief.channelKeys.includes(c.key) : false,
    ),
    knownChannelKeys: new Set(prepared.channels.map((c) => c.key)),
    imageGeneration: prepared.images,
    templateResolved: prepared.layoutTemplateResolved,
    costMicros: prepared.estimate.totalMicros,
    remainingMicros,
  });
  const issues = [...(demo ? [DEMO_GENERATION_ISSUE] : []), ...checked.issues];
  if (prepared.structureError)
    issues.push({
      code: 'structure_not_possible',
      severity: 'blocking',
      message: `The layout change cannot be made on this document (${prepared.structureError}).`,
    });
  const cost: GenerationCostEstimate = { ...prepared.estimate, remainingMicros };
  const brief = request.kind === 'generate' ? request.brief : null;
  const contentType = brief?.contentType ?? prepared.document.contentType;
  const copyType = copyContentTypeFor(contentType);
  const copyTemplates = copyType
    ? matchingCopyTemplates(prepared.snapshot.document.copyTemplates ?? [], {
        contentType: copyType,
        ...(brief?.channelKeys[0] ? { channelKey: brief.channelKeys[0] } : {}),
      })
    : [];
  const facts = new Map(prepared.snapshot.facts.map((f) => [f.id, f]));
  const factIds = request.kind === 'generate' ? request.brief.factIds : request.refine.factIds;
  return {
    blocking: issues.some((i) => i.severity === 'blocking'),
    issues,
    constraints: checked.constraints,
    cost,
    inputs: {
      brandVersionId: prepared.snapshot.brandVersionId,
      brandVersionNumber: prepared.snapshot.brandVersionNumber,
      contentType: contentType ?? null,
      templateVersionId: prepared.templateVersionId,
      pages: prepared.working.pages
        .filter((p) => prepared.structure.targetPageIds.includes(p.id))
        .map((p) => ({
          pageId: p.id,
          name: p.name,
          formatKey: p.formatKey,
          width: p.width,
          height: p.height,
        })),
      structure: prepared.structure.labels,
      slots: prepared.slots.map((s) => ({
        pageId: s.pageId,
        elementId: s.elementId,
        key: s.key,
        kind: s.kind,
        name: s.name,
        role: s.role ?? null,
        maxLength: s.maxLength ?? null,
        required: s.required,
        fixed: s.fixed ?? null,
      })),
      facts: factIds.map((id) => ({
        id,
        statement: facts.get(id)?.statement ?? null,
        effective: facts.has(id),
      })),
      copyTemplates: copyTemplates.map((t) => ({ key: t.key, name: t.name })),
      eligibleAssetCount: prepared.eligible.length,
      emptyImageSlots: checked.emptyImageSlots,
      imageGeneration: prepared.images,
      variations: brief?.variations ?? 1,
      fresh: await isFresh(doc, tx),
    },
  };
}

// ---- the service (router-facing) -----------------------------------------------------------------------------

export const generationService = {
  /** STU-1b preflight: nothing is written; creative.edit on the document (it is the check of a change to it). */
  async preflight(actor: ResolvedActor, input: z.input<typeof GenerationPreflight>, tx?: Tx) {
    const parsed = GenerationPreflight.parse(input);
    const doc = await engine.documentsRepo.getById(parsed.documentId, tx);
    await policy.assert(actor, 'creative.edit', engine.documentResource(doc), {}, tx);
    if (doc.currentRevisionId !== parsed.baseRevisionId)
      throw new StaleRevisionError(doc.currentRevisionId ?? '');
    const request = normalised(parsed.request);
    const prepared = await prepare(actor, doc, parsed.baseRevisionId, request, tx);
    return preflightOf(actor, doc, prepared, request, tx);
  },

  /**
   * Starts a job (idempotent per document, base revision and inputs hash: the same intent returns the same job).
   * The preflight runs again and blocking issues refuse the start; the outbox starts studioGenerationWorkflowV1.
   * creative.edit on the document and agent.start_run on the brand (generation spends the brand's budget).
   */
  async start(actor: ResolvedActor, input: z.input<typeof GenerationStart>, tx: Tx) {
    const parsed = GenerationStart.parse(input);
    await assertTenantCapability('ai_generation', tx);
    const doc = await engine.documentsRepo.lock(parsed.documentId, tx);
    await policy.assert(actor, 'creative.edit', engine.documentResource(doc), {}, tx);
    await policy.assert(actor, 'agent.start_run', engine.brandResource(doc.brandId), {}, tx);
    const request = normalised(parsed.request);
    const base = await engine.loadRevision(doc, parsed.baseRevisionId, tx);
    let inputsHash = '';
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS)
        throw new ValidationFailedError([{ path: 'request', issue: 'too_many_repeats' }]);
      inputsHash = inputsHashOf(request, base.brandVersionId, actor.id, round);
      const existing = await jobsRepo.findByInputs(doc.id, parsed.baseRevisionId, inputsHash, tx);
      if (!existing) break;
      if (LIVE.has(existing.state)) return toJobDto(existing); // the same person's live job: a replayed start
    }
    if (doc.currentRevisionId !== parsed.baseRevisionId)
      throw new StaleRevisionError(doc.currentRevisionId ?? '');
    const prepared = await prepare(actor, doc, parsed.baseRevisionId, request, tx);
    const checked = await preflightOf(actor, doc, prepared, request, tx);
    if (checked.blocking)
      throw new ValidationFailedError(
        checked.issues
          .filter((i) => i.severity === 'blocking')
          .map((i) => ({ path: i.ref ? `request.${i.ref}` : 'request', issue: `${i.code}: ${i.message}` })),
        'The generation cannot start',
      );
    const id = newId('studioGenerationJob');
    await jobsRepo.create(
      {
        id,
        brandId: doc.brandId,
        documentId: doc.id,
        baseRevisionId: parsed.baseRevisionId,
        kind: request.kind,
        state: 'queued',
        progress: GENERATION_PROGRESS.queued,
        request,
        inputsHash,
        attempt: 1,
        costReservedMicros: checked.cost.totalMicros, // the estimate until the worker reserves it
        costSpentMicros: 0,
        requestedByKind: engine.requesterKindOf(actor),
        requestedById: actor.id,
      },
      tx,
    );
    await audit.record(
      engine.actorRef(actor),
      'creative.generation.start',
      { type: 'studio_generation_job', id },
      'allowed',
      tx,
      {
        brandId: doc.brandId,
        documentId: doc.id,
        baseRevisionId: parsed.baseRevisionId,
        kind: request.kind,
        inputsHash,
        estimateMicros: checked.cost.totalMicros,
      },
    );
    await outbox.add(
      'creative.generation_requested',
      { type: 'studio_generation_job', id, version: 0 },
      { jobId: id, attempt: 1, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: doc.brandId },
    );
    return toJobDto(await jobsRepo.getById(id, tx));
  },

  async get(actor: ResolvedActor, input: z.input<typeof GenerationGet>, tx?: Tx) {
    const parsed = GenerationGet.parse(input);
    const job = await loadJob(parsed.jobId, tx);
    await policy.assert(actor, 'creative.read', jobResource(job), {}, tx);
    return toJobDto(job);
  },

  /** The jobs of a document a person comes back to: every live one and the most recent finished one. */
  async active(actor: ResolvedActor, input: z.input<typeof GenerationActive>, tx?: Tx) {
    const parsed = GenerationActive.parse(input);
    const doc = await engine.documentsRepo.getById(parsed.documentId, tx);
    await policy.assert(actor, 'creative.read', engine.documentResource(doc), {}, tx);
    const recent = await jobsRepo.recentForDocument(doc.brandId, doc.id, 20, tx);
    const live = recent.filter((j) => LIVE.has(j.state));
    const last = recent.find((j) => !LIVE.has(j.state)) ?? null;
    return { items: live.map(toJobDto), last: last ? toJobDto(last) : null };
  },

  /**
   * Cancel: the row moves at once (no revision is written after this commits: the save locks the row and stops on a
   * cancelled job), the attempt's reservation is released and the workflow is signalled through the outbox. A job
   * that is already saving cannot be cancelled: it finishes and its result can be undone.
   */
  async cancel(actor: ResolvedActor, input: z.input<typeof GenerationCancel>, tx: Tx) {
    const parsed = GenerationCancel.parse(input);
    const job = await jobsRepo.lock(parsed.jobId, tx);
    await policy.assert(actor, 'creative.edit', jobResource(job), {}, tx);
    if (job.state === 'cancelled') return toJobDto(job); // a replayed cancel
    const toState = move(job.state, 'cancel');
    await jobsRepo.update(
      job.id,
      job.version,
      { state: toState, progress: GENERATION_PROGRESS.cancelled, finishedAt: new Date() },
      tx,
    );
    if (job.budgetRunId) await budgets.release(job.budgetRunId, tx);
    await audit.record(
      engine.actorRef(actor),
      'creative.generation.cancel',
      { type: 'studio_generation_job', id: job.id },
      'allowed',
      tx,
      {
        brandId: job.brandId,
        documentId: job.documentId,
        fromState: job.state,
        toState,
      },
    );
    await outbox.add(
      'creative.generation_cancel_requested',
      { type: 'studio_generation_job', id: job.id, version: job.version + 1 },
      { jobId: job.id, attempt: job.attempt },
      tx,
      { brandId: job.brandId },
    );
    return toJobDto(await jobsRepo.getById(job.id, tx));
  },

  /**
   * Retry a failed or cancelled job as a new attempt from the same base revision (refused when the document moved
   * on: start a new generation from the current revision instead). Same permissions as start.
   */
  async retry(actor: ResolvedActor, input: z.input<typeof GenerationRetry>, tx: Tx) {
    const parsed = GenerationRetry.parse(input);
    await assertTenantCapability('ai_generation', tx);
    const job = await jobsRepo.lock(parsed.jobId, tx);
    await policy.assert(actor, 'creative.edit', jobResource(job), {}, tx);
    await policy.assert(actor, 'agent.start_run', engine.brandResource(job.brandId), {}, tx);
    if (LIVE.has(job.state)) return toJobDto(job); // a replayed retry: the new attempt is already under way
    const toState = move(job.state, 'retry');
    const doc = await engine.documentsRepo.getById(job.documentId, tx);
    if (doc.currentRevisionId !== job.baseRevisionId)
      throw new ValidationFailedError(
        [{ path: 'jobId', issue: 'stale_document' }],
        'The document changed since this generation was asked for; start a new one from the current revision',
      );
    const attempt = job.attempt + 1;
    // The finished attempt keeps nothing reserved (its own settle is idempotent and keyed to that attempt only).
    if (job.budgetRunId) await budgets.release(job.budgetRunId, tx);
    await jobsRepo.update(
      job.id,
      parsed.expectedVersion, // optimistic: a retry decided on an outdated view is a conflict
      {
        state: toState,
        progress: GENERATION_PROGRESS.queued,
        attempt,
        budgetRunId: null,
        budgetReservationId: null,
        modelOutput: null,
        result: null,
        errorCode: null,
        error: null,
        finishedAt: null,
      },
      tx,
    );
    await audit.record(
      engine.actorRef(actor),
      'creative.generation.retry',
      { type: 'studio_generation_job', id: job.id },
      'allowed',
      tx,
      {
        brandId: job.brandId,
        documentId: job.documentId,
        attempt,
      },
    );
    await outbox.add(
      'creative.generation_requested',
      { type: 'studio_generation_job', id: job.id, version: job.version + 1 },
      { jobId: job.id, attempt, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: job.brandId },
    );
    return toJobDto(await jobsRepo.getById(job.id, tx));
  },
};

// ---- the runtime surface (studioGenerationWorkflowV1 activities, via the agents module) -----------------------

/** What the model is shown and may answer about; built by `modelContext`, rendered by the agents module. */
export interface GenerationModelContext {
  jobId: string;
  attempt: number;
  brandId: string;
  request: z.infer<typeof GenerationRequest>;
  snapshot: BrandSnapshot;
  working: CreativeDocumentV1;
  structure: Prepared['structure'];
  slots: GenerationSlot[];
  eligible: GenerationAsset[];
  scope: GenerationScope | null;
  variations: number;
  contentType: string | null;
  channelKey: string | null;
  copyTemplateKey: string | null;
  estimateMicros: number;
}

/** The attempt the activity belongs to, or why it should stop (a newer attempt, a cancel, a finished job). */
function outcomeFor(job: JobRow, attempt: number): GenerationStepOutcomeV1 {
  if (job.attempt !== attempt) return { proceed: false, reason: 'finished' };
  if (job.state === 'cancelled') return { proceed: false, reason: 'cancelled' };
  if (job.state === 'completed' || job.state === 'failed') return { proceed: false, reason: 'finished' };
  return { proceed: true };
}

async function loadForInput(input: StudioGenerationInputV1, tx?: Tx) {
  const job = await loadJob(input.jobId, tx);
  if (job.tenantId !== input.tenantId) throw new NotFoundError('StudioGenerationJob', input.jobId);
  return job;
}

async function advance(job: JobRow, event: GenerationJobEvent, tx: Tx, extra: Partial<JobRow> = {}) {
  const toState = move(job.state, event);
  await jobsRepo.update(
    job.id,
    job.version,
    { state: toState, progress: GENERATION_PROGRESS[toState], ...extra },
    tx,
  );
  return toState;
}

/** Up to the budget: drop the operations of edits whose elements carry blocking findings, then judge once more. */
function blockingElementIds(findings: Finding[]): Set<string> {
  return new Set(
    findings.filter((f) => f.severity === 'blocking' && f.elementId).map((f) => f.elementId as string),
  );
}

export const generationJobs = {
  async begin(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1> {
    return withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      const outcome = outcomeFor(job, input.attempt);
      if (!outcome.proceed) return outcome;
      if (job.state === 'queued') {
        await advance(job, 'start', tx);
        await audit.record(
          SYSTEM,
          'creative.generation.begin',
          { type: 'studio_generation_job', id: job.id },
          'allowed',
          tx,
          {
            brandId: job.brandId,
            attempt: job.attempt,
          },
        );
      }
      return { proceed: true };
    });
  },

  /** The attempt's reservation (once): the estimate is reserved before any model or image call. */
  async reserve(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1> {
    const job = await loadForInput(input);
    const outcome = outcomeFor(job, input.attempt);
    const budgetRunId = budgetRunIdFor(job.id, input.attempt);
    if (!outcome.proceed || job.budgetRunId === budgetRunId) return outcome;
    const estimate = Math.max(job.costReservedMicros, pricing.modelCallMicros); // the start's estimate
    const reservation = await budgets.reserveSpend(
      job.brandId,
      budgetRunId,
      estimate,
      new Date(Date.now() + 30 * 60_000),
    ); // atomic; throws BudgetExhausted
    return withTransaction(async (tx) => {
      const fresh = await jobsRepo.lock(job.id, tx);
      const now = outcomeFor(fresh, input.attempt);
      if (!now.proceed) {
        await budgets.release(budgetRunId, tx);
        return now;
      }
      await jobsRepo.update(
        fresh.id,
        fresh.version,
        { budgetRunId, budgetReservationId: reservation.id, costReservedMicros: reservation.reservedMicros },
        tx,
      );
      return { proceed: true } as const;
    });
  },

  /** What the model call needs; null when the attempt already has its output or should stop. */
  async modelContext(
    actor: ResolvedActor,
    input: StudioGenerationInputV1,
  ): Promise<GenerationModelContext | null> {
    const job = await loadForInput(input);
    if (!outcomeFor(job, input.attempt).proceed || job.modelOutput) return null;
    if (job.budgetRunId !== budgetRunIdFor(job.id, input.attempt))
      throw new BudgetExhaustedError('no_reservation');
    const doc = await engine.documentsRepo.getById(job.documentId);
    await policy.assert(actor, 'creative.edit', engine.documentResource(doc), {}, undefined);
    const request = GenerationRequest.parse(job.request);
    const prepared = await prepare(actor, doc, job.baseRevisionId, request);
    if (prepared.structureError)
      throw new ValidationFailedError([
        { path: 'request', issue: `structure_not_possible: ${prepared.structureError}` },
      ]);
    const brief = request.kind === 'generate' ? request.brief : null;
    const priorities = new Set(brief?.assets.prioritise ?? []);
    const included = new Set([
      ...(brief?.assets.include ?? []),
      ...(request.kind === 'refine' ? request.refine.assetVersionIds : []),
    ]);
    const eligible = [...prepared.eligible].sort(
      (a, b) =>
        Number(priorities.has(b.assetVersionId) || included.has(b.assetVersionId)) -
        Number(priorities.has(a.assetVersionId) || included.has(a.assetVersionId)),
    );
    const contentType = brief?.contentType ?? prepared.document.contentType ?? null;
    return {
      jobId: job.id,
      attempt: job.attempt,
      brandId: job.brandId,
      request,
      snapshot: prepared.snapshot,
      working: prepared.working,
      structure: prepared.structure,
      slots: prepared.slots,
      eligible,
      scope: prepared.scope,
      variations: brief?.variations ?? 1,
      contentType,
      channelKey: brief?.channelKeys[0] ?? null,
      copyTemplateKey: brief?.copyTemplateKey ?? null,
      estimateMicros: prepared.estimate.totalMicros,
    };
  },

  /** The model's validated output, stored before anything is compiled (a retried save never calls the model again). */
  async recordModelOutput(
    input: StudioGenerationInputV1,
    stored: {
      output: z.infer<typeof ModelGenerationOutput>;
      callRef: string;
      structure: Prepared['structure'];
      costMicros: number;
    },
  ): Promise<GenerationStepOutcomeV1> {
    return withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      const outcome = outcomeFor(job, input.attempt);
      if (!outcome.proceed || job.modelOutput) return outcome;
      await advance(job, 'validate', tx, {
        modelOutput: { output: stored.output, callRef: stored.callRef, structure: stored.structure },
        costSpentMicros: job.costSpentMicros + stored.costMicros,
      });
      return { proceed: true };
    });
  },

  /**
   * Spend that does not come with an output (a model call whose answer was refused, or one that finished after the
   * job was cancelled and its reservation released). Only the attempt's own job row is charged.
   */
  async addSpend(input: StudioGenerationInputV1, costMicros: number): Promise<void> {
    await withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      if (job.attempt !== input.attempt) return;
      await jobsRepo.update(job.id, job.version, { costSpentMicros: job.costSpentMicros + costMicros }, tx);
    });
  },

  /** Whether the attempt goes on (a stored model output means the next step is the save). */
  async status(input: StudioGenerationInputV1): Promise<GenerationStepOutcomeV1> {
    return outcomeFor(await loadForInput(input), input.attempt);
  },

  /** The attempt's reservation id, which model and image charges are recorded against (null for another attempt). */
  async reservationIdOf(input: StudioGenerationInputV1): Promise<string | null> {
    const job = await loadForInput(input);
    return job.budgetRunId === budgetRunIdFor(job.id, input.attempt) ? job.budgetReservationId : null;
  },

  /**
   * Compile, guard, validate and write, in one transaction with the job row locked: revisions (a fresh document and
   * each variation copy) or a proposal (a document a person has edited, and every refinement), then the job
   * completes. A cancelled job writes nothing; a moved document fails the job (stale_document).
   */
  async save(actor: ResolvedActor, input: StudioGenerationInputV1) {
    return withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      const outcome = outcomeFor(job, input.attempt);
      if (!outcome.proceed) return { jobId: job.id, state: job.state };
      if (job.state === 'saving' || job.state === 'generating' || !job.modelOutput)
        throw new ValidationFailedError([
          { path: 'state', issue: `job is ${job.state} without a stored output` },
        ]);
      const stored = StoredModelOutput.parse(job.modelOutput);
      const request = GenerationRequest.parse(job.request);
      const doc = await engine.documentsRepo.lock(job.documentId, tx);
      await policy.assert(actor, 'creative.edit', engine.documentResource(doc), {}, tx);
      if (doc.currentRevisionId !== job.baseRevisionId)
        throw new ValidationFailedError(
          [{ path: 'baseRevisionId', issue: 'stale_document' }],
          'The document changed while the generation ran; nothing was saved',
        );
      await advance(job, 'save', tx);
      const prepared = await prepare(actor, doc, job.baseRevisionId, request, tx, stored.structure);
      const fresh = request.kind === 'generate' && (await isFresh(doc, tx));
      const refused: RefusedEdit[] = [];
      const revisions: Array<{ documentId: string; revisionId: string; variation: number }> = [];
      let proposal: z.infer<typeof GenerationProposal> | null = null;
      let findings: Finding[] = [];
      const fills = stored.output.variations.slice(
        0,
        request.kind === 'generate' ? request.brief.variations : 1,
      );
      for (const [variation, fill] of fills.entries()) {
        const compiled = compileFill(prepared.working, fill, {
          variation,
          targetPageIds: prepared.structure.targetPageIds,
          scope: prepared.scope,
          createdPageIds: new Set(prepared.structure.createdPageIds),
          slots: prepared.slots,
          eligibleAssetIds: new Set(prepared.eligible.map((a) => a.assetVersionId)),
          paletteTokens: new Set(prepared.snapshot.document.tokens.colours.map((c) => c.key)),
          effectiveFactIds: new Set(prepared.snapshot.facts.map((f) => f.id)),
          newId: newElementId,
          // A batch (and a proposal) holds at most MAX_BATCH_OPERATIONS operations, the requested ones included.
          maxOperations: MAX_BATCH_OPERATIONS - prepared.structure.operations.length,
        });
        refused.push(...compiled.refused);
        let operations = [...prepared.structure.operations, ...compiled.operations];
        let labels = [...prepared.structure.labels, ...compiled.labels];
        if (compiled.operations.length === 0) continue;
        const summary = `Generated: ${fill.summary}`.slice(0, 500);
        const inputs: GenerationInputs = {
          documentKind: 'graphic',
          jobId: job.id,
          kind: request.kind,
          request,
          inputsHash: job.inputsHash,
          templateVersionId: prepared.templateVersionId,
          brandVersionId: prepared.snapshot.brandVersionId,
          scope: prepared.scope,
          assetVersionIds: compiled.assetVersionIds,
          factIds: compiled.factIds,
          modelCallRefs: [stored.callRef],
          // One model call serves every variation: each revision records its share.
          costMicros: Math.ceil(job.costSpentMicros / fills.length),
          variation,
        };
        // The structural operations are the person's request (checked as theirs); the fill is the model's.
        const structural = prepared.structure.operations.length;
        // Brand validation: an edit whose element is blocked (contrast, prohibited phrase, safe area...) is refused.
        const evaluate = async (ops: Operation[], d: CreativeDocumentRow) => {
          const base = await engine.loadRevision(d, d.currentRevisionId ?? '', tx);
          const batch: OperationBatch = {
            baseRevisionId: base.id,
            operations: ops,
            summary,
            origin: 'agent',
          };
          return {
            base,
            batch,
            evaluated: await engine.evaluateBatch(actor, d, base, batch, tx, {
              scope: prepared.scope,
              requestedOperations: structural,
            }),
          };
        };
        let first = await evaluate(operations, doc);
        const blocked = blockingElementIds(first.evaluated.findings);
        if (blocked.size) {
          const keep = operations.map(
            (op, i) => i < structural || !('elementId' in op && blocked.has(op.elementId)),
          );
          for (const [i, op] of operations.entries())
            if (!keep[i] && 'elementId' in op)
              refused.push({
                variation,
                pageId: op.pageId,
                elementId: op.elementId,
                reason: `brand_validation:${first.evaluated.findings.find((f) => f.elementId === op.elementId && f.severity === 'blocking')?.code ?? 'blocking'}`,
              });
          operations = operations.filter((_, i) => keep[i]);
          labels = labels.filter((_, i) => keep[i]);
          if (operations.length <= structural) continue;
          first = await evaluate(operations, doc);
        }
        findings = [...findings, ...first.evaluated.findings];
        const asProposal = request.kind === 'refine' || (variation === 0 && !fresh);
        if (asProposal && variation === 0) {
          proposal = {
            documentId: doc.id,
            baseRevisionId: first.base.id,
            operations,
            summary,
            groups: groupOperations(operations, labels),
            findings: first.evaluated.findings,
            contentHash: first.evaluated.contentHash,
            scope: prepared.scope,
            requestedOperations: structural,
            inputs,
          };
          continue;
        }
        if (first.evaluated.findings.some(engine.isBlocking))
          throw new ValidationFailedError(
            first.evaluated.findings.filter(engine.isBlocking).map(engine.findingDetail),
            'The generated document has blocking findings',
          );
        let into = doc;
        if (variation > 0) {
          // A copy of the job's base revision at the job's brand version: the first variation's edits are not in it.
          const copy = await engine.duplicateRevision(
            actor,
            doc,
            prepared.base,
            `${doc.title} – variation ${variation + 1}`,
            job.id,
            tx,
          );
          into = await engine.documentsRepo.lock(copy.documentId, tx);
          first = await evaluate(operations, into);
          if (first.evaluated.findings.some(engine.isBlocking))
            throw new ValidationFailedError(
              first.evaluated.findings.filter(engine.isBlocking).map(engine.findingDetail),
              'The generated variation has blocking findings',
            );
        }
        const base = await engine.loadRevision(into, into.currentRevisionId ?? '', tx);
        const committed = await engine.commitRevision(
          actor,
          into,
          base,
          { ...first.batch, baseRevisionId: base.id },
          first.evaluated,
          tx,
          inputs,
        );
        revisions.push({ documentId: into.id, revisionId: committed.revision.id, variation });
      }
      if (revisions.length === 0 && !proposal)
        throw new ValidationFailedError(
          [
            {
              path: 'output',
              issue: `nothing_usable: ${
                refused
                  .map((r) => r.reason)
                  .slice(0, 5)
                  .join(', ') || 'no edits'
              }`,
            },
          ],
          'The generated changes could not be used',
        );
      // Parsed before it is written: what get and active read back always matches the contract.
      const result = GenerationResult.parse({ revisions, proposal, refused, findings });
      const fresher = await jobsRepo.lock(job.id, tx);
      await advance(fresher, 'complete', tx, { result, finishedAt: new Date() });
      await audit.record(
        engine.actorRef(actor),
        'creative.generation.complete',
        { type: 'studio_generation_job', id: job.id },
        'allowed',
        tx,
        {
          brandId: job.brandId,
          documentId: job.documentId,
          revisions: revisions.map((r) => r.revisionId),
          proposal: proposal !== null,
          refused: refused.length,
        },
      );
      await outbox.add(
        'creative.generation_completed',
        { type: 'studio_generation_job', id: job.id, version: fresher.version + 1 },
        {
          jobId: job.id,
          documentId: job.documentId,
          revisionIds: revisions.map((r) => r.revisionId).join(','),
        },
        tx,
        { brandId: job.brandId },
      );
      return { jobId: job.id, state: 'completed' as const };
    });
  },

  /** The attempt's terminal failure (tolerant of a job that is already finished or belongs to a newer attempt). */
  async fail(input: StudioGenerationInputV1, code: GenerationErrorCode, detail?: string) {
    return withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      if (!outcomeFor(job, input.attempt).proceed) return { jobId: job.id, state: job.state };
      const toState = await advance(job, 'fail', tx, {
        errorCode: code,
        error: (detail ?? code).slice(0, 500),
        finishedAt: new Date(),
      });
      await audit.record(
        SYSTEM,
        'creative.generation.fail',
        { type: 'studio_generation_job', id: job.id },
        'allowed',
        tx,
        {
          brandId: job.brandId,
          documentId: job.documentId,
          code,
        },
      );
      return { jobId: job.id, state: toState };
    });
  },

  /** Releases what the attempt reserved and did not spend (idempotent). */
  async settle(input: StudioGenerationInputV1): Promise<void> {
    await loadForInput(input); // tenant binding
    await budgets.settle(budgetRunIdFor(input.jobId, input.attempt)); // this attempt's reservation only; idempotent
  },
};

/** Maps a thrown domain error to the code a failed job records. */
export function generationErrorCode(err: unknown): GenerationErrorCode {
  if (err instanceof BudgetExhaustedError) return 'budget_exhausted';
  if (err instanceof OremediaError) {
    if (err.code === 'FORBIDDEN') return 'policy_denied';
    if (err.code === 'NOT_FOUND') return 'not_found';
    if (err.code === 'VALIDATION_FAILED') return 'validation_failed';
  }
  return 'failed';
}
