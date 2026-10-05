import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type CompanyDto = inferOutput<Trpc['access']['listCompanies']>[number];

/** Spec 5.1: the portfolio is a projection over the user's memberships (access.listCompanies). */
export function useCompanies() {
  const trpc = useTRPC();
  return useQuery(trpc.access.listCompanies.queryOptions());
}
