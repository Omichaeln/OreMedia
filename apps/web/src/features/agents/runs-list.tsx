import { Link } from 'react-router';
import { EmptyState, Skeleton, StatusDot, cn, toneGlyph } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { relativeTime, runStateChip, runTitle } from './run-helpers';
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

/**
 * Runs list as the interface sets it: the run's goal in bold, then its state as a dot and a word beside when it
 * started; rows divided by rules, the selected one tinted. Every row is a link (keyboard path); the task kind,
 * initiator, cost and times are in the run's detail.
 */
export function RunsList({ runs, selectedId, hrefFor, onSelect, isPending, error, onRetry }: RunsListProps) {
  return (
    <div className="flex flex-col">
      {error !== null && (
        <div className="px-5 py-3">
          <RequestError
            error={error}
            onRetry={onRetry}
            title={toUiError(error).kind === 'forbidden' ? 'Permission denied' : 'Runs could not be loaded'}
          />
        </div>
      )}
      {isPending && (
        <div className="px-5 py-4">
          <Skeleton label="Loading runs" lines={3} />
        </div>
      )}
      {!isPending && error === null && runs.length === 0 && (
        <EmptyState
          title="No runs yet"
          description="Nothing has run for this brand. Start a run with New run; it appears here with its state, cost and every step."
          className="m-5"
        />
      )}
      {runs.length > 0 && (
        <ul className="flex flex-col" aria-label="Runs">
          {runs.map((run, i) => {
            const selected = run.id === selectedId;
            const chip = runStateChip(run.state);
            return (
              <li
                key={run.id}
                className="om-in border-t border-border"
                style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
                data-testid="run-row"
                data-run-state={run.state}
              >
                <Link
                  to={hrefFor(run.id)}
                  onClick={onSelect}
                  aria-current={selected ? 'page' : undefined}
                  className={cn(
                    'flex w-full flex-col gap-1 px-5 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    selected ? 'bg-secondary' : 'hover:bg-muted',
                  )}
                >
                  <span className="text-base font-bold">{runTitle(run)}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot tone={chip.tone} size="sm" />
                    <span className="sr-only">{toneGlyph[chip.tone]} </span>
                    {chip.label} · <span className="tabular-nums">{relativeTime(run.createdAt)}</span>
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
