import { useMemo } from 'react';
import type { CreativeDocumentV1, Operation } from '@oremedia/contracts/creative';
import type { TemplateDocument } from '@oremedia/editor';
import { Badge, Button, StatusBanner, type Tone } from '@oremedia/ui';
import { Dialog, DialogActions, DialogContent } from '../../components/dialog';
import { retryAfterText } from '../../lib/errors';
import { elementName } from './document-helpers';
import { keepMineOps } from './studio-reducer';
import type { Conflict, SaveStatus } from './types';

/** Spec 11.1 visible save/revision state; every state has a glyph and words, never colour alone. */
export function SaveIndicator({
  save,
  revisionNumber,
  onRetry,
}: {
  save: SaveStatus;
  revisionNumber: number;
  onRetry: () => void;
}) {
  const view: { tone: Tone; text: string; busy?: boolean } =
    save.kind === 'saved'
      ? { tone: 'good', text: `Saved · revision ${revisionNumber}` }
      : save.kind === 'pending'
        ? { tone: 'info', text: 'Unsaved changes' }
        : save.kind === 'saving'
          ? { tone: 'info', text: 'Saving…', busy: true }
          : save.kind === 'rebasing'
            ? { tone: 'warning', text: 'Document changed elsewhere; re-applying your changes…', busy: true }
            : save.kind === 'conflict'
              ? { tone: 'critical', text: 'Conflict: needs your decision' }
              : {
                  tone: 'critical',
                  text: `Autosave failed: ${save.error.message}${retryAfterText(save.error.retryAfterMs)}`,
                };
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-sm"
      data-testid="save-state"
      data-save-kind={save.kind}
    >
      <Badge tone={view.tone} glyph={!view.busy}>
        {view.busy && (
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
          />
        )}
        {view.text}
      </Badge>
      {save.kind === 'failed' && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export interface ConflictDialogProps {
  conflict: Conflict;
  doc: CreativeDocumentV1;
  templates: Record<string, TemplateDocument>;
  onKeepServer: () => void;
  onKeepMine: () => void;
  onDiscardAll: () => void;
}

/** What one side did to the element, in words a person compares (UX-15): the op and the values it carries. */
export function describeOp(op: Operation): string {
  switch (op.op) {
    case 'setText':
      return `text “${op.text.length > 60 ? `${op.text.slice(0, 57)}…` : op.text}”`;
    case 'moveElement':
      return `moved to ${Math.round(op.x)}, ${Math.round(op.y)}`;
    case 'resizeElement':
      return `resized to ${Math.round(op.width)} × ${Math.round(op.height)}`;
    case 'setStyle':
      return `style ${Object.keys(op.patch).join(', ') || 'unchanged'}`;
    case 'replaceAsset':
      return 'replaced the asset';
    case 'removeElement':
      return 'removed it';
    case 'insertElement':
      return `inserted ${op.element.name}`;
    case 'reorderElement':
      return `moved to layer ${op.toIndex + 1}`;
    case 'setCrop':
      return 'changed the crop';
    case 'setLock':
      return op.locked ? 'locked it' : 'unlocked it';
    case 'applyTemplate':
      return 'applied a template to the page';
    case 'addPage':
      return 'added a page';
    case 'createFormatVariant':
      return `created a ${op.formatKey} variant`;
  }
}

/**
 * Spec 21.4: the same element touched by both sides; the person decides, nothing is merged silently. UX-15: each
 * conflict is shown side by side (theirs, mine), and the person can keep their version or mine for those
 * elements; either way the rest of the local work is re-applied on the head and saved as a new revision.
 */
export function ConflictDialog({
  conflict,
  doc,
  templates,
  onKeepServer,
  onKeepMine,
  onDiscardAll,
}: ConflictDialogProps) {
  const names = [
    ...new Set(
      conflict.conflicts.map(
        (c) => elementName(conflict.head.snapshot, c.elementId) || elementName(doc, c.elementId),
      ),
    ),
  ];
  const kept = conflict.localOps.length - conflict.conflicts.length;
  const mine = useMemo(
    () => keepMineOps(conflict.head, conflict.localOps, templates),
    [conflict.head, conflict.localOps, templates],
  );
  return (
    <Dialog open>
      <DialogContent
        role="alertdialog"
        title="Someone else changed the same elements"
        description={`The document moved to revision ${conflict.head.number} while you were editing. Your changes to ${names.join(', ')} conflict with theirs.`}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <ul
          className="mb-2 flex flex-col gap-2 text-sm"
          aria-label="Conflicting elements"
          data-testid="conflict-list"
        >
          {conflict.conflicts.map((c, i) => (
            <li key={i} className="rounded-md border border-border p-2">
              <span className="font-medium">
                {elementName(conflict.head.snapshot, c.elementId) || c.elementId}
              </span>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">Theirs</dt>
                <dd className="break-words">{describeOp(c.remoteOp)}</dd>
                <dt className="text-muted-foreground">Mine</dt>
                <dd className="break-words">{describeOp(c.localOp)}</dd>
              </dl>
            </li>
          ))}
        </ul>
        <StatusBanner
          tone="info"
          title="Nothing is merged silently"
          description={`Their version is revision ${conflict.head.number}. Keeping theirs re-applies ${Math.max(0, kept)} of your other changes on it; keeping yours writes your ${mine.kept.length} change${mine.kept.length === 1 ? '' : 's'} over theirs as a new revision${mine.dropped.length > 0 ? ` (${mine.dropped.length} no longer apply: ${mine.dropped.map((d) => describeOp(d.op)).join('; ')})` : ''}. Either way their revision stays in the history.`}
        />
        <DialogActions>
          <Button variant="danger" onClick={onDiscardAll}>
            Discard all my changes
          </Button>
          <Button onClick={onKeepMine} disabled={mine.kept.length === 0} data-testid="conflict-keep-mine">
            Keep my version for these elements
          </Button>
          <Button variant="primary" onClick={onKeepServer} data-testid="conflict-keep-server">
            Keep their version for these elements, re-apply the rest
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onStay()}>
      <DialogContent
        role="alertdialog"
        title="You have unsaved changes"
        description="Leaving now discards local edits that have not been saved yet."
      >
        <DialogActions>
          <Button variant="primary" onClick={onStay}>
            Stay and save
          </Button>
          <Button variant="danger" onClick={onLeave}>
            Leave anyway
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
