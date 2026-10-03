export * from './schema';
export * from './formats';
export {
  reduce,
  applyBatch,
  reflow,
  changedElementIds,
  allElementIds,
  findElement,
  isLockedDeep,
  footprintOf,
  boundsOf,
  OperationError,
  SlotConstraintError,
  validateSlotBindings,
  type ReduceContext,
  type SlotFinding,
  type TemplateDocument,
} from './reduce';
export {
  guardProtected,
  guardLocks,
  guardLogoInsertion,
  guardScope,
  scopeState,
  type ScopeState,
} from './guard';
export {
  ancestryOf,
  inScope,
  isImageArea,
  imageForArea,
  generationSlots,
  textCapacity,
  structureFor,
  bindSlots,
  compileFill,
  groupOperations,
  operationsOfGroups,
  preflightGeneration,
  type GenerationSlot,
  type GenerationSlotKind,
  type FixedReason,
  type Structure,
  type CompileContext,
  type CompiledFill,
  type PreflightAsset,
  type PreflightInput,
  type PreflightResult,
} from './generation';
export { fontFaceDescriptors } from './renderer/scene';
export { validateAgainstBrand, contrastRatio, prohibitedPhrasesIn } from './validate';
export type { EditorAdapter, EditorHandle, Unsubscribe } from './adapter';
export { invertBatch, type InvertResult } from './invert';
export { rebaseBatch, type RebaseConflict, type RebaseResult } from './rebase';
export {
  KonvaEditorAdapter,
  isInteractive,
  moveIntent,
  nudgeIntent,
  resizeIntent,
  transformIntent,
  frameTransformIntent,
  marqueeSelection,
  toggleSelection,
  formatForPage,
  fitScale,
  type IntentBatch,
  type KonvaAdapterOptions,
  type KonvaEditorHandle,
} from './konva-adapter';
export {
  STARTERS,
  starterByKey,
  instantiateStarter,
  starterBrandIssue,
  blankDocument,
  type StarterSpec,
  type StarterBrand,
  type StarterSlot,
  type InstantiatedStarter,
} from './starters';
