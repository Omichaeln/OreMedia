// Creative studio (spec 11): documents, revisions, the operation engine, renders, comments and templates.
export {
  creativeService,
  registerAssetAuthoriser,
  resetAssetAuthoriser,
  registerRevisionChangeHook,
  type ActorOptions,
  type AssetAuthoriser,
  type AssetRef,
  type CreativeAssetPurpose,
  type RevisionChangeHook,
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
} from './repositories';
export {
  registerCreativeOutboxRoutes,
  RENDER_TASK_QUEUE,
  VIDEO_RENDER_TASK_QUEUE,
  VIDEO_RENDER_WORKFLOW_TYPE,
  VIDEO_RENDER_SIGNAL_WORKFLOW_TYPE,
} from './outbox-routes';
/** Spec 13.4 brand_review_clean: the review module re-runs the studio's deterministic brand validation on pinned revisions. */
export { validateAgainstBrand } from '@oremedia/editor/validate';
/** STU-2b: the same for a video revision's timeline (overlays, captions, sources). */
export { validateVideoProject } from '@oremedia/editor/video/validate';
