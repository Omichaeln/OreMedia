import type { GenerationRestrictions } from '@oremedia/contracts/brand';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { Tx } from '@oremedia/db';
import { assetService } from '@oremedia/module-assets';
import { brandService } from '@oremedia/module-brand';
import { creativeService } from '@oremedia/module-creative';
import { featureFlag } from '@oremedia/module-operations';

/** Provider job protocol for generated images (spec 12.2 model-call recovery): submit once, then poll by job id. */
export interface ImageGenerator {
  /** The gateway, checked as the model vendor against the company routing policy (spec 12.7). */
  readonly provider: string;
  /** The model id the generator calls, checked against the policy's denied models. */
  readonly model: string;
  submit(input: {
    tenantId: string;
    brandId: string;
    runId: string;
    prompt: string;
    count: number;
    aspect: string;
    /** The run's principal and mode: a generator that catalogues its output acts as them (policy, audit). */
    actor: ResolvedActorServicePrincipal;
    autonomyMode: AutonomyMode;
    /** The brand's restrictions from its active policy (ADR-11 (5)); null when it sets none. */
    restrictions: GenerationRestrictions | null;
  }): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<
    | { status: 'pending' }
    | { status: 'failed'; reason: string }
    | {
        status: 'done';
        images: Array<{ storageKey: string; contentHash: string; width: number; height: number }>;
      }
  >;
}

/** A generated clip as catalogued: the asset version ingest accepted. */
export interface GeneratedMedia {
  storageKey: string;
  contentHash: string;
  width: number;
  height: number;
}

/**
 * Provider job protocol for generated video (ADR-11, spec 12.2): submit once, then poll by job id. A provider renders
 * asynchronously, so a job has two stages: the provider's render, then ingest of the downloaded clip. The poll that
 * sees the render finish hands the clip to ingest and returns the second stage's job id as `next`; the caller
 * persists it (ProviderJobStore.advance) and polls that, so a retry after the hand-off is recorded never repeats it
 * (a worker lost between the two can leave one extra pending asset, never a lost clip).
 */
export interface VideoGenerator {
  /** The gateway, checked as the model vendor against the company routing policy (spec 12.7). */
  readonly provider: string;
  /** The model id the generator calls, checked against the policy's denied models. */
  readonly model: string;
  submit(input: {
    tenantId: string;
    brandId: string;
    runId: string;
    prompt: string;
    seconds: number;
    aspect: string;
    /** The brand's restrictions from its active policy (ADR-11 (5)); null when it sets none. */
    restrictions: GenerationRestrictions | null;
  }): Promise<{ jobId: string }>;
  poll(
    jobId: string,
    /** Who catalogues the clip when the render has finished: the run's principal, mode and brand (policy, audit). */
    by: {
      brandId: string;
      runId: string;
      actor: ResolvedActorServicePrincipal;
      autonomyMode: AutonomyMode;
    },
  ): Promise<
    | { status: 'pending'; next?: string }
    | { status: 'failed'; reason: string }
    | { status: 'done'; video: GeneratedMedia }
  >;
}

/** A hook-backed tool whose module has not registered its source at composition denies with this reason. */
export const NOT_AVAILABLE_YET = 'tool_not_available_yet';

/** What every hook-backed write receives about the run: its brand, its id (recorded on the object) and its mode. */
export interface ToolRunRef {
  brandId: string;
  runId: string;
  autonomyMode: AutonomyMode;
}

/**
 * Spec 12.4 metrics.query / voice.clusters / recommendations.create / experiments.proposeDesign: the intelligence
 * module registers this source (composition root); the tool code stays generic and never names that module.
 * Absent, the four tools deny with tool_not_available_yet.
 */
export interface IntelligenceToolSource {
  metricsQuery(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      metricKeys: string[];
      from: string;
      to: string;
      channelConnectionIds: string[];
    },
    tx: Tx,
  ): Promise<{
    series: Array<{
      metricKey: string;
      points: Array<{ at: string; value: number | null; complete: boolean }>;
    }>;
  }>;
  voiceClusters(
    actor: ResolvedActorServicePrincipal,
    input: { brandId: string; limit: number },
    tx: Tx,
  ): Promise<{
    clusters: Array<{ id: string; label: string; size: number; examples: string[] }>;
  }>;
  recommendationsCreate(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      runId: string;
      title: string;
      rationale: string;
      evidenceRefs: string[];
      suggestedAction: 'brief' | 'variant' | 'experiment' | 'playbook_entry';
    },
    tx: Tx,
  ): Promise<{ recommendationId: string }>;
  experimentsProposeDesign(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      runId: string;
      autonomyMode: AutonomyMode;
      recommendationId?: string;
      hypothesis: string;
      primaryMetricKey: string;
      variants: Array<{ key: string; description: string }>;
    },
    tx: Tx,
  ): Promise<{ experimentId: string }>;
}

let intelligenceSource: IntelligenceToolSource | null = null;
export const registerIntelligenceToolSource = (source: IntelligenceToolSource | null): void => {
  intelligenceSource = source;
};

/**
 * Spec 12.4 content.createBrief / content.draftCopy (effect draft): the content module registers this source. Every
 * object is created as the run's service principal under the run's autonomy mode and records the run id; ids of
 * another brand or tenant are NOT_FOUND. Absent, both tools deny with tool_not_available_yet.
 */
export interface ContentToolSource {
  createBrief(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & {
      campaignId?: string;
      audience: string;
      message: string;
      offerFactIds: string[];
      channelConnectionIds: string[];
      constraints: string[];
    },
    tx: Tx,
  ): Promise<{ briefId: string }>;
  /** Each variant becomes a draft content package (revision 1) under the brief; nothing is reviewed or published. */
  draftCopy(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & {
      briefId: string;
      variants: Array<{ text: string; factIds: string[]; rationale: string }>;
    },
    tx: Tx,
  ): Promise<{ drafts: Array<{ contentPackageId: string; contentRevisionId: string; contentHash: string }> }>;
}

/**
 * Spec 12.4 review.request (effect propose): the review module registers this source. It opens a review request on
 * the revision (manifest frozen, revision in_review) for a person with review.decide to decide.
 */
export interface ReviewToolSource {
  requestReview(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & {
      contentRevisionId: string;
      assigneeUserIds: string[];
      dueAt?: string;
      timing: { kind: 'exact'; at: string } | { kind: 'window'; from: string; to: string };
    },
    tx: Tx,
  ): Promise<{ reviewRequestId: string; manifestHash: string }>;
}

/**
 * Spec 12.4 publications.proposeSchedule (effect propose): the publishing module registers this source. It checks a
 * proposed slot (the revision and channels of the run's brand, a variant per channel, publication.schedule per
 * channel) and returns the publications.schedule commands a person completes; it never writes and never schedules.
 */
export interface PublishingToolSource {
  proposeSchedule(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & { contentRevisionId: string; channelConnectionIds: string[]; proposedAt: string },
    tx: Tx,
  ): Promise<{
    entries: Array<{ channelConnectionId: string; channelVariantId: string; scheduledFor: string }>;
  }>;
}

let contentSource: ContentToolSource | null = null;
export const registerContentToolSource = (source: ContentToolSource | null): void => {
  contentSource = source;
};
let reviewSource: ReviewToolSource | null = null;
export const registerReviewToolSource = (source: ReviewToolSource | null): void => {
  reviewSource = source;
};
let publishingSource: PublishingToolSource | null = null;
export const registerPublishingToolSource = (source: PublishingToolSource | null): void => {
  publishingSource = source;
};

/** The module surfaces tools reach: narrow picks so a tool cannot wander into unrelated commands. */
export interface ToolServices {
  brand: Pick<typeof brandService, 'resolveBrandSnapshot' | 'proposeVoice'>;
  assets: Pick<typeof assetService, 'findEligibleAssets'>;
  creative: {
    operations: Pick<typeof creativeService.operations, 'propose' | 'apply'>;
    renders: Pick<typeof creativeService.renders, 'request'>;
    revisions: Pick<typeof creativeService.revisions, 'get'>;
  };
  /** null until IMAGE_GEN_PROVIDER names a registered generator: images.generate then denies provider_not_configured. */
  images: ImageGenerator | null;
  /** null until VIDEO_GEN_PROVIDER names a registered generator: videos.generate then denies provider_not_configured. */
  videos: VideoGenerator | null;
  /** Engineering flags (spec 22.1), evaluated server-side for the run's tenant. */
  flags: Pick<typeof featureFlag, 'isEnabled'>;
  /** null until the intelligence module registers (Phase 6): its tools then deny tool_not_available_yet. */
  intelligence: IntelligenceToolSource | null;
  /** null until the content, review and publishing modules register their sources (composition roots). */
  content: ContentToolSource | null;
  review: ReviewToolSource | null;
  publishing: PublishingToolSource | null;
}

const generators = new Map<string, ImageGenerator>();
/** Providers register here at composition (ADR-11: openrouter); there are no fake image bytes. */
export const registerImageGenerator = (g: ImageGenerator): void => {
  generators.set(g.provider, g);
};
export function imageGeneratorFromEnv(env: NodeJS.ProcessEnv = process.env): ImageGenerator | null {
  const provider = env['IMAGE_GEN_PROVIDER'];
  return provider ? (generators.get(provider) ?? null) : null;
}

const videoGenerators = new Map<string, VideoGenerator>();
/** Providers register here at composition (ADR-11: openrouter); there are no fake video bytes. */
export const registerVideoGenerator = (g: VideoGenerator): void => {
  videoGenerators.set(g.provider, g);
};
export function videoGeneratorFromEnv(env: NodeJS.ProcessEnv = process.env): VideoGenerator | null {
  const provider = env['VIDEO_GEN_PROVIDER'];
  return provider ? (videoGenerators.get(provider) ?? null) : null;
}

export function defaultToolServices(env: NodeJS.ProcessEnv = process.env): ToolServices {
  return {
    brand: brandService,
    assets: assetService,
    creative: {
      operations: creativeService.operations,
      renders: creativeService.renders,
      revisions: creativeService.revisions,
    },
    // Getters: generators and sources register at composition, after runtimes that captured these services were built.
    get images() {
      return imageGeneratorFromEnv(env);
    },
    get videos() {
      return videoGeneratorFromEnv(env);
    },
    flags: featureFlag,
    get intelligence() {
      return intelligenceSource;
    },
    get content() {
      return contentSource;
    },
    get review() {
      return reviewSource;
    },
    get publishing() {
      return publishingSource;
    },
  };
}
