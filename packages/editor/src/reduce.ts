import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Finding,
  Operation,
  OperationBatch,
  TemplateSlotConstraints,
} from '@oremedia/contracts/creative';
import { CreativeDocumentV1 as DocumentSchema, ElementSchema } from '@oremedia/contracts/creative';
import { formatFor } from './formats';

/** A rejected operation: the reducer is pure and reports structural problems as errors with stable codes. */
export class OperationError extends Error {
  readonly code: string;
  readonly op: Operation['op'];
  constructor(code: string, op: Operation['op'], message?: string) {
    super(message ?? `${op}: ${code}`);
    this.name = 'OperationError';
    this.code = code;
    this.op = op;
  }
}

export interface TemplateDocument {
  /** The template's page used as the source of elements; slot key → element id inside that page. */
  page: CreativePage;
  slots: Array<{
    key: string;
    elementId: string;
    kind: string;
    required: boolean;
    /** Absent means true: versions stored before slot semantics bind like before. */
    replaceable?: boolean;
    constraints?: TemplateSlotConstraints;
  }>;
}

/** A blocking finding about one slot binding of an applyTemplate operation (spec 6.3 / 11.3 slot semantics). */
export type SlotFinding = Finding & { slotKey: string };

/**
 * applyTemplate rejected because slot bindings break the template's slot rules. `code` keeps the stable
 * `<finding code>:<slot key>` shape of the first violation (e.g. `slot_unbound:headline`); `findings` lists them all.
 */
export class SlotConstraintError extends OperationError {
  readonly findings: SlotFinding[];
  constructor(findings: SlotFinding[]) {
    const first = findings[0];
    super(first ? `${first.code}:${first.slotKey}` : 'slot_constraint', 'applyTemplate');
    this.name = 'SlotConstraintError';
    this.findings = findings;
  }
}

/** Element type a bound element must have per enforced slot kind; other kinds (legacy versions) are not typed. */
const SLOT_ELEMENT_TYPE: Readonly<Record<string, Element['type']>> = {
  text: 'text',
  image: 'image',
  logo: 'logo',
  background: 'background',
};

/**
 * Spec 6.3 / 11.3: every binding names a slot of the template, is allowed to replace it, points at an element of
 * the target page of the slot's kind and satisfies the slot's constraints (text length, semantic roles); every
 * required slot is bound and no element fills two slots. Pure: the findings are returned, nothing is thrown.
 */
export function validateSlotBindings(
  template: TemplateDocument,
  page: CreativePage,
  slotBindings: Readonly<Record<string, string>>,
): SlotFinding[] {
  const findings: SlotFinding[] = [];
  const add = (slotKey: string, code: string, message: string, elementId?: string) =>
    findings.push({
      slotKey,
      code,
      severity: 'blocking',
      message,
      pageId: page.id,
      ...(elementId ? { elementId } : {}),
    });
  const slots = new Map(template.slots.map((s) => [s.key, s]));
  for (const key of Object.keys(slotBindings))
    if (!slots.has(key)) add(key, 'slot_unknown', `The template has no slot "${key}"`);
  const boundBy = new Map<string, string>();
  for (const slot of template.slots) {
    const boundId = slotBindings[slot.key];
    if (!boundId) {
      if (slot.required) add(slot.key, 'slot_unbound', `Slot "${slot.key}" is required`);
      continue;
    }
    if (slot.replaceable === false) {
      add(slot.key, 'slot_not_replaceable', `Slot "${slot.key}" is fixed by the template`, boundId);
      continue;
    }
    const previous = boundBy.get(boundId);
    if (previous !== undefined)
      add(slot.key, 'slot_binding_duplicate', `The element already fills slot "${previous}"`, boundId);
    boundBy.set(boundId, slot.key);
    const element = locate(page.elements, boundId)?.element;
    if (!element) {
      add(slot.key, 'slot_binding_not_found', `The bound element is not on page ${page.id}`, boundId);
      continue;
    }
    const expectedType = SLOT_ELEMENT_TYPE[slot.kind];
    if (expectedType !== undefined && element.type !== expectedType) {
      add(
        slot.key,
        'slot_kind_mismatch',
        `Slot "${slot.key}" takes a ${expectedType} element, not ${element.type}`,
        boundId,
      );
      continue;
    }
    const c = slot.constraints ?? {};
    if (c.semanticRoles && !(element.semanticRole && c.semanticRoles.includes(element.semanticRole)))
      add(
        slot.key,
        'slot_role_not_allowed',
        `Slot "${slot.key}" takes ${c.semanticRoles.join(', ')} elements only`,
        boundId,
      );
    if (element.type === 'text') {
      const length = [...element.text].length;
      if (c.maxLength !== undefined && length > c.maxLength)
        add(
          slot.key,
          'slot_text_too_long',
          `Slot "${slot.key}" takes at most ${c.maxLength} characters (${length} given)`,
          boundId,
        );
      if (c.minLength !== undefined && length < c.minLength)
        add(
          slot.key,
          'slot_text_too_short',
          `Slot "${slot.key}" takes at least ${c.minLength} characters (${length} given)`,
          boundId,
        );
    }
  }
  return findings;
}

export interface ReduceContext {
  /** applyTemplate needs the template version document; the caller resolves it (the reducer never fetches). */
  templates?: Readonly<Record<string, TemplateDocument>>;
}

const pageOf = (doc: CreativeDocumentV1, pageId: string, op: Operation['op']): CreativePage => {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) throw new OperationError('page_not_found', op);
  return page;
};

/**
 * Depth-first search through groups. Returns the containing array and index so edits stay local, and the groups
 * that contain the element (outermost first): a locked or protected group covers everything inside it.
 */
function locate(
  elements: Element[],
  elementId: string,
  ancestors: Element[] = [],
): { parent: Element[]; index: number; element: Element; ancestors: Element[] } | null {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as Element;
    if (el.id === elementId) return { parent: elements, index: i, element: el, ancestors };
    if (el.type === 'group') {
      const found = locate(el.children, elementId, [...ancestors, el]);
      if (found) return found;
    }
  }
  return null;
}

/** The element and the groups that contain it, outermost first; null when the page has no such element. */
export function findWithAncestors(
  page: CreativePage,
  elementId: string,
): { element: Element; ancestors: Element[] } | null {
  const found = locate(page.elements, elementId);
  return found ? { element: found.element, ancestors: found.ancestors } : null;
}

export function findElement(page: CreativePage, elementId: string): Element | null {
  return locate(page.elements, elementId)?.element ?? null;
}

const requireElement = (page: CreativePage, elementId: string, op: Operation['op']) => {
  const found = locate(page.elements, elementId);
  if (!found) throw new OperationError('element_not_found', op);
  return found;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Locked pages refuse manual transforms (move, resize, rotate, align, distribute); agents are refused anything (guard). */
const assertPageUnlocked = (page: CreativePage, op: Operation['op']) => {
  if (page.locked) throw new OperationError('page_locked', op);
};

/** An element or anything inside it is locked: a group moves its children, so a locked child pins the group. */
export function isLockedDeep(el: Element): boolean {
  return el.locked || (el.type === 'group' && el.children.some(isLockedDeep));
}

/** Locked for editing: the element, anything inside it, or a group that contains it is locked. */
export const isLockedInContext = (el: Element, ancestors: readonly Element[]): boolean =>
  isLockedDeep(el) || ancestors.some((a) => a.locked);

const assertMovable = (el: Element, op: Operation['op'], ancestors: readonly Element[] = []) => {
  if (isLockedInContext(el, ancestors)) throw new OperationError('element_locked', op);
};

/** Group children carry page-absolute transforms (scene.ts), so moving a group moves every descendant. */
function translate(el: Element, dx: number, dy: number): Element {
  const t = el.transform;
  const moved = { ...el, transform: { ...t, x: round2(t.x + dx), y: round2(t.y + dy) } } as Element;
  if (moved.type === 'group') return { ...moved, children: moved.children.map((c) => translate(c, dx, dy)) };
  return moved;
}

/**
 * Resizing a group scales its descendants' boxes about the group's top-left corner. A rotated child keeps its
 * rotation and has its unrotated box scaled (so a non-uniform resize does not skew it); its footprint may then extend
 * slightly beyond the group's new box, which is recomputed only when the group is made again.
 */
function scaleWithin(el: Element, origin: { x: number; y: number }, sx: number, sy: number): Element {
  const t = el.transform;
  const scaled = {
    ...el,
    transform: {
      ...t,
      x: round2(origin.x + (t.x - origin.x) * sx),
      y: round2(origin.y + (t.y - origin.y) * sy),
      width: Math.max(1, round2(t.width * sx)),
      height: Math.max(1, round2(t.height * sy)),
    },
  } as Element;
  if (scaled.type === 'group')
    return { ...scaled, children: scaled.children.map((c) => scaleWithin(c, origin, sx, sy)) };
  return scaled;
}

/** The axis-aligned box enclosing an element's transform rotated about its centre. */
export function footprintOf(t: Element['transform']): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (!t.rotation) return { x: t.x, y: t.y, width: t.width, height: t.height };
  const rad = (t.rotation * Math.PI) / 180;
  const w = Math.abs(t.width * Math.cos(rad)) + Math.abs(t.height * Math.sin(rad));
  const h = Math.abs(t.width * Math.sin(rad)) + Math.abs(t.height * Math.cos(rad));
  return { x: t.x + t.width / 2 - w / 2, y: t.y + t.height / 2 - h / 2, width: w, height: h };
}

/** The box enclosing a set of boxes. */
export function boundsOf(boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Every element id in a tree (groups' children included), in paint order. */
const idsIn = (elements: readonly Element[]): string[] =>
  elements.flatMap((e) => [e.id, ...(e.type === 'group' ? idsIn(e.children) : [])]);

const withIds = (el: Element, map: Readonly<Record<string, string>>): Element => {
  const id = map[el.id] as string;
  if (el.type === 'group') return { ...el, id, children: el.children.map((c) => withIds(c, map)) };
  return { ...el, id };
};

/** The new top-left of each element when aligned (spec: to the selection's bounds or to the page). */
function alignedPositions(
  page: CreativePage,
  elements: Element[],
  align: Extract<Operation, { op: 'alignElements' }>['align'],
  relativeTo: 'selection' | 'page',
): Map<string, { x: number; y: number }> {
  // Rotated elements align by their footprint (the box they visibly cover), as groupElements bounds them.
  const b =
    relativeTo === 'page'
      ? { x: 0, y: 0, width: page.width, height: page.height }
      : boundsOf(elements.map((e) => footprintOf(e.transform)));
  const out = new Map<string, { x: number; y: number }>();
  for (const el of elements) {
    const t = el.transform;
    const f = footprintOf(t);
    let { x: fx, y: fy } = f;
    if (align === 'left') fx = b.x;
    if (align === 'center') fx = b.x + (b.width - f.width) / 2;
    if (align === 'right') fx = b.x + b.width - f.width;
    if (align === 'top') fy = b.y;
    if (align === 'middle') fy = b.y + (b.height - f.height) / 2;
    if (align === 'bottom') fy = b.y + b.height - f.height;
    out.set(el.id, { x: round2(t.x + fx - f.x), y: round2(t.y + fy - f.y) });
  }
  return out;
}

/**
 * Equal gaps between boxes along the axis, in their current order on it: within the span from the first box to the
 * last (selection) or across the page with the same gap at both edges (page).
 */
function distributedPositions(
  page: CreativePage,
  elements: Element[],
  axis: 'horizontal' | 'vertical',
  relativeTo: 'selection' | 'page',
): Map<string, { x: number; y: number }> {
  // By footprint, like alignment: a rotated element is spaced by the box it visibly covers.
  const pos = (e: Element) =>
    axis === 'horizontal' ? footprintOf(e.transform).x : footprintOf(e.transform).y;
  const len = (e: Element) =>
    axis === 'horizontal' ? footprintOf(e.transform).width : footprintOf(e.transform).height;
  const sorted = [...elements].sort((a, b) => pos(a) - pos(b) || a.id.localeCompare(b.id));
  const total = sorted.reduce((sum, e) => sum + len(e), 0);
  let start: number;
  let gap: number;
  if (relativeTo === 'page') {
    const span = axis === 'horizontal' ? page.width : page.height;
    gap = (span - total) / (sorted.length + 1);
    start = gap;
  } else {
    const first = sorted[0] as Element;
    const last = sorted[sorted.length - 1] as Element;
    start = pos(first);
    gap = (pos(last) + len(last) - start - total) / (sorted.length - 1);
  }
  const out = new Map<string, { x: number; y: number }>();
  let cursor = start;
  for (const el of sorted) {
    const shift = cursor - pos(el); // the footprint moves to the cursor; the transform moves with it
    out.set(
      el.id,
      axis === 'horizontal'
        ? { x: round2(el.transform.x + shift), y: el.transform.y }
        : { x: el.transform.x, y: round2(el.transform.y + shift) },
    );
    cursor += len(el) + gap;
  }
  return out;
}

/** Applies new top-left positions to elements found anywhere on the page (groups move their descendants). */
function moveAll(page: CreativePage, positions: Map<string, { x: number; y: number }>, op: Operation['op']) {
  for (const [id, p] of positions) {
    const { parent, index, element } = requireElement(page, id, op);
    parent[index] = translate(element, p.x - element.transform.x, p.y - element.transform.y);
  }
}

const distinctElements = (page: CreativePage, ids: readonly string[], op: Operation['op']): Element[] => {
  if (new Set(ids).size !== ids.length) throw new OperationError('duplicate_element_ids', op);
  return ids.map((id) => requireElement(page, id, op).element);
};

const STYLE_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  text: new Set([
    'typeRole',
    'fontAssetVersionId',
    'weight',
    'sizePx',
    'lineHeight',
    'tracking',
    'colourToken',
    'colourValue',
    'align',
    'overflow',
  ]),
  shape: new Set(['fillToken', 'strokeToken', 'strokeWidth', 'cornerRadius', 'opacity']),
  background: new Set(['fillToken', 'opacity']),
  image: new Set(['fit', 'mask', 'focalPoint', 'opacity']),
  logo: new Set(['opacity']),
  group: new Set(['opacity']),
};

function applyStyle(el: Element, patch: Record<string, unknown>): Element {
  const allowed = STYLE_KEYS_BY_TYPE[el.type] ?? new Set<string>();
  for (const k of Object.keys(patch))
    if (!allowed.has(k)) throw new OperationError(`style_key_not_allowed:${k}`, 'setStyle');
  if (el.type === 'text') {
    const { opacity: _o, ...stylePatch } = patch;
    return { ...el, style: { ...el.style, ...(stylePatch as Partial<typeof el.style>) } };
  }
  return { ...el, ...(patch as Partial<Element>) } as Element;
}

/**
 * Spec 11.4: `next = reduce(next, op)`, pure. Element ids are stable across every edit; z-order is array order;
 * a document is never partially mutated (each call returns a new document or throws).
 */
export function reduce(doc: CreativeDocumentV1, op: Operation, ctx: ReduceContext = {}): CreativeDocumentV1 {
  const next: CreativeDocumentV1 = structuredClone(doc);
  switch (op.op) {
    case 'insertElement': {
      const page = pageOf(next, op.pageId, op.op);
      if (locate(page.elements, op.element.id)) throw new OperationError('duplicate_element_id', op.op);
      if (page.elements.length >= 300) throw new OperationError('too_many_elements', op.op);
      const index =
        op.index === undefined ? page.elements.length : Math.max(0, Math.min(op.index, page.elements.length));
      page.elements.splice(index, 0, ElementSchema.parse(op.element));
      return next;
    }
    case 'removeElement': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element, ancestors } = requireElement(page, op.elementId, op.op);
      // STU-1a: a locked element (or a group holding one, or one inside a locked group) is never removed; unlock first.
      assertMovable(element, op.op, ancestors);
      parent.splice(index, 1);
      return next;
    }
    case 'setText': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.type !== 'text') throw new OperationError('not_a_text_element', op.op);
      parent[index] = { ...element, text: op.text, factRefs: op.factRefs ?? element.factRefs };
      return next;
    }
    case 'setStyle': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      parent[index] = ElementSchema.parse(applyStyle(element, op.patch));
      return next;
    }
    case 'replaceAsset': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.type !== 'image' && element.type !== 'logo' && element.type !== 'background')
        throw new OperationError('element_has_no_asset', op.op);
      parent[index] = { ...element, assetVersionId: op.assetVersionId };
      return next;
    }
    case 'moveElement': {
      const page = pageOf(next, op.pageId, op.op);
      assertPageUnlocked(page, op.op);
      const { parent, index, element, ancestors } = requireElement(page, op.elementId, op.op);
      assertMovable(element, op.op, ancestors);
      if (element.type === 'group')
        parent[index] = translate(element, op.x - element.transform.x, op.y - element.transform.y);
      else parent[index] = { ...element, transform: { ...element.transform, x: op.x, y: op.y } };
      return next;
    }
    case 'resizeElement': {
      const page = pageOf(next, op.pageId, op.op);
      assertPageUnlocked(page, op.op);
      const { parent, index, element, ancestors } = requireElement(page, op.elementId, op.op);
      assertMovable(element, op.op, ancestors);
      const t = element.transform;
      if (element.type === 'group') {
        const scaled = scaleWithin(element, t, op.width / t.width, op.height / t.height);
        parent[index] = { ...scaled, transform: { ...t, width: op.width, height: op.height } };
      } else parent[index] = { ...element, transform: { ...t, width: op.width, height: op.height } };
      return next;
    }
    case 'reorderElement': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index } = requireElement(page, op.elementId, op.op);
      const [el] = parent.splice(index, 1);
      const to = Math.max(0, Math.min(op.toIndex, parent.length));
      parent.splice(to, 0, el as Element);
      return next;
    }
    case 'setCrop': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.type !== 'image') throw new OperationError('not_an_image', op.op);
      if (op.crop.width <= 0 || op.crop.height <= 0) throw new OperationError('invalid_crop', op.op);
      parent[index] = { ...element, crop: op.crop };
      return next;
    }
    case 'applyTemplate': {
      const page = pageOf(next, op.pageId, op.op);
      const template = ctx.templates?.[op.templateVersionId];
      if (!template) throw new OperationError('template_not_resolved', op.op);
      const slotFindings = validateSlotBindings(template, page, op.slotBindings);
      if (slotFindings.length) throw new SlotConstraintError(slotFindings);
      // STU-1a: a template replaces every element of the page, so a locked page or locked element stops it.
      assertPageUnlocked(page, op.op);
      if (page.elements.some(isLockedDeep)) throw new OperationError('element_locked', op.op);
      // Template elements come in with their template ids; bound slots take the existing element's content.
      const incoming = structuredClone(template.page.elements);
      for (const slot of template.slots) {
        const boundId = op.slotBindings[slot.key];
        if (!boundId) continue;
        const existing = locate(page.elements, boundId)?.element;
        const target = locate(incoming, slot.elementId);
        if (!existing || !target) continue;
        const merged = { ...target.element, id: existing.id } as Element;
        if (existing.type === 'text' && merged.type === 'text')
          target.parent[target.index] = { ...merged, text: existing.text, factRefs: existing.factRefs };
        else if (
          (existing.type === 'image' || existing.type === 'logo') &&
          (merged.type === 'image' || merged.type === 'logo')
        )
          target.parent[target.index] = { ...merged, assetVersionId: existing.assetVersionId } as Element;
        else target.parent[target.index] = merged;
      }
      next.templateVersionId = op.templateVersionId;
      const target = pageOf(next, op.pageId, op.op);
      target.elements = incoming;
      target.layoutConstraints = structuredClone(template.page.layoutConstraints);
      return next;
    }
    case 'addPage': {
      if (next.pages.length >= 20) throw new OperationError('too_many_pages', op.op);
      if (next.pages.some((p) => p.id === op.page.id)) throw new OperationError('duplicate_page_id', op.op);
      const index =
        op.index === undefined ? next.pages.length : Math.max(0, Math.min(op.index, next.pages.length));
      next.pages.splice(index, 0, structuredClone(op.page));
      return next;
    }
    case 'createFormatVariant': {
      const source = pageOf(next, op.sourcePageId, op.op);
      const format = formatFor(op.formatKey);
      if (!format) throw new OperationError('unknown_format', op.op);
      if (next.pages.length >= 20) throw new OperationError('too_many_pages', op.op);
      const variant = reflow(source, format.key, format.width, format.height);
      if (next.pages.some((p) => p.id === variant.id)) throw new OperationError('duplicate_page_id', op.op);
      next.pages.push(variant);
      return next;
    }
    case 'setLock': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      parent[index] = { ...element, locked: op.locked };
      return next;
    }
    case 'groupElements': {
      const page = pageOf(next, op.pageId, op.op);
      if (locate(page.elements, op.groupId)) throw new OperationError('duplicate_element_id', op.op);
      const members = distinctElements(page, op.elementIds, op.op);
      const indices = op.elementIds.map((id) => page.elements.findIndex((e) => e.id === id));
      if (indices.some((i) => i < 0)) throw new OperationError('nested_element', op.op);
      if (members.some((m) => m.type === 'background'))
        throw new OperationError('cannot_group_background', op.op);
      if (members.some(isLockedDeep)) throw new OperationError('element_locked', op.op);
      const ordered = [...indices].sort((a, b) => a - b);
      const children = ordered.map((i) => page.elements[i] as Element);
      const box = boundsOf(children.map((c) => footprintOf(c.transform)));
      const group: Element = {
        id: op.groupId,
        name: op.name ?? 'Group',
        type: 'group',
        locked: false,
        visible: true,
        opacity: 1,
        protected: false,
        transform: {
          x: round2(box.x),
          y: round2(box.y),
          width: Math.max(1, round2(box.width)),
          height: Math.max(1, round2(box.height)),
          rotation: 0,
        },
        children,
      };
      const front = ordered[ordered.length - 1] as number;
      page.elements = page.elements.filter((_, i) => !ordered.includes(i));
      page.elements.splice(front - ordered.length + 1, 0, group);
      return next;
    }
    case 'ungroupElement': {
      const page = pageOf(next, op.pageId, op.op);
      const index = page.elements.findIndex((e) => e.id === op.elementId);
      const group = page.elements[index];
      if (!group) {
        requireElement(page, op.elementId, op.op);
        throw new OperationError('nested_element', op.op);
      }
      if (group.type !== 'group') throw new OperationError('not_a_group', op.op);
      if (group.locked) throw new OperationError('element_locked', op.op);
      const children =
        group.opacity === 1
          ? group.children
          : group.children.map((c) => ({ ...c, opacity: round2(c.opacity * group.opacity) }) as Element);
      page.elements.splice(index, 1, ...children);
      return next;
    }
    case 'setRotation': {
      const page = pageOf(next, op.pageId, op.op);
      assertPageUnlocked(page, op.op);
      const { parent, index, element, ancestors } = requireElement(page, op.elementId, op.op);
      assertMovable(element, op.op, ancestors);
      // Group children carry their own page-absolute transforms; a group is rotated by rotating its members.
      if (element.type === 'group') throw new OperationError('group_rotation_unsupported', op.op);
      parent[index] = { ...element, transform: { ...element.transform, rotation: op.rotation } };
      return next;
    }
    case 'setMask': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.type !== 'image') throw new OperationError('not_an_image', op.op);
      const { mask: _old, ...rest } = element;
      parent[index] = op.mask ? { ...rest, mask: { ...op.mask } } : rest;
      return next;
    }
    case 'removePage': {
      const index = next.pages.findIndex((p) => p.id === op.pageId);
      const page = next.pages[index];
      if (!page) throw new OperationError('page_not_found', op.op);
      if (page.locked) throw new OperationError('page_locked', op.op);
      if (next.pages.length <= 1) throw new OperationError('last_page', op.op);
      next.pages.splice(index, 1);
      return next;
    }
    case 'duplicatePage': {
      const sourceIndex = next.pages.findIndex((p) => p.id === op.pageId);
      const source = next.pages[sourceIndex];
      if (!source) throw new OperationError('page_not_found', op.op);
      if (next.pages.length >= 20) throw new OperationError('too_many_pages', op.op);
      if (next.pages.some((p) => p.id === op.newPageId)) throw new OperationError('duplicate_page_id', op.op);
      const sourceIds = idsIn(source.elements);
      const mapped = Object.keys(op.elementIdMap);
      if (mapped.length !== sourceIds.length || sourceIds.some((id) => op.elementIdMap[id] === undefined))
        throw new OperationError('element_id_map_incomplete', op.op);
      const existing = new Set(next.pages.flatMap((p) => idsIn(p.elements)));
      const fresh = Object.values(op.elementIdMap);
      if (new Set(fresh).size !== fresh.length || fresh.some((id) => existing.has(id)))
        throw new OperationError('duplicate_element_id', op.op);
      const { locked: _locked, ...unlocked } = structuredClone(source);
      const copy: CreativePage = {
        ...unlocked,
        id: op.newPageId,
        name: `${source.name} (copy)`.slice(0, 200),
        elements: source.elements.map((e) => withIds(structuredClone(e), op.elementIdMap)),
        layoutConstraints: source.layoutConstraints.map((c) => ({
          ...c,
          elementId: op.elementIdMap[c.elementId] ?? c.elementId,
        })),
      };
      const index =
        op.index === undefined ? sourceIndex + 1 : Math.max(0, Math.min(op.index, next.pages.length));
      next.pages.splice(index, 0, copy);
      return next;
    }
    case 'reorderPage': {
      const index = next.pages.findIndex((p) => p.id === op.pageId);
      if (index < 0) throw new OperationError('page_not_found', op.op);
      const [page] = next.pages.splice(index, 1);
      next.pages.splice(Math.max(0, Math.min(op.toIndex, next.pages.length)), 0, page as CreativePage);
      return next;
    }
    case 'setPageLock': {
      const page = pageOf(next, op.pageId, op.op);
      // Unlocking removes the key, so a page that was never locked hashes as it did before.
      if (op.locked) page.locked = true;
      else delete page.locked;
      return next;
    }
    case 'alignElements': {
      const page = pageOf(next, op.pageId, op.op);
      assertPageUnlocked(page, op.op);
      const members = distinctElements(page, op.elementIds, op.op);
      for (const id of op.elementIds) {
        const { element, ancestors } = requireElement(page, id, op.op);
        assertMovable(element, op.op, ancestors);
      }
      moveAll(page, alignedPositions(page, members, op.align, op.relativeTo), op.op);
      return next;
    }
    case 'distributeElements': {
      const page = pageOf(next, op.pageId, op.op);
      assertPageUnlocked(page, op.op);
      const members = distinctElements(page, op.elementIds, op.op);
      for (const id of op.elementIds) {
        const { element, ancestors } = requireElement(page, id, op.op);
        assertMovable(element, op.op, ancestors);
      }
      moveAll(page, distributedPositions(page, members, op.axis, op.relativeTo), op.op);
      return next;
    }
  }
}

/**
 * Spec 11.3 createFormatVariant: reflows via layout constraints; never scales pixels blindly. Anchored elements keep
 * their margins to the anchored edge; other elements scale by the smaller axis ratio (aspect preserved) and are
 * re-centred proportionally. Text sizes scale with the same factor so line breaks stay comparable.
 */
export function reflow(source: CreativePage, formatKey: string, width: number, height: number): CreativePage {
  const rx = width / source.width;
  const ry = height / source.height;
  const s = Math.min(rx, ry);
  const constraints = new Map(source.layoutConstraints.map((c) => [c.elementId, c]));
  const place = (el: Element): Element => {
    const t = el.transform;
    const w = t.width * s;
    const h = t.height * s;
    let x = (t.x + t.width / 2) * rx - w / 2;
    let y = (t.y + t.height / 2) * ry - h / 2;
    const c = constraints.get(el.id);
    if (c) {
      if (c.anchor === 'top') y = c.marginPx;
      if (c.anchor === 'bottom') y = height - c.marginPx - h;
      if (c.anchor === 'left') x = c.marginPx;
      if (c.anchor === 'right') x = width - c.marginPx - w;
      if (c.anchor === 'center') {
        x = (width - w) / 2;
        y = (height - h) / 2;
      }
    }
    if (el.type === 'background') return { ...el, transform: { x: 0, y: 0, width, height, rotation: 0 } };
    const base = { ...el, transform: { ...t, x, y, width: w, height: h } } as Element;
    if (base.type === 'text')
      return {
        ...base,
        style: { ...base.style, sizePx: base.style.sizePx * s, lineHeight: base.style.lineHeight },
      };
    if (base.type === 'group') return { ...base, children: base.children.map(place) };
    return base;
  };
  return {
    id: `${source.id}_${formatKey}`,
    name: `${source.name} (${formatKey})`,
    formatKey,
    width,
    height,
    elements: source.elements.map(place),
    layoutConstraints: structuredClone(source.layoutConstraints),
  };
}

export function applyBatch(
  doc: CreativeDocumentV1,
  batch: Pick<OperationBatch, 'operations'>,
  ctx: ReduceContext = {},
): CreativeDocumentV1 {
  let next = doc;
  for (const op of batch.operations) next = reduce(next, op, ctx);
  return DocumentSchema.parse(next);
}

/** Element ids touched by a batch (spec 11.4: anchored comments do not silently drift). */
export function changedElementIds(batch: Pick<OperationBatch, 'operations'>): string[] {
  const ids = new Set<string>();
  for (const op of batch.operations) {
    if ('elementId' in op) ids.add(op.elementId);
    if ('elementIds' in op) for (const id of op.elementIds) ids.add(id);
    if (op.op === 'insertElement') ids.add(op.element.id);
    if (op.op === 'groupElements') ids.add(op.groupId);
    if (op.op === 'duplicatePage') for (const id of Object.values(op.elementIdMap)) ids.add(id);
    if (op.op === 'applyTemplate') for (const id of Object.values(op.slotBindings)) ids.add(id);
  }
  return [...ids];
}

/** Ids of every element in the document (for comment outdating on page-level operations). */
export function allElementIds(doc: CreativeDocumentV1): string[] {
  const out: string[] = [];
  const walk = (els: Element[]) => {
    for (const el of els) {
      out.push(el.id);
      if (el.type === 'group') walk(el.children);
    }
  };
  for (const p of doc.pages) walk(p.elements);
  return out;
}
