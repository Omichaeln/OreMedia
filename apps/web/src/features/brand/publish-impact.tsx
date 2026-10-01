import { Badge, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { PackageTitle } from '../content/package-title';
import { useBrandVersionImpact } from './use-brand';

export const ON_PUBLISHED_LABEL = {
  invalidate_and_hold: 'Invalidate approvals and hold scheduled posts',
  flag: 'Keep approvals and flag the work for attention',
} as const;

/**
 * UX-20 (D-13): before a brand version is published, what it reaches: the open review requests and valid approvals
 * the workflow invalidates, and the scheduled publications it re-checks and holds when their release check fails.
 * Every row names the record; the policy line says what the publish does to them today.
 */
export function PublishImpact({ brandId, versionNumber }: { brandId: string; versionNumber: number }) {
  const impact = useBrandVersionImpact(brandId);
  const data = impact.data;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="publish-impact">
      {impact.isPending && <Skeleton label="Reading what the publish reaches" lines={2} />}
      {impact.isError && (
        <RequestError
          error={impact.error}
          title="The impact could not be read"
          onRetry={() => void impact.refetch()}
        />
      )}
      {data && !data.available && (
        <p className="text-muted-foreground">
          What this publish reaches could not be computed, so nothing here says the work is unaffected.
        </p>
      )}
      {data && data.available && (
        <>
          <p>
            Publishing version {versionNumber} reaches{' '}
            <span className="font-medium tabular-nums">{data.requests.length}</span> open review{' '}
            {data.requests.length === 1 ? 'request' : 'requests'},{' '}
            <span className="font-medium tabular-nums">{data.approvals}</span> valid{' '}
            {data.approvals === 1 ? 'approval' : 'approvals'} and{' '}
            <span className="font-medium tabular-nums">{data.publications.length}</span> scheduled{' '}
            {data.publications.length === 1 ? 'post' : 'posts'}.
          </p>
          <p className="text-xs text-muted-foreground" data-testid="publish-impact-policy">
            Policy: {ON_PUBLISHED_LABEL[data.policy.effective]}
            {data.policy.configured === null && ' (no choice recorded; this is the default)'}. Approvals of
            this brand are invalidated and open requests marked stale; every scheduled post is re-checked
            against the release policy and held with the failed checks. Published work is never edited.
          </p>
          {data.publications.length > 0 && (
            <ul className="flex flex-col divide-y divide-border" aria-label="Scheduled posts reached">
              {data.publications.map((p) => (
                <li
                  key={p.publicationId}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"
                >
                  <span className="min-w-0">
                    <PackageTitle contentPackageId={p.contentPackageId} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(p.scheduledFor).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.requests.length > 0 && (
            <ul className="flex flex-col divide-y divide-border" aria-label="Open review requests reached">
              {data.requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                  <span className="min-w-0">
                    Request <code>{r.id}</code> · {r.assignees} {r.assignees === 1 ? 'reviewer' : 'reviewers'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.dueAt ? `due ${new Date(r.dueAt).toLocaleString()}` : 'no due time'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.requests.length === 0 && data.approvals === 0 && data.publications.length === 0 && (
            <p className="text-muted-foreground">
              <Badge tone="good">Nothing reached</Badge> No open request, valid approval or scheduled post
              exists right now.
            </p>
          )}
        </>
      )}
    </div>
  );
}
