import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '@oremedia/ui';
import { AddToggle, ColumnHeader } from '../../components/column-header';
import { LoadMore } from '../../components/load-more';
import { useBrandContext } from '../brand/brand-context';
import { RunDetail } from './run-detail';
import { RunsList } from './runs-list';
import { StartRunForm } from './start-run-form';
import { useAgentRunList } from './use-agent-runs';

const RUN_PARAM = 'run';

/**
 * Spec 21.1 `agents/`: runs, steps, costs, exceptions, as the v3 prototype lays them out: the runs in a list column
 * and the selected run beside them; "+" opens the start form in place of the run. The selected run is in the URL so
 * a link to it is stable.
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

  return (
    <main id="main" className="flex min-h-full flex-col lg:flex-row">
      <section
        aria-labelledby="runs-title"
        className="flex shrink-0 flex-col border-border lg:w-80 lg:border-r"
        data-testid="runs"
      >
        <ColumnHeader
          id="runs-title"
          title="Agent runs"
          level={1}
          subtitle="State, cost, steps and tool calls with redacted inputs. Model reasoning is never stored."
          action={<AddToggle open={starting} label="New run" onToggle={() => setStarting(!starting)} />}
        />
        <RunsList
          runs={runs.items}
          selectedId={starting ? null : selectedId}
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
        />
      </section>
      <div className="min-w-0 flex-1 border-t border-border p-4 sm:p-6 lg:border-t-0">
        {starting ? (
          <StartRunForm brandId={brandId} brandName={brand.name} hrefFor={hrefFor} />
        ) : selectedId ? (
          <RunDetail key={selectedId} companyId={companyId} brandId={brandId} runId={selectedId} />
        ) : (
          <EmptyState
            title="No run selected"
            description="Choose a run to see its timeline, costs and anything that needs attention, or start one with +."
          />
        )}
      </div>
    </main>
  );
}
