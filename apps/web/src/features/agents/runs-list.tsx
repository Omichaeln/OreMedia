import { Link } from 'react-router';
import { Badge, EmptyState, Skeleton } from '@oremedia/ui';
import { listButton } from '../../components/column-header';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { formatMicros, runStateChip } from './run-helpers';
import type { RunDto } from './use-agent-runs';

export interface RunsListProps {
  /** The brand's runs as the server lists them, newest first. */
  runs: readonly RunDto[];
  selectedId: string | null;
  hrefFor: (runId: string) => string;
  /** Called when a row is followed, including the row already selected (the screen closes its start form). */
  onSelect?: () => void;
  /** The list has not settled yet: show loading, not "no runs". */
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
}

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

/** Runs list: state chip, task kind, initiator, cost, started and finished; every row is a link (keyboard path). */
export function RunsList({ runs, selectedId, hrefFor, onSelect, isPending, error, onRetry }: RunsListProps) {
  return (
    <div className="flex flex-col">
      {error !== null && (
        <div className="px-4 py-3">
          <RequestError
            error={error}
            onRetry={onRetry}
            title={toUiError(error).kind === 'forbidden' ? 'Permission denied' : 'Runs could not be loaded'}
          />
        </div>
      )}
      {isPending && (
        <div className="p-4">
          <Skeleton label="Loading runs" lines={3} />
        </div>
      )}
      {!isPending && error === null && runs.length === 0 && (
        <EmptyState
          title="No runs yet"
          description="Nothing has run for this brand. Start a run with +; it appears here with its state, cost and every step."
          className="m-4"
        />
      )}
      {runs.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" aria-label="Runs">
          {runs.map((run) => {
            const selected = run.id === selectedId;
            return (
              <li key={run.id} data-testid="run-row" data-run-state={run.state}>
                <Link
                  to={hrefFor(run.id)}
                  onClick={onSelect}
                  aria-current={selected ? 'page' : undefined}
                  className={listButton(selected)}
                >
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={runStateChip(run.state).tone}>{runStateChip(run.state).label}</Badge>
                    <span className="font-medium">{run.taskKind.replace(/_/g, ' ')}</span>
                    <span className="text-muted-foreground">{formatMicros(run.costMicros)}</span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {run.initiatorKind} {run.initiatorId} · started {when(run.createdAt)} · finished{' '}
                    {when(run.finishedAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
