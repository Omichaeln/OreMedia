import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../../lib/trpc';

/** The signed-in person's sign-in methods (access.account.signInMethods): a password, a linked Google identity. */
export function useSignInMethods() {
  const trpc = useTRPC();
  return useQuery({ ...trpc.access.account.signInMethods.queryOptions(), retry: false });
}
