import { METRIC, record } from '@oremedia/observability';
import { z } from 'zod';
import {
  CommentAdd,
  CommentList,
  CommentResolve,
  CreativeDocumentV1,
  DocumentCreate,
  DocumentGet,
  DocumentList,
  type OperationBatch,
  OperationsApply,
  OperationsPropose,
  RenderGet,
  RenderManifest,
  RenderCancel,
  RenderMarkFailed,
  RenderMarkProgress,
  RenderProgress,
  RenderMarkReady,
  RenderMarkRendering,
  RenderRequest,
  RenderValidationResult,
  RevisionGet,
  RevisionList,
  TemplateApprove,
  TemplateCreate,
  TemplateGet,
  TemplateList,
  TemplateSlot,
  TemplateSlotKind,
  TemplateVersionCreate,
  type DocumentKind,
  type CreativePage,
  type Element,
  type Finding,
  type Operation,
} from '@oremedia/contracts/creative';
import {
  NotFoundError,
  PolicyDeniedError,
  StaleRevisionError,
  ValidationFailedError,
  type ErrorDetail,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import {
  VideoOperationsApply,
  VideoOperationsPropose,
  VideoTemplateList,
  videoFormatFor,
  type VideoOperationBatch,
  type VideoProjectV1,
} from '@oremedia/contracts/video';
import type { VideoAiScope, VideoGenerationInputs } from '@oremedia/contracts/video-ai';
import { IMAGE_CREATIVE_KINDS, type AssetKind } from '@oremedia/contracts/assets';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { IllegalTransitionError, type StateMachine } from '@oremedia/domain/state-machines/machine';
import { renderJobMachine } from '@oremedia/domain/state-machines/render-job';
import { templateMachine, templateVersionMachine } from '@oremedia/domain/state-machines/template-version';
import { FORMAT_DEFINITIONS } from '@oremedia/editor/formats';
import { guardLogoInsertion, guardProtected } from '@oremedia/editor/guard';
import {
  OperationError,
  SlotConstraintError,
  allElementIds,
  changedElementIds,
  findElement,
  reduce,
  type TemplateDocument,
} from '@oremedia/editor/reduce';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { validateAgainstBrand } from '@oremedia/editor/validate';
import {
  VideoOperationError,
  blankVideoProject,
  findItem,
  guardVideoAgentScoped,
  guardVideoScopeChange,
  instantiateVideoTemplate,
  listVideoTemplates,
  reduceVideo,
  validateVideoProject,
  videoOpItemIds,
  videoScopeOf,
  type VideoScopeState,
} from '@oremedia/editor/video/index';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { audit, featureFlag, outbox } from '@oremedia/module-operations';
import {
  CreativeDocumentRepository,
  CreativeRevisionRepository,
  ElementCommentRepository,
  PreviewExportRepository,
  RenderJobRepository,
  RenderPreviewRepository,
  RenderedExportRepository,
  TemplateRepository,
  TemplateVersionRepository,
} from './repositories';
import {
  asLookup,
  brandBindings,
  distinctKindedRefs,
  elementAssetRefs,
  mediaLookup,
  parseRevisionContent,
  parseSnapshot,
  projectAssetRefs,
  timedAssetIds,
  videoOpAssetRefs,
  type KindedAssetRef,
} from './video-support';

const documentsRepo = new CreativeDocumentRepository();
const revisionsRepo = new CreativeRevisionRepository();
const renderJobsRepo = new RenderJobRepository();
const exportsRepo = new RenderedExportRepository();
const previewsRepo = new RenderPreviewRepository();
const previewExportsRepo = new PreviewExportRepository();
const commentsRepo = new ElementCommentRepository();
const templatesRepo = new TemplateRepository();
const templateVersionsRepo = new TemplateVersionRepository();

type DocumentRow = Awaited<ReturnType<typeof documentsRepo.getById>>;
type RevisionRow = Awaited<ReturnType<typeof revisionsRepo.getById>>;
type RenderJobRow = Awaited<ReturnType<typeof renderJobsRepo.getById>>;
type ExportRow = Awaited<ReturnType<typeof exportsRepo.getById>>;
type PreviewRow = Awaited<ReturnType<typeof previewsRepo.getById>>;
type PreviewExportRow = Awaited<ReturnType<typeof previewExportsRepo.getById>>;
type CommentRow = Awaited<ReturnType<typeof commentsRepo.getById>>;
type TemplateRow = Awaited<ReturnType<typeof templatesRepo.getById>>;
type TemplateVersionRow = Awaited<ReturnType<typeof templateVersionsRepo.getById>>;

/**
 * Policy options the caller may pass through (spec 5.5 step 7): the agent runtime supplies the run's autonomy
 * mode; the router passes nothing, so an agent editing through the API is held to `assist` and denied.
 */
export interface ActorOptions {
  autonomyMode?: AutonomyMode;
}

// ---- cross-module hooks (same pattern as registerBrandChecker: modules never import each other's tables) ----

/** Spec 11.4 guardAssets: assets.authoriseUse for every referenced asset version; the assets module registers it. */
/** Purposes the studio authorises: image/logo/background layers as `creative`, text fonts as `font` (spec 9.2). */
export type CreativeAssetPurpose = 'creative' | 'font';
export type AssetAuthoriser = (
  assetVersionId: string,
  ctx: {
    tenantId: string;
    brandId: string;
    purpose: CreativeAssetPurpose;
    /** STU-2b: the asset kinds the place accepts (graphic layers take still images; clips take video). */
    kinds?: readonly AssetKind[];
  },
  tx: Tx,
) => Promise<void>;
export interface AssetRef {
  assetVersionId: string;
  purpose: CreativeAssetPurpose;
  kinds?: readonly AssetKind[];
}
const unregisteredAuthoriser: AssetAuthoriser = async () => {
  throw new Error('asset authoriser not registered (composition root must call registerAssetAuthoriser)');
};
let assetAuthoriser: AssetAuthoriser = unregisteredAuthoriser;
/** Test seam: back to the loud default. */
export const resetAssetAuthoriser = (): void => {
  assetAuthoriser = unregisteredAuthoriser;
};
export const registerAssetAuthoriser = (fn: AssetAuthoriser): void => {
  assetAuthoriser = fn;
};

/**
 * STU-2b: short-lived download URLs for a job's exports (the studio plays and downloads a rendered video); the
 * assets module signs storage keys (registered at composition). Unregistered, URLs are not offered.
 */
export type ExportSigner = (storageKey: string) => Promise<{ url: string; expiresAt: string }>;
let exportSigner: ExportSigner | null = null;
export const registerExportSigner = (fn: ExportSigner): void => {
  exportSigner = fn;
};

/** Spec 11.4 approvals.invalidateForCreativeRevisionChange: the review module registers it in Phase 5; no-op until then. */
export type RevisionChangeHook = (documentId: string, tx: Tx) => Promise<void>;
let revisionChangeHook: RevisionChangeHook = async () => undefined;
export const registerRevisionChangeHook = (fn: RevisionChangeHook): void => {
  revisionChangeHook = fn;
};

// ---- helpers ----

const DEFAULT_FORMAT_KEY = 'square_1080';
/** The page id a video export is recorded under: the whole timeline is one export. */
export const VIDEO_EXPORT_PAGE_ID = 'timeline';

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const documentResource = (d: DocumentRow) => ({
  type: 'creative_document',
  tenantId: d.tenantId,
  brandId: d.brandId,
  id: d.id,
});
const templateResource = (t: TemplateRow) => ({
  type: 'template',
  tenantId: t.tenantId,
  brandId: t.brandId,
  id: t.id,
});

/** Revision authorship (creative_revisions.author_kind): a service principal is an agent; everyone else is a person. */
const authorKindOf = (actor: ResolvedActor): 'user' | 'agent' =>
  actor.kind === 'service_principal' ? 'agent' : 'user';
const requesterKindOf = (actor: ResolvedActor): 'user' | 'agent' | 'system' =>
  actor.kind === 'user' ? 'user' : actor.kind === 'service_principal' ? 'agent' : 'system';
function commentAuthorKindOf(actor: ResolvedActor): 'user' | 'agent' | 'external_reviewer' {
  switch (actor.kind) {
    case 'user':
      return 'user';
    case 'service_principal':
      return 'agent';
    case 'external_reviewer':
      return 'external_reviewer';
    case 'platform_operator':
      throw new PolicyDeniedError('support_never', 'Support sessions cannot comment on creative work');
  }
}

/** The guards key on batch.origin, so an agent may never label its batch as a person's (a person may commit an agent proposal). */
function assertOrigin(actor: ResolvedActor, origin: 'user' | 'agent'): void {
  if (actor.kind === 'service_principal' && origin !== 'agent')
    throw new PolicyDeniedError('origin_mismatch', 'An agent must submit its batches with origin agent');
}

/** Spec 5.5: agents hold brand.edit_standards with the propose_only obligation; approving a template is a person's decision. */
function assertMayDecide(decision: Decision): void {
  if (decision.obligations?.some((o) => o.type === 'propose_only'))
    throw new PolicyDeniedError('propose_only', 'Agents may only propose; a brand manager must decide');
}

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
  path: string,
): S {
  try {
    return machine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

const isBlocking = (f: Finding) => f.severity === 'blocking';
const findingDetail = (f: Finding): ErrorDetail => ({
  path: [f.pageId, f.elementId].filter((p): p is string => p !== undefined).join('.') || 'document',
  issue: `${f.code}: ${f.message}`,
});
/** Spec 11.4: agent proposals must be clean; humans see warnings and the commit proceeds. */
function assertAgentClean(origin: 'user' | 'agent', findings: Finding[]): void {
  if (origin === 'agent' && findings.some(isBlocking))
    throw new ValidationFailedError(
      findings.filter(isBlocking).map(findingDetail),
      'Agent proposals must have no blocking findings',
    );
}

/** Document-owned rows are loaded through the scoped repository and bound to the document: a foreign or mismatched id is NOT_FOUND. */
async function loadRevision(doc: DocumentRow, revisionId: string, tx?: Tx) {
  const r = await revisionsRepo.getById(revisionId, tx);
  if (r.documentId !== doc.id || r.brandId !== doc.brandId)
    throw new NotFoundError('CreativeRevision', revisionId);
  return r;
}
async function loadComment(doc: DocumentRow, commentId: string, tx?: Tx) {
  const c = await commentsRepo.getById(commentId, tx);
  if (c.documentId !== doc.id || c.brandId !== doc.brandId)
    throw new NotFoundError('ElementComment', commentId);
  return c;
}
async function loadTemplateVersion(template: TemplateRow, templateVersionId: string, tx?: Tx) {
  const v = await templateVersionsRepo.getById(templateVersionId, tx);
  if (v.templateId !== template.id || v.brandId !== template.brandId)
    throw new NotFoundError('TemplateVersion', templateVersionId);
  return v;
}
async function loadCurrentRevision(doc: DocumentRow, tx?: Tx) {
  if (!doc.currentRevisionId) throw new NotFoundError('CreativeRevision', doc.id);
  return loadRevision(doc, doc.currentRevisionId, tx);
}

/**
 * Spec 8.3 / 11.4: the brand snapshot a document is designed against. A brand without a published version cannot
 * host a document; the brand module reports that as NOT_FOUND on the published version, which is a validation
 * problem with the request here, not a missing resource.
 */
async function resolveSnapshot(
  actor: ResolvedActor,
  brandId: string,
  versionId: string | undefined,
  tx?: Tx,
) {
  try {
    return await brandService.resolveBrandSnapshot(actor, { brandId, versionId }, tx);
  } catch (err) {
    if (err instanceof NotFoundError && err.resourceType === 'PublishedBrandVersion')
      throw new ValidationFailedError(
        [{ path: 'brandId', issue: 'brand_has_no_published_version' }],
        'The brand has no published version to design against',
      );
    throw err;
  }
}

/** The minimal valid document (spec 11.2): one page in the default format, no elements. */
function minimalDocument(brandVersionId: string): CreativeDocumentV1 {
  const format = FORMAT_DEFINITIONS[DEFAULT_FORMAT_KEY];
  if (!format) throw new Error(`format ${DEFAULT_FORMAT_KEY} is not defined`);
  return {
    schemaVersion: 1,
    brandVersionId,
    pages: [
      {
        id: 'page_1',
        name: 'Page 1',
        formatKey: format.key,
        width: format.width,
        height: format.height,
        elements: [],
        layoutConstraints: [],
      },
    ],
    variants: [],
  };
}

/**
 * Revision 1 has no parent. Its batch is the addPage sequence that reproduces the snapshot from nothing, so
 * every revision's `operations` replays; baseRevisionId is empty because there is no base (parent_revision_id is null).
 */
const initialBatch = (document: CreativeDocumentV1, origin: 'user' | 'agent'): OperationBatch => ({
  baseRevisionId: '',
  operations: document.pages.map((page, index) => ({ op: 'addPage', page, index })),
  summary: 'Initial document',
  origin,
});

/** Asset versions an element tree references: image, logo and background layers (still images), text fonts. */
const assetRefsIn = (elements: readonly Element[]): AssetRef[] => elementAssetRefs(elements);

/** Spec 11.4 guardAssets: the asset versions an operation introduces into the document. */
function referencedAssetRefs(op: Operation, template: TemplateDocument | undefined): AssetRef[] {
  switch (op.op) {
    case 'insertElement':
      return assetRefsIn([op.element]);
    case 'replaceAsset':
      return [{ assetVersionId: op.assetVersionId, purpose: 'creative', kinds: IMAGE_CREATIVE_KINDS }];
    case 'setStyle': {
      const font = op.patch['fontAssetVersionId'];
      return typeof font === 'string' ? [{ assetVersionId: font, purpose: 'font' }] : [];
    }
    case 'addPage':
      return assetRefsIn(op.page.elements);
    case 'applyTemplate':
      return template ? assetRefsIn(template.page.elements) : [];
    default:
      return [];
  }
}

/** One authorisation per distinct (asset version, purpose, kinds). */
const distinctRefs = (refs: readonly AssetRef[]): AssetRef[] => distinctKindedRefs(refs as KindedAssetRef[]);

/** guardAssets: every reference authorised for its purpose and the kinds its place accepts. */
async function authoriseRefs(refs: readonly AssetRef[], brandId: string, tx: Tx): Promise<void> {
  const { tenantId } = requireTenant();
  for (const ref of distinctRefs(refs))
    await assetAuthoriser(
      ref.assetVersionId,
      { tenantId, brandId, purpose: ref.purpose, ...(ref.kinds ? { kinds: ref.kinds } : {}) },
      tx,
    );
}

const elementIdsOfPage = (doc: CreativeDocumentV1, pageId: string): string[] => {
  const page = doc.pages.find((p) => p.id === pageId);
  return page ? allElementIds({ ...doc, pages: [page] }) : [];
};

/**
 * Spec 6.3 slot semantics at version creation: an enforced kind must match the template element it points at, text
 * length limits apply to text slots only and must be ordered. Consumers are then checked by the reducer.
 */
function slotDefinitionIssues(document: CreativeDocumentV1, slot: TemplateSlot, i: number): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  const element = document.pages.map((p) => findElement(p, slot.elementId)).find((e) => e !== null);
  const kind = TemplateSlotKind.safeParse(slot.kind);
  if (element && kind.success && element.type !== kind.data)
    issues.push({ path: `slots.${i}.kind`, issue: `slot_kind_mismatch: element is ${element.type}` });
  const { minLength, maxLength } = slot.constraints;
  if ((minLength !== undefined || maxLength !== undefined) && element && element.type !== 'text')
    issues.push({ path: `slots.${i}.constraints`, issue: 'length_limits_apply_to_text_slots' });
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
    issues.push({ path: `slots.${i}.constraints.minLength`, issue: 'must not exceed maxLength' });
  return issues;
}

/**
 * applyTemplate needs the template version document (the reducer never fetches). Only approved versions of the
 * document's own brand can be applied; the template page in the target page's format is used, else the first page.
 */
async function resolveTemplate(
  doc: DocumentRow,
  op: Extract<Operation, { op: 'applyTemplate' }>,
  current: CreativeDocumentV1,
  index: number,
  tx: Tx,
): Promise<TemplateDocument> {
  const tv = await templateVersionsRepo.getById(op.templateVersionId, tx);
  if (tv.brandId !== doc.brandId) throw new NotFoundError('TemplateVersion', op.templateVersionId);
  if (tv.state !== 'approved')
    throw new ValidationFailedError(
      [{ path: `operations.${index}.templateVersionId`, issue: 'template_version_not_approved' }],
      'Only approved template versions can be applied',
    );
  const document = CreativeDocumentV1.parse(tv.document);
  const target = current.pages.find((p) => p.id === op.pageId);
  const page =
    document.pages.find((p) => target !== undefined && p.formatKey === target.formatKey) ?? document.pages[0];
  if (!page)
    throw new ValidationFailedError([
      { path: `operations.${index}.templateVersionId`, issue: 'template_has_no_pages' },
    ]);
  return { page, slots: TemplateSlot.array().parse(tv.slots) };
}

/**
 * Spec 11.4, the pure part shared by apply and propose: guards, asset authorisation and the reducer per operation,
 * then schema bounds and brand validation. Nothing is written here.
 */
async function evaluateBatch(
  actor: ResolvedActor,
  doc: DocumentRow,
  base: RevisionRow,
  batch: OperationBatch,
  tx: Tx,
) {
  const baseDocument = CreativeDocumentV1.parse(base.snapshot);
  const snapshot = await resolveSnapshot(actor, doc.brandId, baseDocument.brandVersionId, tx);
  let next = structuredClone(baseDocument);
  const templates: Record<string, TemplateDocument> = {};
  const changed = new Set(changedElementIds(batch));
  for (const [index, op] of batch.operations.entries()) {
    try {
      guardProtected(next, op, batch.origin); // agents cannot touch protected elements
      guardLogoInsertion(op, batch.origin); // agents cannot add logos
      if (op.op === 'applyTemplate') {
        templates[op.templateVersionId] ??= await resolveTemplate(doc, op, next, index, tx);
        for (const id of elementIdsOfPage(next, op.pageId)) changed.add(id); // every element of the page is replaced
      }
      const template = op.op === 'applyTemplate' ? templates[op.templateVersionId] : undefined;
      await authoriseRefs(referencedAssetRefs(op, template), doc.brandId, tx);
      next = reduce(next, op, { templates }); // pure; packages/editor/src/reduce.ts
    } catch (err) {
      if (err instanceof SlotConstraintError)
        throw new ValidationFailedError(
          err.findings.map((f) => ({
            path: `operations.${index}.slotBindings.${f.slotKey}`,
            issue: f.code,
          })),
          'The slot bindings do not satisfy the template',
        );
      if (err instanceof OperationError)
        throw new ValidationFailedError(
          [{ path: `operations.${index}`, issue: err.code }],
          'An operation could not be applied to the document',
        );
      throw err;
    }
  }
  const parsed = CreativeDocumentV1.parse(next); // schema bounds
  const findings = validateAgainstBrand(parsed, snapshot); // tokens, logo rules, min sizes, contrast, facts
  return { next: parsed, findings, contentHash: hashCanonical(parsed), changedElementIds: [...changed] };
}

/** A video document's current project, the timed sources it uses and what is known about them. */
const videoSnapshotOf = (r: RevisionRow): VideoProjectV1 =>
  parseSnapshot('video', r.snapshot).snapshot as VideoProjectV1;

/**
 * The timeline counterpart of evaluateBatch (STU-2b): agent guards (locks, protected overlays), asset authorisation
 * with the kinds each place accepts, sources described by the assets module so the reducer can hold in < out <=
 * source duration, the pure reducer per operation, schema bounds, then the project's findings (missing sources,
 * clips beyond their source, overlays through the brand rules). Nothing is written here.
 */
async function evaluateVideoBatch(
  actor: ResolvedActor,
  doc: DocumentRow,
  base: RevisionRow,
  batch: VideoOperationBatch,
  tx: Tx,
  opts: {
    scope?: VideoAiScope | null;
    /** A scope already resolved (and grown) by an earlier part of the same change, carried across parts. */
    scopeState?: VideoScopeState | null;
  } = {},
) {
  const project = videoSnapshotOf(base);
  const snapshot = await resolveSnapshot(actor, doc.brandId, project.brandVersionId, tx);
  let next = structuredClone(project);
  const media = await mediaLookup(timedAssetIds(project), tx);
  const changed = new Set<string>();
  // STU-3: an agent batch made for a scoped request is held to that scope (resolved against the base project).
  const scope =
    batch.origin !== 'agent'
      ? null
      : opts.scopeState !== undefined
        ? opts.scopeState
        : videoScopeOf(project, opts.scope ?? null);
  for (const [index, op] of batch.operations.entries()) {
    try {
      guardVideoAgentScoped(next, op, batch.origin, scope);
      const refs = videoOpAssetRefs(op, (id) => next.tracks.find((t) => t.id === id)?.kind);
      await authoriseRefs(refs, doc.brandId, tx);
      const unknown = refs.map((r) => r.assetVersionId).filter((id) => !(id in media));
      Object.assign(media, await mediaLookup(unknown, tx));
      const reduced = reduceVideo(next, op, { media: asLookup(media), strictMedia: true });
      guardVideoScopeChange(next, reduced, op, scope);
      next = reduced;
      for (const id of videoOpItemIds(op)) changed.add(id);
    } catch (err) {
      if (err instanceof VideoOperationError)
        throw new ValidationFailedError(
          [{ path: `operations.${index}`, issue: `${err.code}: ${err.message}` }],
          err.message,
        );
      throw err;
    }
  }
  const parsed = parseSnapshot('video', next).snapshot as VideoProjectV1; // schema bounds
  const findings = validateVideoProject(parsed, { media, snapshot });
  return { next: parsed, findings, contentHash: hashCanonical(parsed), changedItemIds: [...changed], media };
}

/**
 * The write half of operations.applyVideo (STU-2b), shared with STU-3's assembly and proposal accept: the insert-only
 * revision (with its generation inputs when an AI job produced it), the head move, outdated comments, the
 * revision_created event, the approvals hook and the audit record. The caller locked the document, checked the stale
 * base and evaluated the batch.
 */
async function commitVideoRevision(
  actor: ResolvedActor,
  doc: DocumentRow,
  base: RevisionRow,
  batch: VideoOperationBatch,
  evaluated: Awaited<ReturnType<typeof evaluateVideoBatch>>,
  tx: Tx,
  generationInputs: VideoGenerationInputs | null = null,
) {
  assertAgentClean(batch.origin, evaluated.findings);
  const revisionId = newId('creativeRevision');
  const number = base.number + 1;
  await revisionsRepo.create(
    {
      id: revisionId,
      brandId: doc.brandId,
      documentId: doc.id,
      parentRevisionId: base.id,
      number,
      brandVersionId: evaluated.next.brandVersionId,
      agentRunId: batch.agentRunId ?? null,
      authorKind: batch.origin,
      authorId: actor.id,
      changeSummary: batch.summary,
      operations: batch,
      snapshot: evaluated.next,
      contentHash: evaluated.contentHash,
      generationInputs,
    },
    tx,
  );
  await documentsRepo.setCurrentRevision(doc.id, doc.version, revisionId, tx);
  const outdatedComments = await commentsRepo.markOutdated(doc.brandId, doc.id, evaluated.changedItemIds, tx); // comments anchored to a timeline item outdate when it changes
  await outbox.add(
    'creative.revision_created',
    { type: 'creative_document', id: doc.id, version: doc.version + 1 },
    {
      documentId: doc.id,
      revisionId,
      number,
      contentHash: evaluated.contentHash,
      brandVersionId: evaluated.next.brandVersionId,
    },
    tx,
    { brandId: doc.brandId },
  );
  await revisionChangeHook(doc.id, tx);
  await audit.record(
    actorRef(actor),
    'creative.operations.apply',
    { type: 'creative_revision', id: revisionId },
    'allowed',
    tx,
    {
      brandId: doc.brandId,
      revisionId,
      count: batch.operations.length,
      runId: batch.agentRunId ?? null,
      scope: 'video',
    },
  );
  return {
    revision: toRevisionDto(await revisionsRepo.getById(revisionId, tx), 'video'),
    findings: evaluated.findings,
    media: Object.values(evaluated.media),
    outdatedComments,
    version: doc.version + 1,
  };
}

/** Longest edge of a proposal preview: small enough to draw inline beside the conversation. */
export const PREVIEW_MAX_EDGE_PX = 320;

/**
 * Spec 11.4 "returns a preview render and diff without committing". The synchronous preview is low-resolution: the
 * proposed snapshot drawn by the same scene code the studio and the render worker share (packages/editor/src/renderer,
 * pinned by rendererVersion) at `scale`, for the pages the batch touched. When the caller asks for `previewRender`,
 * the worker also renders the proposed snapshot (a preview render job against the committed base revision, the
 * snapshot kept in render_previews); its output lands in preview_exports, never in rendered_exports, so it is never
 * publishable. Pages whose content did not change are left out of the scene preview.
 */
function previewOf(base: CreativeDocumentV1, next: CreativeDocumentV1) {
  const basePages = new Map(base.pages.map((p) => [p.id, hashCanonical(p)]));
  const touched = (page: CreativePage) => basePages.get(page.id) !== hashCanonical(page);
  return {
    kind: 'scene' as const,
    rendererVersion: RENDERER_VERSION,
    publishable: false as const,
    pages: next.pages.filter(touched).map((page) => {
      const scale = Math.min(1, PREVIEW_MAX_EDGE_PX / Math.max(page.width, page.height));
      return {
        pageId: page.id,
        formatKey: page.formatKey,
        width: Math.max(1, Math.round(page.width * scale)),
        height: Math.max(1, Math.round(page.height * scale)),
        scale,
      };
    }),
  };
}

/** Graphic operations on a video (or the reverse) are a request for the wrong procedure, not a reducer error. */
function assertGraphic(doc: DocumentRow): void {
  if (doc.kind !== 'graphic')
    throw new ValidationFailedError(
      [{ path: 'documentId', issue: 'document_is_video' }],
      'This document is a video; edit it with timeline operations (operations.applyVideo)',
    );
}
function assertVideo(doc: DocumentRow): void {
  if (doc.kind !== 'video')
    throw new ValidationFailedError(
      [{ path: 'documentId', issue: 'document_is_graphic' }],
      'This document is a graphic; edit it with graphic operations (operations.applyBatch)',
    );
}

async function assertStale(doc: DocumentRow, baseRevisionId: string) {
  if (!doc.currentRevisionId || doc.currentRevisionId !== baseRevisionId)
    throw new StaleRevisionError(doc.currentRevisionId ?? ''); // 409; the client rebases or branches
}

// ---- DTO mappers: JSON documents are validated on read as well as on write (spec 6.1) ----

const StringList = z.array(z.string());

const toDocumentDto = (d: DocumentRow) => ({
  id: d.id,
  brandId: d.brandId,
  contentPackageId: d.contentPackageId,
  title: d.title,
  currentRevisionId: d.currentRevisionId,
  schemaVersion: d.schemaVersion,
  /** STU-2b: graphic (pages) or video (timeline). */
  kind: d.kind,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
  version: d.version,
});
/**
 * A revision as its document's kind: graphic revisions carry CreativeDocumentV1 and graphic operations, video
 * revisions VideoProjectV1 and timeline operations (`kind` discriminates the two for the client).
 */
const revisionBase = (r: RevisionRow) => ({
  id: r.id,
  documentId: r.documentId,
  parentRevisionId: r.parentRevisionId,
  number: r.number,
  brandVersionId: r.brandVersionId,
  agentRunId: r.agentRunId,
  authorKind: r.authorKind,
  authorId: r.authorId,
  changeSummary: r.changeSummary,
  contentHash: r.contentHash,
  createdAt: r.createdAt.toISOString(),
});
type GraphicRevisionDto = ReturnType<typeof revisionBase> & {
  kind: 'graphic';
  operations: OperationBatch;
  snapshot: CreativeDocumentV1;
};
type VideoRevisionDto = ReturnType<typeof revisionBase> & {
  kind: 'video';
  operations: VideoOperationBatch;
  snapshot: VideoProjectV1;
};
function toRevisionDto(r: RevisionRow, kind: 'graphic'): GraphicRevisionDto;
function toRevisionDto(r: RevisionRow, kind: 'video'): VideoRevisionDto;
function toRevisionDto(r: RevisionRow, kind: DocumentKind): GraphicRevisionDto | VideoRevisionDto;
function toRevisionDto(r: RevisionRow, kind: DocumentKind): GraphicRevisionDto | VideoRevisionDto {
  return { ...revisionBase(r), ...parseRevisionContent(kind, r.operations, r.snapshot) };
}
const toRevisionSummary = (r: RevisionRow, kind: DocumentKind) => ({
  id: r.id,
  documentId: r.documentId,
  parentRevisionId: r.parentRevisionId,
  number: r.number,
  brandVersionId: r.brandVersionId,
  agentRunId: r.agentRunId,
  authorKind: r.authorKind,
  authorId: r.authorId,
  changeSummary: r.changeSummary,
  kind,
  contentHash: r.contentHash,
  createdAt: r.createdAt.toISOString(),
});
const toCommentDto = (c: CommentRow) => ({
  id: c.id,
  documentId: c.documentId,
  revisionId: c.revisionId,
  elementId: c.elementId,
  body: c.body,
  authorKind: c.authorKind,
  authorId: c.authorId,
  state: c.state,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
  version: c.version,
});
/**
 * Storage keys and hashes only: delivery is the assets media endpoint, never a URL from here. `publishable` is
 * false for a preview export (spec 11.4): it can never be selected for a channel variant, bound or released.
 */
const toExportDto = (e: ExportRow) => ({
  id: e.id,
  revisionId: e.revisionId,
  pageId: e.pageId,
  formatKey: e.formatKey,
  mime: e.mime,
  width: e.width,
  height: e.height,
  bytes: e.bytes,
  storageKey: e.storageKey,
  contentHash: e.contentHash,
  rendererVersion: e.rendererVersion,
  manifest: RenderManifest.parse(e.manifest),
  validation: RenderValidationResult.parse(e.validation),
  publishable: true,
  // STU-2a video exports (video/mp4); null for stills.
  durationMs: e.durationMs ?? null,
  fps: e.fps ?? null,
  posterStorageKey: e.posterStorageKey ?? null,
  captionsStorageKey: e.captionsStorageKey ?? null,
  dedupeKey: e.dedupeKey ?? null,
  createdAt: e.createdAt.toISOString(),
});
/** A preview export in the same shape; its revisionId is the committed base the proposal was made against. */
const toPreviewExportDto = (e: PreviewExportRow, preview: PreviewRow): ReturnType<typeof toExportDto> => ({
  id: e.id,
  revisionId: preview.baseRevisionId,
  pageId: e.pageId,
  formatKey: e.formatKey,
  mime: e.mime,
  width: e.width,
  height: e.height,
  bytes: e.bytes,
  storageKey: e.storageKey,
  contentHash: e.contentHash,
  rendererVersion: e.rendererVersion,
  manifest: RenderManifest.parse(e.manifest),
  validation: RenderValidationResult.parse(e.validation),
  publishable: false,
  durationMs: null,
  fps: null,
  posterStorageKey: null,
  captionsStorageKey: null,
  dedupeKey: null,
  createdAt: e.createdAt.toISOString(),
});
const exportIdsOf = (j: RenderJobRow) => StringList.parse(j.exportIds ?? []);
/** Exports in the order the worker recorded them (render_jobs.export_ids): ids minted in the same millisecond do not sort by time. */
const orderedExports = <E extends { id: string }>(exportIds: readonly string[], exports: E[]) => {
  const byId = new Map(exports.map((e) => [e.id, e]));
  return exportIds.map((id) => byId.get(id)).filter((e): e is E => e !== undefined);
};
const toRenderJobDto = (
  j: RenderJobRow,
  exports: Array<ReturnType<typeof toExportDto>>,
  preview: PreviewRow | null = null,
) => ({
  id: j.id,
  brandId: j.brandId,
  revisionId: j.revisionId,
  formatKeys: StringList.parse(j.formatKeys),
  state: j.state,
  attempts: j.attempts,
  error: j.error,
  /** STU-2a: phase and fraction of a long (video) render while it runs; null otherwise. */
  progress: j.progress ? RenderProgress.parse(j.progress) : null,
  requestedByKind: j.requestedByKind,
  requestedById: j.requestedById,
  exportIds: exportIdsOf(j),
  exports: orderedExports(exportIdsOf(j), exports),
  /** Set for a proposal preview: the proposed snapshot's hash; its exports are never publishable. */
  preview: preview ? { contentHash: preview.contentHash, baseRevisionId: preview.baseRevisionId } : null,
  createdAt: j.createdAt.toISOString(),
  updatedAt: j.updatedAt.toISOString(),
  version: j.version,
});

/** The job's exports as the read returns them: preview_exports for a preview job, rendered_exports otherwise. */
async function exportsOfJob(job: RenderJobRow, preview: PreviewRow | null, tx?: Tx) {
  return preview
    ? (await previewExportsRepo.listByIds(job.brandId, exportIdsOf(job), tx)).map((e) =>
        toPreviewExportDto(e, preview),
      )
    : (await exportsRepo.listByIds(job.brandId, exportIdsOf(job), tx)).map(toExportDto);
}

/**
 * Spec 11.5: one render job for a set of formats, audited and started through the outbox (renderJobWorkflowV1).
 * A preview job (spec 11.4) carries the proposed snapshot next to it; its revision is the committed base.
 */
async function queueRenderJob(
  actor: ResolvedActor,
  doc: DocumentRow,
  revision: RevisionRow,
  requested: readonly string[],
  tx: Tx,
  preview: { snapshot: CreativeDocumentV1; contentHash: string } | null = null,
) {
  const formatKeys = [...new Set(requested)];
  if (doc.kind === 'video') {
    // STU-2b: a video renders at its own output preset (one MP4 per job); there is no reflow to other formats.
    const project = videoSnapshotOf(revision);
    if (preview)
      throw new ValidationFailedError([{ path: 'previewRender', issue: 'not_available_for_video' }]);
    if (
      formatKeys.length !== 1 ||
      formatKeys[0] !== project.format.key ||
      !videoFormatFor(project.format.key)
    )
      throw new ValidationFailedError(
        [{ path: 'formatKeys', issue: `video_renders_at:${project.format.key}` }],
        `This video renders at its own format (${project.format.key})`,
      );
  } else {
    const unknown = formatKeys.filter((k) => FORMAT_DEFINITIONS[k] === undefined);
    if (unknown.length)
      throw new ValidationFailedError(
        unknown.map((k) => ({ path: 'formatKeys', issue: `unknown format ${k}` })),
      );
  }
  const id = newId('renderJob');
  await renderJobsRepo.create(
    {
      id,
      brandId: doc.brandId,
      revisionId: revision.id,
      formatKeys,
      state: 'pending',
      attempts: 0,
      error: null,
      requestedByKind: requesterKindOf(actor),
      requestedById: actor.id,
      exportIds: null,
    },
    tx,
  );
  if (preview)
    await previewsRepo.create(
      {
        id: newId('renderPreview'),
        brandId: doc.brandId,
        renderJobId: id,
        baseRevisionId: revision.id,
        snapshot: preview.snapshot,
        contentHash: preview.contentHash,
      },
      tx,
    );
  await audit.record(actorRef(actor), 'creative.render.request', { type: 'render_job', id }, 'allowed', tx, {
    brandId: doc.brandId,
    revisionId: revision.id,
    ...(preview ? { scope: 'preview' } : {}),
  });
  await outbox.add(
    'creative.render_requested',
    { type: 'render_job', id, version: 0 },
    {
      renderJobId: id,
      documentId: doc.id,
      revisionId: revision.id,
      formatKeys: formatKeys.join(','),
      actorKind: actor.kind,
      actorId: actor.id,
      // STU-2b: routes the job to videoRenderJobWorkflowV1 on task queue `video` (outbox-routes.ts).
      ...(doc.kind === 'video' ? { kind: 'video' } : {}),
    },
    tx,
    { brandId: doc.brandId },
  );
  return { renderJobId: id, state: 'pending' as const, version: 0 };
}
/** Revision 1 of a video: the tracks and scenes that build the project (no parent, like a graphic revision 1). */
const initialVideoBatch = (project: VideoProjectV1, origin: 'user' | 'agent'): VideoOperationBatch => ({
  baseRevisionId: '',
  operations: [
    ...project.tracks.map((track, index) => ({ op: 'addTrack' as const, track, index })),
    ...project.scenes.map((scene) => ({ op: 'setScene' as const, scene })),
  ],
  summary: project.templateKey ? `Initial video from template ${project.templateKey}` : 'Initial video',
  origin,
});

/**
 * Spec 11.1: the document row and its revision 1 in one transaction, audited, with the revision_created event.
 * The same for both kinds; the snapshot and operations are already validated for the document's kind.
 */
async function insertNewDocument(
  actor: ResolvedActor,
  d: {
    brandId: string;
    title: string;
    contentPackageId: string | null;
    kind: DocumentKind;
    snapshot: CreativeDocumentV1 | VideoProjectV1;
    operations: OperationBatch | VideoOperationBatch;
    brandVersionId: string;
    origin: 'user' | 'agent';
    /** STU-3: a document an AI job created (a new-format version) records what produced it. */
    generationInputs?: VideoGenerationInputs | null;
  },
  tx: Tx,
) {
  const documentId = newId('creativeDocument');
  const revisionId = newId('creativeRevision');
  const contentHash = hashCanonical(d.snapshot);
  await documentsRepo.create(
    {
      id: documentId,
      brandId: d.brandId,
      contentPackageId: d.contentPackageId,
      title: d.title,
      currentRevisionId: null,
      schemaVersion: d.snapshot.schemaVersion,
      kind: d.kind,
    },
    tx,
  );
  await revisionsRepo.create(
    {
      id: revisionId,
      brandId: d.brandId,
      documentId,
      parentRevisionId: null,
      number: 1,
      brandVersionId: d.brandVersionId,
      agentRunId: null,
      authorKind: d.origin,
      authorId: actor.id,
      changeSummary: d.kind === 'video' ? 'Initial video' : 'Initial document',
      operations: d.operations,
      snapshot: d.snapshot,
      contentHash,
      generationInputs: d.generationInputs ?? null,
    },
    tx,
  );
  await documentsRepo.setCurrentRevision(documentId, 0, revisionId, tx);
  await audit.record(
    actorRef(actor),
    'creative.document.create',
    { type: 'creative_document', id: documentId },
    'allowed',
    tx,
    { brandId: d.brandId, revisionId, ...(d.kind === 'video' ? { scope: 'video' } : {}) },
  );
  await outbox.add(
    'creative.revision_created',
    { type: 'creative_document', id: documentId, version: 1 },
    { documentId, revisionId, number: 1, contentHash, brandVersionId: d.brandVersionId },
    tx,
    { brandId: d.brandId },
  );
  return { documentId, revisionId, number: 1, version: 1, contentHash, kind: d.kind };
}

const toTemplateDto = (t: TemplateRow) => ({
  id: t.id,
  brandId: t.brandId,
  name: t.name,
  currentVersionId: t.currentVersionId,
  state: t.state,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
  version: t.version,
});
const toTemplateVersionDto = (v: TemplateVersionRow) => ({
  id: v.id,
  templateId: v.templateId,
  number: v.number,
  slots: TemplateSlot.array().parse(v.slots),
  constraints: v.constraints,
  formats: StringList.parse(v.formats),
  document: CreativeDocumentV1.parse(v.document),
  contentHash: v.contentHash,
  state: v.state,
  createdAt: v.createdAt.toISOString(),
});
const toTemplateVersionSummary = (v: TemplateVersionRow) => {
  const { document: _document, ...summary } = toTemplateVersionDto(v);
  return summary;
};

export const creativeService = {
  documents: {
    /**
     * Spec 11.1/11.4: a document is born with revision 1 in the same transaction. It is designed against the
     * brand's published version (the snapshot's brandVersionId is authoritative) and every asset the initial
     * document references is authorised, exactly as an operation would be.
     */
    async create(
      actor: ResolvedActor,
      input: z.infer<typeof DocumentCreate>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = DocumentCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx); // a foreign or invisible brand is NOT_FOUND
      await policy.assert(actor, 'creative.edit', brandResource(brand.id), opts, tx);
      const snapshot = await resolveSnapshot(actor, brand.id, undefined, tx);
      const origin = authorKindOf(actor);
      const kind: DocumentKind = parsed.kind ?? 'graphic';
      if (kind === 'video') {
        // STU-2b: a timeline from an output preset, or from a built-in starter template bound to the brand.
        if (parsed.document)
          throw new ValidationFailedError([{ path: 'document', issue: 'graphic_document_for_video' }]);
        if (!parsed.video)
          throw new ValidationFailedError(
            [{ path: 'video', issue: 'required' }],
            'A video needs an output format (9:16, 1:1, 4:5 or 16:9) and a frame rate',
          );
        const bindings = await brandBindings(snapshot, tx);
        const options = parsed.video;
        const project = options.templateKey
          ? instantiateVideoTemplate(options.templateKey, bindings, { fps: options.fps })
          : blankVideoProject(bindings, {
              formatKey: options.formatKey,
              fps: options.fps,
              ...(options.durationMs ? { durationMs: options.durationMs } : {}),
            });
        if (!project)
          throw new ValidationFailedError([{ path: 'video.templateKey', issue: 'unknown_template' }]);
        const video = parseSnapshot('video', project).snapshot as VideoProjectV1;
        await authoriseRefs(projectAssetRefs(video), brand.id, tx);
        const findings = validateVideoProject(video, {
          media: await mediaLookup(timedAssetIds(video), tx),
          snapshot,
        });
        assertAgentClean(origin, findings);
        const created = await insertNewDocument(
          actor,
          {
            brandId: brand.id,
            title: parsed.title,
            contentPackageId: parsed.contentPackageId ?? null,
            kind,
            snapshot: video,
            operations: initialVideoBatch(video, origin),
            brandVersionId: snapshot.brandVersionId,
            origin,
          },
          tx,
        );
        return { ...created, findings };
      }
      if (parsed.video)
        throw new ValidationFailedError([{ path: 'video', issue: 'video_options_for_graphic' }]);
      const document = CreativeDocumentV1.parse({
        ...(parsed.document ?? minimalDocument(snapshot.brandVersionId)),
        brandVersionId: snapshot.brandVersionId,
      });
      await authoriseRefs(assetRefsIn(document.pages.flatMap((p) => p.elements)), brand.id, tx);
      const findings = validateAgainstBrand(document, snapshot);
      assertAgentClean(origin, findings);
      const created = await insertNewDocument(
        actor,
        {
          brandId: brand.id,
          title: parsed.title,
          contentPackageId: parsed.contentPackageId ?? null,
          kind,
          snapshot: document,
          operations: initialBatch(document, origin),
          brandVersionId: snapshot.brandVersionId,
          origin,
        },
        tx,
      );
      return { ...created, findings };
    },

    /** Save/reopen: the document row plus the committed snapshot of its current revision. */
    async get(actor: ResolvedActor, input: z.infer<typeof DocumentGet>, tx?: Tx) {
      const parsed = DocumentGet.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const current = await loadCurrentRevision(doc, tx);
      const revision = toRevisionDto(current, doc.kind);
      // STU-2b: a video carries what is known about its sources (kind, duration, size, sound, derivatives), so the
      // editor checks edits against them and fetches proxies, strips and waveforms without probing.
      const media =
        revision.kind === 'video'
          ? Object.values(await mediaLookup(timedAssetIds(revision.snapshot), tx))
          : [];
      return { ...toDocumentDto(doc), revision, media };
    },

    /** The brand's documents, newest first, without their revisions (get returns the current one); creative.read. */
    async list(actor: ResolvedActor, input: z.infer<typeof DocumentList>, tx?: Tx) {
      const parsed = DocumentList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx); // a foreign or invisible brand is NOT_FOUND
      await policy.assert(actor, 'creative.read', brandResource(brand.id), {}, tx);
      const page = await documentsRepo.list(
        brand.id,
        parsed.contentPackageId ? { contentPackageId: parsed.contentPackageId } : {},
        parsed.page,
        tx,
      );
      return { items: page.items.map(toDocumentDto), nextCursor: page.nextCursor };
    },
  },

  revisions: {
    /** History is never rewritten: every revision of the document, newest first. */
    async list(actor: ResolvedActor, input: z.infer<typeof RevisionList>, tx?: Tx) {
      const parsed = RevisionList.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const page = await revisionsRepo.list(doc.brandId, doc.id, parsed.page, tx);
      return { items: page.items.map((r) => toRevisionSummary(r, doc.kind)), nextCursor: page.nextCursor };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof RevisionGet>, tx?: Tx) {
      const parsed = RevisionGet.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      return toRevisionDto(await loadRevision(doc, parsed.revisionId, tx), doc.kind);
    },
  },

  operations: {
    /**
     * Spec 11.4 applyOperations, literally: lock + load (tenant-scoped), policy, stale check (409), base revision,
     * brand snapshot pinned to the base's brand version, guards + asset authorisation + reduce per operation,
     * schema bounds, brand validation (agents must be clean), insert-only revision, optimistic head move,
     * comment outdating, outbox event, approvals hook, audit. All in the caller's transaction.
     */
    async apply(
      actor: ResolvedActor,
      input: z.infer<typeof OperationsApply>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const { documentId, ...batch } = OperationsApply.parse(input);
      const doc = await documentsRepo.lock(documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      assertGraphic(doc);
      assertOrigin(actor, batch.origin);
      await assertStale(doc, batch.baseRevisionId);
      const base = await loadRevision(doc, batch.baseRevisionId, tx);
      const evaluated = await evaluateBatch(actor, doc, base, batch, tx);
      assertAgentClean(batch.origin, evaluated.findings);
      const revisionId = newId('creativeRevision');
      const number = base.number + 1;
      await revisionsRepo.create(
        {
          id: revisionId,
          brandId: doc.brandId,
          documentId: doc.id,
          parentRevisionId: base.id,
          number,
          brandVersionId: evaluated.next.brandVersionId,
          agentRunId: batch.agentRunId ?? null,
          authorKind: batch.origin,
          authorId: actor.id,
          changeSummary: batch.summary,
          operations: batch,
          snapshot: evaluated.next,
          contentHash: evaluated.contentHash,
        },
        tx,
      );
      await documentsRepo.setCurrentRevision(doc.id, doc.version, revisionId, tx);
      const outdatedComments = await commentsRepo.markOutdated(
        doc.brandId,
        doc.id,
        evaluated.changedElementIds,
        tx,
      ); // anchored comments never silently drift
      await outbox.add(
        'creative.revision_created',
        { type: 'creative_document', id: doc.id, version: doc.version + 1 },
        {
          documentId: doc.id,
          revisionId,
          number,
          contentHash: evaluated.contentHash,
          brandVersionId: evaluated.next.brandVersionId,
        },
        tx,
        { brandId: doc.brandId },
      );
      await revisionChangeHook(doc.id, tx); // any approval bound to the old hash (Phase 5)
      await audit.record(
        actorRef(actor),
        'creative.operations.apply',
        { type: 'creative_revision', id: revisionId },
        'allowed',
        tx,
        { brandId: doc.brandId, revisionId, count: batch.operations.length, runId: batch.agentRunId ?? null },
      );
      return {
        revision: toRevisionDto(await revisionsRepo.getById(revisionId, tx), 'graphic'),
        findings: evaluated.findings,
        outdatedComments,
        version: doc.version + 1,
      };
    },

    /**
     * Spec 11.4 agent flow: the same guards, reduction and validation as a dry run, nothing written. Findings are
     * returned even when blocking; the caller (agent run or studio overlay) decides what to do with them.
     */
    async propose(
      actor: ResolvedActor,
      input: z.infer<typeof OperationsPropose>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const { documentId, previewRender, ...batch } = OperationsPropose.parse(input);
      const doc = await documentsRepo.getById(documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      assertGraphic(doc);
      assertOrigin(actor, batch.origin);
      await assertStale(doc, batch.baseRevisionId);
      const base = await loadRevision(doc, batch.baseRevisionId, tx);
      const {
        next,
        findings,
        contentHash,
        changedElementIds: changed,
      } = await evaluateBatch(actor, doc, base, batch, tx);
      let renderJobId: string | null = null;
      // Behind `creative.preview_render` (default off) until every worker-render is preview-aware: with the flag
      // off the proposal keeps its scene preview only and nothing is queued (docs/runbooks/deploy-railway.md).
      if (
        previewRender &&
        (await featureFlag.isEnabled('creative.preview_render', requireTenant().tenantId, tx))
      ) {
        // Nothing is committed to the document: the job renders the proposed snapshot next to the base revision.
        await policy.assert(actor, 'creative.render', documentResource(doc), opts, tx);
        const queued = await queueRenderJob(actor, doc, base, previewRender.formatKeys, tx, {
          snapshot: next,
          contentHash,
        });
        renderJobId = queued.renderJobId;
      }
      return {
        baseRevisionId: base.id,
        snapshot: next,
        contentHash,
        findings,
        changedElementIds: changed,
        blocking: findings.some(isBlocking),
        preview: {
          ...previewOf(CreativeDocumentV1.parse(base.snapshot), next),
          ...(renderJobId ? { renderJobId } : {}), // the worker preview render, when one was queued
        },
      };
    },
  },

  /**
   * STU-2b timeline operations: the same flow as operations.apply/propose (lock, policy, stale check, guards, asset
   * authorisation, pure reducer, validation, insert-only revision, head move, events, approvals hook, audit) with
   * VideoOperation batches against a video document's VideoProjectV1.
   */
  videoOperations: {
    async apply(
      actor: ResolvedActor,
      input: z.infer<typeof VideoOperationsApply>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const { documentId, ...batch } = VideoOperationsApply.parse(input);
      const doc = await documentsRepo.lock(documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      assertVideo(doc);
      assertOrigin(actor, batch.origin);
      await assertStale(doc, batch.baseRevisionId);
      const base = await loadRevision(doc, batch.baseRevisionId, tx);
      const evaluated = await evaluateVideoBatch(actor, doc, base, batch, tx);
      return commitVideoRevision(actor, doc, base, batch, evaluated, tx);
    },

    /** The dry run: findings are returned even when blocking; nothing is written. */
    async propose(
      actor: ResolvedActor,
      input: z.infer<typeof VideoOperationsPropose>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const { documentId, ...batch } = VideoOperationsPropose.parse(input);
      const doc = await documentsRepo.getById(documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      assertVideo(doc);
      assertOrigin(actor, batch.origin);
      await assertStale(doc, batch.baseRevisionId);
      const base = await loadRevision(doc, batch.baseRevisionId, tx);
      const evaluated = await evaluateVideoBatch(actor, doc, base, batch, tx);
      return {
        baseRevisionId: base.id,
        snapshot: evaluated.next,
        contentHash: evaluated.contentHash,
        findings: evaluated.findings,
        changedItemIds: evaluated.changedItemIds,
        blocking: evaluated.findings.some(isBlocking),
      };
    },
  },

  /** STU-2b: the built-in starter video templates (STU-1a's creation screen lists them); creative.read on the brand. */
  videoTemplates: {
    async list(actor: ResolvedActor, input: z.infer<typeof VideoTemplateList>, tx?: Tx) {
      const parsed = VideoTemplateList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'creative.read', brandResource(brand.id), {}, tx);
      return { items: listVideoTemplates() };
    },
  },

  renders: {
    /** Spec 11.5: a render job per revision and set of formats; the worker picks it up from the outbox event. */
    async request(
      actor: ResolvedActor,
      input: z.infer<typeof RenderRequest>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = RenderRequest.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.render', documentResource(doc), opts, tx);
      const revision = await loadRevision(doc, parsed.revisionId, tx);
      return queueRenderJob(actor, doc, revision, parsed.formatKeys, tx);
    },

    /**
     * Spec 14.5: the exports a channel variant publishes, in the variant's order, for the composition root's
     * publish media source (the assets module mints the release URLs). A missing or foreign export is NOT_FOUND:
     * a variant can never publish with fewer files than its approval pinned.
     */
    async exportsByIds(brandId: string, exportIds: readonly string[], tx?: Tx) {
      const rows = await exportsRepo.listByIds(brandId, exportIds, tx);
      const byId = new Map(rows.map((e) => [e.id, e]));
      return exportIds.map((id) => {
        const e = byId.get(id);
        if (!e) throw new NotFoundError('RenderedExport', id);
        return toExportDto(e);
      });
    },

    /**
     * STU-2b render worker: an earlier video export with the same dedupe key (same project snapshot, renderer,
     * format, frame rate and pinned source bytes), newest first, so an identical render reuses its file.
     */
    async findVideoExport(brandId: string, dedupeKey: string, tx?: Tx) {
      const e = await exportsRepo.findByDedupeKey(brandId, dedupeKey, tx);
      return e ? toExportDto(e) : null;
    },

    /** The exports that still exist among the ids, in id order (a review manifest may name a deleted one). */
    async findByIds(brandId: string, exportIds: readonly string[], tx?: Tx) {
      return (await exportsRepo.listByIds(brandId, exportIds, tx)).map(toExportDto);
    },

    /** The job with its exports: storage keys and hashes only (delivery is the assets media endpoint). */
    async get(actor: ResolvedActor, input: z.infer<typeof RenderGet>, tx?: Tx) {
      const parsed = RenderGet.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const revision = await revisionsRepo.getById(job.revisionId, tx);
      const doc = await documentsRepo.getById(revision.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const preview = await previewsRepo.findForJob(job.id, tx);
      return toRenderJobDto(job, await exportsOfJob(job, preview, tx), preview);
    },

    /**
     * STU-2b: signed URLs of a ready job's exports, with the poster and captions of a video; creative.read. A job
     * that is not ready (or a preview job) has none.
     */
    async exportMedia(actor: ResolvedActor, input: z.infer<typeof RenderGet>, tx?: Tx) {
      const parsed = RenderGet.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const revision = await revisionsRepo.getById(job.revisionId, tx);
      const doc = await documentsRepo.getById(revision.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      if (job.state !== 'ready' || !exportSigner || (await previewsRepo.findForJob(job.id, tx)))
        return { items: [] };
      const sign = exportSigner;
      const items = [];
      for (const e of await exportsRepo.listByIds(job.brandId, exportIdsOf(job), tx)) {
        const main = await sign(e.storageKey);
        items.push({
          exportId: e.id,
          mime: e.mime,
          url: main.url,
          posterUrl: e.posterStorageKey ? (await sign(e.posterStorageKey)).url : null,
          captionsUrl: e.captionsStorageKey ? (await sign(e.captionsStorageKey)).url : null,
          expiresAt: main.expiresAt,
        });
      }
      return { items };
    },

    /**
     * Render worker: the proposed snapshot a preview job draws (null for a job that renders its committed revision).
     * Re-checks creative.read like the revision read it stands in for.
     */
    async previewSource(actor: ResolvedActor, input: z.infer<typeof RenderGet>, tx?: Tx) {
      const parsed = RenderGet.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const revision = await revisionsRepo.getById(job.revisionId, tx);
      const doc = await documentsRepo.getById(revision.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const preview = await previewsRepo.findForJob(job.id, tx);
      if (!preview) return null;
      const snapshot = CreativeDocumentV1.parse(preview.snapshot);
      return { snapshot, contentHash: preview.contentHash, brandVersionId: snapshot.brandVersionId };
    },

    /** Render worker (Phase 3 render stream): the job moves only by renderJobMachine; the worker never sets a state string. */
    async markRendering(input: z.infer<typeof RenderMarkRendering>, tx: Tx) {
      const parsed = RenderMarkRendering.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const toState = transition(renderJobMachine, job.state, 'start', 'renderJobId');
      await renderJobsRepo.update(job.id, job.version, { state: toState, attempts: job.attempts + 1 }, tx);
      await audit.record(
        requireTenant().actor,
        'creative.render.start',
        { type: 'render_job', id: job.id },
        'allowed',
        tx,
        { brandId: job.brandId, fromState: job.state, toState },
      );
      // Spec 17.2 render "keeping up": requested → picked up by the render worker (first start only).
      if (job.attempts === 0)
        record(METRIC.renderStartLagMs, Math.max(0, Date.now() - job.createdAt.getTime()));
      return { renderJobId: job.id, state: toState, attempts: job.attempts + 1, version: job.version + 1 };
    },

    /** Exports are insert-only evidence: each carries its manifest (fonts, asset versions, hashes) and validation result. */
    async markReady(input: z.infer<typeof RenderMarkReady>, tx: Tx) {
      const parsed = RenderMarkReady.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const toState = transition(renderJobMachine, job.state, 'succeed', 'renderJobId');
      const revision = await revisionsRepo.getById(job.revisionId, tx);
      const preview = await previewsRepo.findForJob(job.id, tx);
      const doc = await documentsRepo.getById(revision.documentId, tx);
      // A video's one export is the whole timeline (pageId VIDEO_EXPORT_PAGE_ID); a graphic's are its pages.
      const pageIds =
        doc.kind === 'video'
          ? new Set([VIDEO_EXPORT_PAGE_ID])
          : new Set(
              CreativeDocumentV1.parse(preview ? preview.snapshot : revision.snapshot).pages.map((p) => p.id),
            );
      const formats = new Set(StringList.parse(job.formatKeys));
      const details: ErrorDetail[] = [];
      parsed.exports.forEach((e, i) => {
        if (!pageIds.has(e.pageId))
          details.push({ path: `exports.${i}.pageId`, issue: 'page_not_in_revision' });
        if (!formats.has(e.formatKey))
          details.push({ path: `exports.${i}.formatKey`, issue: 'format_not_requested' });
      });
      if (details.length) throw new ValidationFailedError(details);
      const exportIds: string[] = [];
      for (const e of parsed.exports) {
        // A preview's output is never a rendered export: it cannot be selected, bound or published (spec 11.4).
        const id = newId(preview ? 'previewExport' : 'renderedExport');
        if (preview) {
          // Preview exports are stills of a proposal: the video-only fields have no columns there.
          const {
            durationMs: _d,
            fps: _f,
            posterStorageKey: _p,
            captionsStorageKey: _c,
            dedupeKey: _k,
            ...still
          } = e;
          await previewExportsRepo.create({ id, brandId: job.brandId, renderJobId: job.id, ...still }, tx);
        } else await exportsRepo.create({ id, brandId: job.brandId, revisionId: revision.id, ...e }, tx);
        exportIds.push(id);
      }
      await renderJobsRepo.update(job.id, job.version, { state: toState, exportIds, error: null }, tx);
      await audit.record(
        requireTenant().actor,
        'creative.render.ready',
        { type: 'render_job', id: job.id },
        'allowed',
        tx,
        {
          brandId: job.brandId,
          fromState: job.state,
          toState,
          count: exportIds.length,
          revisionId: revision.id,
        },
      );
      await outbox.add(
        'creative.render_completed',
        { type: 'render_job', id: job.id, version: job.version + 1 },
        { renderJobId: job.id, revisionId: revision.id, state: toState, exportCount: exportIds.length },
        tx,
        { brandId: job.brandId },
      );
      return { renderJobId: job.id, state: toState, exportIds, version: job.version + 1 };
    },

    /** STU-2a render worker: how far a long (video) job is; ignored once the job is no longer rendering. */
    async markProgress(input: z.infer<typeof RenderMarkProgress>, tx: Tx) {
      const parsed = RenderMarkProgress.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      if (job.state !== 'rendering') return { renderJobId: job.id, state: job.state, version: job.version };
      // No version bump (see setProgressWhileRendering): a cancel between two progress notes never conflicts.
      if (await renderJobsRepo.setProgressWhileRendering(job.id, parsed.progress, tx))
        return { renderJobId: job.id, state: job.state, version: job.version };
      const now = await renderJobsRepo.getById(job.id, tx);
      return { renderJobId: now.id, state: now.state, version: now.version };
    },

    /**
     * STU-2a: a person stops a pending or rendering job (a long video render). The job moves to `cancelled` by the
     * render job machine; the worker reads the state at its next step and stops. Authorised as requesting a render.
     */
    async cancel(actor: ResolvedActor, input: z.infer<typeof RenderCancel>, tx: Tx, opts: ActorOptions = {}) {
      const parsed = RenderCancel.parse(input);
      // Locked: the worker's state changes on the job wait for the cancel (and then find it cancelled).
      const job = await renderJobsRepo.lock(parsed.renderJobId, tx);
      const revision = await revisionsRepo.getById(job.revisionId, tx);
      const doc = await documentsRepo.getById(revision.documentId, tx);
      await policy.assert(actor, 'creative.render', documentResource(doc), opts, tx);
      const toState = transition(renderJobMachine, job.state, 'cancel', 'renderJobId');
      await renderJobsRepo.update(job.id, job.version, { state: toState, progress: null }, tx);
      // STU-2b: a running video render is stopped by a signal (relayed after commit), killing ffmpeg mid-encode.
      if (doc.kind === 'video')
        await outbox.add(
          'creative.render_cancel_requested',
          { type: 'render_job', id: job.id, version: job.version + 1 },
          { renderJobId: job.id },
          tx,
          { brandId: job.brandId },
        );
      await audit.record(
        { kind: actor.kind, id: actor.id },
        'creative.render.cancel',
        { type: 'render_job', id: job.id },
        'allowed',
        tx,
        { brandId: job.brandId, fromState: job.state, toState, reason: parsed.reason ?? null },
      );
      await outbox.add(
        'creative.render_completed',
        { type: 'render_job', id: job.id, version: job.version + 1 },
        { renderJobId: job.id, revisionId: job.revisionId, state: toState, exportCount: 0 },
        tx,
        { brandId: job.brandId },
      );
      return { renderJobId: job.id, state: toState, version: job.version + 1 };
    },

    async markFailed(input: z.infer<typeof RenderMarkFailed>, tx: Tx) {
      const parsed = RenderMarkFailed.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const toState = transition(renderJobMachine, job.state, 'fail', 'renderJobId');
      await renderJobsRepo.update(job.id, job.version, { state: toState, error: parsed.error }, tx);
      await audit.record(
        requireTenant().actor,
        'creative.render.fail',
        { type: 'render_job', id: job.id },
        'allowed',
        tx,
        { brandId: job.brandId, fromState: job.state, toState, reason: parsed.error.slice(0, 200) },
      );
      await outbox.add(
        'creative.render_completed',
        { type: 'render_job', id: job.id, version: job.version + 1 },
        { renderJobId: job.id, revisionId: job.revisionId, state: toState, exportCount: 0 },
        tx,
        { brandId: job.brandId },
      );
      return { renderJobId: job.id, state: toState, version: job.version + 1 };
    },
  },

  comments: {
    /** Anyone who can read the document can comment (reviewers, agents); the anchor element must exist in the revision. */
    async add(actor: ResolvedActor, input: z.infer<typeof CommentAdd>, tx: Tx, opts: ActorOptions = {}) {
      const parsed = CommentAdd.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), opts, tx);
      const authorKind = commentAuthorKindOf(actor);
      const revision = await loadRevision(doc, parsed.revisionId, tx);
      const content = parseSnapshot(doc.kind, revision.snapshot);
      // A video comment anchors on a timeline item (its id) as a graphic one anchors on an element.
      const anchored =
        content.kind === 'video'
          ? findItem(content.snapshot, parsed.elementId) !== null
          : content.snapshot.pages.some((p) => findElement(p, parsed.elementId));
      if (!anchored)
        throw new ValidationFailedError([{ path: 'elementId', issue: 'element_not_in_revision' }]);
      const id = newId('elementComment');
      await commentsRepo.create(
        {
          id,
          brandId: doc.brandId,
          documentId: doc.id,
          revisionId: revision.id,
          elementId: parsed.elementId,
          body: parsed.body,
          authorKind,
          authorId: actor.id,
          state: 'open',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.comment.add',
        { type: 'element_comment', id },
        'allowed',
        tx,
        { brandId: doc.brandId, revisionId: revision.id },
      );
      return { commentId: id, state: 'open' as const, version: 0 };
    },

    /** Resolving is an edit of the document's review state: open or outdated → resolved, once. */
    async resolve(
      actor: ResolvedActor,
      input: z.infer<typeof CommentResolve>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = CommentResolve.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      const comment = await loadComment(doc, parsed.commentId, tx);
      if (comment.state === 'resolved')
        throw new ValidationFailedError([{ path: 'commentId', issue: 'already_resolved' }]);
      await commentsRepo.update(comment.id, parsed.expectedVersion, { state: 'resolved' }, tx);
      await audit.record(
        actorRef(actor),
        'creative.comment.resolve',
        { type: 'element_comment', id: comment.id },
        'allowed',
        tx,
        {
          brandId: doc.brandId,
          fromState: comment.state,
          toState: 'resolved',
          expectedVersion: parsed.expectedVersion,
        },
      );
      return { commentId: comment.id, state: 'resolved' as const, version: parsed.expectedVersion + 1 };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof CommentList>, tx?: Tx) {
      const parsed = CommentList.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const page = await commentsRepo.list(doc.brandId, doc.id, parsed.state, parsed.page, tx);
      return { items: page.items.map(toCommentDto), nextCursor: page.nextCursor };
    },
  },

  /** Spec 6.3 templates: a brand-owned template with numbered versions; only approved versions can be applied (spec 11.3). */
  templates: {
    async create(
      actor: ResolvedActor,
      input: z.infer<typeof TemplateCreate>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = TemplateCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'creative.edit', brandResource(brand.id), opts, tx);
      const id = newId('template');
      await templatesRepo.create(
        { id, brandId: brand.id, name: parsed.name, currentVersionId: null, state: 'draft' },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.template.create',
        { type: 'template', id },
        'allowed',
        tx,
        { brandId: brand.id },
      );
      return { templateId: id, state: 'draft' as const, version: 0 };
    },

    /** Every slot must point at an element of the template document; formats must be known. Versions start as drafts. */
    async createVersion(
      actor: ResolvedActor,
      input: z.input<typeof TemplateVersionCreate>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = TemplateVersionCreate.parse(input);
      const template = await templatesRepo.lock(parsed.templateId, tx);
      await policy.assert(actor, 'creative.edit', templateResource(template), opts, tx);
      const document = CreativeDocumentV1.parse(parsed.document);
      const elementIds = new Set(allElementIds(document));
      const keys = new Set<string>();
      const details: ErrorDetail[] = [];
      parsed.slots.forEach((slot, i) => {
        if (keys.has(slot.key)) details.push({ path: `slots.${i}.key`, issue: 'duplicate_slot_key' });
        keys.add(slot.key);
        if (!elementIds.has(slot.elementId))
          details.push({ path: `slots.${i}.elementId`, issue: 'element_not_in_document' });
        details.push(...slotDefinitionIssues(document, slot, i));
      });
      parsed.formats.forEach((f, i) => {
        if (FORMAT_DEFINITIONS[f] === undefined)
          details.push({ path: `formats.${i}`, issue: `unknown format ${f}` });
      });
      if (details.length) throw new ValidationFailedError(details);
      const id = newId('templateVersion');
      const number = await templateVersionsRepo.nextNumber(template.brandId, template.id, tx);
      const contentHash = hashCanonical(document);
      await templateVersionsRepo.create(
        {
          id,
          brandId: template.brandId,
          templateId: template.id,
          number,
          slots: parsed.slots,
          constraints: parsed.constraints,
          formats: parsed.formats,
          document,
          contentHash,
          state: 'draft',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.template.create_version',
        { type: 'template_version', id },
        'allowed',
        tx,
        { brandId: template.brandId },
      );
      return { templateVersionId: id, number, state: 'draft' as const, contentHash };
    },

    /**
     * Approval is a brand-standards decision (brand.edit_standards, never an agent): the version becomes approved,
     * the template points at it as current and becomes active on its first approval.
     */
    async approve(
      actor: ResolvedActor,
      input: z.infer<typeof TemplateApprove>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = TemplateApprove.parse(input);
      const template = await templatesRepo.lock(parsed.templateId, tx);
      const tv = await loadTemplateVersion(template, parsed.templateVersionId, tx);
      const decision = await policy.assert(
        actor,
        'brand.edit_standards',
        {
          type: 'template_version',
          tenantId: template.tenantId,
          brandId: template.brandId,
          id: tv.id,
          state: tv.state,
        },
        opts,
        tx,
      );
      assertMayDecide(decision);
      const toState = transition(templateVersionMachine, tv.state, 'approve', 'templateVersionId');
      const templateState =
        template.state === 'active'
          ? template.state
          : transition(templateMachine, template.state, 'activate', 'templateId');
      await templateVersionsRepo.setState(tv.id, template.brandId, tv.state, toState, tx);
      await templatesRepo.update(
        template.id,
        parsed.expectedVersion,
        { currentVersionId: tv.id, state: templateState },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.template.approve',
        { type: 'template_version', id: tv.id },
        'allowed',
        tx,
        { brandId: template.brandId, fromState: tv.state, toState, expectedVersion: parsed.expectedVersion },
      );
      return {
        templateId: template.id,
        templateVersionId: tv.id,
        state: toState,
        templateState,
        version: parsed.expectedVersion + 1,
      };
    },

    /**
     * Spec 8.3 eligible template versions: the approved versions of the brand's templates, for the brand module's
     * snapshot builder (registered at composition). Tenant- and brand-scoped read without a policy decision: the
     * snapshot resolver has already asserted brand.read.
     */
    async eligibleVersionIds(brandId: string, tx?: Tx): Promise<string[]> {
      return templateVersionsRepo.listApprovedIds(brandId, tx);
    },

    async list(actor: ResolvedActor, input: z.infer<typeof TemplateList>, tx?: Tx) {
      const parsed = TemplateList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'creative.read', brandResource(brand.id), {}, tx);
      const page = await templatesRepo.list(brand.id, parsed.page, tx);
      return { items: page.items.map(toTemplateDto), nextCursor: page.nextCursor };
    },

    /** The template, its versions (summaries, newest first) and one full version (selectedVersion): the requested one, else the current one. */
    async get(actor: ResolvedActor, input: z.infer<typeof TemplateGet>, tx?: Tx) {
      const parsed = TemplateGet.parse(input);
      const template = await templatesRepo.getById(parsed.templateId, tx);
      await policy.assert(actor, 'creative.read', templateResource(template), {}, tx);
      const versions = await templateVersionsRepo.listForTemplate(template.brandId, template.id, tx);
      const selectedId = parsed.templateVersionId ?? template.currentVersionId;
      const selected = selectedId ? await loadTemplateVersion(template, selectedId, tx) : null;
      return {
        ...toTemplateDto(template),
        versions: versions.map(toTemplateVersionSummary),
        selectedVersion: selected ? toTemplateVersionDto(selected) : null,
      };
    },
  },
};

/**
 * STU-3: the creative engine's internals that the studio video AI service (video-ai.ts) composes, so it runs the same
 * loads, guards, evaluation and writes as every other change to a document (one engine, no second path).
 */
export const creativeEngine = {
  documentsRepo,
  revisionsRepo,
  loadRevision,
  documentResource,
  brandResource,
  resolveSnapshot,
  evaluateVideoBatch,
  commitVideoRevision,
  insertNewDocument,
  initialVideoBatch,
  actorRef,
  requesterKindOf,
  isBlocking,
  findingDetail,
  assertVideo,
  authoriseRefs,
  loadDocumentForUpdate: (id: string, tx: Tx) => documentsRepo.lock(id, tx),
};
export type CreativeDocumentRow = DocumentRow;
