// Creative studio (spec 11): documents, revisions, the operation engine, renders, comments and templates.
export {
  creativeService,
  registerAssetAuthoriser,
  resetAssetAuthoriser,
  registerRevisionChangeHook,
  registerExportSigner,
  type ActorOptions,
  type AssetAuthoriser,
  type AssetRef,
  type CreativeAssetPurpose,
  type RevisionChangeHook,
  type ExportSigner,
  VIDEO_EXPORT_PAGE_ID,
} from './service';
export { registerCreativeAssetCatalog, type CreativeAssetCatalog } from './video-support';
export {
  CreativeDocumentRepository,
  CreativeRevisionRepository,
  RenderJobRepository,
  RenderedExportRepository,
  ElementCommentRepository,
  TemplateRepository,
  TemplateVersionRepository,
  StudioGenerationJobRepository,
} from './repositories';
export {
  registerCreativeOutboxRoutes,
  RENDER_TASK_QUEUE,
  GENERATION_TASK_QUEUE,
  STUDIO_GENERATION_WORKFLOW_TYPE,
  STUDIO_GENERATION_SIGNAL_RELAY_WORKFLOW_TYPE,
  VIDEO_RENDER_TASK_QUEUE,
  VIDEO_RENDER_WORKFLOW_TYPE,
  VIDEO_RENDER_SIGNAL_WORKFLOW_TYPE,
} from './outbox-routes';
// STU-1b: generation jobs (router-facing service, the worker's runtime surface and the composition hooks).
export {
  generationService,
  generationJobs,
  generationErrorCode,
  workflowIdFor as generationWorkflowId,
  modelCallRef as generationModelCallRef,
  registerGenerationAssetSource,
  resetGenerationAssetSource,
  registerChannelCapabilitySource,
  resetChannelCapabilitySource,
  registerGenerationImageAvailability,
  configureGenerationPricing,
  type GenerationAsset,
  type GenerationAssetSource,
  type ChannelCapabilitySource,
  type GenerationImageAvailability,
  type GenerationModelContext,
  type GenerationPricing,
  type GenerationJobDto,
} from './generation';
/** Spec 13.4 brand_review_clean: the review module re-runs the studio's deterministic brand validation on pinned revisions. */
export { validateAgainstBrand } from '@oremedia/editor/validate';
/** STU-2b: the same for a video revision's timeline (overlays, captions, sources). */
export { validateVideoProject } from '@oremedia/editor/video/validate';
