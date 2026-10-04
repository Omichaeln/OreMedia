import type { z } from 'zod';
import type { BrandSnapshot, BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { Finding } from '@oremedia/contracts/creative';
import {
  BudgetExhaustedError,
  NotFoundError,
  OremediaError,
  StaleRevisionError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  type VideoMediaInfo,
  type VideoOperationBatch,
  type VideoProjectV1,
  type VideoTemplateSummary,
} from '@oremedia/contracts/video';
import {
  ModelRecutOutput,
  ModelStoryboardOutput,
  VIDEO_AI_PROGRESS,
  VideoAiAccept,
  VideoAiActive,
  VideoAiAssemble,
  VideoAiCancel,
  VideoAiGet,
  VideoAiPreflight,
  VideoAiRequest,
  VideoAiResult,
  VideoAiRetry,
  VideoAiSaveDraft,
  VideoAiStart,
  type GapAlternative,
  type RecutRequest,
  type GapKind,
  type Storyboard,
  type StudioVideoJobInputV1,
  type VideoAiErrorCode,
  type VideoAiIssue,
  type VideoAiJobState,
  type VideoAiScope,
  type VideoConflict,
  type VideoGenerationInputs,
  type VideoJobStepOutcomeV1,
  type VideoProposal,
} from '@oremedia/contracts/video-ai';
import { withTransaction, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import { videoAiJobMachine, type VideoAiJobEvent } from '@oremedia/domain/state-machines/video-ai-job';
import { looksLikeClaim, prohibitedPhrasesIn } from '@oremedia/editor/validate';
import {
  brandCtaCopy,
  checkModelStoryboard,
  compileAssembly,
  compileRecut,
  isEmptyProject,
  listVideoTemplates,
  storyboardProblems,
  validateVideoProject,
  videoScopeOf,
  videoTimelineDiff,
  SHOT_KINDS,
  type StoryboardAsset,
} from '@oremedia/editor/video/index';
import { policy } from '@oremedia/module-access';
import { budgets } from '@oremedia/module-billing';
import { audit, outbox } from '@oremedia/module-operations';
import { StudioVideoJobRepository } from './repositories';
import { creativeEngine as engine, type CreativeDocumentRow } from './service';
import {
  brandBindings,
  mediaLookup,
  parseSnapshot,
  projectAssetRefs,
  timedAssetIds,
  waveformLookup,
} from './video-support';

/**
 * STU-3: the studio video AI service (preflight, start, get, active, cancel, retry, assemble, accept) and the
 * runtime surface the agents worker drives (studioVideoJobWorkflowV1). The model call itself lives in the agents
 * module (it holds the model adapter); everything that reads or writes creative state is here, through the same
 * engine as every other change: the storyboard and recut compilers produce timeline operations, which are evaluated
 * by evaluateVideoBatch (guards with the request's scope, asset authorisation, reducer, validation) and committed by
 * commitVideoRevision with the job's generation inputs.
 */

const jobsRepo = new StudioVideoJobRepository();
type JobRow = Awaited<ReturnType<typeof jobsRepo.getById>>;

// ---- cross-module hooks (registered by the composition roots, as registerAssetAuthoriser) ---------------------

/** Assets a storyboard may use: person-supplied, approved, with recorded rights, eligible for creative use now. */
export type VideoAiAssetSource = (brandId: string, tx?: Tx) => Promise<StoryboardAsset[]>;
const unregisteredAssets: VideoAiAssetSource = async () => {
  throw new Error(
    'video AI asset source not registered (composition root must call registerVideoAiAssetSource)',
  );
};
let assetSource: VideoAiAssetSource = unregisteredAssets;
export const registerVideoAiAssetSource = (fn: VideoAiAssetSource): void => {
  assetSource = fn;
};
export const resetVideoAiAssetSource = (): void => {
  assetSource = unregisteredAssets;
};

/** Whether generated media can close a gap for this brand: the feature, the provider, and its price. */
export interface VideoAiCapabilities {
  videoGeneration: { available: boolean; reason?: string; costMicrosPerSecond?: number };
  speechGeneration: { available: boolean; reason?: string; costMicros?: number };
}
export type VideoAiCapabilitySource = (tenantId: string, tx?: Tx) => Promise<VideoAiCapabilities>;
const NOT_CONFIGURED: VideoAiCapabilitySource = async () => ({
  videoGeneration: { available: false, reason: 'Video generation is not configured for this deployment' },
  speechGeneration: { available: false, reason: 'Speech generation is not configured for this deployment' },
});
let capabilitySource: VideoAiCapabilitySource = NOT_CONFIGURED;
export const registerVideoAiCapabilitySource = (fn: VideoAiCapabilitySource | null): void => {
  capabilitySource = fn ?? NOT_CONFIGURED;
};

/** Price list for the estimate (micro-units): the composition root sets it from the model configuration. */
export interface VideoAiPricing {
  modelCallMicros: number;
}
const DEFAULT_PRICING: VideoAiPricing = { modelCallMicros: 170_000 };
let pricing: VideoAiPricing = DEFAULT_PRICING;
export const configureVideoAiPricing = (p: Partial<VideoAiPricing>): void => {
  pricing = { ...DEFAULT_PRICING, ...p };
};

// ---- helpers -------------------------------------------------------------------------------------------------

const jobResource = (j: JobRow) => ({
  type: 'creative_document',
  tenantId: j.tenantId,
  brandId: j.brandId,
  id: j.documentId,
});

function move(from: VideoAiJobState, event: VideoAiJobEvent): VideoAiJobState {
  try {
    return videoAiJobMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path: 'state', issue: err.message }],
        `The job is ${from}; this is not possible now`,
      );
    throw err;
  }
}

const SYSTEM = { kind: 'system' as const, id: 'studio_video_job' };
const LIVE: ReadonlySet<VideoAiJobState> = new Set(['queued', 'generating', 'validating', 'saving']);
export const videoJobWorkflowId = (jobId: string, attempt: number): string =>
  `studio-video:${jobId}:${attempt}`;
export const videoJobModelCallRef = (jobId: string, attempt: number): string =>
  `svj:${jobId}:${attempt}:model`;
/** Item ids a job's compiles mint (deterministic, so an accept's recompile yields the proposal's ids). */
const idPrefixOf = (jobId: string) => `ai${jobId.slice(-6).toLowerCase()}_`;
/** Idempotent start while live: the same person's same request on the same revision joins the running job. */
const liveKeyOf = (requesterId: string, baseRevisionId: string, inputsHash: string) =>
  `${requesterId}:${baseRevisionId}:${inputsHash}`;
const TERMINAL: ReadonlySet<VideoAiJobState> = new Set(['completed', 'failed', 'cancelled']);

const parseOutput = (job: JobRow) => {
  if (!job.modelOutput) return null;
  const raw = job.modelOutput as { output: unknown; callRef: string };
  return job.kind === 'storyboard'
    ? { kind: 'storyboard' as const, output: ModelStoryboardOutput.parse(raw.output), callRef: raw.callRef }
    : { kind: 'recut' as const, output: ModelRecutOutput.parse(raw.output), callRef: raw.callRef };
};

function toJobDto(j: JobRow) {
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
    request: VideoAiRequest.parse(j.request),
    costReservedMicros: j.costReservedMicros,
    costSpentMicros: j.costSpentMicros,
    error: j.errorCode ? { code: j.errorCode, message: j.error ?? '' } : null,
    result: j.result ? VideoAiResult.parse(j.result) : null,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    version: j.version,
  };
}
export type VideoAiJobDto = ReturnType<typeof toJobDto>;

/** The request as stored and hashed: parsed with every default, so equal intents hash equally. */
const normalised = (request: z.input<typeof VideoAiRequest>) => VideoAiRequest.parse(request);

async function remainingBudget(brandId: string, tx?: Tx): Promise<number | null> {
  try {
    const s = await budgets.summary(brandId, tx);
    return Math.min(s.month.remainingMicros, s.day.remainingMicros);
  } catch {
    return null; // shown as unknown; reserving at start is the authority
  }
}

/** A generated clip of this length is what a gap's alternative is priced at. */
const GENERATED_CLIP_SECONDS = 5;

/** The supported ways to close a gap, with this brand's availability (never offered silently: the person picks). */
function alternativesFor(
  kind: GapKind,
  caps: VideoAiCapabilities,
  eligible: ReadonlyMap<string, StoryboardAsset>,
  remainingMicros: number | null,
): GapAlternative[] {
  const stills = [...eligible.values()].some((a) => SHOT_KINDS.includes(a.kind) && a.kind !== 'video');
  const withSound = [...eligible.values()].some((a) => a.kind === 'video' && a.hasAudio);
  const priced = (
    gen: { available: boolean; reason?: string },
    cost: number | undefined,
  ): { available: boolean; reason?: string; costMicros?: number } => {
    if (!gen.available) return { available: false, reason: gen.reason ?? 'Not available' };
    if (cost !== undefined && remainingMicros !== null && cost > remainingMicros)
      return { available: false, reason: 'The remaining budget does not cover it', costMicros: cost };
    return { available: true, ...(cost !== undefined ? { costMicros: cost } : {}) };
  };
  switch (kind) {
    case 'footage': {
      const perSecond = caps.videoGeneration.costMicrosPerSecond;
      return [
        {
          kind: 'use_still',
          label: 'Use an approved still for the shot (held on screen; no motion)',
          available: stills,
          ...(stills ? {} : { reason: 'No eligible stills in the library' }),
        },
        {
          kind: 'generated_clip',
          label: `Generate a ${GENERATED_CLIP_SECONDS} s clip (labelled as generated, held for approval)`,
          ...priced(
            caps.videoGeneration,
            perSecond !== undefined ? perSecond * GENERATED_CLIP_SECONDS : undefined,
          ),
        },
        {
          kind: 'ask_for_footage',
          label: 'Ask for footage: upload it to the library with its rights',
          available: true,
        },
      ];
    }
    case 'music':
      return [
        { kind: 'ask_for_footage', label: 'Upload licensed music to the library', available: true },
        {
          kind: 'use_clip_sound',
          label: 'Use the clips’ own sound',
          available: withSound,
          ...(withSound ? {} : { reason: 'No eligible clip has sound' }),
        },
        { kind: 'no_music', label: 'No music', available: true },
      ];
    case 'voiceover':
      return [
        { kind: 'record_voiceover', label: 'Ask for a recording of the script', available: true },
        {
          kind: 'generated_speech',
          label: 'Generate speech from the script (labelled as generated, held for approval)',
          ...priced(caps.speechGeneration, caps.speechGeneration.costMicros),
        },
        {
          kind: 'use_clip_sound',
          label: 'Use the clips’ own sound',
          available: withSound,
          ...(withSound ? {} : { reason: 'No eligible clip has sound' }),
        },
      ];
  }
}

/**
 * Everything a request is checked, generated and compiled against: the base project, the brand snapshot it is
 * designed against and its template bindings, the eligible assets (minus excluded ones) and what is known about every
 * source, the effective facts, the template structure, waveforms for pause detection, capabilities and the budget.
 */
async function prepare(
  actor: ResolvedActor,
  doc: CreativeDocumentRow,
  baseRevisionId: string,
  request: VideoAiRequest,
  tx?: Tx,
) {
  const base = await engine.loadRevision(doc, baseRevisionId, tx);
  const project = parseSnapshot('video', base.snapshot).snapshot as VideoProjectV1;
  const snapshot: BrandSnapshot = await engine.resolveSnapshot(
    actor,
    doc.brandId,
    project.brandVersionId,
    tx,
  );
  const bindings = await brandBindings(snapshot, tx);
  const brief = request.kind === 'storyboard' ? request.brief : null;
  const excluded = new Set(brief?.assets.exclude ?? []);
  const eligible = new Map(
    (await assetSource(doc.brandId, tx))
      .filter((a) => !excluded.has(a.assetVersionId))
      .map((a) => [a.assetVersionId, a] as const),
  );
  const effectiveFactIds = new Set(snapshot.facts.map((f) => f.id));
  const templateKey = brief?.templateKey ?? project.templateKey ?? null;
  const template: VideoTemplateSummary | null = templateKey
    ? (listVideoTemplates().find((t) => t.key === templateKey) ?? null)
    : null;
  const media: Record<string, VideoMediaInfo> = await mediaLookup(
    [...new Set([...timedAssetIds(project), ...eligible.keys()])],
    tx,
  );
  const videoSources = timedAssetIds(project).filter((id) => media[id]?.kind === 'video');
  const waveforms = request.kind === 'recut' ? await waveformLookup(videoSources, tx) : {};
  const caps = await capabilitySource(doc.tenantId, tx);
  const remainingMicros = await remainingBudget(doc.brandId, tx);
  const logoRule = snapshot.document.logoRules.find((r) => r.variant === 'primary');
  return {
    base,
    project,
    snapshot,
    bindings,
    eligible,
    effectiveFactIds,
    template,
    templateKey,
    media,
    waveforms,
    caps,
    remainingMicros,
    logoMinWidthPx: logoRule?.minWidthPx ?? 0,
    estimateMicros: pricing.modelCallMicros,
    prohibitedPhrases: snapshot.document.voice.prohibitedPhrases,
    // Recuts caption from the document's storyboard script and place only an approved call to action.
    script: request.kind === 'recut' ? await scriptOf(doc, project, tx) : [],
    approvedCtas:
      request.kind === 'recut' ? await approvedCtasOf(doc, request.recut, snapshot.document, tx) : [],
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

/**
 * The calls to action a recut may place: the person's ctaText when it passes the copy checks (no prohibited phrase;
 * a claim needs an approved fact in the request), and CTA copy from the brand's guidance for the request's channel
 * (the recut's own, else its storyboard brief's). Without a channel, no brand convention applies.
 */
async function approvedCtasOf(
  doc: CreativeDocumentRow,
  recut: RecutRequest,
  brand: BrandSystemDocumentV1,
  tx?: Tx,
): Promise<string[]> {
  const out = recut.ctaText && ctaTextProblems(recut, brand, null).length === 0 ? [recut.ctaText] : [];
  let channelKey = recut.channelKey ?? null;
  if (!channelKey) {
    const last = await lastStoryboardJob(doc, tx);
    const req = last ? VideoAiRequest.safeParse(last.request) : null;
    channelKey = req?.success && req.data.kind === 'storyboard' ? (req.data.brief.channelKey ?? null) : null;
  }
  const guidance = channelKey ? brand.channelGuidance.find((g) => g.providerKey === channelKey) : undefined;
  const copy = guidance ? brandCtaCopy(guidance.ctaConventions) : null;
  return copy ? [...out, copy] : out;
}

/** Why the person's ctaText may not be placed (the copy checks any on-screen text gets). */
function ctaTextProblems(
  recut: RecutRequest,
  brand: BrandSystemDocumentV1,
  effectiveFactIds: ReadonlySet<string> | null,
): VideoAiIssue[] {
  if (!recut.ctaText) return [];
  const issues: VideoAiIssue[] = [];
  const found = prohibitedPhrasesIn(recut.ctaText, brand.voice.prohibitedPhrases);
  if (found.length)
    issues.push({
      code: 'cta_prohibited_phrase',
      severity: 'blocking',
      message: `The call to action uses a phrase the brand prohibits (${found.join(', ')})`,
      ref: 'ctaText',
    });
  const facts = effectiveFactIds ? recut.factIds.filter((id) => effectiveFactIds.has(id)) : recut.factIds;
  if (looksLikeClaim(recut.ctaText) && facts.length === 0)
    issues.push({
      code: 'cta_claim_without_fact',
      severity: 'blocking',
      message: 'The call to action makes a claim; choose the approved fact it rests on',
      ref: 'ctaText',
    });
  return issues;
}

/** The preflight answer: material inputs, issues and cost (also what start checks). */
function preflightOf(prepared: Prepared, request: VideoAiRequest) {
  const issues: VideoAiIssue[] = [];
  const { project, eligible, effectiveFactIds } = prepared;
  const factIds = request.kind === 'storyboard' ? request.brief.factIds : request.recut.factIds;
  for (const id of factIds)
    if (!effectiveFactIds.has(id))
      issues.push({
        code: 'fact_not_effective',
        severity: 'blocking',
        message: 'A chosen fact is not approved and in force; pick another or ask for it to be approved',
        ref: id,
      });
  const picked = request.kind === 'storyboard' ? request.brief.assets.include : request.recut.assetVersionIds;
  for (const id of picked)
    if (!eligible.has(id))
      issues.push({
        code: 'asset_not_eligible',
        severity: 'blocking',
        message: 'A chosen asset is not approved for creative use with recorded rights',
        ref: id,
      });
  if (request.kind === 'recut')
    issues.push(...ctaTextProblems(request.recut, prepared.snapshot.document, effectiveFactIds));
  const shots = [...eligible.values()].filter((a) => SHOT_KINDS.includes(a.kind));
  if (request.kind === 'storyboard') {
    const brief = request.brief;
    if (brief.formatKey && brief.formatKey !== project.format.key)
      issues.push({
        code: 'format_mismatch',
        severity: 'blocking',
        message: `This video is ${project.format.width}×${project.format.height}; storyboard it in its own format, then make a version in another format from the timeline`,
        ref: 'formatKey',
      });
    if (!shots.some((a) => a.kind === 'video'))
      issues.push({
        code: 'no_footage',
        severity: 'warning',
        message:
          'There is no approved footage with recorded rights; the storyboard will list the shots it needs',
      });
    if (brief.audio === 'music' && ![...eligible.values()].some((a) => a.kind === 'audio'))
      issues.push({
        code: 'no_music',
        severity: 'warning',
        message: 'There is no approved music in the library; the storyboard will list it as a gap',
      });
    if (brief.audio === 'voiceover')
      issues.push({
        code: 'voiceover_needs_recording',
        severity: 'info',
        message: prepared.caps.speechGeneration.available
          ? 'A voice-over needs a recording, or generated speech (offered as an alternative, never used silently)'
          : 'A voice-over needs a recording of the script; generated speech is not available',
      });
    if (brief.captions && !(prepared.bindings.fonts.caption ?? prepared.bindings.fonts.body))
      issues.push({
        code: 'no_caption_font',
        severity: 'warning',
        message: 'The brand system has no caption or body font, so captions cannot be added',
      });
    if (brief.logo && !prepared.bindings.logoAssetVersionId)
      issues.push({
        code: 'no_logo',
        severity: 'warning',
        message: 'The brand system names no primary logo',
      });
  } else {
    const v = project.tracks.find((t) => t.kind === 'video');
    if (!v || v.items.length === 0)
      issues.push({
        code: 'nothing_to_recut',
        severity: 'blocking',
        message: 'The timeline has no clips yet; make a storyboard and assemble it first',
      });
    try {
      videoScopeOf(project, request.recut.scope);
    } catch (err) {
      issues.push({
        code: 'scope_invalid',
        severity: 'blocking',
        message: err instanceof Error ? err.message : 'The scope names something that is not on the timeline',
        ref: 'scope',
      });
    }
  }
  if (prepared.remainingMicros !== null && prepared.estimateMicros > prepared.remainingMicros)
    issues.push({
      code: 'budget_insufficient',
      severity: 'blocking',
      message: 'The remaining generation budget is below what this request would reserve',
    });
  return {
    blocking: issues.some((i) => i.severity === 'blocking'),
    issues,
    cost: { modelCalls: 1, totalMicros: prepared.estimateMicros, remainingMicros: prepared.remainingMicros },
    inputs: {
      brandVersionId: prepared.snapshot.brandVersionId,
      brandVersionNumber: prepared.snapshot.brandVersionNumber,
      formatKey: project.format.key,
      durationMs: project.durationMs,
      templateKey: prepared.templateKey,
      templateScenes: prepared.template?.scenes.map((s) => ({ id: s.id, title: s.title })) ?? [],
      eligible: {
        clips: shots.filter((a) => a.kind === 'video').length,
        stills: shots.filter((a) => a.kind !== 'video').length,
        audio: [...eligible.values()].filter((a) => a.kind === 'audio').length,
      },
      facts: factIds.map((id) => ({
        id,
        statement: prepared.snapshot.facts.find((f) => f.id === id)?.statement ?? null,
        effective: effectiveFactIds.has(id),
      })),
      capabilities: {
        videoGeneration: prepared.caps.videoGeneration.available,
        speechGeneration: prepared.caps.speechGeneration.available,
        transcription: false,
      },
      empty: isEmptyProject(project),
    },
  };
}

async function loadJob(jobId: string, tx?: Tx) {
  return jobsRepo.getById(jobId, tx);
}

const generationInputsOf = (
  job: JobRow,
  prepared: Prepared,
  kind: VideoGenerationInputs['kind'],
  extra: Partial<VideoGenerationInputs> & { assetVersionIds: string[]; factIds: string[] },
): VideoGenerationInputs => {
  const stored = parseOutput(job);
  const request = VideoAiRequest.parse(job.request);
  return {
    documentKind: 'video',
    jobId: job.id,
    kind,
    request,
    inputsHash: job.inputsHash,
    templateVersionId: null,
    brandVersionId: prepared.snapshot.brandVersionId,
    variation: 0,
    templateKey: prepared.templateKey,
    scope: request.kind === 'recut' ? request.recut.scope : null,
    modelCallRefs: stored ? [stored.callRef] : [],
    costMicros: job.costSpentMicros,
    ...extra,
  };
};

/** The facts a job's change may cite: for a recut, those its request names that are in force. */
const citableFactIds = (request: VideoAiRequest, prepared: Prepared): ReadonlySet<string> =>
  request.kind === 'recut'
    ? new Set(request.recut.factIds.filter((id) => prepared.effectiveFactIds.has(id)))
    : prepared.effectiveFactIds;

/** The compile context of a job against a prepared base. */
const compileContext = (job: JobRow, prepared: Prepared, scope: VideoAiScope | null) => ({
  media: prepared.media,
  bindings: prepared.bindings,
  idPrefix: idPrefixOf(job.id),
  waveforms: prepared.waveforms,
  eligibleAssetIds: new Set(
    [...prepared.eligible.values()].filter((a) => SHOT_KINDS.includes(a.kind)).map((a) => a.assetVersionId),
  ),
  // A recut may cite only the facts its request names, and only while they are in force.
  effectiveFactIds: citableFactIds(job.request, prepared),
  scope,
  script: prepared.script,
  approvedCtas: prepared.approvedCtas,
});

const stripGroupOps = <G extends { operations: unknown }>(groups: G[]) =>
  groups.map(({ operations: _o, ...g }) => g);

/** The most operations one revision holds (VideoOperationBatch); a larger change is committed in parts. */
const BATCH_MAX = 100;

/**
 * Parts of at most BATCH_MAX operations that end only on the compile's cut points (whole groups, or whole scenes of
 * the assembly's larger groups), so no revision holds half of a step. A step longer than BATCH_MAX is refused.
 */
export function partsAt(count: number, cutPoints: readonly number[]): Array<[number, number]> {
  const points = [...new Set([...cutPoints.filter((p) => p > 0 && p < count), count])].sort((a, b) => a - b);
  const parts: Array<[number, number]> = [];
  let from = 0;
  while (from < count) {
    const fits = points.filter((p) => p > from && p - from <= BATCH_MAX);
    const to = fits[fits.length - 1];
    if (to === undefined)
      throw new ValidationFailedError(
        [
          {
            path: 'operations',
            issue: `change_too_large: one step needs more than ${BATCH_MAX} timeline operations`,
          },
        ],
        'This change is too large for one step; narrow the request (a scene, fewer clips) and ask again',
      );
    parts.push([from, to]);
    from = to;
  }
  return parts;
}

/**
 * Commits a compiled change as one revision, or (above BATCH_MAX operations) as consecutive revisions split at the
 * compile's cut points, like a large restore: every state between parts is a state the reducer reached at the end of
 * a step, each part is evaluated with the same guards and (growing) scope and records the job's inputs with its part
 * number. Returns the last commit and every revision written, in order, so the studio adopts each as an undo step.
 */
async function commitInParts(
  actor: ResolvedActor,
  doc: CreativeDocumentRow,
  base: Awaited<ReturnType<typeof engine.loadRevision>>,
  batch: VideoOperationBatch,
  evaluated: Awaited<ReturnType<typeof engine.evaluateVideoBatch>>,
  guard: { scope: VideoAiScope | null; brandLogo?: { assetVersionId: string; minWidthPx: number } },
  cutPoints: readonly number[],
  inputs: VideoGenerationInputs,
  tx: Tx,
) {
  if (batch.operations.length <= BATCH_MAX) {
    const committed = await engine.commitVideoRevision(actor, doc, base, batch, evaluated, tx, inputs);
    return { ...committed, parts: [committed.revision] };
  }
  const ranges = partsAt(batch.operations.length, cutPoints);
  const project = parseSnapshot('video', base.snapshot).snapshot as VideoProjectV1;
  const scopeState = batch.origin === 'agent' ? videoScopeOf(project, guard.scope) : null;
  const parts = [];
  let current = { doc, base };
  let last: Awaited<ReturnType<typeof engine.commitVideoRevision>> | null = null;
  for (const [k, [from, to]] of ranges.entries()) {
    const suffix = ` (part ${k + 1} of ${ranges.length})`;
    const part: VideoOperationBatch = {
      ...batch,
      baseRevisionId: current.base.id,
      operations: batch.operations.slice(from, to),
      summary: `${batch.summary.slice(0, 500 - suffix.length)}${suffix}`,
    };
    const partEvaluated = await engine.evaluateVideoBatch(actor, current.doc, current.base, part, tx, {
      scopeState,
      ...(guard.brandLogo ? { brandLogo: guard.brandLogo } : {}),
    });
    last = await engine.commitVideoRevision(actor, current.doc, current.base, part, partEvaluated, tx, {
      ...inputs,
      part: { index: k + 1, count: ranges.length },
    });
    parts.push(last.revision);
    const nextDoc = await engine.loadDocumentForUpdate(doc.id, tx);
    current = { doc: nextDoc, base: await engine.loadRevision(nextDoc, last.revision.id, tx) };
  }
  return { ...(last as NonNullable<typeof last>), parts };
}

/** The brand's primary logo version a model-planned assembly may place (the agent guard's one exception). */
const brandLogoOf = (prepared: Prepared) =>
  prepared.bindings.logoAssetVersionId
    ? {
        brandLogo: {
          assetVersionId: prepared.bindings.logoAssetVersionId,
          minWidthPx: prepared.logoMinWidthPx,
        },
      }
    : {};

/** The storyboard against today's brand and library: facts in force, eligible assets, prohibited phrases. */
function assertStoryboardUsable(
  storyboard: Storyboard,
  prepared: Prepared,
  request: VideoAiRequest,
  path: string,
) {
  const problems = storyboardProblems(storyboard, {
    eligible: prepared.eligible,
    effectiveFactIds: prepared.effectiveFactIds,
    prohibitedPhrases: prepared.prohibitedPhrases,
    brief: request.kind === 'storyboard' ? request.brief : (undefined as never),
  });
  if (problems.length)
    throw new ValidationFailedError(
      problems.map((p) => ({
        path: `${path}.${p.path}`,
        issue: `${p.reason}${p.detail ? `: ${p.detail}` : ''}`,
      })),
      'The storyboard uses something it may not now (a fact no longer in force, an asset no longer usable, a prohibited phrase); fix it and assemble again',
    );
}

/** Conflicts that mean the brand or library changed since the proposal was made (accept refuses rather than drop). */
const NO_LONGER_ALLOWED = new Set([
  'asset_not_eligible',
  'asset_kind',
  'claim_without_fact',
  'cta_not_approved',
]);

// ---- the service (router-facing) -----------------------------------------------------------------------------

export const videoAiService = {
  /** Preflight: nothing is written; creative.edit on the document (it is the check of a change to it). */
  async preflight(actor: ResolvedActor, input: z.input<typeof VideoAiPreflight>, tx?: Tx) {
    const parsed = VideoAiPreflight.parse(input);
    const doc = await engine.documentsRepo.getById(parsed.documentId, tx);
    await policy.assert(actor, 'creative.edit', engine.documentResource(doc), {}, tx);
    engine.assertVideo(doc);
    if (doc.currentRevisionId !== parsed.baseRevisionId)
      throw new StaleRevisionError(doc.currentRevisionId ?? '');
    const request = normalised(parsed.request);
    return preflightOf(await prepare(actor, doc, parsed.baseRevisionId, request, tx), request);
  },

  /**
   * Starts a job (idempotent per requester, document, base revision and inputs hash while the job is live; a job
   * that stopped making progress is ended first, see liveJobOf). The preflight runs again and blocking
   * issues refuse the start; the outbox starts studioVideoJobWorkflowV1. creative.edit on the document and
   * agent.start_run on the brand (the job spends the brand's generation budget).
   */
  async start(actor: ResolvedActor, input: z.input<typeof VideoAiStart>, tx: Tx) {
    const parsed = VideoAiStart.parse(input);
    const found = await engine.documentsRepo.getById(parsed.documentId, tx);
    await policy.assert(actor, 'creative.edit', engine.documentResource(found), {}, tx);
    await policy.assert(actor, 'agent.start_run', engine.brandResource(found.brandId), {}, tx);
    engine.assertVideo(found);
    const request = normalised(parsed.request);
    const inputsHash = hashCanonical(request);
    const liveKey = liveKeyOf(actor.id, parsed.baseRevisionId, inputsHash);
    // Lock order as in save, assemble and accept: the job (a stale one taken over) before the document.
    const existing = await liveJobOf(found.id, liveKey, tx);
    if (existing) return toJobDto(existing);
    const doc = await engine.documentsRepo.lock(parsed.documentId, tx);
    const raced = await jobsRepo.findLive(doc.id, liveKey, tx); // a start that committed while we waited
    if (raced) return toJobDto(raced);
    if (doc.currentRevisionId !== parsed.baseRevisionId)
      throw new StaleRevisionError(doc.currentRevisionId ?? '');
    const prepared = await prepare(actor, doc, parsed.baseRevisionId, request, tx);
    const checked = preflightOf(prepared, request);
    if (checked.blocking)
      throw new ValidationFailedError(
        checked.issues
          .filter((i) => i.severity === 'blocking')
          .map((i) => ({ path: i.ref ? `request.${i.ref}` : 'request', issue: `${i.code}: ${i.message}` })),
        'The request cannot start',
      );
    const id = newId('studioVideoJob');
    await jobsRepo.create(
      {
        id,
        brandId: doc.brandId,
        documentId: doc.id,
        baseRevisionId: parsed.baseRevisionId,
        kind: request.kind,
        state: 'queued',
        progress: VIDEO_AI_PROGRESS.queued,
        request,
        inputsHash,
        liveKey,
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
      'creative.video_ai.start',
      { type: 'studio_video_job', id },
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
      'creative.video_job_requested',
      { type: 'studio_video_job', id, version: 0 },
      { jobId: id, attempt: 1, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: doc.brandId },
    );
    return toJobDto(await jobsRepo.getById(id, tx));
  },

  async get(actor: ResolvedActor, input: z.input<typeof VideoAiGet>, tx?: Tx) {
    const parsed = VideoAiGet.parse(input);
    const job = await loadJob(parsed.jobId, tx);
    await policy.assert(actor, 'creative.read', jobResource(job), {}, tx);
    return toJobDto(job);
  },

  /** The jobs of a document a person comes back to: every live one and the most recent finished one of each kind. */
  async active(actor: ResolvedActor, input: z.input<typeof VideoAiActive>, tx?: Tx) {
    const parsed = VideoAiActive.parse(input);
    const doc = await engine.documentsRepo.getById(parsed.documentId, tx);
    await policy.assert(actor, 'creative.read', engine.documentResource(doc), {}, tx);
    const recent = await jobsRepo.recentForDocument(doc.brandId, doc.id, 20, tx);
    const live = recent.filter((j) => LIVE.has(j.state));
    const lastOf = (kind: JobRow['kind']) =>
      recent.find((j) => j.kind === kind && !LIVE.has(j.state)) ?? null;
    const storyboard = lastOf('storyboard');
    const recut = lastOf('recut');
    return {
      items: live.map(toJobDto),
      lastStoryboard: storyboard ? toJobDto(storyboard) : null,
      lastRecut: recut ? toJobDto(recut) : null,
    };
  },

  /**
   * Cancel: the row moves at once (nothing is written after this commits: the save locks the row and stops on a
   * cancelled job), the attempt's reservation is released and the workflow is signalled through the outbox. A job
   * that is already saving cannot be cancelled: it finishes, and its result is a proposal or can be undone.
   */
  async cancel(actor: ResolvedActor, input: z.input<typeof VideoAiCancel>, tx: Tx) {
    const parsed = VideoAiCancel.parse(input);
    const job = await jobsRepo.lock(parsed.jobId, tx);
    await policy.assert(actor, 'creative.edit', jobResource(job), {}, tx);
    if (job.state === 'cancelled') return toJobDto(job); // a replayed cancel
    const toState = move(job.state, 'cancel');
    await jobsRepo.update(
      job.id,
      job.version,
      { state: toState, progress: VIDEO_AI_PROGRESS.cancelled, finishedAt: new Date(), liveKey: null },
      tx,
    );
    // A call already under way still records its cost (consumeIncurred); only the unspent remainder is released.
    if (job.budgetRunId) await budgets.release(job.budgetRunId, tx);
    await audit.record(
      engine.actorRef(actor),
      'creative.video_ai.cancel',
      { type: 'studio_video_job', id: job.id },
      'allowed',
      tx,
      { brandId: job.brandId, documentId: job.documentId, fromState: job.state, toState },
    );
    await outbox.add(
      'creative.video_job_cancel_requested',
      { type: 'studio_video_job', id: job.id, version: job.version + 1 },
      { jobId: job.id, attempt: job.attempt },
      tx,
      { brandId: job.brandId },
    );
    return toJobDto(await jobsRepo.getById(job.id, tx));
  },

  /**
   * Retry a failed or cancelled job as a new attempt from the same base revision (refused when the document moved
   * on: start a new request from the current revision instead). Same permissions as start.
   */
  async retry(actor: ResolvedActor, input: z.input<typeof VideoAiRetry>, tx: Tx) {
    const parsed = VideoAiRetry.parse(input);
    const job = await jobsRepo.lock(parsed.jobId, tx);
    await policy.assert(actor, 'creative.edit', jobResource(job), {}, tx);
    await policy.assert(actor, 'agent.start_run', engine.brandResource(job.brandId), {}, tx);
    if (LIVE.has(job.state)) return toJobDto(job); // a replayed retry: the new attempt is already under way
    const toState = move(job.state, 'retry');
    const doc = await engine.documentsRepo.getById(job.documentId, tx);
    if (doc.currentRevisionId !== job.baseRevisionId)
      throw new ValidationFailedError(
        [{ path: 'jobId', issue: 'stale_document' }],
        'The video changed since this was asked for; start a new request from the current revision',
      );
    const liveKey = liveKeyOf(actor.id, job.baseRevisionId, job.inputsHash);
    const live = await liveJobOf(job.documentId, liveKey, tx);
    if (live) return toJobDto(live); // the same request is already running again: join it
    // The previous attempt's reservation is released now, so its late settle has nothing of the new attempt's to touch.
    if (job.budgetRunId) await budgets.release(job.budgetRunId, tx);
    const attempt = job.attempt + 1;
    await jobsRepo.update(
      job.id,
      parsed.expectedVersion,
      {
        state: toState,
        progress: VIDEO_AI_PROGRESS.queued,
        liveKey,
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
      'creative.video_ai.retry',
      { type: 'studio_video_job', id: job.id },
      'allowed',
      tx,
      { brandId: job.brandId, documentId: job.documentId, attempt },
    );
    await outbox.add(
      'creative.video_job_requested',
      { type: 'studio_video_job', id: job.id, version: job.version + 1 },
      { jobId: job.id, attempt, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: job.brandId },
    );
    return toJobDto(await jobsRepo.getById(job.id, tx));
  },

  /**
   * Saves the person's storyboard edits on the job as they work, so a reload or another device picks them up (the
   * schema is checked here and on every read). Optimistic: an edit made on an outdated view is a conflict.
   * creative.edit on the document.
   */
  async saveDraft(actor: ResolvedActor, input: z.input<typeof VideoAiSaveDraft>, tx: Tx) {
    const parsed = VideoAiSaveDraft.parse(input);
    const job = await jobsRepo.lock(parsed.jobId, tx);
    await policy.assert(actor, 'creative.edit', jobResource(job), {}, tx);
    if (job.kind !== 'storyboard' || job.state !== 'completed' || !job.result)
      throw new ValidationFailedError(
        [{ path: 'jobId', issue: 'storyboard_not_ready' }],
        'Only a finished storyboard can be edited',
      );
    const result = VideoAiResult.parse(job.result);
    // Once assembled, the storyboard on the job is what was assembled; a draft from before it would overwrite that.
    if (result.assembledAt)
      throw new ValidationFailedError(
        [{ path: 'jobId', issue: 'storyboard_assembled' }],
        'This storyboard was assembled; edits are no longer saved on it (assemble again to apply them)',
      );
    await jobsRepo.update(
      job.id,
      parsed.expectedVersion,
      { result: { ...result, draft: parsed.storyboard } },
      tx,
    );
    return toJobDto(await jobsRepo.getById(job.id, tx));
  },

  /**
   * Assemble a storyboard (as the person edited it) into the video. It is checked again (eligible assets, effective
   * facts, length), compiled into timeline operations and evaluated like any batch; into an empty project it is
   * committed at once (nothing to replace; undoable), otherwise it becomes a proposal on the job, accepted per group.
   * The person's edited storyboard is stored on the job either way. creative.edit on the document.
   */
  async assemble(actor: ResolvedActor, input: z.input<typeof VideoAiAssemble>, tx: Tx) {
    const parsed = VideoAiAssemble.parse(input);
    const job = await jobsRepo.lock(parsed.jobId, tx);
    await policy.assert(actor, 'creative.edit', jobResource(job), {}, tx);
    if (job.kind !== 'storyboard' || job.state !== 'completed' || !job.result)
      throw new ValidationFailedError(
        [{ path: 'jobId', issue: 'storyboard_not_ready' }],
        'Assemble a completed storyboard',
      );
    const doc = await engine.documentsRepo.lock(job.documentId, tx);
    engine.assertVideo(doc);
    if (doc.currentRevisionId !== parsed.baseRevisionId)
      throw new StaleRevisionError(doc.currentRevisionId ?? '');
    const request = VideoAiRequest.parse(job.request);
    const prepared = await prepare(actor, doc, parsed.baseRevisionId, request, tx);
    const storyboard = parsed.storyboard;
    assertStoryboardUsable(storyboard, prepared, request, 'storyboard');
    const compiled = compileAssembly(prepared.project, storyboard, {
      media: prepared.media,
      bindings: prepared.bindings,
      idPrefix: idPrefixOf(job.id),
      logoMinWidthPx: prepared.logoMinWidthPx,
    });
    if (!compiled.operations.length)
      throw new ValidationFailedError(
        compiled.conflicts.map((c) => ({ path: 'storyboard', issue: `${c.code}: ${c.message}` })),
        'Nothing in the storyboard can be placed on the timeline',
      );
    const summary = `Assembled storyboard “${storyboard.title}”`.slice(0, 500);
    // Model-planned (the storyboard came from the model): held to the agent guards like a recut, whoever commits it.
    const batch: VideoOperationBatch = {
      baseRevisionId: prepared.base.id,
      operations: compiled.operations,
      summary,
      origin: 'agent',
    };
    const evaluated = await engine.evaluateVideoBatch(
      actor,
      doc,
      prepared.base,
      batch,
      tx,
      brandLogoOf(prepared),
    );
    const storyboardHash = hashCanonical(storyboard);
    const result = VideoAiResult.parse(job.result);
    const fresh = isEmptyProject(prepared.project);
    if (fresh) {
      const committed = await commitInParts(
        actor,
        doc,
        prepared.base,
        batch,
        evaluated,
        { scope: null, ...brandLogoOf(prepared) },
        compiled.cutPoints,
        generationInputsOf(job, prepared, 'assembly', {
          assetVersionIds: compiled.assetVersionIds,
          factIds: compiled.factIds,
          storyboardHash,
        }),
        tx,
      );
      await jobsRepo.update(
        job.id,
        job.version,
        {
          result: {
            ...result,
            storyboard,
            draft: null,
            assembledAt: new Date().toISOString(),
            conflicts: compiled.conflicts,
          },
        },
        tx,
      );
      await audit.record(
        engine.actorRef(actor),
        'creative.video_ai.assemble',
        { type: 'studio_video_job', id: job.id },
        'allowed',
        tx,
        { brandId: job.brandId, documentId: doc.id, applied: true, revisionId: committed.revision.id },
      );
      return {
        applied: true as const,
        ...committed,
        conflicts: compiled.conflicts,
        proposal: null,
        job: toJobDto(await jobsRepo.getById(job.id, tx)),
      };
    }
    const proposal: VideoProposal = {
      kind: 'assembly',
      documentId: doc.id,
      baseRevisionId: prepared.base.id,
      origin: 'agent',
      summary,
      operations: compiled.operations,
      groups: stripGroupOps(compiled.groups),
      changes: videoTimelineDiff(prepared.project, evaluated.next),
      findings: evaluated.findings,
      contentHash: evaluated.contentHash,
      scope: null,
      storyboard,
      acceptedRevisionId: null,
    };
    await jobsRepo.update(
      job.id,
      job.version,
      {
        result: {
          ...result,
          storyboard,
          draft: null,
          assembledAt: new Date().toISOString(),
          proposal,
          conflicts: compiled.conflicts,
        },
      },
      tx,
    );
    await audit.record(
      engine.actorRef(actor),
      'creative.video_ai.assemble',
      { type: 'studio_video_job', id: job.id },
      'allowed',
      tx,
      { brandId: job.brandId, documentId: doc.id, applied: false, groups: proposal.groups.length },
    );
    return {
      applied: false as const,
      proposal,
      conflicts: compiled.conflicts,
      job: toJobDto(await jobsRepo.getById(job.id, tx)),
    };
  },

  /**
   * Accept some or all groups of a job's proposal. The chosen groups are recompiled against the proposal's base (which
   * must still be the head: a moved document is a 409 and the studio asks for a fresh request), evaluated with the
   * request's scope and the agent guards, and committed as one revision with the job's generation inputs and the
   * groups kept. creative.edit on the document.
   */
  async accept(actor: ResolvedActor, input: z.input<typeof VideoAiAccept>, tx: Tx) {
    const parsed = VideoAiAccept.parse(input);
    const job = await jobsRepo.lock(parsed.jobId, tx);
    await policy.assert(actor, 'creative.edit', jobResource(job), {}, tx);
    const result = job.result ? VideoAiResult.parse(job.result) : null;
    const proposal = result?.proposal;
    if (!result || !proposal)
      throw new ValidationFailedError([{ path: 'jobId', issue: 'no_proposal' }], 'This job has no proposal');
    if (proposal.acceptedRevisionId)
      throw new ValidationFailedError(
        [{ path: 'jobId', issue: 'proposal_already_accepted' }],
        'This proposal was already accepted; undo it from the history if needed',
      );
    const known = new Set(proposal.groups.map((g) => g.id));
    const unknown = parsed.groupIds.filter((id) => !known.has(id));
    if (unknown.length)
      throw new ValidationFailedError(
        unknown.map((id) => ({ path: 'groupIds', issue: `unknown_group: ${id}` })),
      );
    const doc = await engine.documentsRepo.lock(job.documentId, tx);
    engine.assertVideo(doc);
    if (
      doc.currentRevisionId !== proposal.baseRevisionId ||
      parsed.baseRevisionId !== proposal.baseRevisionId
    )
      throw new StaleRevisionError(doc.currentRevisionId ?? '');
    const request = VideoAiRequest.parse(job.request);
    const prepared = await prepare(actor, doc, proposal.baseRevisionId, request, tx);
    const only = new Set(parsed.groupIds);
    let compiled: {
      operations: VideoOperationBatch['operations'];
      cutPoints: number[];
      assetVersionIds: string[];
      factIds: string[];
      conflicts: VideoConflict[];
    };
    if (proposal.kind === 'recut') {
      const stored = parseOutput(job);
      if (stored?.kind !== 'recut')
        throw new ValidationFailedError([{ path: 'jobId', issue: 'no_model_output' }]);
      compiled = compileRecut(
        prepared.project,
        stored.output.actions,
        compileContext(job, prepared, proposal.scope),
        only,
      );
    } else {
      if (!proposal.storyboard) throw new ValidationFailedError([{ path: 'jobId', issue: 'no_storyboard' }]);
      // Facts may have been revoked or expired, assets retired or their rights ended since the proposal was made.
      assertStoryboardUsable(proposal.storyboard, prepared, request, 'proposal.storyboard');
      compiled = compileAssembly(
        prepared.project,
        proposal.storyboard,
        {
          media: prepared.media,
          bindings: prepared.bindings,
          idPrefix: idPrefixOf(job.id),
          logoMinWidthPx: prepared.logoMinWidthPx,
        },
        only,
      );
    }
    const changed = compiled.conflicts.filter(
      (c) => NO_LONGER_ALLOWED.has(c.code) && (!c.groupId || only.has(c.groupId)),
    );
    if (changed.length)
      throw new ValidationFailedError(
        changed.map((c) => ({ path: `groupIds.${c.groupId ?? ''}`, issue: `${c.code}: ${c.message}` })),
        'Part of this proposal is no longer allowed (an asset or a fact changed since); ask again',
      );
    const { operations, assetVersionIds, factIds } = compiled;
    if (!operations.length)
      throw new ValidationFailedError(
        [{ path: 'groupIds', issue: 'nothing_to_apply' }],
        'The chosen changes no longer apply to the video',
      );
    const kept = proposal.groups.filter((g) => only.has(g.id));
    const full = kept.length === proposal.groups.length;
    const batch: VideoOperationBatch = {
      baseRevisionId: proposal.baseRevisionId,
      operations,
      summary: full
        ? proposal.summary
        : `${proposal.summary} (${kept.map((g) => g.label).join('; ')})`.slice(0, 500),
      origin: proposal.origin,
    };
    const guard = { scope: proposal.scope, ...(proposal.kind === 'assembly' ? brandLogoOf(prepared) : {}) };
    const evaluated = await engine.evaluateVideoBatch(actor, doc, prepared.base, batch, tx, guard);
    // Accepting everything must give exactly the timeline the person reviewed.
    if (full && evaluated.contentHash !== proposal.contentHash)
      throw new ValidationFailedError(
        [
          {
            path: 'jobId',
            issue: 'proposal_changed: the recompiled result differs from the reviewed proposal',
          },
        ],
        'The proposal no longer gives the timeline you reviewed; ask again',
      );
    const committed = await commitInParts(
      actor,
      doc,
      prepared.base,
      batch,
      evaluated,
      guard,
      compiled.cutPoints,
      generationInputsOf(job, prepared, proposal.kind === 'recut' ? 'recut' : 'assembly', {
        assetVersionIds,
        factIds,
        acceptedGroupIds: [...only],
        ...(proposal.storyboard ? { storyboardHash: hashCanonical(proposal.storyboard) } : {}),
      }),
      tx,
    );
    await jobsRepo.update(
      job.id,
      job.version,
      { result: { ...result, proposal: { ...proposal, acceptedRevisionId: committed.revision.id } } },
      tx,
    );
    await audit.record(
      engine.actorRef(actor),
      'creative.video_ai.accept',
      { type: 'studio_video_job', id: job.id },
      'allowed',
      tx,
      {
        brandId: job.brandId,
        documentId: doc.id,
        revisionId: committed.revision.id,
        groups: [...only].join(','),
      },
    );
    return {
      ...committed,
      /** What was applied, recomputed for the groups kept (a partial accept differs from the proposal's diff). */
      changes: videoTimelineDiff(prepared.project, evaluated.next),
      job: toJobDto(await jobsRepo.getById(job.id, tx)),
    };
  },
};

// ---- the runtime surface (studioVideoJobWorkflowV1 activities, via the agents module) -------------------------

/** What the model is shown and may answer about; built by `modelContext`, rendered by packages/ai. */
export interface VideoAiModelContext {
  jobId: string;
  attempt: number;
  brandId: string;
  request: VideoAiRequest;
  snapshot: BrandSnapshot;
  project: VideoProjectV1;
  eligible: StoryboardAsset[];
  template: VideoTemplateSummary | null;
  /** The latest storyboard's script by scene (recut: captions come from it). */
  script: Array<{ sceneId: string | null; title: string; narration: string }>;
  media: Record<string, VideoMediaInfo>;
  /** Sources with a waveform (pauses can be found in them). */
  waveformSources: string[];
  estimateMicros: number;
}

function outcomeFor(job: JobRow, attempt: number): VideoJobStepOutcomeV1 {
  if (job.attempt !== attempt) return { proceed: false, reason: 'finished' };
  if (job.state === 'cancelled') return { proceed: false, reason: 'cancelled' };
  if (job.state === 'completed' || job.state === 'failed') return { proceed: false, reason: 'finished' };
  return { proceed: true };
}

async function loadForInput(input: StudioVideoJobInputV1, tx?: Tx) {
  const job = await loadJob(input.jobId, tx);
  if (job.tenantId !== input.tenantId) throw new NotFoundError('StudioVideoJob', input.jobId);
  return job;
}

async function advance(job: JobRow, event: VideoAiJobEvent, tx: Tx, extra: Partial<JobRow> = {}) {
  const toState = move(job.state, event);
  await jobsRepo.update(
    job.id,
    job.version,
    {
      state: toState,
      progress: VIDEO_AI_PROGRESS[toState],
      ...(TERMINAL.has(toState) ? { liveKey: null } : {}),
      ...extra,
    },
    tx,
  );
  return toState;
}

/**
 * How long a live job may go without a state change before it counts as dead (its workflow was lost): well above
 * studioVideoJobWorkflowV1's longest path (control steps 5 × 1 min, the model call 3 × 4 min with backoff, the save
 * 5 × 3 min, about 40 minutes), and above the 30-minute budget reservation it holds.
 */
export const VIDEO_JOB_STALE_MS = 60 * 60_000;

/**
 * The live job holding a request's key, or null. A job that stopped making progress (no state change for
 * VIDEO_JOB_STALE_MS) is failed here, its reservation released and its key cleared, so the request can start again;
 * a workflow that was only slow then stops at its next step (the attempt is over).
 */
async function liveJobOf(documentId: string, liveKey: string, tx: Tx, now = Date.now()) {
  const found = await jobsRepo.findLive(documentId, liveKey, tx);
  if (!found || now - found.updatedAt.getTime() <= VIDEO_JOB_STALE_MS) return found;
  const job = await jobsRepo.lock(found.id, tx);
  if (!LIVE.has(job.state) || job.liveKey !== liveKey) return null;
  // Re-checked on the locked row: a step that committed meanwhile means the workflow is alive.
  if (now - job.updatedAt.getTime() <= VIDEO_JOB_STALE_MS) return job;
  await advance(job, 'fail', tx, {
    errorCode: 'failed',
    error: 'The job stopped making progress and was ended; ask again',
    finishedAt: new Date(now),
  });
  if (job.budgetRunId) await budgets.release(job.budgetRunId, tx);
  await audit.record(
    SYSTEM,
    'creative.video_ai.fail',
    { type: 'studio_video_job', id: job.id },
    'allowed',
    tx,
    {
      brandId: job.brandId,
      documentId: job.documentId,
      code: 'stalled',
    },
  );
  return null;
}

/** The document's latest finished storyboard job (its script and its brief's channel), if any. */
async function lastStoryboardJob(doc: CreativeDocumentRow, tx?: Tx) {
  const recent = await jobsRepo.recentForDocument(doc.brandId, doc.id, 20, tx);
  return recent.find((j) => j.kind === 'storyboard' && j.state === 'completed' && j.result) ?? null;
}

/** The latest storyboard of the document, scene by scene, matched to the project's scenes by title. */
async function scriptOf(doc: CreativeDocumentRow, project: VideoProjectV1, tx?: Tx) {
  const last = await lastStoryboardJob(doc, tx);
  const storyboard: Storyboard | null = last ? (VideoAiResult.parse(last.result).storyboard ?? null) : null;
  return (storyboard?.scenes ?? [])
    .filter((s) => s.narration)
    .map((s) => ({
      sceneId: project.scenes.find((p) => p.title === s.title)?.id ?? null,
      title: s.title,
      narration: s.narration,
    }));
}

export const videoAiJobs = {
  async begin(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1> {
    return withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      const outcome = outcomeFor(job, input.attempt);
      if (!outcome.proceed) return outcome;
      if (job.state === 'queued') {
        await advance(job, 'start', tx);
        await audit.record(
          SYSTEM,
          'creative.video_ai.begin',
          { type: 'studio_video_job', id: job.id },
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

  /** The attempt's reservation (once): the estimate is reserved before the model call. */
  async reserve(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1> {
    const job = await loadForInput(input);
    const outcome = outcomeFor(job, input.attempt);
    if (!outcome.proceed || job.budgetRunId) return outcome;
    const estimate = Math.max(job.costReservedMicros, pricing.modelCallMicros);
    const budgetRunId = newId('budgetReservation');
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
    input: StudioVideoJobInputV1,
  ): Promise<VideoAiModelContext | null> {
    const job = await loadForInput(input);
    if (!outcomeFor(job, input.attempt).proceed || job.modelOutput) return null;
    if (!job.budgetRunId) throw new BudgetExhaustedError('no_reservation');
    const doc = await engine.documentsRepo.getById(job.documentId);
    await policy.assert(actor, 'creative.edit', engine.documentResource(doc), {}, undefined);
    const request = VideoAiRequest.parse(job.request);
    const prepared = await prepare(actor, doc, job.baseRevisionId, request);
    const include = new Set(
      request.kind === 'storyboard' ? request.brief.assets.include : request.recut.assetVersionIds,
    );
    const eligible = [...prepared.eligible.values()].sort(
      (a, b) => Number(include.has(b.assetVersionId)) - Number(include.has(a.assetVersionId)),
    );
    return {
      jobId: job.id,
      attempt: job.attempt,
      brandId: job.brandId,
      request,
      snapshot: prepared.snapshot,
      project: prepared.project,
      eligible,
      template: prepared.template,
      script: request.kind === 'recut' ? await scriptOf(doc, prepared.project) : [],
      media: prepared.media,
      waveformSources: Object.keys(prepared.waveforms),
      estimateMicros: prepared.estimateMicros,
    };
  },

  /** The model's validated output, stored before anything is compiled (a retried save never calls the model again). */
  async recordModelOutput(
    input: StudioVideoJobInputV1,
    stored: { output: unknown; callRef: string; costMicros: number },
  ): Promise<VideoJobStepOutcomeV1> {
    return withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      const outcome = outcomeFor(job, input.attempt);
      if (!outcome.proceed || job.modelOutput) {
        // The call was made and billed: a cancelled attempt still shows what it cost.
        if (job.attempt === input.attempt && !job.modelOutput)
          await jobsRepo.update(
            job.id,
            job.version,
            { costSpentMicros: job.costSpentMicros + stored.costMicros },
            tx,
          );
        return outcome;
      }
      await advance(job, 'validate', tx, {
        modelOutput: { output: stored.output, callRef: stored.callRef },
        costSpentMicros: job.costSpentMicros + stored.costMicros,
      });
      return { proceed: true };
    });
  },

  /** Spend that does not come with an output (a model call whose answer was refused). */
  async addSpend(input: StudioVideoJobInputV1, costMicros: number): Promise<void> {
    await withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      if (job.attempt !== input.attempt) return; // a superseded attempt: the ledger has the cost, the job shows its own
      await jobsRepo.update(job.id, job.version, { costSpentMicros: job.costSpentMicros + costMicros }, tx);
    });
  },

  async status(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1> {
    return outcomeFor(await loadForInput(input), input.attempt);
  },

  /** The attempt's own reservation; none for a superseded attempt (it must never charge a newer one's). */
  async reservationIdOf(input: StudioVideoJobInputV1): Promise<string | null> {
    const job = await loadForInput(input);
    return job.attempt === input.attempt ? job.budgetReservationId : null;
  },

  /**
   * Check, compile and write in one transaction with the job row locked: a storyboard (nothing on the timeline), or
   * a recut proposal (evaluated with the scope; accepted per group later), or a new-format document (revision 1 of a
   * new video; the original untouched). Then the job completes. A cancelled job writes nothing; a moved document
   * fails the job (stale_document).
   */
  async save(actor: ResolvedActor, input: StudioVideoJobInputV1) {
    return withTransaction(async (tx) => {
      const job = await jobsRepo.lock((await loadForInput(input, tx)).id, tx);
      const outcome = outcomeFor(job, input.attempt);
      if (!outcome.proceed) return { jobId: job.id, state: job.state };
      const stored = parseOutput(job);
      if (job.state !== 'validating' || !stored)
        throw new ValidationFailedError([
          { path: 'state', issue: `job is ${job.state} without a stored output` },
        ]);
      const request = VideoAiRequest.parse(job.request);
      const doc = await engine.documentsRepo.lock(job.documentId, tx);
      await policy.assert(actor, 'creative.edit', engine.documentResource(doc), {}, tx);
      if (doc.currentRevisionId !== job.baseRevisionId)
        throw new ValidationFailedError(
          [{ path: 'baseRevisionId', issue: 'stale_document' }],
          'The video changed while the job ran; nothing was saved',
        );
      await advance(job, 'save', tx);
      const prepared = await prepare(actor, doc, job.baseRevisionId, request, tx);
      let result: VideoAiResult;
      if (stored.kind === 'storyboard' && request.kind === 'storyboard') {
        const checked = checkModelStoryboard(stored.output, {
          brief: request.brief,
          eligible: prepared.eligible,
          effectiveFactIds: prepared.effectiveFactIds,
          alternatives: (kind) =>
            alternativesFor(kind, prepared.caps, prepared.eligible, prepared.remainingMicros),
          prohibitedPhrases: prepared.prohibitedPhrases,
          mint: (() => {
            let n = 0;
            const prefix = idPrefixOf(job.id);
            return () => `${prefix}s${++n}`;
          })(),
        });
        result = {
          storyboard: checked.storyboard,
          proposal: null,
          revisions: [],
          draft: null,
          assembledAt: null,
          conflicts: [],
          refused: checked.refused,
          findings: [],
          summary: `Storyboard “${checked.storyboard.title}”: ${checked.storyboard.scenes.length} scenes, ${checked.storyboard.gaps.length} gaps`,
        };
      } else if (stored.kind === 'recut' && request.kind === 'recut') {
        result = await saveRecut(
          actor,
          job,
          doc,
          prepared,
          stored.output,
          request.recut.scope,
          stored.callRef,
          tx,
        );
      } else throw new ValidationFailedError([{ path: 'output', issue: 'model_output_invalid: wrong kind' }]);
      const fresher = await jobsRepo.lock(job.id, tx);
      await advance(fresher, 'complete', tx, { result, finishedAt: new Date() });
      await audit.record(
        engine.actorRef(actor),
        'creative.video_ai.complete',
        { type: 'studio_video_job', id: job.id },
        'allowed',
        tx,
        {
          brandId: job.brandId,
          documentId: job.documentId,
          kind: job.kind,
          proposal: result.proposal !== null,
          revisions: result.revisions.map((r) => r.revisionId).join(','),
          refused: result.refused.length,
          conflicts: result.conflicts.length,
        },
      );
      await outbox.add(
        'creative.video_job_completed',
        { type: 'studio_video_job', id: job.id, version: fresher.version + 1 },
        { jobId: job.id, documentId: job.documentId, kind: job.kind },
        tx,
        { brandId: job.brandId },
      );
      return { jobId: job.id, state: 'completed' as const };
    });
  },

  /** The attempt's terminal failure (tolerant of a job that is already finished or belongs to a newer attempt). */
  async fail(input: StudioVideoJobInputV1, code: VideoAiErrorCode, detail?: string) {
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
        'creative.video_ai.fail',
        { type: 'studio_video_job', id: job.id },
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
  async settle(input: StudioVideoJobInputV1): Promise<void> {
    const job = await loadForInput(input);
    // A late settle of a superseded attempt never touches the newer attempt's reservation (retry released its own).
    if (job.attempt !== input.attempt) return;
    if (job.budgetRunId) await budgets.settle(job.budgetRunId);
  },
};

/** A recut's result: the proposal (scoped, evaluated) or a new-format document, and every conflict. */
async function saveRecut(
  actor: ResolvedActor,
  job: JobRow,
  doc: CreativeDocumentRow,
  prepared: Prepared,
  output: z.infer<typeof ModelRecutOutput>,
  scope: VideoAiScope,
  callRef: string,
  tx: Tx,
): Promise<VideoAiResult> {
  const compiled = compileRecut(prepared.project, output.actions, compileContext(job, prepared, scope));
  const conflicts: VideoConflict[] = [
    ...compiled.conflicts,
    ...output.unsupported.map((text) => ({ code: 'not_supported', message: text, itemIds: [] })),
  ];
  if (!output.actions.length && !output.unsupported.length)
    conflicts.push({
      code: 'nothing_asked',
      message: 'No change could be read from the request',
      itemIds: [],
    });
  const revisions: VideoAiResult['revisions'] = [];
  let findings: Finding[] = [];
  const version = compiled.version;
  if (version) {
    const project = parseSnapshot('video', version.project).snapshot as VideoProjectV1;
    await engine.authoriseRefs(projectAssetRefs(project), doc.brandId, tx);
    const versionFindings = validateVideoProject(project, {
      media: await mediaLookup(timedAssetIds(project), tx),
      snapshot: prepared.snapshot,
    });
    findings = versionFindings;
    if (versionFindings.some(engine.isBlocking))
      conflicts.push({
        code: 'version_blocked',
        message: `The ${version.label.toLowerCase()} has blocking findings (${versionFindings
          .filter(engine.isBlocking)
          .map((f) => f.message)
          .join('; ')}); it was not created`,
        itemIds: [],
      });
    else {
      const created = await engine.insertNewDocument(
        actor,
        {
          brandId: doc.brandId,
          title: `${doc.title} – ${version.label}`.slice(0, 200),
          contentPackageId: doc.contentPackageId,
          kind: 'video',
          snapshot: project,
          operations: engine.initialVideoBatch(project, 'agent'),
          brandVersionId: project.brandVersionId,
          origin: 'agent',
          changeSummary: 'Initial video',
          auditAction: 'creative.document.create',
          auditMeta: {
            sourceType: 'creative_document',
            sourceId: doc.id,
            sourceRevisionId: prepared.base.id,
            videoJobId: job.id,
          },
          generationInputs: generationInputsOf(job, prepared, 'vertical_version', {
            assetVersionIds: [...new Set(timedAssetIds(project))],
            factIds: compiled.factIds,
            modelCallRefs: [callRef],
          }),
        },
        tx,
      );
      revisions.push({
        documentId: created.documentId,
        revisionId: created.revisionId,
        label: version.label,
      });
    }
  }
  // The other actions (if any) are still a proposal for this video, reviewed and accepted as usual.
  let proposal: VideoProposal | null = null;
  if (compiled.operations.length) {
    const batch: VideoOperationBatch = {
      baseRevisionId: prepared.base.id,
      operations: compiled.operations,
      summary: output.summary,
      origin: 'agent',
    };
    const evaluated = await engine.evaluateVideoBatch(actor, doc, prepared.base, batch, tx, { scope });
    findings = [...findings, ...evaluated.findings];
    proposal = {
      kind: 'recut',
      documentId: doc.id,
      baseRevisionId: prepared.base.id,
      origin: 'agent',
      summary: output.summary,
      operations: compiled.operations,
      groups: stripGroupOps(compiled.groups),
      changes: videoTimelineDiff(prepared.project, evaluated.next),
      findings: evaluated.findings,
      contentHash: evaluated.contentHash,
      scope,
      acceptedRevisionId: null,
    };
  }
  return {
    storyboard: null,
    proposal,
    revisions,
    draft: null,
    assembledAt: null,
    conflicts,
    refused: [],
    findings,
    summary: output.summary,
  };
}

/** Maps a thrown domain error to the code a failed job records. */
export function videoAiErrorCode(err: unknown): VideoAiErrorCode {
  if (err instanceof BudgetExhaustedError) return 'budget_exhausted';
  if (err instanceof OremediaError) {
    if (err.code === 'FORBIDDEN') return 'policy_denied';
    if (err.code === 'NOT_FOUND') return 'not_found';
    if (err.code === 'VALIDATION_FAILED') return 'validation_failed';
  }
  return 'failed';
}
