import { z } from 'zod';
import type { ActivityHooks } from './agents';
import { Finding } from './creative';
import type { ResolvedActor } from './policy';
import { TenantContextInput } from './tenancy';
import type { VideoProjectV1 } from './video';
import {
  TRANSITION_KINDS,
  VIDEO_FORMAT_KEYS,
  VIDEO_MIN_DURATION_MS,
  VIDEO_PROJECT_MAX_DURATION_MS,
  VIDEO_SOURCE_MAX_MS,
  VideoFormatKey,
  VideoId,
  VideoOperation,
} from './video';

/**
 * Studio video AI (STU-3, architecture "Generation" video paragraph, principles 1-3, 7, 8). Two durable jobs make one
 * bounded model call each whose strict JSON answer the server checks and compiles:
 *
 * - `storyboard`: from a brief and the brand's eligible assets, a script, scenes and a shot list that names asset
 *   versions from the eligible set only, cites approved claims by effective fact id and lists gaps explicitly with
 *   the alternatives this brand actually has. Nothing is written to the timeline; the person refines the storyboard
 *   in Studio and assembles it (a deterministic compile into timeline operations, no model involved).
 * - `recut`: a plain-language change of the current timeline with an explicit scope (selected items, a scene or the
 *   whole timeline). The model only chooses edit actions; deterministic planners (duration fit, silence trim, scene
 *   reorder...) turn them into timeline operations, the server guard enforces the scope and the locks, and conflicts
 *   (locked material longer than the target, missing messaging...) are reported. The result is a proposal with a
 *   timeline diff, accepted per change group; a vertical version is a new document and never touches the original.
 */

const Line = (max: number) => z.string().trim().max(max);
const Ids = (max: number) => z.array(z.string().min(1).max(64)).max(max);
const Ms = z.number().int().min(0);

export const VideoAiJobKind = z.enum(['storyboard', 'recut']);
export type VideoAiJobKind = z.infer<typeof VideoAiJobKind>;

export const VideoPacing = z.enum(['calm', 'balanced', 'fast']);
export type VideoPacing = z.infer<typeof VideoPacing>;
/** What the soundtrack is: a music bed, the clips' own sound, a voice-over (needs a recording) or silence. */
export const VideoAudioPreference = z.enum(['music', 'clip_sound', 'voiceover', 'none']);
export type VideoAudioPreference = z.infer<typeof VideoAudioPreference>;

/** Shortest and longest shot a storyboard may plan. */
export const STORYBOARD_MIN_SHOT_MS = 500;
export const STORYBOARD_MAX_SHOT_MS = 30_000;
export const STORYBOARD_MAX_SCENES = 12;
export const STORYBOARD_MAX_SHOTS_PER_SCENE = 6;

/**
 * The storyboard brief. Defaults come from the project (format), its template (scene structure) and the published
 * brand system (voice, channel guidance, facts); the panel shows them rather than asking again.
 */
export const VideoBrief = z
  .object({
    objective: Line(500).default(''),
    audience: Line(300).default(''),
    keyMessage: Line(500).default(''),
    /** Destination channel (provider key); its brand guidance (caption style, CTA conventions) applies. */
    channelKey: z.string().min(1).max(40).optional(),
    /** Must be the project's format; another format is a vertical (or other) version, made from the timeline. */
    formatKey: VideoFormatKey.optional(),
    durationMs: z
      .number()
      .int()
      .min(VIDEO_MIN_DURATION_MS)
      .max(VIDEO_PROJECT_MAX_DURATION_MS)
      .default(15_000),
    pacing: VideoPacing.default('balanced'),
    captions: z.boolean().default(true),
    audio: VideoAudioPreference.default('music'),
    /** A built-in starter template whose scene structure the storyboard follows (defaults to the project's). */
    templateKey: z.string().min(1).max(60).optional(),
    /** Approved facts the script may state, picked by statement; each must be effective when the job runs. */
    factIds: Ids(20).default([]),
    assets: z
      .object({ include: Ids(20).default([]), exclude: Ids(50).default([]) })
      .strict()
      .default({}),
    /** Title and logo overlays per the brand's logo rules when the storyboard is assembled. */
    logo: z.boolean().default(true),
  })
  .strict();
export type VideoBrief = z.infer<typeof VideoBrief>;
export type VideoBriefInput = z.input<typeof VideoBrief>;

/**
 * What a recut may touch (principle 2), enforced by the server guard on every operation: the selected items, the
 * items of one scene, or the whole timeline. Ripple shifts of items outside the scope (same content, moved in time)
 * are allowed; any other change outside it is refused.
 */
export const VideoAiScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('items'), itemIds: z.array(VideoId).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('scene'), sceneId: VideoId }).strict(),
  z.object({ kind: z.literal('timeline') }).strict(),
]);
export type VideoAiScope = z.infer<typeof VideoAiScope>;

export const RecutRequest = z
  .object({
    instruction: z.string().trim().min(1).max(2000),
    scope: VideoAiScope,
    /** Approved facts the change may state (a call to action, a caption). */
    factIds: Ids(20).default([]),
    /** Eligible assets the change may place (e.g. a replacement opening shot). */
    assetVersionIds: Ids(20).default([]),
    /**
     * The call to action the person approves, verbatim. A call to action the model adds must be this text or one of
     * the brand's channel CTA conventions; nothing else is placed.
     */
    ctaText: Line(80).optional(),
    /** The channel the cut is for: the brand's CTA copy for it may be placed (else the storyboard brief's channel). */
    channelKey: z.string().min(1).max(40).optional(),
  })
  .strict();
export type RecutRequest = z.infer<typeof RecutRequest>;

export const VideoAiRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('storyboard'), brief: VideoBrief }),
  z.object({ kind: z.literal('recut'), recut: RecutRequest }),
]);
export type VideoAiRequest = z.infer<typeof VideoAiRequest>;
export type VideoAiRequestInput = z.input<typeof VideoAiRequest>;

// ---- the storyboard (stored on the job, edited by the person, assembled) ----------------------------------------

export const StoryboardClaim = z
  .object({
    text: z.string().trim().min(1).max(200),
    /** Effective approved facts the claim states; a claim without one is refused. */
    factIds: z.array(z.string().min(1).max(64)).min(1).max(5),
  })
  .strict();
export type StoryboardClaim = z.infer<typeof StoryboardClaim>;

export const StoryboardShot = z
  .object({
    id: VideoId,
    description: z.string().trim().min(1).max(300),
    /** An eligible asset version (video or still), or null for a gap the storyboard lists. */
    assetVersionId: z.string().min(1).max(64).nullable(),
    sourceInMs: Ms.max(VIDEO_SOURCE_MAX_MS).default(0),
    durationMs: z.number().int().min(STORYBOARD_MIN_SHOT_MS).max(STORYBOARD_MAX_SHOT_MS),
    framing: z.enum(['fill', 'fit']).default('fill'),
  })
  .strict();
export type StoryboardShot = z.infer<typeof StoryboardShot>;

export const StoryboardScene = z
  .object({
    id: VideoId,
    title: z.string().trim().min(1).max(80),
    purpose: z.string().trim().max(200).default(''),
    /** The script for the scene: spoken or read, and the source of its captions. */
    narration: z.string().trim().max(600).default(''),
    /** A short title shown over the scene. */
    onScreenText: z.string().trim().max(120).default(''),
    claims: z.array(StoryboardClaim).max(5).default([]),
    shots: z.array(StoryboardShot).min(1).max(STORYBOARD_MAX_SHOTS_PER_SCENE),
    /** The scene of the project's template this scene fills (its title overlay is reused). */
    templateSceneId: VideoId.optional(),
  })
  .strict();
export type StoryboardScene = z.infer<typeof StoryboardScene>;

export const GapKind = z.enum(['footage', 'music', 'voiceover']);
export type GapKind = z.infer<typeof GapKind>;
export const GapAlternativeKind = z.enum([
  'use_still',
  'generated_clip',
  'ask_for_footage',
  'generated_speech',
  'record_voiceover',
  'use_clip_sound',
  'no_music',
]);
export type GapAlternativeKind = z.infer<typeof GapAlternativeKind>;

/** A supported way to close a gap; unavailable ones say why (feature off, provider not configured, budget). */
export const GapAlternative = z.object({
  kind: GapAlternativeKind,
  label: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
  /** Estimated cost in micro-units, for generated media. */
  costMicros: z.number().int().min(0).optional(),
});
export type GapAlternative = z.infer<typeof GapAlternative>;

export const StoryboardGap = z.object({
  id: VideoId,
  kind: GapKind,
  sceneId: VideoId.nullable(),
  description: z.string().max(300),
  alternatives: z.array(GapAlternative).max(8),
});
export type StoryboardGap = z.infer<typeof StoryboardGap>;

export const Storyboard = z
  .object({
    title: z.string().trim().min(1).max(120),
    scenes: z.array(StoryboardScene).min(1).max(STORYBOARD_MAX_SCENES),
    gaps: z.array(StoryboardGap).max(40).default([]),
    /** An eligible audio asset for the music bed, or null. */
    musicAssetVersionId: z.string().min(1).max(64).nullable().default(null),
    pacing: VideoPacing,
    captions: z.boolean(),
    audio: VideoAudioPreference,
    logo: z.boolean(),
  })
  .strict();
export type Storyboard = z.infer<typeof Storyboard>;
export type StoryboardInput = z.input<typeof Storyboard>;

/** An item of the model's answer the server refused, and why (shown to the person; never silently dropped). */
export const RefusedItem = z.object({
  path: z.string(),
  reason: z.string(),
  detail: z.string().optional(),
});
export type RefusedItem = z.infer<typeof RefusedItem>;

// ---- the model's strict answers -----------------------------------------------------------------------------

export const ModelShot = z
  .object({
    description: z.string().min(1).max(300),
    assetVersionId: z.string().min(1).max(64).nullable(),
    sourceInMs: Ms.max(VIDEO_SOURCE_MAX_MS).optional(),
    durationMs: z.number().int().min(STORYBOARD_MIN_SHOT_MS).max(STORYBOARD_MAX_SHOT_MS),
  })
  .strict();
export const ModelScene = z
  .object({
    title: z.string().min(1).max(80),
    purpose: z.string().max(200).optional(),
    narration: z.string().max(600).optional(),
    onScreenText: z.string().max(120).optional(),
    claims: z
      .array(
        z.object({ text: z.string().min(1).max(200), factIds: z.array(z.string().max(64)).max(5) }).strict(),
      )
      .max(5)
      .optional(),
    shots: z.array(ModelShot).min(1).max(STORYBOARD_MAX_SHOTS_PER_SCENE),
    templateSceneId: z.string().max(40).optional(),
  })
  .strict();
export const ModelStoryboardOutput = z
  .object({
    title: z.string().min(1).max(120),
    scenes: z.array(ModelScene).min(1).max(STORYBOARD_MAX_SCENES),
    gaps: z
      .array(
        z
          .object({
            kind: GapKind,
            sceneIndex: z.number().int().min(0).max(STORYBOARD_MAX_SCENES).optional(),
            description: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    musicAssetVersionId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict();
export type ModelStoryboardOutput = z.infer<typeof ModelStoryboardOutput>;

/**
 * A recut action as the model may choose it. The model names items, scenes, eligible assets and fact ids it was
 * shown; the server's planners compute every time, trim and position.
 */
export const RecutAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reorder_scenes'), order: z.array(VideoId).min(1).max(30) }).strict(),
  z.object({ kind: z.literal('move_clip'), itemId: VideoId, beforeItemId: VideoId.nullable() }).strict(),
  z
    .object({
      kind: z.literal('fit_duration'),
      targetMs: z.number().int().min(VIDEO_MIN_DURATION_MS).max(VIDEO_PROJECT_MAX_DURATION_MS),
    })
    .strict(),
  z
    .object({ kind: z.literal('tighten'), minPauseMs: z.number().int().min(200).max(3_000).optional() })
    .strict(),
  z.object({ kind: z.literal('keep_only'), itemIds: z.array(VideoId).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('remove_items'), itemIds: z.array(VideoId).min(1).max(100) }).strict(),
  z
    .object({
      kind: z.literal('replace_source'),
      itemId: VideoId,
      assetVersionId: z.string().min(1).max(64),
      sourceInMs: Ms.max(VIDEO_SOURCE_MAX_MS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('trim_clip'),
      itemId: VideoId,
      durationMs: z.number().int().min(100).max(VIDEO_PROJECT_MAX_DURATION_MS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('add_captions'),
      /**
       * The scenes to caption (null: the whole video). The text is never the model's: the server takes each scene's
       * script from the document's storyboard.
       */
      sceneIds: z.array(VideoId).max(30).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('add_cta'),
      /** Must be the person's approved call to action or a brand CTA convention (checked on the server). */
      text: z.string().max(80),
      factIds: z.array(z.string().max(64)).max(5).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set_transitions'),
      transition: z.enum(TRANSITION_KINDS),
      durationMs: z.number().int().min(0).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('vertical_version'),
      formatKey: z.enum(VIDEO_FORMAT_KEYS),
      focus: z
        .array(
          z
            .object({ itemId: VideoId, focalX: z.number().min(0).max(1), focalY: z.number().min(0).max(1) })
            .strict(),
        )
        .max(100)
        .default([]),
    })
    .strict(),
]);
export type RecutAction = z.infer<typeof RecutAction>;
export type RecutActionKind = RecutAction['kind'];

export const ModelRecutOutput = z
  .object({
    summary: z.string().min(1).max(300),
    actions: z.array(RecutAction).max(10),
    /** Parts of the request no action can express; reported to the person as conflicts. */
    unsupported: z.array(z.string().max(300)).max(10).default([]),
  })
  .strict();
export type ModelRecutOutput = z.infer<typeof ModelRecutOutput>;

// ---- proposals, diffs and conflicts -------------------------------------------------------------------------

export const TimelineChangeKind = z.enum(['added', 'removed', 'moved', 'trimmed', 'replaced', 'changed']);
export type TimelineChangeKind = z.infer<typeof TimelineChangeKind>;
/** One item's change between two projects (scene and duration changes use their own ids). */
export const TimelineChange = z.object({
  kind: TimelineChangeKind,
  target: z.enum(['item', 'scene', 'duration', 'track', 'format']),
  id: z.string(),
  trackKind: z.enum(['video', 'audio', 'overlay', 'caption']).optional(),
  label: z.string(),
  before: z.object({ startMs: Ms, endMs: Ms }).nullable(),
  after: z.object({ startMs: Ms, endMs: Ms }).nullable(),
});
export type TimelineChange = z.infer<typeof TimelineChange>;

export const VideoConflict = z.object({
  code: z.string(),
  message: z.string(),
  /** The proposal group (action) it belongs to, when it is about one. */
  groupId: z.string().optional(),
  itemIds: z.array(z.string()).default([]),
});
export type VideoConflict = z.infer<typeof VideoConflict>;

/** Operations that belong together (one action), accepted or left out as one. */
export const VideoProposalGroup = z.object({
  id: z.string(),
  label: z.string(),
  operationCount: z.number().int().min(0),
  changes: z.array(TimelineChange),
});
export type VideoProposalGroup = z.infer<typeof VideoProposalGroup>;

export const VideoProposal = z.object({
  kind: z.enum(['recut', 'assembly']),
  documentId: z.string(),
  baseRevisionId: z.string(),
  origin: z.enum(['user', 'agent']),
  summary: z.string().max(500),
  /** Every operation of the proposal (for display; an accept recompiles the kept groups). */
  operations: z.array(VideoOperation).max(4_000),
  groups: z.array(VideoProposalGroup).min(1),
  changes: z.array(TimelineChange),
  findings: z.array(Finding),
  contentHash: z.string(),
  /** The scope the operations were checked against; accept checks it again. */
  scope: VideoAiScope.nullable(),
  /** Assembly only: the storyboard as the person assembled it (accept recompiles it). */
  storyboard: Storyboard.optional(),
  /** Set once a person accepted part or all of it. */
  acceptedRevisionId: z.string().nullable().default(null),
});
export type VideoProposal = z.infer<typeof VideoProposal>;

export const VideoAiResult = z.object({
  storyboard: Storyboard.nullable(),
  proposal: VideoProposal.nullable(),
  /** Documents written by the job (a vertical version), each revision 1 of a new document. */
  revisions: z.array(z.object({ documentId: z.string(), revisionId: z.string(), label: z.string() })),
  /** The person's edits of the storyboard, saved as they work (validated against the schema on every read). */
  draft: Storyboard.nullable().default(null),
  conflicts: z.array(VideoConflict),
  refused: z.array(RefusedItem),
  findings: z.array(Finding),
  summary: z.string().max(500),
});
export type VideoAiResult = z.infer<typeof VideoAiResult>;

/**
 * Principle 8: what produced a revision (creative_revisions.generation_inputs). The column belongs to STU-1b (#59,
 * GenerationInputs for graphic documents); this is its video variant: the same field names and types where they
 * overlap (job, inputs hash, template version, brand version, assets, facts, model call refs, cost, variation,
 * accepted groups), told apart by `documentKind: 'video'`, with the video request, scope and kinds. The model call
 * reference is the job's ledger key, never a prompt or a model identifier.
 */
export const VideoGenerationInputs = z.object({
  documentKind: z.literal('video'),
  jobId: z.string(),
  kind: z.enum(['assembly', 'recut', 'vertical_version']),
  request: VideoAiRequest,
  inputsHash: z.string(),
  /** Brand template versions are graphic; a video's built-in starter is `templateKey`. */
  templateVersionId: z.string().nullable(),
  brandVersionId: z.string(),
  scope: VideoAiScope.nullable(),
  assetVersionIds: z.array(z.string()),
  factIds: z.array(z.string()),
  modelCallRefs: z.array(z.string()),
  costMicros: z.number().int().min(0),
  variation: z.number().int().min(0),
  /** The groups a person kept when accepting a proposal. */
  acceptedGroupIds: z.array(z.string()).optional(),
  templateKey: z.string().nullable(),
  /** Assembly: the hash of the storyboard as assembled. */
  storyboardHash: z.string().optional(),
  /** A change committed in parts: this revision's part (1-based) and the number of parts. */
  part: z.object({ index: z.number().int().min(1), count: z.number().int().min(1) }).optional(),
});
export type VideoGenerationInputs = z.infer<typeof VideoGenerationInputs>;

/**
 * What creative_revisions.generation_inputs may hold on any row: the video variant first, then STU-1b's graphic
 * GenerationInputs (#59; no `documentKind`, or `documentKind: 'graphic'` once it gains the discriminator), kept as
 * an opaque record here. Neither side's parse throws on the other's rows. At the rebase onto #59 the second member
 * becomes #59's GenerationInputs.
 */
export const StoredGenerationInputs = z.union([
  VideoGenerationInputs,
  z
    .object({ documentKind: z.literal('graphic').optional(), jobId: z.string() })
    .passthrough()
    .refine(
      (v) => (v as { documentKind?: unknown }).documentKind !== 'video',
      'a video row that does not parse',
    ),
]);
export type StoredGenerationInputs = z.infer<typeof StoredGenerationInputs>;

/** The video variant of a stored generation_inputs value; null for a graphic row, an empty one or a malformed one. */
export function videoGenerationInputsOf(raw: unknown): VideoGenerationInputs | null {
  if (!raw || typeof raw !== 'object' || (raw as { documentKind?: unknown }).documentKind !== 'video')
    return null;
  const parsed = VideoGenerationInputs.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const VideoAiJobState = z.enum([
  'queued',
  'generating',
  'validating',
  'saving',
  'completed',
  'failed',
  'cancelled',
]);
export type VideoAiJobState = z.infer<typeof VideoAiJobState>;

export const VIDEO_AI_PROGRESS: Record<VideoAiJobState, number> = {
  queued: 5,
  generating: 30,
  validating: 70,
  saving: 85,
  completed: 100,
  failed: 100,
  cancelled: 100,
};

export const VideoAiErrorCode = z.enum([
  'budget_exhausted',
  'policy_denied',
  'model_failed',
  'model_output_invalid',
  'validation_failed',
  'stale_document',
  'not_found',
  'failed',
]);
export type VideoAiErrorCode = z.infer<typeof VideoAiErrorCode>;

// ---- router DTOs ----------------------------------------------------------------------------------------------

export const VideoAiPreflight = z.object({
  documentId: z.string(),
  baseRevisionId: z.string(),
  request: VideoAiRequest,
});
export const VideoAiStart = VideoAiPreflight;
export const VideoAiGet = z.object({ jobId: z.string() });
export const VideoAiActive = z.object({ documentId: z.string() });
export const VideoAiCancel = z.object({ jobId: z.string(), expectedVersion: z.number().int() });
export const VideoAiRetry = z.object({ jobId: z.string(), expectedVersion: z.number().int() });
/** Compile the (edited) storyboard of a completed storyboard job into the document. */
export const VideoAiAssemble = z.object({
  jobId: z.string(),
  baseRevisionId: z.string(),
  storyboard: Storyboard,
});
/** The person's storyboard edits, saved on the job as they work (the studio reattaches to them). */
export const VideoAiSaveDraft = z.object({
  jobId: z.string(),
  expectedVersion: z.number().int(),
  storyboard: Storyboard,
});
/** Accept some or all groups of the job's proposal; recompiled against the base revision, which must be current. */
export const VideoAiAccept = z.object({
  jobId: z.string(),
  baseRevisionId: z.string(),
  groupIds: z.array(z.string().min(1).max(40)).min(1).max(20),
});

export const VideoAiIssue = z.object({
  code: z.string(),
  severity: z.enum(['blocking', 'warning', 'info']),
  message: z.string(),
  ref: z.string().optional(),
});
export type VideoAiIssue = z.infer<typeof VideoAiIssue>;

// ---- workflow contract (studioVideoJobWorkflowV1 on task queue `agents`) --------------------------------------

/**
 * Workflow id `studio-video:<jobId>:<attempt>`; a retry is a new attempt of the same job. Activity parameters are
 * frozen once deployed: a change ships as new activities and a new workflow version.
 */
export const StudioVideoJobInputV1 = TenantContextInput.extend({
  jobId: z.string(),
  attempt: z.number().int().min(1),
});
export type StudioVideoJobInputV1 = z.infer<typeof StudioVideoJobInputV1>;

export type VideoJobStepOutcomeV1 = { proceed: true } | { proceed: false; reason: 'cancelled' | 'finished' };

export interface StudioVideoJobResultV1 {
  jobId: string;
  state: VideoAiJobState | 'stopped';
}

export interface StudioVideoJobFailInputV1 extends StudioVideoJobInputV1 {
  code: VideoAiErrorCode;
  detail?: string;
}

/**
 * begin: queued → generating. reserveBudget: before the model call; non-retryable BudgetExhausted. callModel: one
 * bounded call whose checked output is stored on the job (a retried activity after a stored output returns at once).
 * save: compile, guard, validate and write the storyboard, the proposal or the new document in one transaction; the
 * job completes only after that commit. fail: the job's terminal failure. settle: releases what was not spent.
 */
export interface StudioVideoJobActivitiesV1 {
  beginVideoJob(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1>;
  reserveVideoJobBudget(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1>;
  callVideoJobModel(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1>;
  saveVideoJob(input: StudioVideoJobInputV1): Promise<StudioVideoJobResultV1>;
  failVideoJob(input: StudioVideoJobFailInputV1): Promise<StudioVideoJobResultV1>;
  settleVideoJobBudget(input: StudioVideoJobInputV1): Promise<void>;
}

/** The module-side implementation the activities wrap (apps/worker-core wires the agents module's runtime). */
export interface StudioVideoJobRuntimeV1 {
  begin(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1>;
  reserve(input: StudioVideoJobInputV1): Promise<VideoJobStepOutcomeV1>;
  callModel(
    input: StudioVideoJobInputV1,
    actor: ResolvedActor,
    hooks?: ActivityHooks,
  ): Promise<VideoJobStepOutcomeV1>;
  save(input: StudioVideoJobInputV1, actor: ResolvedActor): Promise<StudioVideoJobResultV1>;
  fail(
    input: StudioVideoJobInputV1,
    code: VideoAiErrorCode,
    detail?: string,
  ): Promise<StudioVideoJobResultV1>;
  settle(input: StudioVideoJobInputV1): Promise<void>;
}

export const StudioVideoJobSignalV1 = z.object({ workflowId: z.string(), signal: z.literal('cancel') });
export type StudioVideoJobSignalV1 = z.infer<typeof StudioVideoJobSignalV1>;

/** A vertical (or other format) version as the compile describes it; the service saves it as a new document. */
export interface VideoVersionPlan {
  formatKey: VideoFormatKey;
  project: VideoProjectV1;
  label: string;
  /** The new version against the original project. */
  changes: TimelineChange[];
}
