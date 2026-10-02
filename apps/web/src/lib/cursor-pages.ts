import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorPagesOptions<T> {
  /** The tRPC query key of the first page (`trpc.x.list.queryKey(input)`), so `pathFilter()` invalidations still match. */
  queryKey: QueryKey;
  /** Fetches one page; `cursor` is undefined for the first page and the previous page's `nextCursor` after that. */
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>;
  enabled?: boolean;
  /** A fixed interval, or one decided from the rows fetched so far (a list that polls only while something is live). */
  refetchInterval?: number | false | ((items: T[]) => number | false);
  /**
   * Read every page in turn until the end, without a "load more": for a figure that must span the whole list (a
   * window's every publication), never for a list the person scrolls. `complete` says when the last page is in.
   */
  readAll?: boolean;
}

const flatten = <T>(pages: Array<CursorPage<T>> | undefined): T[] => pages?.flatMap((p) => p.items) ?? [];

/**
 * Spec 7.4 cursor pagination on the client: every list that can grow is read page by page and the pages are
 * concatenated, so a queue is never silently cut at its first page. The key extends the tRPC key of the first
 * page, so the router's prefetch and the `pathFilter()` invalidations the mutations already use keep working.
 */
export function useCursorPages<T>(opts: CursorPagesOptions<T>) {
  const interval = opts.refetchInterval;
  const query = useInfiniteQuery({
    queryKey: [...opts.queryKey, 'pages'],
    queryFn: ({ pageParam }) => opts.fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: opts.enabled ?? true,
    refetchInterval:
      typeof interval === 'function' ? (q) => interval(flatten(q.state.data?.pages)) : (interval ?? false),
  });
  const items = useMemo(() => flatten(query.data?.pages), [query.data]);
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (opts.readAll && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [opts.readAll, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const complete = query.isSuccess && !hasNextPage;
  return { ...query, items, complete };
}
