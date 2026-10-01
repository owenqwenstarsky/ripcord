'use client';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { api } from '../ui';
export function useManagementList<T>(queryKey: QueryKey, path: string, enabled = true) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      api<T[]>(`${path}${path.includes('?') ? '&' : '?'}page=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, page) => (last.length === 100 ? page + 1 : undefined),
    enabled,
  });
  return { ...query, data: query.data?.pages.flat() };
}
export function MoreRows({
  query,
}: {
  query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  return query.hasNextPage ? (
    <button
      className="secondary-button"
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    >
      {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
    </button>
  ) : null;
}
