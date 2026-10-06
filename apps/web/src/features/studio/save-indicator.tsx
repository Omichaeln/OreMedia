import { useMemo } from 'react';
import type { CreativeDocumentV1, Operation } from '@oremedia/contracts/creative';
import type { TemplateDocument } from '@oremedia/editor';
import { Button, StatusBanner, StatusDot, cn, toneGlyph, toneTextClass, type Tone } from '@oremedia/ui';
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
              : // The reason and when to retry are in the autosave banner under the bar (AutosaveFailedBanner).
                { tone: 'critical', text: 'Not saved' };
  // The interface's form: a 6 px dot and the state in small muted figures beside the breadcrumb; the glyph is kept
  // for assistive technology so the dot is never the only carrier of the state.
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
      data-testid="save-state"
      data-save-kind={save.kind}
    >
      {view.busy ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-status-info-dot"
        />
      ) : (
        <StatusDot tone={view.tone} size="sm" />
      )}
      <span className="sr-only">{toneGlyph[view.tone]} </span>
      <span
        className={cn(
          'truncate',
          save.kind === 'failed' || save.kind === 'conflict' ? toneTextClass[view.tone] : '',
        )}
      >
        {view.text}
      </span>
      {save.kind === 'failed' && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * The interface's autosave and conflict states as banners under the studio bar (graphic and video studios alike):
 * a failed autosave keeps the work locally and offers the retry that replays the same intent; while the head moved
 * underneath, the person is told their changes are being re-applied; a conflict names the revision and points to the
 * decision (the dialog). Nothing here changes how saves, rebases or conflicts work.
 */
export function SaveBanners({
  save,
  headNumber,
  onRetry,
}: {
  save: SaveStatus;
  headNumber: number;
  onRetry: () => void;
}) {
  if (save.kind === 'failed')
    return (
      <StatusBanner
        tone="critical"
        title="Autosave failed"
        description={`${save.error.message}${retryAfterText(save.error.retryAfterMs)} Your changes are kept locally; retry when ready.`}
        actions={
          <Button size="sm" onClick={onRetry}>
            Retry save
          </Button>
        }
      />
    );
  if (save.kind === 'rebasing')
    return (
      <StatusBanner
        tone="warning"
        busy
        title="Someone saved a newer revision while you were editing"
        description="Your changes are being re-applied on it. Nothing is overwritten."
      />
    );
  if (save.kind === 'conflict')
    return (
      <StatusBanner
        tone="warning"
        live="polite"
        title={`Revision ${headNumber} was saved while you were editing`}
        description="Some of your changes touch the same parts. Choose which version to keep; theirs stays in the history either way."
      />
    );
  return null;
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
    case 'setVisibility':
      return op.visible ? 'showed it' : 'hid it';
    case 'applyTemplate':
      return 'applied a template to the page';
    case 'addPage':
      return 'added a page';
    case 'createFormatVariant':
      return `created a ${op.formatKey} variant`;
    case 'groupElements':
      return `grouped ${op.elementIds.length} elements`;
    case 'ungroupElement':
      return 'ungrouped it';
    case 'setRotation':
      return `rotated to ${Math.round(op.rotation)}°`;
    case 'setMask':
      return op.mask ? `masked it (${op.mask.kind})` : 'removed the mask';
    case 'removePage':
      return 'removed the page';
    case 'duplicatePage':
      return 'duplicated the page';
    case 'reorderPage':
      return `moved the page to position ${op.toIndex + 1}`;
    case 'setPageLock':
      return op.locked ? 'locked the page' : 'unlocked the page';
    case 'alignElements':
      return `aligned ${op.align} to the ${op.relativeTo}`;
    case 'distributeElements':
      return `distributed ${op.axis === 'horizontal' ? 'horizontally' : 'vertically'}`;
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
