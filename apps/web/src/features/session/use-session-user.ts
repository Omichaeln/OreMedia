import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../../lib/trpc';

/** The signed-in person (access.session); fails quietly when there is no user session (sign-in page, API keys). */
export function useSessionUser(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.access.session.queryOptions(), enabled, retry: false, staleTime: 5 * 60_000 });
}
