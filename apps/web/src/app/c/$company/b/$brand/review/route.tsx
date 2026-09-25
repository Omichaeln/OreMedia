import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Skeleton, cn } from '@oremedia/ui';
import { RequestError } from '../../../../../../components/request-state';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { PackageTitle } from '../../../../../../features/content/package-title';
import { useChannels, type ChannelDto } from '../../../../../../features/publishing/use-publishing';
import { RequestDetail } from '../../../../../../features/review/request-detail';
import {
  ATTENTION_CHIP,
  REQUEST_STATE_CHIP,
  orderAttention,
} from '../../../../../../features/review/review-attention';
import { useReviewInbox, type InboxItemDto } from '../../../../../../features/review/use-review';
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
 * Spec 21.1 review: the requests beside the one being decided. The list filters by what each request needs (spec
 * 21.2: changes requested, stale, approval invalidated, revoked external access) and names the package; the detail
 * shows the frozen manifest, decisions and external reviewer links. Stacked at phone width.
 */
export function ReviewInboxRoute() {
  const { brandId } = useBrandContext();
  const inbox = useReviewInbox(brandId);
  const channels = useChannels(brandId);
  const channelMap = useMemo(
    () => new Map<string, ChannelDto>((channels.data ?? []).map((c) => [c.id, c])),
    [channels.data],
  );
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
  const items = (inbox.data?.items ?? []).filter(matches);
  const selected = inbox.data?.items.find((i) => i.id === selectedId) ?? null;

  return (
    <main id="main" className="flex min-h-full flex-col lg:flex-row">
      <section
        aria-labelledby="review-title"
        className="flex shrink-0 flex-col border-border lg:w-96 lg:border-r"
      >
        <div className="flex flex-col gap-3 px-4 pb-3 pt-6 sm:px-6">
          <div className="flex items-start justify-between gap-2">
            <h1 id="review-title" className="text-xl font-semibold">
              Review
            </h1>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void inbox.refetch()}
              disabled={inbox.isFetching}
            >
              {inbox.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Each request freezes exactly what reviewers see. A decision binds that manifest; anything that
            changes afterwards shows here.
          </p>
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {FILTERS.map(([key, label, test]) => {
              const count = inbox.data?.items.filter(test).length;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setParam('show', key === 'all' ? null : key)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    filter === key
                      ? 'border-foreground bg-secondary font-medium'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  {count !== undefined && <span className="ml-1 tabular-nums">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="border-t border-border">
          {inbox.isPending && (
            <div className="p-4">
              <Skeleton label="Loading review requests" lines={4} />
            </div>
          )}
          {inbox.isError && (
            <div className="p-4">
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
            <div className="p-4">
              <EmptyState
                title={inbox.data.items.length === 0 ? 'No review requests' : 'Nothing in this view'}
                description={
                  inbox.data.items.length === 0
                    ? 'Requests appear here when a content package is sent for review.'
                    : 'Choose another filter to see the other requests.'
                }
              />
            </div>
          )}
          {inbox.isSuccess && items.length > 0 && (
            <ul
              className="flex flex-col divide-y divide-border"
              aria-label="Review requests"
              data-testid="inbox"
            >
              {items.map((item) => {
                const state = REQUEST_STATE_CHIP[item.state];
                const isSelected = item.id === selectedId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setParam('request', item.id)}
                      data-testid={`inbox-${item.id}`}
                      className={cn(
                        'flex w-full flex-col gap-1.5 px-4 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6',
                        isSelected ? 'bg-secondary' : 'hover:bg-muted',
                      )}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="min-w-0 font-medium">
                          <PackageTitle contentPackageId={item.contentPackageId} />
                        </span>
                        {item.dueAt && (
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            due{' '}
                            {new Date(item.dueAt).toLocaleDateString(undefined, {
                              day: 'numeric',
                              month: 'short',
                            })}
                          </span>
                        )}
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        {item.attention.length === 0 && (
                          <Badge tone={state.tone} glyph={false}>
                            {state.label}
                          </Badge>
                        )}
                        {orderAttention(item.attention).map((flag) => (
                          <Badge
                            key={flag}
                            tone={ATTENTION_CHIP[flag].tone}
                            title={ATTENTION_CHIP[flag].detail}
                          >
                            {ATTENTION_CHIP[flag].label}
                          </Badge>
                        ))}
                      </span>
                      {item.externalLinks.total > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {item.externalLinks.total} external link{item.externalLinks.total === 1 ? '' : 's'}
                          {item.externalLinks.revoked > 0 && ` (${item.externalLinks.revoked} revoked)`}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
      <div className="min-w-0 flex-1 border-t border-border px-4 py-6 sm:px-8 lg:border-t-0">
        <RequestDetail
          reviewRequestId={selectedId}
          channels={channelMap}
          title={selected ? <PackageTitle contentPackageId={selected.contentPackageId} /> : undefined}
        />
      </div>
    </main>
  );
}
