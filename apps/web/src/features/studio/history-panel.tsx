import { Link } from 'react-router';
import { Badge, EmptyState, Skeleton } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useRevisions } from './use-document';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Spec 11.4: revisions are insert-only, so the history is the list the server holds, newest first. An agent's
 * revision links to the run that produced it; the summary is the one the revision was saved with. Every save
 * invalidates the list (use-studio afterCommit), so it follows the head. Older revisions are fetched page by page.
 */
export function HistoryPanel({ documentId, headRevisionId }: { documentId: string; headRevisionId: string }) {
  const { companyId, brandId } = useBrandContext();
  const revisions = useRevisions(documentId);

  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-2" data-testid="history">
      <h2 id="history-heading" className="text-sm font-semibold">
        Revisions
      </h2>
      {revisions.isPending && <Skeleton label="Loading revisions" lines={3} />}
      {revisions.isError && <RequestError error={revisions.error} onRetry={() => void revisions.refetch()} />}
      {revisions.isSuccess && revisions.items.length === 0 && (
        <EmptyState title="No revisions" description="The first save creates revision 1." className="py-4" />
      )}
      {revisions.isSuccess && revisions.items.length > 0 && (
        <ol className="flex flex-col divide-y divide-border text-sm">
          {revisions.items.map((r) => (
            <li key={r.id} className="flex flex-col gap-0.5 py-2">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Revision {r.number}</span>
                <span className="text-xs text-muted-foreground">{when(r.createdAt)}</span>
              </p>
              <p className="text-muted-foreground">{r.changeSummary || 'No summary recorded'}</p>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {r.id === headRevisionId && <Badge tone="good">Current</Badge>}
                <span>{r.authorKind === 'agent' ? 'Agent' : 'Person'}</span>
                {r.generationInputs && (
                  <Badge tone="info">
                    {r.generationInputs.kind === 'refine' ? 'AI change' : 'Generated'}
                    {r.generationInputs.acceptedGroupIds ? ' (accepted)' : ''}
                  </Badge>
                )}
                {r.agentRunId && (
                  <Link
                    to={brandPath(companyId, brandId, `agents?run=${encodeURIComponent(r.agentRunId)}`)}
                    className="underline-offset-2 hover:underline"
                  >
                    Open run <span aria-hidden="true">→</span>
                  </Link>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
      {revisions.isSuccess && (
        <LoadMore
          shown={revisions.items.length}
          hasNextPage={revisions.hasNextPage}
          isFetchingNextPage={revisions.isFetchingNextPage}
          onLoadMore={() => void revisions.fetchNextPage()}
          noun={revisions.items.length === 1 ? 'revision' : 'revisions'}
          className="px-0"
        />
      )}
    </section>
  );
}
