import type {
  SeoAuditActivitiesV1,
  SeoAuditRuntimeV1,
  SeoAuditSweepActivitiesV1,
} from '@oremedia/contracts/seo-audit';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { withLogContext } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/** The weekly sweep is a platform job applied inside each tenant: no requesting actor, every brand of the tenant. */
export const SEO_AUDIT_ACTOR = { kind: 'platform_operator' as const, id: 'seo-audit-sweep' };
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

/**
 * R2-4 activities for seoAuditSweepWorkflowV1 and seoAuditWorkflowV1 (task queue `ingest-metrics`, worker-ingest):
 * the target listing is platform-level (the runtime declares the platform job itself); everything else runs in
 * its destination's tenant with domain errors translated into the workflows' failure types. Every effect lives in
 * the destinations module's audit runtime (createDestinationRuntime().audit). Payloads carry ids, URLs and counts
 * only (spec 14.7, R5): a page body never enters Temporal.
 */
export function createSeoAuditActivities(
  runtime: SeoAuditRuntimeV1,
): SeoAuditSweepActivitiesV1 & SeoAuditActivitiesV1 {
  const guarded =
    <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
    async (input: I): Promise<R> => {
      try {
        return await inTenant(input, wholeTenant, () => fn(input));
      } catch (err) {
        throw toActivityFailure(err);
      }
    };
  return {
    listSeoAuditTargets: (input) =>
      withLogContext({ correlationId: input.correlationId }, () => runtime.listSeoAuditTargets(input)),
    planSeoAudit: guarded((input) => runtime.planSeoAudit(input)),
    crawlSeoAuditPage: guarded((input) => {
      heartbeat(`audit:${input.runId}:start`);
      return runtime.crawlSeoAuditPage(input, { heartbeat });
    }),
    finishSeoAudit: guarded((input) => runtime.finishSeoAudit(input)),
    pruneSeoAudits: guarded((input) => runtime.pruneSeoAudits(input)),
  };
}
