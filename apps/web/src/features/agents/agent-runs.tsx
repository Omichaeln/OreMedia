import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { useBrandContext } from '../brand/brand-context';
import { RunDetail } from './run-detail';
import { RunsList } from './runs-list';
import { StartRunForm } from './start-run-form';
import { useAgentRunList } from './use-agent-runs';

const RUN_PARAM = 'run';

/**
 * Spec 21.1 `agents/`: runs, steps, costs, exceptions, as the interface lays them out: a 330 px column of runs under
 * "Agent runs" and "New run", and the selected run beside it (below it under 768 px). The selected run is in the
 * URL so a link to it is stable; without one the newest run is shown, as the interface opens on a run. "New run"
 * opens the start form in place of the run.
 */
export function AgentRunsScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const [params] = useSearchParams();
  const selectedId = params.get(RUN_PARAM);
  const hrefFor = (runId: string) => `?${RUN_PARAM}=${encodeURIComponent(runId)}`;
  const runs = useAgentRunList(brandId);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (selectedId) setStarting(false); // a run the start form created replaces the form
  }, [selectedId]);
  const shownId = selectedId ?? runs.items[0]?.id ?? null;

  return (
    <main
      id="main"
      className="om-in grid min-h-full md:h-full md:grid-cols-[minmax(260px,330px)_minmax(0,1fr)]"
    >
      <section
        aria-labelledby="runs-title"
        className="flex min-h-0 flex-col border-border md:overflow-auto md:border-r"
        data-testid="runs"
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-4 pt-7">
          <h1 id="runs-title" className="text-xl font-bold tracking-title">
            Agent runs
          </h1>
          <Button size="sm" variant="primary" aria-expanded={starting} onClick={() => setStarting(!starting)}>
            New run
          </Button>
        </div>
        <RunsList
          runs={runs.items}
          selectedId={starting ? null : shownId}
          hrefFor={hrefFor}
          onSelect={() => setStarting(false)}
          isPending={runs.isPending}
          error={runs.isError ? runs.error : null}
          onRetry={() => void runs.refetch()}
        />
        <LoadMore
          shown={runs.items.length}
          hasNextPage={runs.hasNextPage}
          isFetchingNextPage={runs.isFetchingNextPage}
          onLoadMore={() => void runs.fetchNextPage()}
          noun="runs"
          className="border-t border-border px-5 py-3"
        />
      </section>
      <div className="min-h-0 min-w-0 border-t border-border md:overflow-auto md:border-t-0">
        {starting ? (
          <div className="om-in max-w-[640px] px-5 py-6 sm:px-9 sm:py-8">
            <StartRunForm
              brandId={brandId}
              brandName={brand.name}
              hrefFor={hrefFor}
              onCancel={() => setStarting(false)}
            />
          </div>
        ) : shownId ? (
          <RunDetail key={shownId} companyId={companyId} brandId={brandId} runId={shownId} />
        ) : (
          <div className="px-5 py-6 sm:px-9 sm:py-8">
            <EmptyState
              title="No run selected"
              description="Choose a run to see its timeline, costs and anything that needs attention, or start one with New run."
            />
          </div>
        )}
      </div>
    </main>
  );
}
