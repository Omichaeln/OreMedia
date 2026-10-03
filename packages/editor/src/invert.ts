import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Operation,
  OperationBatch,
} from '@oremedia/contracts/creative';
import { reduce, type ReduceContext } from './reduce';

/**
 * Spec 11.4: undo is a NEW revision whose snapshot equals an earlier one; history is never rewritten. The inverse
 * of a batch is therefore itself an operation batch, computed against the document the batch was applied to.
 *
 * Page-level operations invert through the STU-1a page operations (addPage ↔ removePage, reorderPage, setPageLock).
 * Operations whose exact inverse cannot be expressed (e.g. a nested element removed) are reported as not invertible
 * rather than guessed at.
 */
export type InvertResult =
  { ok: true; operations: Operation[] } | { ok: false; reason: string; op: Operation['op'] };

const pageOf = (doc: CreativeDocumentV1, pageId: string): CreativePage | undefined =>
  doc.pages.find((p) => p.id === pageId);

/** Top-level index of an element on a page; nested elements (inside groups) return -1. */
const topLevelIndex = (page: CreativePage, elementId: string): number =>
  page.elements.findIndex((e) => e.id === elementId);

const findNested = (elements: Element[], elementId: string): Element | null => {
  for (const el of elements) {
    if (el.id === elementId) return el;
    if (el.type === 'group') {
      const found = findNested(el.children, elementId);
      if (found) return found;
    }
  }
  return null;
};

const notInvertible = (op: Operation['op'], reason: string): InvertResult => ({ ok: false, reason, op });

/** The old value of every key a setStyle patch touches; text style keys live under `style`, the rest on the element. */
function styleBefore(el: Element, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bag: Record<string, unknown> =
    el.type === 'text' ? { ...(el.style as Record<string, unknown>), opacity: el.opacity } : { ...el };
  for (const k of Object.keys(patch)) out[k] = bag[k];
  return out;
}

/**
 * Removes a top-level element even when it (or something inside it) is locked: the reducer refuses to remove locked
 * elements, so the inverse unlocks them first (STU-1a). What is re-inserted afterwards carries its locks again.
 */
function removalOf(pageId: string, element: Element): Operation[] {
  const unlock: Operation[] = [];
  const walk = (el: Element) => {
    if (el.locked) unlock.push({ op: 'setLock', pageId, elementId: el.id, locked: false });
    if (el.type === 'group') el.children.forEach(walk);
  };
  walk(element);
  return [...unlock, { op: 'removeElement', pageId, elementId: element.id }];
}

/** Restores one top-level element in place: remove whatever is there now, insert the old element at its old index. */
const restoreSequence = (pageId: string, element: Element, index: number): Operation[] => [
  ...removalOf(pageId, element),
  { op: 'insertElement', pageId, element: structuredClone(element), index },
];

/**
 * Moving an element back: a leaf takes its old position (exact); a top-level group is restored whole, since its
 * descendants were translated and float arithmetic would not land them exactly where they were.
 */
function restorePosition(page: CreativePage, pageId: string, el: Element): Operation[] | null {
  if (el.type !== 'group')
    return [{ op: 'moveElement', pageId, elementId: el.id, x: el.transform.x, y: el.transform.y }];
  const index = topLevelIndex(page, el.id);
  return index < 0 ? null : restoreSequence(pageId, el, index);
}

/** The page restored at its place; a locked page is added unlocked, then locked again (removePage refuses it). */
const removeAdded = (pageId: string, locked: boolean | undefined): Operation[] => [
  ...(locked ? [{ op: 'setPageLock' as const, pageId, locked: false }] : []),
  { op: 'removePage', pageId },
];

function invertOne(doc: CreativeDocumentV1, op: Operation, ctx: ReduceContext): Operation[] | InvertResult {
  switch (op.op) {
    case 'addPage':
      return removeAdded(op.page.id, op.page.locked);
    case 'createFormatVariant': {
      const after = reduce(doc, op, ctx);
      const added = after.pages[after.pages.length - 1];
      if (!added) return notInvertible(op.op, 'page_not_found');
      return removeAdded(added.id, added.locked);
    }
    case 'duplicatePage':
      return [{ op: 'removePage', pageId: op.newPageId }];
    case 'removePage': {
      const index = doc.pages.findIndex((p) => p.id === op.pageId);
      const page = doc.pages[index];
      if (!page) return notInvertible(op.op, 'page_not_found');
      return [{ op: 'addPage', page: structuredClone(page), index }];
    }
    case 'reorderPage': {
      const index = doc.pages.findIndex((p) => p.id === op.pageId);
      if (index < 0) return notInvertible(op.op, 'page_not_found');
      return [{ op: 'reorderPage', pageId: op.pageId, toIndex: index }];
    }
    case 'setPageLock': {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      return [{ op: 'setPageLock', pageId: op.pageId, locked: page.locked === true }];
    }
    case 'groupElements': {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      const members = op.elementIds
        .map((id) => ({ index: topLevelIndex(page, id), element: page.elements[topLevelIndex(page, id)] }))
        .sort((a, b) => a.index - b.index);
      if (members.some((m) => m.index < 0 || !m.element)) return notInvertible(op.op, 'nested_element');
      return [
        { op: 'removeElement', pageId: op.pageId, elementId: op.groupId },
        ...members.map((m): Operation => ({
          op: 'insertElement',
          pageId: op.pageId,
          element: structuredClone(m.element as Element),
          index: m.index,
        })),
      ];
    }
    case 'ungroupElement': {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      const index = topLevelIndex(page, op.elementId);
      const group = page.elements[index];
      if (!group || group.type !== 'group') return notInvertible(op.op, 'not_a_group');
      return [
        ...group.children.map((c): Operation => ({
          op: 'removeElement',
          pageId: op.pageId,
          elementId: c.id,
        })),
        { op: 'insertElement', pageId: op.pageId, element: structuredClone(group), index },
      ];
    }
    case 'alignElements':
    case 'distributeElements': {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      const ops: Operation[] = [];
      for (const id of op.elementIds) {
        const el = findNested(page.elements, id);
        if (!el) return notInvertible(op.op, 'element_not_found');
        const back = restorePosition(page, op.pageId, el);
        if (!back) return notInvertible(op.op, 'nested_element');
        ops.push(...back);
      }
      return ops;
    }
    case 'applyTemplate': {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      const after = reduce(doc, op, ctx);
      const afterPage = pageOf(after, op.pageId);
      if (!afterPage) return notInvertible(op.op, 'page_not_found');
      // Elements are restored; the page's layoutConstraints and the document's templateVersionId are template
      // metadata with no operation of their own and stay as the template left them.
      const ops: Operation[] = afterPage.elements.flatMap((e) => removalOf(op.pageId, e));
      page.elements.forEach((e, index) =>
        ops.push({ op: 'insertElement', pageId: op.pageId, element: structuredClone(e), index }),
      );
      return ops;
    }
    case 'insertElement':
      return removalOf(op.pageId, op.element);
    default: {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      const el = findNested(page.elements, op.elementId);
      if (!el) return notInvertible(op.op, 'element_not_found');
      const index = topLevelIndex(page, op.elementId);
      switch (op.op) {
        case 'removeElement':
          if (index < 0) return notInvertible(op.op, 'nested_element');
          return [{ op: 'insertElement', pageId: op.pageId, element: structuredClone(el), index }];
        case 'setText':
          if (el.type !== 'text') return notInvertible(op.op, 'not_a_text_element');
          return [
            { op: 'setText', pageId: op.pageId, elementId: el.id, text: el.text, factRefs: [...el.factRefs] },
          ];
        case 'setStyle':
          return [{ op: 'setStyle', pageId: op.pageId, elementId: el.id, patch: styleBefore(el, op.patch) }];
        case 'replaceAsset': {
          const old =
            el.type === 'image' || el.type === 'logo' || el.type === 'background'
              ? el.assetVersionId
              : undefined;
          if (old === undefined) {
            if (index < 0) return notInvertible(op.op, 'nested_element');
            return restoreSequence(op.pageId, el, index);
          }
          return [{ op: 'replaceAsset', pageId: op.pageId, elementId: el.id, assetVersionId: old }];
        }
        case 'moveElement':
          return restorePosition(page, op.pageId, el) ?? notInvertible(op.op, 'nested_element');
        case 'resizeElement':
          if (el.type === 'group') {
            if (index < 0) return notInvertible(op.op, 'nested_element');
            return restoreSequence(op.pageId, el, index);
          }
          return [
            {
              op: 'resizeElement',
              pageId: op.pageId,
              elementId: el.id,
              width: el.transform.width,
              height: el.transform.height,
            },
          ];
        case 'reorderElement': {
          if (index < 0) return notInvertible(op.op, 'nested_element');
          return [{ op: 'reorderElement', pageId: op.pageId, elementId: el.id, toIndex: index }];
        }
        case 'setCrop': {
          if (el.type !== 'image') return notInvertible(op.op, 'not_an_image');
          if (!el.crop) {
            if (index < 0) return notInvertible(op.op, 'nested_element');
            return restoreSequence(op.pageId, el, index);
          }
          return [{ op: 'setCrop', pageId: op.pageId, elementId: el.id, crop: { ...el.crop } }];
        }
        case 'setLock':
          return [{ op: 'setLock', pageId: op.pageId, elementId: el.id, locked: el.locked }];
        case 'setRotation':
          return [
            { op: 'setRotation', pageId: op.pageId, elementId: el.id, rotation: el.transform.rotation },
          ];
        case 'setMask':
          if (el.type !== 'image') return notInvertible(op.op, 'not_an_image');
          return [
            { op: 'setMask', pageId: op.pageId, elementId: el.id, mask: el.mask ? { ...el.mask } : null },
          ];
      }
    }
  }
}

/**
 * The operations that restore `before` from `applyBatch(before, batch)`. Each operation is inverted against the
 * document state it was applied to, and the inverses are returned in reverse order so that
 * `applyBatch(applyBatch(before, batch), inverse)` deep-equals `before` (canonical JSON) for every invertible op.
 * `ctx.templates` is needed only when the batch contains applyTemplate (the reducer never fetches).
 */
export function invertBatch(
  before: CreativeDocumentV1,
  batch: Pick<OperationBatch, 'operations'>,
  ctx: ReduceContext = {},
): InvertResult {
  const inverses: Operation[][] = [];
  let current = before;
  for (const op of batch.operations) {
    const inv = invertOne(current, op, ctx);
    if (!Array.isArray(inv)) return inv;
    inverses.push(inv);
    current = reduce(current, op, ctx);
  }
  return { ok: true, operations: inverses.reverse().flat() };
}
