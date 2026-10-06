import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, Skeleton, StatusDot, cn, toneGlyph } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from '../brand/brand-context';
import { CreateExperimentForm } from './create-experiment-form';
import { ExperimentDetail } from './experiment-detail';
import { experimentStateChip, modeLabel, variantsLine } from './experiment-helpers';
import { useExperiments } from './use-experiments';

const EXPERIMENT_PARAM = 'experiment';

/**
 * Spec 21.1 `experiments/`: as the interface lays it out, a column of the brand's experiments (name, the arms
 * compared, state and mode as a dot and words, spec 16.6) beside the selected experiment, from 768 px; stacked
 * below it (D-31). The selection is in the URL; without one the newest experiment is shown, as the interface opens
 * on one. "New" opens the design form in place of the detail.
 */
export function ExperimentsScreen() {
  const { brandId } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(EXPERIMENT_PARAM);
  const list = useExperiments(brandId);
  const [creating, setCreating] = useState(false);
  const select = (id: string) => {
    setCreating(false);
    setParams({ [EXPERIMENT_PARAM]: id }, { replace: true });
  };
  const forbidden = list.isError && toUiError(list.error).kind === 'forbidden';
  const shownId = selectedId ?? list.items[0]?.id ?? null;

  return (
    <main
      id="main"
      className="om-in grid min-h-full md:h-full md:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]"
    >
      <section
        aria-labelledby="experiments-title"
        className="flex min-h-0 flex-col border-border md:overflow-auto md:border-r"
        data-testid="experiments"
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-4 pt-7">
          <h1 id="experiments-title" className="text-xl font-bold tracking-title">
            Experiments
          </h1>
          {!forbidden && (
            <Button size="sm" aria-expanded={creating} onClick={() => setCreating(!creating)}>
              New<span className="sr-only"> experiment</span>
            </Button>
          )}
        </div>
        {list.isPending && (
          <div className="px-5 py-4">
            <Skeleton label="Loading experiments" lines={3} />
          </div>
        )}
        {list.isError && (
          <div className="px-5 py-3">
            <RequestError
              error={list.error}
              onRetry={() => void list.refetch()}
              title={forbidden ? 'Permission denied' : undefined}
            />
          </div>
        )}
        {list.isSuccess && list.items.length === 0 && (
          <p className="border-t border-border px-5 py-3.5 text-sm text-muted-foreground">
            No experiments yet. Design one with New, or accept a recommendation that prepares a test.
          </p>
        )}
        {list.isSuccess && list.items.length > 0 && (
          <ul className="flex flex-col" aria-label="Experiments">
            {list.items.map((x) => {
              const chip = experimentStateChip(x.state);
              const selected = x.id === shownId && !creating;
              return (
                <li key={x.id} className="border-t border-border">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => select(x.id)}
                    data-testid={`experiment-${x.id}`}
                    className={cn(
                      'flex w-full flex-col gap-1.5 px-5 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      selected ? 'bg-secondary' : 'hover:bg-muted',
                    )}
                  >
                    <span className="text-base font-bold">{x.hypothesis}</span>
                    <span className="text-xs text-muted-foreground">{variantsLine(x.variants)}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot tone={chip.tone} size="sm" />
                      <span className="sr-only">{toneGlyph[chip.tone]} </span>
                      {chip.label} · {modeLabel(x.mode)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {list.isSuccess && (
          <LoadMore
            shown={list.items.length}
            hasNextPage={list.hasNextPage}
            isFetchingNextPage={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            noun={list.items.length === 1 ? 'experiment' : 'experiments'}
            className="border-t border-border px-5 py-3"
          />
        )}
        <div className="mt-auto border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" onClick={() => void list.refetch()} disabled={list.isFetching}>
            {list.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </section>
      <div className="min-h-0 min-w-0 border-t border-border md:overflow-auto md:border-t-0">
        {creating ? (
          <div className="om-in max-w-[760px] px-5 py-6 sm:px-9 sm:py-8">
            <CreateExperimentForm brandId={brandId} onCreated={select} />
          </div>
        ) : shownId ? (
          <ExperimentDetail key={shownId} experimentId={shownId} />
        ) : list.isPending ? null : (
          <div className="px-5 py-6 sm:px-9 sm:py-8">
            <EmptyState
              title="No experiment selected"
              description="Choose an experiment to see its frozen design, lifecycle and results, or design one with New."
            />
          </div>
        )}
      </div>
    </main>
  );
}
