import type { Operation } from '@oremedia/contracts/creative';
import { changedElementIds } from './reduce';

/**
 * Spec 21.4: on STALE_REVISION the client re-applies its local intents to the new head when they do not conflict;
 * the same element touched by both sides is a conflict shown to the user. Operations are intents (setText,
 * moveElement, …), so a non-conflicting local operation is valid against the new head unchanged.
 */
export interface RebaseConflict {
  elementId: string;
  localOp: Operation;
  remoteOp: Operation;
}

export type RebaseResult = { ok: true; operations: Operation[] } | { ok: false; conflicts: RebaseConflict[] };

/**
 * Page ids an operation touches as a whole: applyTemplate replaces every element on its page, removePage takes them
 * all away; addPage and duplicatePage own the page id they create. A LOCAL duplicatePage also reads its source page
 * as it stands, so remote edits or a removal of the source conflict with it (the copy would not be what the person
 * saw); a remote duplicate does not stop local edits of the source.
 */
const pageScopes = (op: Operation, side: 'local' | 'remote'): string[] => {
  if (op.op === 'applyTemplate' || op.op === 'removePage') return [op.pageId];
  if (op.op === 'addPage') return [op.page.id];
  if (op.op === 'duplicatePage') return side === 'local' ? [op.newPageId, op.pageId] : [op.newPageId];
  return [];
};

const pageOfOp = (op: Operation): string | null => {
  if (op.op === 'duplicatePage') return op.newPageId;
  if ('pageId' in op) return op.pageId;
  if (op.op === 'addPage') return op.page.id;
  if (op.op === 'createFormatVariant') return op.sourcePageId;
  return null;
};

export function rebaseBatch(localOps: Operation[], serverOpsSinceBase: Operation[][]): RebaseResult {
  const remoteByElement = new Map<string, Operation>();
  const remoteByPage = new Map<string, Operation>();
  const remoteOnPage = new Map<string, Operation>();
  for (const batch of serverOpsSinceBase)
    for (const op of batch) {
      for (const id of changedElementIds({ operations: [op] }))
        if (!remoteByElement.has(id)) remoteByElement.set(id, op);
      for (const scope of pageScopes(op, 'remote')) if (!remoteByPage.has(scope)) remoteByPage.set(scope, op);
      const page = pageOfOp(op);
      if (page && !remoteOnPage.has(page)) remoteOnPage.set(page, op);
    }

  const conflicts: RebaseConflict[] = [];
  for (const localOp of localOps) {
    const ids = changedElementIds({ operations: [localOp] });
    for (const id of ids) {
      const remoteOp = remoteByElement.get(id);
      if (remoteOp) conflicts.push({ elementId: id, localOp, remoteOp });
    }
    // A remote page-level replacement invalidates every local intent on that page, and a local one every remote edit.
    const pages = new Set([pageOfOp(localOp), ...(localOp.op === 'duplicatePage' ? [localOp.pageId] : [])]);
    for (const page of pages) {
      const remotePage = page ? remoteByPage.get(page) : undefined;
      if (remotePage && !ids.some((id) => remoteByElement.get(id) === remotePage))
        conflicts.push({ elementId: ids[0] ?? page ?? '', localOp, remoteOp: remotePage });
    }
    for (const localScope of pageScopes(localOp, 'local')) {
      let found = false;
      for (const [id, remoteOp] of remoteByElement)
        if (pageOfOp(remoteOp) === localScope && !ids.includes(id)) {
          conflicts.push({ elementId: id, localOp, remoteOp });
          found = true;
        }
      // Page-level remote changes of the scope (a reorder, a lock) name no element but still touch the page.
      const remotePageOp = remoteOnPage.get(localScope);
      if (!found && remotePageOp && localOp.op === 'duplicatePage' && localScope === localOp.pageId)
        if (remotePageOp.op === 'removePage' || remotePageOp.op === 'applyTemplate')
          conflicts.push({ elementId: localScope, localOp, remoteOp: remotePageOp });
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, operations: localOps.map((op) => structuredClone(op)) };
}
