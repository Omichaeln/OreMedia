import type { CreativeDocumentV1, CreativePage, Element, Operation } from '@oremedia/contracts/creative';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { allElementIds, findElement, isLockedDeep } from './reduce';

/** Spec 11.2/11.4: protected elements (e.g. logos) cannot be moved, resized, recoloured, replaced or removed by agents. */
const MUTATING_ON_ELEMENT = new Set<Operation['op']>([
  'removeElement',
  'setStyle',
  'replaceAsset',
  'moveElement',
  'resizeElement',
  'setCrop',
  'reorderElement',
  'setLock',
  'setText',
  'setRotation',
  'setMask',
  'ungroupElement',
]);

/** The page an operation acts on, when it acts on one (insertions, edits, page operations). */
function pageIdOf(op: Operation): string | null {
  if ('pageId' in op) return op.pageId;
  if (op.op === 'createFormatVariant') return op.sourcePageId;
  return null;
}

/**
 * The elements an operation changes, as they are in `page` before it applies: the element it names, the members
 * of a group/align/distribute, every element of the page for a page replacement or removal.
 */
function targetsOf(page: CreativePage, op: Operation): Element[] {
  const ids: string[] = [];
  if ('elementId' in op) ids.push(op.elementId);
  if ('elementIds' in op) ids.push(...op.elementIds);
  if (op.op === 'applyTemplate' || op.op === 'removePage')
    ids.push(...allElementIds({ schemaVersion: 1, brandVersionId: '', pages: [page], variants: [] }));
  return ids.map((id) => findElement(page, id)).filter((e): e is Element => e !== null);
}

/** Inside a group, an element is as protected as anything that contains it. */
const isProtectedDeep = (el: Element): boolean =>
  el.protected || el.type === 'logo' || (el.type === 'group' && el.children.some(isProtectedDeep));

export function guardProtected(doc: CreativeDocumentV1, op: Operation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  const pageId = pageIdOf(op);
  const page = pageId ? doc.pages.find((p) => p.id === pageId) : undefined;
  if (!page) return; // the reducer reports page_not_found
  if ('elementId' in op && MUTATING_ON_ELEMENT.has(op.op)) {
    const el = findElement(page, op.elementId);
    if (!el) return; // the reducer reports element_not_found
    if (isProtectedDeep(el))
      throw new PolicyDeniedError('protected_element', `Agents cannot change protected element ${el.id}`);
    return;
  }
  if (op.op === 'groupElements' || op.op === 'alignElements' || op.op === 'distributeElements') {
    const el = targetsOf(page, op).find(isProtectedDeep);
    if (el)
      throw new PolicyDeniedError('protected_element', `Agents cannot change protected element ${el.id}`);
  }
}

/**
 * STU-1a, architecture principle 2 (locks are binding): an agent operation is refused when it acts on a locked page
 * (anything on it, the page itself, a copy or variant made from it) or on a locked element (text, style, asset,
 * transform, crop, mask, order, grouping, removal; a page replacement or removal that would take it with it). A
 * person's operations are not refused here: the reducer stops manual move, resize and rotation of locked items.
 */
export function guardLocks(doc: CreativeDocumentV1, op: Operation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  const pageId = pageIdOf(op);
  const page = pageId ? doc.pages.find((p) => p.id === pageId) : undefined;
  if (!page) return; // addPage carries its own page; the reducer reports page_not_found
  if (page.locked) throw new PolicyDeniedError('page_locked', `Agents cannot change locked page ${page.id}`);
  const locked = targetsOf(page, op).find(isLockedDeep);
  if (locked)
    throw new PolicyDeniedError('element_locked', `Agents cannot change locked element ${locked.id}`);
}

/** Logos are always approved original asset files (spec 2.2): agents may not insert logo elements or generated logos. */
export function guardLogoInsertion(op: Operation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  if (op.op === 'insertElement' && op.element.type === 'logo')
    throw new PolicyDeniedError(
      'agent_logo_insert',
      'Agents cannot add logo elements; logos are placed from approved assets by a person',
    );
}
