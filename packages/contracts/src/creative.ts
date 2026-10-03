import { z } from 'zod';
import { LogoVariant } from './brand';
import { ElementId as Id } from './ids';
import { PageRequest } from './pagination';

/**
 * Spec 11.2: the creative document schema. Owned here (contracts) so that packages/db and
 * packages/editor both depend on one definition; packages/editor/src/schema.ts re-exports it.
 */
const Transform = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().min(-360).max(360).default(0),
});

export const SemanticRole = z.enum([
  'headline',
  'body',
  'price',
  'cta',
  'logo',
  'product',
  'background',
  'decoration',
  'legal',
]);
export type SemanticRole = z.infer<typeof SemanticRole>;

const Base = z.object({
  id: Id,
  name: z.string().max(80),
  locked: z.boolean().default(false),
  visible: z.boolean().default(true),
  transform: Transform,
  opacity: z.number().min(0).max(1).default(1),
  semanticRole: SemanticRole.optional(),
  protected: z.boolean().default(false), // e.g. logo: agents cannot move/resize/recolour
});

export const TypeRole = z.enum(['display', 'heading', 'body', 'label', 'caption']);

export const TextElement = Base.extend({
  type: z.literal('text'),
  text: z.string().max(5000),
  style: z.object({
    typeRole: TypeRole,
    fontAssetVersionId: z.string(),
    weight: z.number(),
    sizePx: z.number().positive(),
    lineHeight: z.number().positive(),
    tracking: z.number().default(0),
    colourToken: z.string().optional(),
    colourValue: z.string().optional(), // token preferred; raw value flagged by review
    align: z.enum(['left', 'center', 'right', 'justify']),
    overflow: z.enum(['shrink_to_fit', 'clip', 'error']).default('error'),
  }),
  factRefs: z.array(z.string()).default([]), // approved_facts this text asserts
});

export const ImageElement = Base.extend({
  type: z.literal('image'),
  assetVersionId: z.string(),
  crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
  mask: z.object({ kind: z.enum(['rect', 'rounded', 'circle']), radius: z.number().optional() }).optional(),
});

export const LogoElement = Base.extend({
  type: z.literal('logo'),
  assetVersionId: z.string(),
  variant: LogoVariant,
});

export const ShapeElement = Base.extend({
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line']),
  fillToken: z.string().optional(),
  strokeToken: z.string().optional(),
  strokeWidth: z.number().default(0),
  cornerRadius: z.number().default(0),
});

export const BackgroundElement = Base.extend({
  type: z.literal('background'),
  fillToken: z.string().optional(),
  assetVersionId: z.string().optional(),
});

export type TextElement = z.infer<typeof TextElement>;
export type ImageElement = z.infer<typeof ImageElement>;
export type LogoElement = z.infer<typeof LogoElement>;
export type ShapeElement = z.infer<typeof ShapeElement>;
export type BackgroundElement = z.infer<typeof BackgroundElement>;
export type LeafElement = TextElement | ImageElement | LogoElement | ShapeElement | BackgroundElement;
export interface GroupElement extends z.infer<typeof Base> {
  type: 'group';
  children: Element[];
}
export type Element = LeafElement | GroupElement;

// Recursive schema: a plain union (not discriminatedUnion) avoids zod's restrictions on lazy members.
export const ElementSchema: z.ZodType<Element> = z.lazy(() =>
  z.union([
    TextElement,
    ImageElement,
    LogoElement,
    ShapeElement,
    BackgroundElement,
    Base.extend({ type: z.literal('group'), children: z.array(ElementSchema).max(200) }),
  ]),
) as z.ZodType<Element>;

export const LayoutConstraint = z.object({
  elementId: Id,
  anchor: z.enum(['top', 'bottom', 'left', 'right', 'center']),
  marginPx: z.number(),
});

/**
 * STU-1a: a custom page size is a format key of the form `custom_<width>x<height>` (packages/editor formatFor parses
 * it into a definition with a proportional safe area), so renders, variants and checks treat it like a preset. The
 * bounds are the render worker's edge limit and a sensible aspect range.
 */
export const CUSTOM_FORMAT_MIN_PX = 64;
export const CUSTOM_FORMAT_MAX_PX = 4096;
/** Longest edge over shortest edge: wider than a 4:1 banner (1584×396) is allowed, a sliver is not. */
export const CUSTOM_FORMAT_MAX_ASPECT = 8;

export const CreativePage = z.object({
  id: z.string(),
  name: z.string(),
  formatKey: z.string(), // references a format definition (dimensions, safe areas)
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  elements: z.array(ElementSchema).max(300), // z-order = array order
  layoutConstraints: z.array(LayoutConstraint).default([]),
  /**
   * STU-1a: a locked page blocks every agent operation on the page and its elements, and manual move, resize and
   * rotation. Optional with no default so stored pages parse and hash exactly as before; unlocking removes the key.
   */
  locked: z.boolean().optional(),
});
export type CreativePage = z.infer<typeof CreativePage>;

/**
 * STU-1a (architecture principle 4): what the document is for, separate from its layout (pages and formats) and its
 * destinations (format and channel variants). `video` is reserved for the video document kind.
 */
export const ContentType = z.enum([
  'social_post',
  'carousel',
  'story',
  'video',
  'thumbnail_banner',
  'custom',
]);
export type ContentType = z.infer<typeof ContentType>;

export const CreativeDocumentV1 = z.object({
  schemaVersion: z.literal(1),
  brandVersionId: z.string(),
  templateVersionId: z.string().optional(),
  /** Optional with no default: documents stored before STU-1a parse and hash unchanged. */
  contentType: ContentType.optional(),
  pages: z.array(CreativePage).min(1).max(20), // carousels are multi-page
  variants: z
    .array(
      z.object({
        formatKey: z.string(),
        derivedFromPageIds: z.array(z.string()),
        overrides: z.record(z.unknown()),
      }),
    )
    .default([]),
});
export type CreativeDocumentV1 = z.infer<typeof CreativeDocumentV1>;

/** Spec 11.3: the one operation contract shared by humans and agents. */
export const Operation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insertElement'),
    pageId: z.string(),
    element: ElementSchema,
    index: z.number().int().optional(),
  }),
  z.object({ op: z.literal('removeElement'), pageId: z.string(), elementId: Id }),
  z.object({
    op: z.literal('setText'),
    pageId: z.string(),
    elementId: Id,
    text: z.string().max(5000),
    factRefs: z.array(z.string()).optional(),
  }),
  z.object({ op: z.literal('setStyle'), pageId: z.string(), elementId: Id, patch: z.record(z.unknown()) }),
  z.object({ op: z.literal('replaceAsset'), pageId: z.string(), elementId: Id, assetVersionId: z.string() }),
  z.object({ op: z.literal('moveElement'), pageId: z.string(), elementId: Id, x: z.number(), y: z.number() }),
  z.object({
    op: z.literal('resizeElement'),
    pageId: z.string(),
    elementId: Id,
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({ op: z.literal('reorderElement'), pageId: z.string(), elementId: Id, toIndex: z.number().int() }),
  z.object({
    op: z.literal('setCrop'),
    pageId: z.string(),
    elementId: Id,
    crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  }),
  z.object({
    op: z.literal('applyTemplate'),
    pageId: z.string(),
    templateVersionId: z.string(),
    slotBindings: z.record(Id),
  }),
  z.object({ op: z.literal('addPage'), page: CreativePage, index: z.number().int().optional() }),
  z.object({ op: z.literal('createFormatVariant'), sourcePageId: z.string(), formatKey: z.string() }), // reflows via constraints; never scales pixels blindly
  z.object({ op: z.literal('setLock'), pageId: z.string(), elementId: Id, locked: z.boolean() }),
  // ---- STU-1a: editor completeness. Every operation is pure, invertible and guarded like the ones above. ----
  /**
   * Wraps top-level elements of a page in a new group at the place of the front-most member; children keep their
   * page-absolute transforms (scene.ts) and their paint order, the group's box encloses them.
   */
  z.object({
    op: z.literal('groupElements'),
    pageId: z.string(),
    elementIds: z.array(Id).min(2).max(100),
    groupId: Id,
    name: z.string().min(1).max(80).optional(),
  }),
  /** Replaces a top-level group by its children at its place; a translucent group's opacity moves into them. */
  z.object({ op: z.literal('ungroupElement'), pageId: z.string(), elementId: Id }),
  z.object({
    op: z.literal('setRotation'),
    pageId: z.string(),
    elementId: Id,
    rotation: z.number().min(-360).max(360),
  }),
  /** An image's mask shape; null removes it. */
  z.object({
    op: z.literal('setMask'),
    pageId: z.string(),
    elementId: Id,
    mask: z
      .object({ kind: z.enum(['rect', 'rounded', 'circle']), radius: z.number().min(0).max(4096).optional() })
      .nullable(),
  }),
  z.object({ op: z.literal('removePage'), pageId: z.string() }),
  /**
   * Copies a page with new ids: `elementIdMap` maps every element id of the page (groups' children included) to a
   * new one, so the reducer stays pure and the copy is addressable at once.
   */
  z.object({
    op: z.literal('duplicatePage'),
    pageId: z.string(),
    newPageId: z.string().min(1).max(40),
    elementIdMap: z.record(Id),
    index: z.number().int().optional(),
  }),
  z.object({ op: z.literal('reorderPage'), pageId: z.string(), toIndex: z.number().int() }),
  z.object({ op: z.literal('setPageLock'), pageId: z.string(), locked: z.boolean() }),
  /** Aligns element boxes to the selection's bounds or to the page. */
  z.object({
    op: z.literal('alignElements'),
    pageId: z.string(),
    elementIds: z.array(Id).min(1).max(100),
    align: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
    relativeTo: z.enum(['selection', 'page']),
  }),
  /** Equal gaps between element boxes along an axis, within the selection's span or the page. */
  z.object({
    op: z.literal('distributeElements'),
    pageId: z.string(),
    elementIds: z.array(Id).min(2).max(100),
    axis: z.enum(['horizontal', 'vertical']),
    relativeTo: z.enum(['selection', 'page']),
  }),
]);
export type Operation = z.infer<typeof Operation>;
/** Every operation name, in contract order (the agent tool schema and the studio's labels enumerate these). */
export const OPERATION_NAMES = Operation.options.map((o) => o.shape.op.value) as ReadonlyArray<
  Operation['op']
>;

export const OperationBatch = z.object({
  baseRevisionId: z.string(),
  operations: z.array(Operation).min(1).max(100),
  summary: z.string().max(500),
  origin: z.enum(['user', 'agent']),
  agentRunId: z.string().optional(),
});
export type OperationBatch = z.infer<typeof OperationBatch>;

/** Deterministic findings from brand validation and render checks (spec 11.4, 11.5). */
export const FindingSeverity = z.enum(['blocking', 'warning', 'info']);
export const Finding = z.object({
  code: z.string(),
  severity: FindingSeverity,
  message: z.string(),
  pageId: z.string().optional(),
  elementId: z.string().optional(),
  factId: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

/** Format definitions: dimensions and safe areas per channel format key. */
export const FormatDefinition = z.object({
  key: z.string(),
  label: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  safeArea: z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() }),
  providerKeys: z.array(z.string()),
});
export type FormatDefinition = z.infer<typeof FormatDefinition>;

export const RenderManifest = z.object({
  rendererVersion: z.string(),
  fonts: z.array(z.object({ assetVersionId: z.string(), contentHash: z.string() })),
  assets: z.array(z.object({ assetVersionId: z.string(), contentHash: z.string() })),
  brandVersionId: z.string(),
  revisionContentHash: z.string(),
});
export type RenderManifest = z.infer<typeof RenderManifest>;

export const RenderValidationResult = z.object({
  ok: z.boolean(),
  findings: z.array(Finding),
});
export type RenderValidationResult = z.infer<typeof RenderValidationResult>;

export const RenderJobState = z.enum(['pending', 'rendering', 'ready', 'failed']);
export type RenderJobState = z.infer<typeof RenderJobState>;

export const ElementCommentState = z.enum(['open', 'resolved', 'outdated']);
export type ElementCommentState = z.infer<typeof ElementCommentState>;

/** Spec 6.3 templates / template_versions: a template is active once a version is approved; versions are approved one by one. */
export const TemplateState = z.enum(['draft', 'active', 'retired']);
export type TemplateState = z.infer<typeof TemplateState>;
export const TemplateVersionState = z.enum(['draft', 'approved', 'retired']);
export type TemplateVersionState = z.infer<typeof TemplateVersionState>;

/**
 * Spec 6.3 / 11.3 slot kinds with enforced semantics: a bound element must have the matching element type. Other
 * kind strings (versions stored before slot semantics) are accepted and only checked for existence.
 */
export const TemplateSlotKind = z.enum(['text', 'image', 'logo', 'background']);
export type TemplateSlotKind = z.infer<typeof TemplateSlotKind>;

/**
 * What a template consumer may put into a slot (spec 6.3 template_versions constraints): text length limits for text
 * slots and, for any slot, the semantic roles a bound element may carry (e.g. an image slot for `product` imagery
 * only). Every field is optional so versions stored before slot constraints keep parsing.
 */
export const TemplateSlotConstraints = z
  .object({
    minLength: z.number().int().min(0).max(5000).optional(),
    maxLength: z.number().int().min(1).max(5000).optional(),
    semanticRoles: z.array(SemanticRole).min(1).max(9).optional(),
  })
  .strict();
export type TemplateSlotConstraints = z.infer<typeof TemplateSlotConstraints>;

/**
 * A slot binds a key to an element of the template page; applyTemplate maps slot keys to existing element ids and
 * validates each bound element against the slot (kind, replaceable, constraints). `replaceable: false` marks a
 * fixed element of the template that a consumer may not bind (it always comes from the template).
 */
export const TemplateSlot = z.object({
  key: z.string().min(1).max(80),
  elementId: Id,
  kind: z.string().min(1).max(40),
  required: z.boolean().default(false),
  replaceable: z.boolean().default(true),
  constraints: TemplateSlotConstraints.default({}),
});
export type TemplateSlot = z.infer<typeof TemplateSlot>;

// ---- router DTOs (spec 7.5 creative router) ----
/**
 * STU-1a: where a new document starts from, recorded in the audit trail. `template` makes the server start from the
 * approved brand template version itself (no `document` is sent); `starter` names a built-in starter the client
 * instantiated with the brand's tokens, fonts and logos (packages/editor/src/starters), sent as `document`.
 */
export const DocumentSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blank') }),
  z.object({ kind: z.literal('custom') }),
  z.object({ kind: z.literal('starter'), starterKey: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('template'), templateId: z.string(), templateVersionId: z.string() }),
]);
export type DocumentSource = z.infer<typeof DocumentSource>;
export const DocumentTitle = z.string().trim().min(1).max(200);
export const DocumentCreate = z.object({
  brandId: z.string(),
  title: DocumentTitle,
  contentPackageId: z.string().optional(),
  /** Optional initial document; its brandVersionId is replaced by the published brand version resolved on the server. */
  document: CreativeDocumentV1.optional(),
  /** STU-1a: stored on the document snapshot (overrides the document's own when both are given). */
  contentType: ContentType.optional(),
  source: DocumentSource.optional(),
});
/** STU-1a: a new document whose revision 1 is the source document's current revision, provenance in the audit. */
export const DocumentDuplicate = z.object({ documentId: z.string(), title: DocumentTitle.optional() });
/** STU-1a: the title is a label, last writer wins; it never touches revisions. */
export const DocumentRename = z.object({ documentId: z.string(), title: DocumentTitle });
export const DocumentGet = z.object({ documentId: z.string() });
/** The brand's documents, newest first; optionally those created for one content package. */
export const DocumentList = z.object({
  brandId: z.string(),
  contentPackageId: z.string().optional(),
  page: PageRequest,
});
export const RevisionList = z.object({ documentId: z.string(), page: PageRequest });
export const RevisionGet = z.object({ documentId: z.string(), revisionId: z.string() });
/** Spec 11.4 applyOperations(docId, batch): the batch plus the document it targets. */
export const OperationsApply = OperationBatch.extend({ documentId: z.string() });
export type OperationsApply = z.infer<typeof OperationsApply>;
export const RenderFormatKeys = z.array(z.string().min(1).max(40)).min(1).max(20);
/**
 * Same input as apply; runs the same guards and validation as a dry run (agent preview). With `previewRender` the
 * proposed snapshot is also queued as a worker preview render (spec 11.4): its output is never publishable.
 */
export const OperationsPropose = OperationsApply.extend({
  previewRender: z.object({ formatKeys: RenderFormatKeys }).optional(),
});
export const RenderRequest = z.object({
  documentId: z.string(),
  revisionId: z.string(),
  formatKeys: RenderFormatKeys,
});
export const RenderGet = z.object({ renderJobId: z.string() });
export const CommentAdd = z.object({
  documentId: z.string(),
  revisionId: z.string(),
  elementId: Id,
  body: z.string().min(1).max(5000),
});
export const CommentResolve = z.object({
  documentId: z.string(),
  commentId: z.string(),
  expectedVersion: z.number().int(),
});
export const CommentList = z.object({
  documentId: z.string(),
  state: ElementCommentState.optional(),
  page: PageRequest,
});
export const TemplateCreate = z.object({ brandId: z.string(), name: z.string().min(1).max(200) });
export const TemplateVersionCreate = z.object({
  templateId: z.string(),
  document: CreativeDocumentV1,
  slots: z.array(TemplateSlot).max(100).default([]),
  constraints: z.record(z.unknown()).default({}),
  formats: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export const TemplateApprove = z.object({
  templateId: z.string(),
  templateVersionId: z.string(),
  /** The template row's version (optimistic concurrency); the version row moves by state transition. */
  expectedVersion: z.number().int(),
});
/**
 * STU-1a: retiring is a brand-standards decision like approval. With a version id that version is retired (the
 * template falls back to its newest other approved version); without one the template and its versions are.
 */
export const TemplateRetire = z.object({
  templateId: z.string(),
  templateVersionId: z.string().optional(),
  expectedVersion: z.number().int(),
});
export const TemplateList = z.object({ brandId: z.string(), page: PageRequest });
/**
 * STU-1a: the brand's active templates with their current (approved) version document, in one read, for the
 * creation gallery's previews (instead of one templates.get per card).
 */
export const TemplateListCurrent = z.object({ brandId: z.string(), page: PageRequest });
export const TemplateGet = z.object({ templateId: z.string(), templateVersionId: z.string().optional() });

// ---- render worker DTOs (spec 11.5: the worker reports through the creative module, never by writing state) ----
export const RenderExportInput = z.object({
  pageId: z.string().min(1).max(40),
  formatKey: z.string().min(1).max(40),
  mime: z.string().min(1).max(40),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  storageKey: z.string().min(1).max(300),
  contentHash: z.string().length(64),
  rendererVersion: z.string().min(1).max(40),
  manifest: RenderManifest,
  validation: RenderValidationResult,
});
export type RenderExportInput = z.infer<typeof RenderExportInput>;
export const RenderMarkRendering = z.object({ renderJobId: z.string() });
export const RenderMarkReady = z.object({
  renderJobId: z.string(),
  exports: z.array(RenderExportInput).min(1).max(100),
});
export const RenderMarkFailed = z.object({ renderJobId: z.string(), error: z.string().min(1).max(2000) });
