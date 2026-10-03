import type {
  BrandAssistActivitiesV1,
  BrandSourceCaptureActivitiesV1,
  BrandSourceExtractActivitiesV1,
} from '@oremedia/contracts/brand-assist';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import type { BrandAssistRuntime } from '@oremedia/module-brand';
import { loadActorGrants, resolveActivityActor } from './actor';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/** Closing a job (its bookkeeping and the budget settlement) is not an effect on anyone's behalf: the whole tenant. */
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

const guard =
  (grants: GrantLoader) =>
  <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
  async (input: I): Promise<R> => {
    try {
      return await inTenant(input, grants, () => fn(input));
    } catch (err) {
      throw toActivityFailure(err);
    }
  };

/**
 * BSC-4 activities for brandAssistWorkflowV1. Control, budget and model calls run on task queue `agents`
 * (worker-core) as the person or agent who asked, their grants re-loaded at the point of effect (spec 5.2); website
 * capture runs on `ingest-metrics` (worker-ingest) and document extraction on `media` (worker-render). Every effect
 * lives in the brand module's runtime (createBrandAssistRuntime); domain errors become the workflow's failure types.
 */
export function createBrandAssistActivities(runtime: BrandAssistRuntime): BrandAssistActivitiesV1 {
  const asActor = guard(loadActorGrants);
  const asTenant = guard(wholeTenant);
  return {
    beginBrandAssist: asActor((input) => runtime.beginBrandAssist(input)),
    markBrandAssistStage: asActor((input) => runtime.markBrandAssistStage(input)),
    recordBrandSourceFailure: asTenant((input) => runtime.recordBrandSourceFailure(input)),
    prepareBrandAssistProposals: asActor(async (input) =>
      runtime.prepareBrandAssistProposals(input, (await resolveActivityActor(input)).actor),
    ),
    proposeBrandAssistSection: asActor((input) => {
      heartbeat(`brand-assist:${input.jobId}:${input.section}`);
      return runtime.proposeBrandAssistSection(input, { heartbeat });
    }),
    recordBrandAssistSectionFailure: asTenant((input) => runtime.recordBrandAssistSectionFailure(input)),
    finishBrandAssist: asTenant((input) => runtime.finishBrandAssist(input)),
  };
}

export function createBrandSourceCaptureActivities(
  runtime: BrandAssistRuntime,
): BrandSourceCaptureActivitiesV1 {
  const asActor = guard(loadActorGrants);
  return {
    captureBrandSourceUrl: asActor((input) => {
      heartbeat(`brand-source:${input.sourceId}:start`);
      return runtime.captureBrandSourceUrl(input, { heartbeat });
    }),
  };
}

export function createBrandSourceExtractActivities(
  runtime: BrandAssistRuntime,
): BrandSourceExtractActivitiesV1 {
  const asActor = guard(loadActorGrants);
  return {
    extractBrandSourceDocument: asActor((input) => {
      heartbeat(`brand-source:${input.sourceId}:start`);
      return runtime.extractBrandSourceDocument(input, { heartbeat });
    }),
  };
}
