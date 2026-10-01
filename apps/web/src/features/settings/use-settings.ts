import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type SkillDto = inferOutput<Trpc['skills']['list']>['items'][number];
export type SkillDetailDto = inferOutput<Trpc['skills']['get']>;
export type BudgetsDto = inferOutput<Trpc['agents']['budgets']['read']>;

/** UX-17: one skill with its versions, evaluations and bindings (skill.read). */
/** A version in the sandbox is polled until the worker reports (as runs are while live). */
const SANDBOX_POLL_MS = 2000;
export function useSkill(skillId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.skills.get.queryOptions({ skillId: skillId ?? '' }),
    enabled: skillId !== null,
    refetchInterval: (query) =>
      query.state.data?.versions.some((v) => v.state === 'sandbox_evaluation') ? SANDBOX_POLL_MS : false,
  });
}

/** UX-16, spec 12.6: the brand's spend position and limits. Owners and admins only (billing.manage). */
export function useBudgets(brandId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.agents.budgets.read.queryOptions({ brandId }), enabled, retry: false });
}

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
