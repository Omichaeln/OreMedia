import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Operation,
  SemanticRole,
  TemplateSlot,
} from '@oremedia/contracts/creative';
import type {
  GenerationConstraint,
  GenerationIssue,
  GenerationRequest,
  GenerationScope,
  ModelElementEdit,
  ModelFill,
  ProposalGroup,
  RefusedEdit,
} from '@oremedia/contracts/generation';
import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { formatFor } from './formats';
import {
  allElementIds,
  findElement,
  findWithAncestors,
  isLockedDeep,
  reflow,
  type TemplateDocument,
} from './reduce';

/**
 * STU-1b generation, the pure part shared by the server (preflight, compile, guard) and the studio (panel defaults,
 * proposal groups): what a page offers to fill (its slots), the structural operations a request implies, the
 * compilation of the model's strict output into operations, and the grouping of a proposal for selective accept.
 * Nothing here fetches or hashes; the creative module supplies the brand snapshot, eligible assets and capabilities.
 */

// ---- image areas (STU-1a starters) ---------------------------------------------------------------------------

/** An image area of a starter (a placeholder shape with the product role): filled by an eligible image. */
export const isImageArea = (el: Element | null | undefined): boolean =>
  el?.type === 'shape' && el.semanticRole === 'product';

/** The image that fills an image area: same box, place in the layer order and corner radius as a mask. */
export function imageForArea(area: Element, assetVersionId: string, name: string, id: string): Element {
  const radius = area.type === 'shape' ? area.cornerRadius : 0;
  return {
    id,
    name,
    locked: false,
    visible: true,
    opacity: area.opacity,
    protected: false,
    semanticRole: 'product',
    transform: { ...area.transform },
    type: 'image',
    assetVersionId,
    fit: 'cover',
    ...(radius > 0 ? { mask: { kind: 'rounded' as const, radius } } : {}),
  };
}

// ---- scope ---------------------------------------------------------------------------------------------------

/** The element and its containing groups, outermost first; null when the element is not on the page. */
export function ancestryOf(page: CreativePage, elementId: string): Element[] | null {
  const found = findWithAncestors(page, elementId);
  return found ? [...found.ancestors, found.element] : null;
}

/** In scope: the page is the scope's (or one the batch created) and, with selected ids, the element or a group containing it is selected. */
export function inScope(
  doc: CreativeDocumentV1,
  scope: GenerationScope,
  pageId: string,
  elementId: string | null,
  createdPageIds: ReadonlySet<string> = new Set(),
): boolean {
  if (createdPageIds.has(pageId)) return true;
  if (pageId !== scope.pageId) return false;
  if (elementId === null || scope.elementIds.length === 0) return true;
  const page = doc.pages.find((p) => p.id === pageId);
  const path = page ? ancestryOf(page, elementId) : null;
  return path !== null && path.some((el) => scope.elementIds.includes(el.id));
}

// ---- slots ---------------------------------------------------------------------------------------------------

export type GenerationSlotKind = 'text' | 'image' | 'image_area' | 'background' | 'shape' | 'logo' | 'group';
export type FixedReason = 'locked' | 'protected' | 'page_locked' | 'out_of_scope' | 'logo' | 'hidden';

export interface GenerationSlot {
  pageId: string;
  elementId: string;
  /** The template slot key when the document's template names one, else the element's role or kind. */
  key: string;
  kind: GenerationSlotKind;
  name: string;
  role?: SemanticRole;
  maxLength?: number;
  required: boolean;
  /** Why the generator may not change it (it still shows the model what is fixed); absent when editable. */
  fixed?: FixedReason;
  text?: string;
  assetVersionId?: string;
  colourToken?: string;
  box: { x: number; y: number; width: number; height: number };
}

const AVG_GLYPH_EM = 0.55;
/**
 * How many characters a text box holds at its size (lines × glyphs per line); generous for shrink-to-fit boxes. Used
 * as the slot's limit when the document has no template slot that says.
 */
export function textCapacity(el: Extract<Element, { type: 'text' }>): number {
  const size = Math.max(1, el.style.sizePx);
  const perLine = Math.max(1, Math.floor(el.transform.width / (size * AVG_GLYPH_EM)));
  const lines = Math.max(1, Math.floor(el.transform.height / (size * el.style.lineHeight)));
  const factor = el.style.overflow === 'shrink_to_fit' ? 1.5 : 1;
  return Math.max(10, Math.min(5000, Math.floor(perLine * lines * factor)));
}

const kindOf = (el: Element): GenerationSlotKind =>
  el.type === 'shape' ? (isImageArea(el) ? 'image_area' : 'shape') : el.type;

/**
 * Every element of a page as a slot: template slots (key, required, length limit) where the document's template
 * names the element, else the element's role. Locked, protected, hidden and logo elements, anything on a locked page
 * and anything outside the scope are listed as fixed with the reason.
 */
export function generationSlots(
  doc: CreativeDocumentV1,
  page: CreativePage,
  opts: {
    templateSlots?: ReadonlyArray<
      Pick<TemplateSlot, 'key' | 'elementId'> & { required?: boolean; constraints?: { maxLength?: number } }
    >;
    scope?: GenerationScope | null;
    createdPageIds?: ReadonlySet<string>;
  } = {},
): GenerationSlot[] {
  const byElement = new Map((opts.templateSlots ?? []).map((s) => [s.elementId, s]));
  const out: GenerationSlot[] = [];
  const visit = (el: Element, ancestors: Element[]) => {
    const tpl = byElement.get(el.id);
    const kind = kindOf(el);
    const locked = isLockedDeep(el) || ancestors.some((a) => a.locked);
    const isProtected = el.protected || ancestors.some((a) => a.protected);
    const fixed: FixedReason | undefined = page.locked
      ? 'page_locked'
      : locked
        ? 'locked'
        : el.type === 'logo'
          ? 'logo'
          : isProtected
            ? 'protected'
            : !el.visible
              ? 'hidden'
              : opts.scope && !inScope(doc, opts.scope, page.id, el.id, opts.createdPageIds)
                ? 'out_of_scope'
                : undefined;
    const maxLength =
      el.type === 'text' ? (tpl?.constraints?.maxLength ?? textCapacity(el)) : tpl?.constraints?.maxLength;
    out.push({
      pageId: page.id,
      elementId: el.id,
      key: tpl?.key ?? el.semanticRole ?? kind,
      kind,
      name: el.name,
      ...(el.semanticRole ? { role: el.semanticRole } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      required: tpl?.required ?? false,
      ...(fixed ? { fixed } : {}),
      ...(el.type === 'text' ? { text: el.text, colourToken: el.style.colourToken } : {}),
      ...((el.type === 'image' || el.type === 'logo') && el.assetVersionId
        ? { assetVersionId: el.assetVersionId }
        : {}),
      ...(el.type === 'background'
        ? {
            ...(el.assetVersionId ? { assetVersionId: el.assetVersionId } : {}),
            ...(el.fillToken ? { colourToken: el.fillToken } : {}),
          }
        : {}),
      ...(el.type === 'shape' && el.fillToken ? { colourToken: el.fillToken } : {}),
      box: {
        x: el.transform.x,
        y: el.transform.y,
        width: el.transform.width,
        height: el.transform.height,
      },
    });
    if (el.type === 'group') for (const c of el.children) visit(c, [...ancestors, el]);
  };
  for (const el of page.elements) visit(el, []);
  return out;
}

// ---- structure -----------------------------------------------------------------------------------------------

export interface Structure {
  operations: Operation[];
  labels: string[];
  /** The pages the model fills (created pages for alternatives and adapt; the scope or brief pages otherwise). */
  targetPageIds: string[];
  createdPageIds: string[];
}

/**
 * The deterministic operations a request implies before any model call: an approved brand template applied to the
 * pages (slots bound to the page's elements by type and role), copies of the scoped page for alternatives, a format
 * variant for adapt. `template` is the resolved version document; `newId` mints element ids (the server's).
 */
export function structureFor(
  doc: CreativeDocumentV1,
  request: GenerationRequest,
  opts: { template?: TemplateDocument & { templateVersionId: string }; newId: () => string },
): Structure {
  const operations: Operation[] = [];
  const labels: string[] = [];
  if (request.kind === 'generate') {
    const brief = request.brief;
    const pages = doc.pages.filter(
      (p) => !p.locked && (brief.pageIds.length === 0 || brief.pageIds.includes(p.id)),
    );
    if (brief.layout.kind === 'template' && opts.template)
      for (const page of pages) {
        operations.push({
          op: 'applyTemplate',
          pageId: page.id,
          templateVersionId: opts.template.templateVersionId,
          slotBindings: bindSlots(opts.template, page),
        });
        labels.push(`Apply the template to ${page.name}`);
      }
    return { operations, labels, targetPageIds: pages.map((p) => p.id), createdPageIds: [] };
  }
  const { scope, action } = request.refine;
  const source = doc.pages.find((p) => p.id === scope.pageId);
  if (!source || action.kind === 'edit')
    return { operations, labels, targetPageIds: [scope.pageId], createdPageIds: [] };
  if (action.kind === 'adapt') {
    const format = formatFor(action.formatKey);
    if (!format) return { operations, labels, targetPageIds: [], createdPageIds: [] };
    const id = reflow(source, format.key, format.width, format.height).id;
    operations.push({ op: 'createFormatVariant', sourcePageId: source.id, formatKey: format.key });
    labels.push(`New ${format.label} page`);
    return { operations, labels, targetPageIds: [id], createdPageIds: [id] };
  }
  const existing = new Set(doc.pages.map((p) => p.id));
  const created: string[] = [];
  const index = doc.pages.findIndex((p) => p.id === source.id);
  for (let n = 1; n <= action.count; n++) {
    let k = n;
    while (existing.has(`${source.id}_alt${k}`)) k += 1;
    const newPageId = `${source.id}_alt${k}`.slice(0, 40);
    existing.add(newPageId);
    const elementIdMap: Record<string, string> = {};
    for (const id of allElementIds({ ...doc, pages: [source] })) elementIdMap[id] = opts.newId();
    operations.push({
      op: 'duplicatePage',
      pageId: source.id,
      newPageId,
      elementIdMap,
      index: index + n,
    });
    labels.push(`Alternative ${n} of ${source.name}`);
    created.push(newPageId);
  }
  return { operations, labels, targetPageIds: created, createdPageIds: created };
}

/** Template slots bound to unused page elements of the slot's type and role (the first that fits, in page order). */
export function bindSlots(template: TemplateDocument, page: CreativePage): Record<string, string> {
  const used = new Set<string>();
  const bindings: Record<string, string> = {};
  const flat = allElementIds({ schemaVersion: 1, brandVersionId: '', pages: [page], variants: [] })
    .map((id) => findElement(page, id))
    .filter((e): e is Element => e !== null);
  for (const slot of template.slots) {
    if (slot.replaceable === false) continue;
    const templateEl = findElement(template.page, slot.elementId);
    if (!templateEl) continue;
    const match = flat.find(
      (el) =>
        !used.has(el.id) &&
        el.type === templateEl.type &&
        el.type !== 'logo' &&
        (el.semanticRole ?? null) === (templateEl.semanticRole ?? null),
    );
    if (!match) continue;
    used.add(match.id);
    bindings[slot.key] = match.id;
  }
  return bindings;
}

// ---- compile -------------------------------------------------------------------------------------------------

export interface CompileContext {
  variation: number;
  /** The pages the fill may touch; refinements also carry the scope (checked per element). */
  targetPageIds: readonly string[];
  scope: GenerationScope | null;
  createdPageIds: ReadonlySet<string>;
  slots: readonly GenerationSlot[];
  eligibleAssetIds: ReadonlySet<string>;
  paletteTokens: ReadonlySet<string>;
  effectiveFactIds: ReadonlySet<string>;
  newId: () => string;
  /** At most this many operations in all; an edit that would go past it is refused (too_many_operations). */
  maxOperations?: number;
}

export interface CompiledFill {
  operations: Operation[];
  /** The model's label for each operation (same index). */
  labels: string[];
  refused: RefusedEdit[];
  assetVersionIds: string[];
  factIds: string[];
}

const within = (box: { x: number; y: number; width: number; height: number }, page: CreativePage) =>
  box.x >= 0 && box.y >= 0 && box.x + box.width <= page.width && box.y + box.height <= page.height;

/** One edit's operations, or the reason it is refused (an edit is applied whole or not at all). */
function compileEdit(
  doc: CreativeDocumentV1,
  edit: ModelElementEdit,
  ctx: CompileContext,
): { ops: Operation[]; assets: string[]; facts: string[] } | { reason: string } {
  if (!ctx.targetPageIds.includes(edit.pageId)) return { reason: 'page_not_in_scope' };
  const page = doc.pages.find((p) => p.id === edit.pageId);
  if (!page) return { reason: 'page_not_found' };
  const el = findElement(page, edit.elementId);
  if (!el) return { reason: 'element_not_found' };
  const slot = ctx.slots.find((s) => s.pageId === page.id && s.elementId === el.id);
  if (!slot) return { reason: 'element_not_found' };
  if (slot.fixed) return { reason: `element_${slot.fixed}` };
  if (ctx.scope && !inScope(doc, ctx.scope, page.id, el.id, ctx.createdPageIds))
    return { reason: 'element_out_of_scope' };
  const ops: Operation[] = [];
  const assets: string[] = [];
  const facts: string[] = [];
  const at = { pageId: page.id, elementId: el.id };
  if (edit.text !== undefined) {
    if (el.type !== 'text') return { reason: 'text_on_non_text_element' };
    if (slot.maxLength !== undefined && [...edit.text].length > slot.maxLength)
      return { reason: `text_too_long:${slot.maxLength}` };
    const unknown = (edit.factIds ?? []).find((f) => !ctx.effectiveFactIds.has(f));
    if (unknown) return { reason: `fact_not_effective:${unknown}` };
    facts.push(...(edit.factIds ?? []));
    ops.push({ op: 'setText', ...at, text: edit.text, factRefs: edit.factIds ?? [] });
  }
  let targetId = el.id;
  if (edit.assetVersionId !== undefined) {
    if (!ctx.eligibleAssetIds.has(edit.assetVersionId)) return { reason: 'asset_not_eligible' };
    assets.push(edit.assetVersionId);
    if (el.type === 'image' || el.type === 'background')
      ops.push({ op: 'replaceAsset', ...at, assetVersionId: edit.assetVersionId });
    else if (isImageArea(el)) {
      const index = page.elements.findIndex((e) => e.id === el.id);
      const image = imageForArea(el, edit.assetVersionId, el.name, ctx.newId());
      targetId = image.id;
      ops.push(
        { op: 'removeElement', ...at },
        { op: 'insertElement', pageId: page.id, element: image, ...(index >= 0 ? { index } : {}) },
      );
    } else return { reason: 'asset_on_element_without_image' };
  }
  if (edit.colourToken !== undefined) {
    if (!ctx.paletteTokens.has(edit.colourToken)) return { reason: 'colour_not_in_palette' };
    if (el.type === 'text') ops.push({ op: 'setStyle', ...at, patch: { colourToken: edit.colourToken } });
    else if (el.type === 'shape' || el.type === 'background')
      ops.push({ op: 'setStyle', ...at, patch: { fillToken: edit.colourToken } });
    else return { reason: 'colour_on_element_without_fill' };
  }
  const textPatch: Record<string, unknown> = {
    ...(edit.sizePx !== undefined ? { sizePx: edit.sizePx } : {}),
    ...(edit.weight !== undefined ? { weight: edit.weight } : {}),
    ...(edit.align !== undefined ? { align: edit.align } : {}),
  };
  if (Object.keys(textPatch).length) {
    if (el.type !== 'text') return { reason: 'type_style_on_non_text_element' };
    ops.push({ op: 'setStyle', ...at, patch: textPatch });
  }
  if (edit.box !== undefined) {
    if (el.type === 'background') return { reason: 'background_box_fixed' };
    if (!within(edit.box, page)) return { reason: 'box_outside_page' };
    const t = el.transform;
    const target = { pageId: page.id, elementId: targetId };
    if (edit.box.width !== t.width || edit.box.height !== t.height)
      ops.push({ op: 'resizeElement', ...target, width: edit.box.width, height: edit.box.height });
    if (edit.box.x !== t.x || edit.box.y !== t.y)
      ops.push({ op: 'moveElement', ...target, x: edit.box.x, y: edit.box.y });
  }
  if (ops.length === 0) return { reason: 'no_change' };
  return { ops, assets, facts };
}

/**
 * The model's fill as operations against the working document. Every edit names an existing element of a target
 * page; edits on fixed elements (locked, protected, logos, hidden, locked pages, outside the scope), unknown facts,
 * ineligible assets, colours outside the palette, text over the slot's limit and boxes outside the page are refused
 * with the reason, never applied. The server guard and brand validation run again on the result.
 */
export function compileFill(doc: CreativeDocumentV1, fill: ModelFill, ctx: CompileContext): CompiledFill {
  const out: CompiledFill = { operations: [], labels: [], refused: [], assetVersionIds: [], factIds: [] };
  for (const edit of fill.edits) {
    const compiled = compileEdit(doc, edit, ctx);
    if ('reason' in compiled) {
      out.refused.push({
        variation: ctx.variation,
        pageId: edit.pageId,
        elementId: edit.elementId,
        reason: compiled.reason,
      });
      continue;
    }
    if (ctx.maxOperations !== undefined && out.operations.length + compiled.ops.length > ctx.maxOperations) {
      out.refused.push({
        variation: ctx.variation,
        pageId: edit.pageId,
        elementId: edit.elementId,
        reason: 'too_many_operations',
      });
      continue;
    }
    out.operations.push(...compiled.ops);
    out.labels.push(...compiled.ops.map(() => edit.label));
    out.assetVersionIds.push(...compiled.assets);
    out.factIds.push(...compiled.facts);
  }
  out.assetVersionIds = [...new Set(out.assetVersionIds)];
  out.factIds = [...new Set(out.factIds)];
  return out;
}

// ---- proposal groups -----------------------------------------------------------------------------------------

/** What an operation acts on, for grouping: elements by id (on its page), pages it creates or reads. */
function touches(op: Operation): string[] {
  const keys: string[] = [];
  const page = 'pageId' in op ? op.pageId : op.op === 'createFormatVariant' ? op.sourcePageId : null;
  if ('elementId' in op) keys.push(`el:${page}:${op.elementId}`);
  if ('elementIds' in op) keys.push(...op.elementIds.map((id) => `el:${page}:${id}`));
  if (op.op === 'insertElement') keys.push(`el:${page}:${op.element.id}`);
  if (op.op === 'duplicatePage') keys.push(`page:${op.newPageId}`);
  if (op.op === 'createFormatVariant') {
    const format = formatFor(op.formatKey);
    if (format) keys.push(`page:${op.sourcePageId}_${format.key}`);
  }
  if (op.op === 'applyTemplate') keys.push(`page:${op.pageId}`);
  if (page && op.op !== 'duplicatePage' && op.op !== 'createFormatVariant') keys.push(`on:${page}`);
  return keys;
}

/**
 * Operations that must be accepted together: the same label (one change as the model described it), the same
 * element, or a page a structural operation creates (or replaces) together with every operation on that page. An
 * image area's removal and its image's insertion share a label, so they stay together. Groups keep proposal order.
 */
export function groupOperations(
  operations: readonly Operation[],
  labels: readonly string[],
): ProposalGroup[] {
  const parent = operations.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] as number] as number;
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const owner = new Map<string, number>();
  const pageOwner = new Map<string, number>();
  operations.forEach((op, i) => {
    const label = labels[i] ?? '';
    const lk = `label:${label}`;
    if (label) {
      const o = owner.get(lk);
      if (o === undefined) owner.set(lk, i);
      else union(o, i);
    }
    for (const key of touches(op)) {
      if (key.startsWith('page:')) {
        const id = key.slice(5);
        const o = pageOwner.get(id);
        if (o === undefined) pageOwner.set(id, i);
        else union(o, i);
        continue;
      }
      if (key.startsWith('on:')) {
        const o = pageOwner.get(key.slice(3));
        if (o !== undefined) union(o, i);
        continue;
      }
      const o = owner.get(key);
      if (o === undefined) owner.set(key, i);
      else union(o, i);
    }
  });
  const groups = new Map<number, number[]>();
  operations.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  return [...groups.values()].map((indexes, n) => {
    const names = [...new Set(indexes.map((i) => labels[i]).filter((l): l is string => Boolean(l)))];
    const elementIds = [
      ...new Set(
        indexes.flatMap((i) => {
          const op = operations[i] as Operation;
          return [
            ...('elementId' in op ? [op.elementId] : []),
            ...(op.op === 'insertElement' ? [op.element.id] : []),
          ];
        }),
      ),
    ];
    return {
      id: `g${n + 1}`,
      label: (names.join('; ') || 'Change').slice(0, 200),
      operationIndexes: indexes,
      elementIds,
    };
  });
}

/** The operations of the chosen groups, in proposal order. */
export function operationsOfGroups(
  operations: readonly Operation[],
  groups: readonly ProposalGroup[],
  groupIds: readonly string[],
): Operation[] {
  const chosen = new Set(groups.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.operationIndexes));
  return operations.filter((_, i) => chosen.has(i));
}

// ---- preflight -----------------------------------------------------------------------------------------------

export interface PreflightAsset {
  assetVersionId: string;
  kind: string;
  altText: string | null;
}

export interface PreflightInput {
  /** The document as it is (the base revision). */
  document: CreativeDocumentV1;
  /** The document after the request's structural operations (new pages), when there are any. */
  working?: CreativeDocumentV1;
  request: GenerationRequest;
  snapshot: BrandSnapshot;
  /** Slots of the pages the job would fill (after structural operations). */
  slots: readonly GenerationSlot[];
  targetPageIds: readonly string[];
  eligibleAssets: readonly PreflightAsset[];
  /** Capabilities of the destination channels the platform knows (missing keys are unknown channels). */
  channels: readonly ProviderCapabilityV1[];
  knownChannelKeys: ReadonlySet<string>;
  imageGeneration: { available: boolean; reason?: string };
  /** The template version the request names, when it resolved to an approved version of the brand. */
  templateResolved: boolean;
  costMicros: number;
  remainingMicros: number | null;
}

export interface PreflightResult {
  issues: GenerationIssue[];
  constraints: GenerationConstraint[];
  /** Image slots the job would leave or fill with generated images. */
  emptyImageSlots: number;
}

const aspectOk = (cap: ProviderCapabilityV1, width: number, height: number) => {
  const ranges = cap.media.image?.aspectRatios ?? [];
  const r = width / height;
  return ranges.length === 0 || ranges.some((a) => r >= a.min - 1e-6 && r <= a.max + 1e-6);
};

/**
 * STU-1b preflight rules: the material inputs are checked (facts effective, assets eligible, channels known and
 * able to carry the page's image, the template approved, the scope on the page and not locked), the constraints
 * that will apply are listed in words, missing requirements and unsupported combinations are reported, and the cost
 * is compared with what remains of the budget. Blocking issues stop the start.
 */
export function preflightGeneration(input: PreflightInput): PreflightResult {
  const { document, request, snapshot } = input;
  const issues: GenerationIssue[] = [];
  const constraints: GenerationConstraint[] = [];
  const effective = new Map(snapshot.facts.map((f) => [f.id, f]));
  const eligible = new Set(input.eligibleAssets.map((a) => a.assetVersionId));
  const block = (code: string, message: string, ref?: string) =>
    issues.push({ code, severity: 'blocking', message, ...(ref ? { ref } : {}) });
  const warn = (code: string, message: string, ref?: string) =>
    issues.push({ code, severity: 'warning', message, ...(ref ? { ref } : {}) });

  const factIds = request.kind === 'generate' ? request.brief.factIds : request.refine.factIds;
  for (const id of factIds)
    if (!effective.has(id))
      block('fact_not_effective', 'A chosen fact is not approved and in force today; pick another.', id);
  if (factIds.length)
    constraints.push({
      kind: 'fact',
      text: `Only the ${factIds.length} chosen approved fact${factIds.length === 1 ? '' : 's'} may be stated as claims.`,
    });

  const chosenAssets =
    request.kind === 'generate'
      ? [
          ...request.brief.assets.include,
          ...request.brief.assets.prioritise,
          ...request.brief.referenceAssetVersionIds,
        ]
      : request.refine.assetVersionIds;
  for (const id of new Set(chosenAssets))
    if (!eligible.has(id))
      block(
        'asset_not_eligible',
        'A chosen asset is not eligible for creative use (approval, rights or kind).',
        id,
      );
  if (request.kind === 'generate') {
    const overlap = request.brief.assets.include.filter((id) => request.brief.assets.exclude.includes(id));
    for (const id of overlap)
      block('asset_included_and_excluded', 'An asset is both included and excluded.', id);
  }

  const targetPages = (input.working ?? document).pages.filter((p) => input.targetPageIds.includes(p.id));
  if (request.kind === 'generate') {
    const brief = request.brief;
    if (brief.layout.kind === 'template' && !input.templateResolved)
      block('template_not_approved', 'The chosen template is not an approved template of this brand.');
    for (const id of brief.pageIds)
      if (!document.pages.some((p) => p.id === id))
        block('page_not_found', 'A chosen page does not exist.', id);
    for (const page of document.pages.filter((p) => p.locked && brief.pageIds.includes(p.id)))
      block('page_locked', `${page.name} is locked; unlock it to generate into it.`, page.id);
    if (targetPages.length === 0 && !brief.pageIds.length)
      block('no_unlocked_page', 'Every page is locked; unlock a page to generate into it.');
    if (!brief.objective && !brief.keyMessage && !brief.requiredCopy.headline)
      block('brief_missing_message', 'Say what the graphic should achieve or the key message.');
    if (brief.variations > 1 && document.pages.length * brief.variations > 40)
      warn('many_pages', 'Several variations of a multi-page document make many pages to review.');
    for (const key of brief.channelKeys) {
      if (!input.knownChannelKeys.has(key)) {
        block('channel_unknown', `The platform has no channel ${key}.`, key);
        continue;
      }
      const cap = input.channels.find((c) => c.key === key);
      if (!cap?.media.image) {
        block('channel_without_images', `${key} cannot publish images.`, key);
        continue;
      }
      if (!cap.certifiedAt) warn('channel_not_certified', `${key} is not certified for publishing yet.`, key);
      for (const page of targetPages) {
        if (!aspectOk(cap, page.width, page.height))
          block(
            'format_not_supported_by_channel',
            `${page.name} (${page.width}×${page.height}) is not an aspect ratio ${key} accepts; adapt it into a supported format first.`,
            key,
          );
        else if (page.width < (cap.media.image.minWidth ?? 0))
          block('format_too_small_for_channel', `${page.name} is narrower than ${key} accepts.`, key);
      }
      if (document.pages.length > 1 && cap.media.carousel && document.pages.length > cap.media.carousel.max)
        warn(
          'carousel_too_long',
          `${key} takes at most ${cap.media.carousel.max} images in a carousel; this document has ${document.pages.length} pages.`,
          key,
        );
      constraints.push({
        kind: 'channel',
        text: `${key}: images ${cap.media.image.minWidth}–${cap.media.image.maxWidth}px wide, up to ${cap.media.image.maxCount} per post; captions up to ${cap.text.maxLength} characters.`,
      });
    }
    if (brief.channelKeys.length === 0)
      warn('no_destination', 'No destination channel: channel guidance and limits are not applied.');
    const required = input.slots.filter((s) => s.required && !s.fixed && s.kind === 'text');
    if (required.length && !brief.objective && !brief.keyMessage && !brief.requiredCopy.headline)
      block(
        'slot_needs_copy',
        `${required[0]?.name ?? 'The headline'} needs copy: give a key message or headline.`,
      );
    if (brief.requiredCopy.headline) {
      const headline = input.slots.find((s) => s.kind === 'text' && s.role === 'headline' && !s.fixed);
      if (!headline)
        block('no_headline_slot', 'The layout has no editable headline for the required headline.');
      else if (
        headline.maxLength !== undefined &&
        [...brief.requiredCopy.headline].length > headline.maxLength
      )
        block(
          'required_copy_too_long',
          `The required headline is longer than the headline holds (${headline.maxLength} characters).`,
        );
    }
    if (brief.requiredCopy.cta && !input.slots.some((s) => s.kind === 'text' && s.role === 'cta' && !s.fixed))
      warn('no_cta_slot', 'The layout has no editable call-to-action text; the CTA goes into the body copy.');
    if (brief.generateImages && !input.imageGeneration.available)
      block(
        'image_generation_unavailable',
        input.imageGeneration.reason ?? 'Image generation is not available for this brand.',
      );
  } else {
    const { scope, action } = request.refine;
    const page = document.pages.find((p) => p.id === scope.pageId);
    if (!page) block('page_not_found', 'The selected page does not exist.', scope.pageId);
    else {
      if (page.locked && action.kind === 'edit')
        block('page_locked', `${page.name} is locked; nothing on it can change.`, page.id);
      for (const id of scope.elementIds) {
        const path = ancestryOf(page, id);
        if (!path) block('element_not_found', 'A selected element is not on the page.', id);
        else if (path.some((el) => isLockedDeep(el) || el.locked) && action.kind === 'edit')
          block('element_locked', `${path[path.length - 1]?.name ?? 'An element'} is locked.`, id);
      }
      if (action.kind === 'adapt') {
        const format = formatFor(action.formatKey);
        if (!format) block('format_unknown', 'The chosen format is not known.', action.formatKey);
        else if (format.key === page.formatKey)
          block('format_same', 'The page is already in this format.', action.formatKey);
        else if (document.pages.some((p) => p.id === `${page.id}_${format.key}`))
          block('variant_exists', 'This page already has a variant in this format.', action.formatKey);
      }
      if (action.kind !== 'edit' && scope.elementIds.length)
        block('scope_page_only', 'Alternatives and adaptations work on a whole page; clear the selection.');
      if (action.kind !== 'edit' && document.pages.length + (action.kind === 'adapt' ? 1 : action.count) > 20)
        block('too_many_pages', 'A document holds at most 20 pages.');
    }
    constraints.push({
      kind: 'scope',
      text: scope.elementIds.length
        ? `Only the ${scope.elementIds.length} selected element${scope.elementIds.length === 1 ? '' : 's'} may change.`
        : action.kind === 'edit'
          ? 'Only this page may change.'
          : 'The original page is not changed; only the new page is worked on.',
    });
  }

  // Constraints that apply to every request, in words.
  for (const page of targetPages) {
    const format = formatFor(page.formatKey);
    if (format)
      constraints.push({
        kind: 'safe_area',
        text: `${page.name}: text and logos stay inside the ${format.label} safe area.`,
      });
  }
  const fixed = input.slots.filter((s) => s.fixed && s.fixed !== 'out_of_scope' && s.fixed !== 'hidden');
  for (const s of fixed)
    constraints.push({
      kind: s.fixed === 'logo' || s.fixed === 'protected' ? 'protected' : 'lock',
      text: `${s.name} is ${s.fixed === 'page_locked' ? 'on a locked page' : s.fixed === 'logo' ? 'a logo' : s.fixed} and stays as it is.`,
    });
  for (const rule of snapshot.document.logoRules)
    constraints.push({
      kind: 'logo_rule',
      text: `${rule.variant} logo: at least ${rule.minWidthPx}px wide, clear space ${rule.clearSpaceRatio}× its height, only on ${rule.allowedBackgroundColourKeys.join(', ') || 'no'} backgrounds.`,
    });
  for (const s of input.slots.filter((x) => !x.fixed && x.kind === 'text' && x.maxLength !== undefined))
    constraints.push({ kind: 'slot', text: `${s.name}: at most ${s.maxLength} characters.` });

  const emptyImageSlots = input.slots.filter((s) => s.kind === 'image_area' && !s.fixed).length;
  if (request.kind === 'generate' && emptyImageSlots > 0 && input.eligibleAssets.length === 0)
    warn(
      'no_eligible_images',
      'No eligible image is available for the image areas; they stay as placeholders.',
    );
  if (input.remainingMicros !== null && input.costMicros > input.remainingMicros)
    block('budget_insufficient', 'The estimated cost is more than what remains of the generation budget.');
  return { issues, constraints, emptyImageSlots };
}
