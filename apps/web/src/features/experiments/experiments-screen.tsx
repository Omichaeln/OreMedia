import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Skeleton } from '@oremedia/ui';
import { AddToggle, ColumnHeader, listButton } from '../../components/column-header';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from '../brand/brand-context';
import { CreateExperimentForm } from './create-experiment-form';
import { ExperimentDetail } from './experiment-detail';
import { DIRECTIONAL_LABEL, experimentStateChip, modeLabel } from './experiment-helpers';
import { useExperiments } from './use-experiments';

const EXPERIMENT_PARAM = 'experiment';

/**
 * Spec 21.1 `experiments/`: the brand's experiments with their state and mode (always labelled, spec 16.6) in a list
 * column, and the selected experiment's frozen design, lifecycle and results beside it (the v3 prototype's layout).
 * "+" opens the design form in place of the detail. The selection is in the URL.
 */
export function ExperimentsScreen() {
  const { brandId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(EXPERIMENT_PARAM);
  const list = useExperiments(brandId);
  const [creating, setCreating] = useState(false);
  const select = (id: string) => {
    setCreating(false);
    setParams({ [EXPERIMENT_PARAM]: id }, { replace: true });
  };
  const forbidden = list.isError && toUiError(list.error).kind === 'forbidden';

  return (
    <main id="main" className="flex min-h-full flex-col lg:flex-row">
      <section
        aria-labelledby="experiments-title"
        className="flex shrink-0 flex-col border-border lg:w-80 lg:border-r"
        data-testid="experiments"
      >
        <ColumnHeader
          id="experiments-title"
          title="Experiments"
          level={1}
          subtitle={`Pre-registered tests for ${brand.name}. Structured comparisons are directional; not causal. No result is declared before the pre-registered sample and window.`}
          action={
            !forbidden && (
              <AddToggle open={creating} label="New experiment" onToggle={() => setCreating(!creating)} />
            )
          }
        />
        {list.isPending && (
          <div className="p-4">
            <Skeleton label="Loading experiments" lines={3} />
          </div>
        )}
        {list.isError && (
          <div className="p-4">
            <RequestError
              error={list.error}
              onRetry={() => void list.refetch()}
              title={forbidden ? 'Permission denied' : undefined}
            />
          </div>
        )}
        {list.isSuccess && list.data.items.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No experiments yet. Design one with +, or accept a recommendation that prepares a test.
          </p>
        )}
        {list.isSuccess && list.data.items.length > 0 && (
          <ul className="flex flex-col divide-y divide-border" aria-label="Experiments">
            {list.data.items.map((x) => {
              const chip = experimentStateChip(x.state);
              const selected = x.id === selectedId && !creating;
              return (
                <li key={x.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => select(x.id)}
                    data-testid={`experiment-${x.id}`}
                    className={listButton(selected)}
                  >
                    <span className="font-medium">{x.hypothesis}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={chip.tone}>{chip.label}</Badge>
                      <Badge tone="neutral" glyph={false}>
                        {modeLabel(x.mode)}
                      </Badge>
                      {x.conclusionLabel === DIRECTIONAL_LABEL && (
                        <span className="text-xs text-muted-foreground">{DIRECTIONAL_LABEL}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-auto border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={() => void list.refetch()} disabled={list.isFetching}>
            {list.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </section>
      <div className="min-w-0 flex-1 border-t border-border p-4 sm:p-6 lg:border-t-0">
        {creating ? (
          <CreateExperimentForm brandId={brandId} onCreated={select} />
        ) : selectedId ? (
          <ExperimentDetail key={selectedId} experimentId={selectedId} />
        ) : (
          <EmptyState
            title="No experiment selected"
            description="Choose an experiment to see its frozen design, lifecycle and results, or design one with +."
          />
        )}
      </div>
    </main>
  );
}
