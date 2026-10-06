import { Fragment, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Chip, EmptyState, Skeleton, StatusDot, cn, toneGlyph } from '@oremedia/ui';
import { LoadMore } from '../../../../../../components/load-more';
import { RequestError } from '../../../../../../components/request-state';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { PackageTitle } from '../../../../../../features/content/package-title';
import { useChannels, type ChannelDto } from '../../../../../../features/publishing/use-publishing';
import { useDestinationMap } from '../../../../../../features/destinations/use-destinations';
import { useCompanies } from '../../../../../../features/portfolio/use-companies';
import { RequestDetail } from '../../../../../../features/review/request-detail';
import { dueText, inboxRowState } from '../../../../../../features/review/review-attention';
import { useReviewInboxPages, type InboxItemDto } from '../../../../../../features/review/use-review';
import { useMembers } from '../../../../../../features/settings/use-settings';
import { REVIEW_NEEDS_YOU } from '../../../../../../features/shell/use-nav-counts';
import { toUiError } from '../../../../../../lib/errors';

type Filter = 'all' | 'attention' | 'awaiting' | 'approved';
const FILTERS: Array<[Filter, string, (i: InboxItemDto) => boolean]> = [
  ['all', 'All', () => true],
  [
    'attention',
    'Needs attention',
    (i) => i.attention.some((a) => a !== 'awaiting_decision' && REVIEW_NEEDS_YOU.has(a)),
  ],
  ['awaiting', 'Awaiting', (i) => i.attention.includes('awaiting_decision')],
  ['approved', 'Approved', (i) => i.attention.includes('approved')],
];

/**
 * Spec 21.1 review, as the supplied interface lays it out: a 300 px column of requests (title, due, the dot and
 * state, any further flag) beside the request being decided, stacked below 768 px. The list filters by what each
 * request needs (spec 21.2: changes requested, stale, approval invalidated, revoked external access) and names the
 * package; the detail shows the frozen manifest, reviewers, external links, comments and the decision.
 */
export function ReviewInboxRoute() {
  const { companyId, brandId, brand } = useBrandContext();
  const inbox = useReviewInboxPages(brandId);
  const channels = useChannels(brandId);
  const destinationMap = useDestinationMap(brandId);
  const channelMap = useMemo(
    () => new Map<string, ChannelDto>((channels.data ?? []).map((c) => [c.id, c])),
    [channels.data],
  );
  // Reviewers are named from the members list, which only owners and admins may read; others see ids.
  const companies = useCompanies();
  const role = companies.data?.find((c) => c.tenantId === companyId)?.role ?? null;
  const members = useMembers(role === 'owner' || role === 'admin');
  const memberName = (id: string) => members.data?.items.find((m) => m.userId === id)?.name ?? id;
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('request');
  const filter = (FILTERS.find(([key]) => key === params.get('show'))?.[0] ?? 'all') as Filter;
  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null) p.delete(key);
    else p.set(key, value);
    setParams(p, { replace: true });
  };
  const matches = FILTERS.find(([key]) => key === filter)?.[2] ?? (() => true);
  // Filters run over every page fetched so far; a request on a page not yet shown is reached with "Show more".
  const items = inbox.items.filter(matches);
  const selected = inbox.items.find((i) => i.id === selectedId) ?? null;

  return (
    <main
      id="main"
      className="om-in flex min-h-full flex-col md:grid md:h-full md:min-h-0 md:grid-cols-[300px_minmax(0,1fr)]"
    >
      <section
        aria-labelledby="review-title"
        className="flex flex-col border-border md:min-h-0 md:overflow-auto md:border-r"
      >
        <div className="flex flex-col gap-1 px-5 pb-3 pt-7">
          <div className="flex items-start justify-between gap-2">
            <h1 id="review-title" className="text-xl font-bold tracking-title">
              Review
            </h1>
            <Button
              size="sm"
              variant="ghost"
              className="-mr-2 -mt-1 text-muted-foreground"
              onClick={() => void inbox.refetch()}
              disabled={inbox.isFetching}
            >
              {inbox.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground text-pretty">
            Each request freezes exactly what reviewers see. A decision binds that manifest.
          </p>
        </div>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1 px-5 pb-3">
          {FILTERS.map(([key, label]) => (
            <Chip
              key={key}
              selected={filter === key}
              onClick={() => setParam('show', key === 'all' ? null : key)}
            >
              {label}
            </Chip>
          ))}
        </div>
        {inbox.isPending && (
          <div className="border-t border-border p-5">
            <Skeleton label="Loading review requests" lines={4} />
          </div>
        )}
        {inbox.isError && (
          <div className="border-t border-border p-5">
            <RequestError
              error={inbox.error}
              onRetry={() => void inbox.refetch()}
              title={
                toUiError(inbox.error).kind === 'forbidden'
                  ? 'Restricted access: you cannot see this brand’s reviews'
                  : undefined
              }
            />
          </div>
        )}
        {inbox.isSuccess && items.length === 0 && (
          <div className="border-t border-border p-5">
            <EmptyState
              title={inbox.items.length === 0 ? 'No review requests' : 'Nothing in this view'}
              description={
                inbox.items.length === 0
                  ? 'Requests appear here when a content package is sent for review.'
                  : 'Choose another filter to see the other requests.'
              }
            />
          </div>
        )}
        {inbox.isSuccess && items.length > 0 && (
          <ul className="flex flex-col" aria-label="Review requests" data-testid="inbox">
            {items.map((item, index) => {
              const row = inboxRowState(item);
              const isSelected = item.id === selectedId;
              return (
                <li
                  key={item.id}
                  className="om-in"
                  style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setParam('request', item.id)}
                    data-testid={`inbox-${item.id}`}
                    className={cn(
                      'flex w-full flex-col gap-1.5 border-t border-border px-5 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      isSelected ? 'bg-secondary' : 'hover:bg-muted',
                    )}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-base font-bold">
                        <PackageTitle contentPackageId={item.contentPackageId} />
                      </span>
                      {item.dueAt && (
                        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                          {dueText(item.dueAt)}
                        </span>
                      )}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot tone={row.tone} size="sm" />
                      <span className="sr-only">{toneGlyph[row.tone]} </span>
                      <span title={row.detail}>{row.label}</span>
                      {row.flags.map((flag) => (
                        <Fragment key={flag.label}>
                          <span aria-hidden="true">·</span>
                          <span className="text-accent-ink" title={flag.detail}>
                            {flag.label}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {inbox.isSuccess && (
          <LoadMore
            shown={inbox.items.length}
            hasNextPage={inbox.hasNextPage}
            isFetchingNextPage={inbox.isFetchingNextPage}
            onLoadMore={() => void inbox.fetchNextPage()}
            noun={inbox.items.length === 1 ? 'request' : 'requests'}
            className="border-t border-border px-5 py-2.5"
          />
        )}
      </section>
      <div className="min-w-0 border-t border-border md:min-h-0 md:overflow-auto md:border-t-0">
        <RequestDetail
          reviewRequestId={selectedId}
          channels={channelMap}
          destinations={destinationMap}
          locale={brand.defaultLocale}
          title={selected ? <PackageTitle contentPackageId={selected.contentPackageId} /> : undefined}
          memberName={memberName}
        />
      </div>
    </main>
  );
}
