import { Button, cn } from '@oremedia/ui';

export interface LoadMoreProps {
  /** How many rows the list shows now. */
  shown: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** What the rows are, for the count ("12 requests shown"). */
  noun: string;
  /** Replaces the default gutter (`px-4 py-2`) where the list has none of its own. */
  className?: string;
}

/**
 * The foot of a paged list (spec 7.4): says how many rows are shown and whether more exist, and fetches the next
 * page on request. A list that has shown everything says so, so "all" is never assumed from a short first page.
 */
export function LoadMore({
  shown,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  noun,
  className,
}: LoadMoreProps) {
  if (shown === 0) return null;
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 text-xs text-muted-foreground',
        className ?? 'px-4 py-2',
      )}
      data-testid="load-more"
    >
      <span aria-live="polite">
        {shown} {noun} shown{hasNextPage ? '' : ', that is all'}
      </span>
      {hasNextPage && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onLoadMore}
          disabled={isFetchingNextPage}
          aria-label={`Show more ${noun}`}
        >
          {isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}
