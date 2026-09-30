import { ToolRegistry, type AnyToolDefinition } from '../tool-registry';
import { assetsSearchEligible } from './assets';
import { brandGetSnapshot, brandProposeVoice, factsList } from './brand';
import { contentCreateBrief, contentDraftCopy, contentProposePlan } from './content';
import { creativeProposeOperations, creativeRequestRender } from './creative';
import { imagesGenerate } from './images';
import { experimentsProposeDesign, metricsQuery, recommendationsCreate, voiceClusters } from './intelligence';
import { publicationsProposeSchedule } from './publications';
import { reviewRequest, reviewRunBrandReview } from './review';
import { speechGenerate } from './speech';
import { videosGenerate, videosStatus } from './videos';

/** Spec 12.4 Release 1 tool registry, in the order of the table. No tool has an external effect. */
export const RELEASE_1_TOOLS: readonly AnyToolDefinition[] = [
  brandGetSnapshot,
  brandProposeVoice,
  assetsSearchEligible,
  factsList,
  metricsQuery,
  voiceClusters,
  contentCreateBrief,
  contentDraftCopy,
  contentProposePlan,
  creativeProposeOperations,
  creativeRequestRender,
  imagesGenerate,
  videosGenerate,
  videosStatus,
  speechGenerate,
  reviewRunBrandReview,
  reviewRequest,
  experimentsProposeDesign,
  recommendationsCreate,
  publicationsProposeSchedule,
];

export function createReleaseOneRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of RELEASE_1_TOOLS) registry.register(def);
  return registry;
}

export {
  brandGetSnapshot,
  brandProposeVoice,
  factsList,
  assetsSearchEligible,
  creativeProposeOperations,
  creativeRequestRender,
};
export { applyProposalBatch, CreativeProposalPayload } from './creative';
export { imagesGenerate, IMAGE_COST_MICROS } from './images';
export { videosGenerate, videosStatus, VIDEO_COST_MICROS_PER_SECOND } from './videos';
export { speechGenerate, SPEECH_COST_MICROS_PER_1K_CHARS } from './speech';
export { reviewRunBrandReview, reviewRequest } from './review';
export { contentCreateBrief, contentDraftCopy, contentProposePlan } from './content';
export { publicationsProposeSchedule, ScheduleProposalPayload } from './publications';
export { metricsQuery, voiceClusters, recommendationsCreate, experimentsProposeDesign } from './intelligence';
export {
  NOT_AVAILABLE_YET,
  defaultToolServices,
  imageGeneratorFromEnv,
  registerImageGenerator,
  registerVideoGenerator,
  videoGeneratorFromEnv,
  registerSpeechGenerator,
  speechGeneratorFromEnv,
  registerIntelligenceToolSource,
  registerContentToolSource,
  registerReviewToolSource,
  registerPublishingToolSource,
  type ImageGenerator,
  type VideoGenerator,
  type SpeechGenerator,
  type GeneratedMedia,
  type IntelligenceToolSource,
  type ContentToolSource,
  type ReviewToolSource,
  type PublishingToolSource,
  type ToolRunRef,
  type ToolServices,
} from './services';
