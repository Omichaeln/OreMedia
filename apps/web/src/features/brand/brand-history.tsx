import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Skeleton, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { useToast } from '../../components/toast';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from './brand-context';
import { PublishImpact } from './publish-impact';
import { useBrandVersionImpact } from './use-brand';
import { useBrandHistory, useHistoryCompare, type HistoryEntryDto } from './use-assist';

/**
 * BSC-5 history of the brand system (D-22: versions stay internal): each applied state with who applied it, when
 * and which sections it changed; any of them compared with the brand system now, section by section in words; and a
 * restore that is a normal save of that state, with what saving reaches shown and confirmed first.
 */

const CHANGE_LABEL = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not applied';

function Compare({
  entry,
  onRestore,
  canRestore,
}: {
  entry: HistoryEntryDto;
  onRestore: () => void;
  canRestore: boolean;
}) {
  const { brandId } = useBrandContext();
  const diff = useHistoryCompare(brandId, entry.versionId);
  return (
    <section
      aria-labelledby={`compare-${entry.versionId}`}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      data-testid="history-compare"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`compare-${entry.versionId}`} className="text-sm font-semibold">
          From the state of {when(entry.appliedAt)} to the brand system now
        </h3>
        {canRestore && !entry.current && (
          <Button size="sm" onClick={onRestore}>
            Restore this state
          </Button>
        )}
      </div>
      {diff.isPending && <Skeleton label="Comparing" lines={3} />}
      {diff.isError && <RequestError error={diff.error} onRetry={() => void diff.refetch()} />}
      {diff.data && diff.data.sections.length === 0 && (
        <p className="text-sm text-muted-foreground">It is the same as the brand system now.</p>
      )}
      {diff.data?.sections.map((s) => (
        <div key={s.section}>
          <h4 className="text-sm font-medium">{s.label}</h4>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {s.changes.map((c, i) => (
              <li key={i} className="rounded-sm border border-border px-2 py-1" data-testid="history-change">
                <span className="font-medium">
                  {CHANGE_LABEL[c.change]}: {c.item}
                </span>
                {c.before !== null && (
                  <p className="text-xs text-muted-foreground">
                    Then: <span className="whitespace-pre-wrap">{c.before}</span>
                  </p>
                )}
                {c.after !== null && (
                  <p className="text-xs">
                    Now: <span className="whitespace-pre-wrap">{c.after}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function BrandHistory({
  canRestore,
  appliedVersionId,
}: {
  canRestore: boolean;
  appliedVersionId: string | null;
}) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const history = useBrandHistory(brandId);
  const [open, setOpen] = useState<HistoryEntryDto | null>(null);
  const [restoring, setRestoring] = useState<HistoryEntryDto | null>(null);
  const impact = useBrandVersionImpact(brandId, restoring !== null);
  const intent = useIntentKey();
  const restore = useMutation(
    trpc.brand.history.restore.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setRestoring(null);
        setOpen(null);
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
        toast({ tone: 'good', title: 'Earlier state restored and applied' });
      },
      onError: () => intent.renew(),
    }),
  );
  if (history.isPending) return <Skeleton label="Loading the history" lines={3} />;
  if (history.isError) return <RequestError error={history.error} onRetry={() => void history.refetch()} />;
  if (history.data.items.length === 0)
    return (
      <EmptyState
        title="Nothing applied yet"
        description="Each time the brand system is saved, it appears here."
      />
    );
  const restoreError = restore.error ? toUiError(restore.error) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="brand-history">
      <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
        {history.data.items.map((h) => (
          <li
            key={h.versionId}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            data-testid="history-entry"
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{when(h.appliedAt)}</span>
                {h.current && <Badge tone="good">Now</Badge>}
                <span className="text-muted-foreground">
                  {h.appliedByName ? `by ${h.appliedByName}` : ''}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {h.changedSections.length ? `Changed ${h.changedSections.join(', ')}` : 'No content changes'}
              </p>
            </div>
            {!h.current && (
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={open?.versionId === h.versionId}
                onClick={() => setOpen(open?.versionId === h.versionId ? null : h)}
              >
                Compare with now<span className="sr-only"> ({when(h.appliedAt)})</span>
              </Button>
            )}
          </li>
        ))}
      </ol>
      {open && <Compare entry={open} canRestore={canRestore} onRestore={() => setRestoring(open)} />}
      <Dialog open={restoring !== null} onOpenChange={(o) => !o && setRestoring(null)}>
        {restoring && (
          <DialogContent
            role="alertdialog"
            title="Restore this earlier state?"
            description={`The brand system goes back to how it was on ${when(restoring.appliedAt)}. It is saved and applied like any change; the current state stays in the history.`}
          >
            <PublishImpact brandId={brandId} />
            {restoreError && (
              <StatusBanner
                tone="critical"
                title="Not restored"
                description={[
                  restoreError.message,
                  ...restoreError.details.map((d) => d.issue.replaceAll('_', ' ')),
                ].join(' · ')}
              />
            )}
            <DialogActions>
              <DialogClose asChild>
                <Button size="sm" variant="ghost">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                size="sm"
                variant="primary"
                disabled={restore.isPending || impact.data?.available !== true}
                disabledReason={
                  impact.data?.available === true ? undefined : 'Wait for what restoring reaches to load'
                }
                onClick={() =>
                  restore.mutate({
                    brandId,
                    versionId: restoring.versionId,
                    basedOnVersionId: appliedVersionId,
                  })
                }
              >
                {restore.isPending ? 'Restoring…' : 'Restore and apply'}
              </Button>
            </DialogActions>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
