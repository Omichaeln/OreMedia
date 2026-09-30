import { Link } from 'react-router';
import { Badge, EmptyState, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { runStateChip } from '../agents/run-helpers';
import { useAgentRunList } from '../agents/use-agent-runs';

const RECENT = 5;

/** The brand's most recent agent runs from the server, newest first, with their state; the agents screen has them all. */
export function AgentActivity() {
  const { companyId, brandId } = useBrandContext();
  const runs = useAgentRunList(brandId, RECENT);
  const recent = runs.items.slice(0, RECENT);
  const agentsHref = brandPath(companyId, brandId, 'agents');
  return (
    <Section
      id="agent-activity"
      title="Agent activity"
      action={
        <Link to={agentsHref} className="underline-offset-2 hover:underline">
          All runs <span aria-hidden="true">→</span>
        </Link>
      }
    >
      {runs.isPending && <Skeleton label="Loading agent runs" lines={3} />}
      {runs.isError && (
        <RequestError
          error={runs.error}
          onRetry={() => void runs.refetch()}
          title="Runs could not be loaded"
        />
      )}
      {runs.isSuccess && recent.length === 0 && (
        <EmptyState
          title="No runs yet"
          description="Nothing has run for this brand. Runs started from the agents screen appear here, newest first."
        />
      )}
      {recent.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" aria-label="Recent agent runs">
          {recent.map((run) => {
            const chip = runStateChip(run.state);
            return (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <Link
                    to={`${agentsHref}?run=${encodeURIComponent(run.id)}`}
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    {run.taskKind.replace(/_/g, ' ')}
                  </Link>
                  <p className="font-mono text-xs text-muted-foreground">
                    {new Date(run.createdAt).toLocaleString()}
                  </p>
                </div>
                <Badge tone={chip.tone}>{chip.label}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
