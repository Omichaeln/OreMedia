import { Link } from 'react-router';
import { EmptyState, Skeleton, StatusDot, toneGlyph } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { runStateChip } from '../agents/run-helpers';
import { useAgentRunList } from '../agents/use-agent-runs';

const RECENT = 4;

/** "12 min ago", "2 h ago", "Yesterday", "3 days ago": the interface's relative times, never a raw timestamp. */
export function relativeTime(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The brand's most recent agent runs from the server, newest first: the task, when it started, and its state as a
 * dot and a word; the agents screen has them all.
 */
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
        <Link to={agentsHref} className="hover:text-foreground">
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
        <ul className="flex flex-col" aria-label="Recent agent runs">
          {recent.map((run) => {
            const chip = runStateChip(run.state);
            return (
              <li key={run.id} className="border-b border-border last:border-b-0">
                <Link
                  to={`${agentsHref}?run=${encodeURIComponent(run.id)}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-[11px] text-sm hover:text-accent-ink"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate">{run.taskKind.replace(/_/g, ' ')}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {relativeTime(run.createdAt)}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    <StatusDot tone={chip.tone} size="sm" />
                    <span className="sr-only">{toneGlyph[chip.tone]} </span>
                    {chip.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
