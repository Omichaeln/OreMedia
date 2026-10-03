// Studio video v1 (STU-2b): the timeline model's pure reducer, inverse, rebase, guards, validation, overlay
// helpers shared by the preview and the compositor, and the built-in starter templates.
export * from './time';
export { framePlacement, type FramePlacement } from './frame';
export {
  reduceVideo,
  applyVideoBatch,
  videoOpItemIds,
  VideoOperationError,
  type VideoMediaLookup,
  type VideoReduceContext,
} from './reduce';
export { invertVideoBatch, type VideoInvertResult } from './invert';
export { rebaseVideoBatch, type VideoRebaseConflict, type VideoRebaseResult } from './rebase';
export { guardVideoAgent } from './guard';
export { validateVideoProject, CAPTION_MAX_CHARS_PER_SECOND, type VideoValidationContext } from './validate';
export {
  videoFormatOf,
  framePage,
  overlayPage,
  captionElements,
  captionPage,
  overlayAnimationAt,
  captionsVtt,
  SLIDE_FRACTION,
  CAPTION_MAX_LINES,
} from './overlays';
export {
  listVideoTemplates,
  instantiateVideoTemplate,
  blankVideoProject,
  VIDEO_TEMPLATE_KEYS,
  type VideoBrandBindings,
} from './templates';
