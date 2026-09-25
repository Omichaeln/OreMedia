import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type SkillDto = inferOutput<Trpc['skills']['list']>['items'][number];

/** Spec 9: the skills the company can see (built in, company-wide and brand-scoped). One hook per query. */
export function useSkills() {
  const trpc = useTRPC();
  return useQuery(trpc.skills.list.queryOptions({ page: { limit: 200 } }));
}
