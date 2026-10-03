import type { CreativeDocumentV1, CreativePage, Element, Operation } from '@oremedia/contracts/creative';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type { GenerationScope } from '@oremedia/contracts/generation';
import { findWithAncestors, isLockedInContext, reflow } from './reduce';

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

interface Target {
  element: Element;
  ancestors: Element[];
}

/**
 * The elements an operation changes, as they are in `page` before it applies, each with the groups that contain it:
 * the element it names, the members of a group/align/distribute, every element of the page (top level) for a page
 * replacement or removal.
 */
function targetsOf(page: CreativePage, op: Operation): Target[] {
  if (op.op === 'applyTemplate' || op.op === 'removePage')
    return page.elements.map((element) => ({ element, ancestors: [] }));
  const ids: string[] = [];
  if ('elementId' in op) ids.push(op.elementId);
  if ('elementIds' in op) ids.push(...op.elementIds);
  return ids.map((id) => findWithAncestors(page, id)).filter((t): t is Target => t !== null);
}

const isProtected = (el: Element): boolean => el.protected || el.type === 'logo';
/** Protected: the element, anything inside it, or a group containing it is protected (a logo always is). */
const isProtectedDeep = (el: Element): boolean =>
  isProtected(el) || (el.type === 'group' && el.children.some(isProtectedDeep));
const isProtectedInContext = (t: Target): boolean =>
  isProtectedDeep(t.element) || t.ancestors.some(isProtected);

const deny = (el: Element) => {
  throw new PolicyDeniedError('protected_element', `Agents cannot change protected element ${el.id}`);
};

export function guardProtected(doc: CreativeDocumentV1, op: Operation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  const pageId = pageIdOf(op);
  const page = pageId ? doc.pages.find((p) => p.id === pageId) : undefined;
  if (!page) return; // the reducer reports page_not_found
  const checked =
    ('elementId' in op && MUTATING_ON_ELEMENT.has(op.op)) ||
    op.op === 'groupElements' ||
    op.op === 'alignElements' ||
    op.op === 'distributeElements' ||
    // A page replacement or removal would take a protected element (a logo) with it.
    op.op === 'applyTemplate' ||
    op.op === 'removePage';
  if (!checked) return;
  const hit = targetsOf(page, op).find(isProtectedInContext);
  if (hit) deny(hit.element);
}

/**
 * STU-1a, architecture principle 2 (locks are binding): an agent operation is refused when it acts on a locked page
 * (anything on it, the page itself, a copy or variant made from it) or on a locked element: the element itself,
 * anything inside it or a group that contains it (text, style, asset, transform, crop, mask, order, grouping,
 * removal; a page replacement or removal that would take it with it). A person's operations are checked by the
 * reducer (locked elements are not moved, resized, rotated or removed; templates do not replace locked pages).
 */
export function guardLocks(doc: CreativeDocumentV1, op: Operation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  const pageId = pageIdOf(op);
  const page = pageId ? doc.pages.find((p) => p.id === pageId) : undefined;
  if (!page) return; // addPage carries its own page; the reducer reports page_not_found
  if (page.locked) throw new PolicyDeniedError('page_locked', `Agents cannot change locked page ${page.id}`);
  const locked = targetsOf(page, op).find((t) => isLockedInContext(t.element, t.ancestors));
  if (locked)
    throw new PolicyDeniedError('element_locked', `Agents cannot change locked element ${locked.element.id}`);
}

const hasLogo = (elements: readonly Element[]): boolean =>
  elements.some((e) => e.type === 'logo' || (e.type === 'group' && hasLogo(e.children)));

/**
 * Logos are always approved original asset files (spec 2.2): agents may not bring logo elements into a document,
 * whether inserted, carried by a new page, copied with a duplicated page or a format variant, or brought in by a
 * template. `doc` is the document the operation applies to; `templateElements` the template page applyTemplate uses.
 */
export function guardLogoInsertion(
  op: Operation,
  origin: 'user' | 'agent',
  doc?: CreativeDocumentV1,
  templateElements?: readonly Element[],
): void {
  if (origin !== 'agent') return;
  const source =
    op.op === 'duplicatePage'
      ? doc?.pages.find((p) => p.id === op.pageId)
      : op.op === 'createFormatVariant'
        ? doc?.pages.find((p) => p.id === op.sourcePageId)
        : undefined;
  const introduces =
    (op.op === 'insertElement' && hasLogo([op.element])) ||
    (op.op === 'addPage' && hasLogo(op.page.elements)) ||
    (source !== undefined && hasLogo(source.elements)) ||
    (op.op === 'applyTemplate' && templateElements !== undefined && hasLogo(templateElements));
  if (introduces)
    throw new PolicyDeniedError(
      'agent_logo_insert',
      'Agents cannot add logo elements; logos are placed from approved assets by a person',
    );
}

/**
 * STU-1b scope state for one batch: the scope a person gave the request and what the batch itself created so far
 * (pages copied or adapted from the scoped page, elements inserted in place of a scoped one). Created pages and
 * inserted elements are in scope for the rest of the batch.
 */
export interface ScopeState {
  scope: GenerationScope;
  createdPageIds: Set<string>;
  insertedIds: Set<string>;
  /** Scoped elements the batch removed: each allows one insertion on the scoped page (an image area's image). */
  replacements: number;
}

export const scopeState = (scope: GenerationScope): ScopeState => ({
  scope,
  createdPageIds: new Set(),
  insertedIds: new Set(),
  replacements: 0,
});

const scopeDenied = (what: string): PolicyDeniedError =>
  new PolicyDeniedError('out_of_scope', `The request's scope does not include ${what}`);

/**
 * STU-1b, architecture principle 2: an AI batch made for a scope (a page, or selected elements of it) may change
 * only what the scope holds. A selected group brings its children; an element inside a selected group is in scope.
 * The scoped page may be copied or adapted (the original is only read) when the scope is the whole page, and the new
 * pages are in scope. Everything else (other pages, unselected elements, page removal or reordering, new pages that
 * do not come from the scope) is refused here, on the server, whatever the prompt said. Runs before the reducer.
 */
export function guardScope(doc: CreativeDocumentV1, op: Operation, state: ScopeState): void {
  const { scope } = state;
  const wholePage = scope.elementIds.length === 0;
  const pageId = pageIdOf(op);
  if (op.op === 'addPage') throw scopeDenied('new pages');
  if (op.op === 'duplicatePage' || op.op === 'createFormatVariant') {
    if (pageId !== scope.pageId || !wholePage) throw scopeDenied(`copies of page ${pageId}`);
    if (op.op === 'duplicatePage') state.createdPageIds.add(op.newPageId);
    else {
      const source = doc.pages.find((p) => p.id === op.sourcePageId);
      if (source) state.createdPageIds.add(reflow(source, op.formatKey, 1, 1).id);
    }
    return;
  }
  if (pageId === null) throw scopeDenied(`operation ${op.op}`);
  if (state.createdPageIds.has(pageId)) return;
  if (pageId !== scope.pageId) throw scopeDenied(`page ${pageId}`);
  if (op.op === 'removePage' || op.op === 'reorderPage' || op.op === 'setPageLock')
    throw scopeDenied(`changes to page ${pageId} itself`);
  if (wholePage) return;
  if (op.op === 'applyTemplate') throw scopeDenied(`the whole of page ${pageId}`);
  if (op.op === 'insertElement') {
    if (state.replacements <= 0) throw scopeDenied('new elements outside the selection');
    state.replacements -= 1;
    state.insertedIds.add(op.element.id);
    return;
  }
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return; // the reducer reports page_not_found
  const ids = [...('elementId' in op ? [op.elementId] : []), ...('elementIds' in op ? op.elementIds : [])];
  for (const id of ids) {
    if (state.insertedIds.has(id)) continue;
    const found = findWithAncestors(page, id); // the same ancestor-aware lookup the lock and protection guards use
    if (!found) continue; // the reducer reports element_not_found
    if (![...found.ancestors, found.element].some((el) => scope.elementIds.includes(el.id)))
      throw scopeDenied(`element ${id}`);
  }
  if (op.op === 'removeElement') state.replacements += 1;
}
