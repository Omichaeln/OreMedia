import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { DestinationKind } from '@oremedia/contracts/destinations';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type DestinationDto = inferOutput<Trpc['destinations']['list']>['items'][number];
export type SourceUsePolicyDto = inferOutput<Trpc['destinations']['sourceUse']['list']>['items'][number];

/** R2-0: the brand's destinations (analytics, Search Console, Business Profile, CMS, webhooks), optionally one kind. */
export function useDestinations(brandId: string, kind?: DestinationKind) {
  const trpc = useTRPC();
  return useQuery(trpc.destinations.list.queryOptions({ brandId, kind }));
}

/** D-17: the brand's source-use policies, one row per destination kind and data type. */
export function useSourceUsePolicies(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.destinations.sourceUse.list.queryOptions({ brandId }));
}
