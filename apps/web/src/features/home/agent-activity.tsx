import { Link } from 'react-router';
import { Badge, EmptyState } from '@oremedia/ui';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { readRecentRuns, runStateChip } from '../agents/run-helpers';
import { useAgentRuns } from '../agents/use-agent-runs';
import { Section } from '../../components/section';

const RECENT = 5;

/**
 * The agent runs started or opened on this device, newest first, with their state. The API has no run listing for
 * every member (the brand-wide history needs audit access, on the agents screen), so this says whose list it is.
 */
export function AgentActivity() {
  const { companyId, brandId } = useBrandContext();
  const recent = readRecentRuns(companyId, brandId).slice(0, RECENT);
  const runs = useAgentRuns(recent.map((r) => r.runId));
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
      {recent.length === 0 ? (
        <EmptyState
          title="No runs on this device"
          description="Runs you start or open appear here; the agents screen lists the brand’s history."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {recent.map((r, i) => {
            const run = runs[i]?.data;
            const chip = run ? runStateChip(run.state) : null;
            return (
              <li key={r.runId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <Link
                    to={`${agentsHref}?run=${encodeURIComponent(r.runId)}`}
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    {run ? run.taskKind.replace(/_/g, ' ') : r.runId}
                  </Link>
                  <p className="font-mono text-xs text-muted-foreground">
                    {new Date(run?.createdAt ?? r.openedAt).toLocaleString()}
                  </p>
                </div>
                {chip && <Badge tone={chip.tone}>{chip.label}</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
