// Studio video v1 (STU-2b): the timeline model's pure reducer, inverse, rebase, guards, validation, overlay
// helpers shared by the preview and the compositor, and the built-in starter templates.
export * from './time';
export { framePlacement, type FramePlacement } from './frame';
export {
  pictureLayersAt,
  activeOverlays,
  activeCaptions,
  restoreVideoOps,
  type PictureLayer,
} from './preview';
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
// STU-3: storyboard checks and assembly, recut planning (duration fit, silence trim...), the timeline diff, scope.
export { guardVideoAgentScoped, guardVideoScopeChange, videoScopeOf, type VideoScopeState } from './guard';
export { videoTimelineDiff } from './diff';
export {
  WorkingProject,
  idMinter,
  captionChunks,
  timedCaptions,
  brandCaptionTrack,
  trackOfKind,
  CAPTION_CHUNK_CHARS,
  type VideoCompileContext,
} from './compile-support';
export {
  checkModelStoryboard,
  storyboardProblems,
  storyboardDurationMs,
  compileAssembly,
  isEmptyProject,
  ASSEMBLY_GROUPS,
  PACING_TRANSITIONS,
  SHOT_KINDS,
  type StoryboardAsset,
  type StoryboardCheckContext,
  type AssemblyCompile,
  type AssemblyGroupId,
} from './storyboard';
export {
  compileRecut,
  applyCuts,
  planDurationFit,
  planSilenceTrim,
  reframeProject,
  isMusicTrack,
  mergeCuts,
  timeMapper,
  FIT_MIN_CLIP_MS,
  PAUSE_KEEP_MS,
  DEFAULT_MIN_PAUSE_MS,
  SILENCE_FLOOR,
  type RecutContext,
  type RecutCompile,
  type TimeCut,
} from './recut';
