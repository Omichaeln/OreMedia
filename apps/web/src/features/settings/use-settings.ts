import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type SkillDto = inferOutput<Trpc['skills']['list']>['items'][number];

/** Spec 9: the skills the company can see (built in, company-wide and brand-scoped). One hook per query. */
export function useSkills() {
  const trpc = useTRPC();
  return useQuery(trpc.skills.list.queryOptions({ page: { limit: 200 } }));
}

export type KillSwitchScope = 'agent_starts' | 'release_dispatch';

/** Spec 8.1 / 13.5: the brand's active release policy version (NOT_FOUND while none is activated). */
export function useReleasePolicy(brandId: string) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.brand.policy.get.queryOptions({ brandId }), retry: false });
}

/** Runbook kill switches: company-wide (no brandId) or for one brand. Admin-only on the server (audit.read). */
export function useKillSwitch(scope: KillSwitchScope, brandId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.operations.killSwitch.get.queryOptions({ scope, brandId }),
    enabled,
    retry: false,
  });
}

/** Spec 12.7: the company's model-routing policy. Admin-only on the server (billing.manage). */
export function useRoutingPolicy(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.agents.routingPolicy.get.queryOptions(), enabled, retry: false });
}

/** The company's members with name, email, role and brand scope. Owners and admins only (membership.manage). */
export function useMembers(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.access.members.list.queryOptions(), enabled, retry: false });
}

/** Spec 13.4: the brand's mandates in every state, newest first. */
export function useMandates(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.review.mandates.list.queryOptions({ brandId, page: { limit: 100 } }));
}
