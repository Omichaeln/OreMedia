import type { BrandFactSweepActivitiesV1, BrandFactSweepRuntimeV1 } from '@oremedia/contracts/fact-sweep';
import { withLogContext } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/** The sweep is a platform job applied inside each tenant: no requesting actor, every brand of the tenant. */
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

/**
 * BSC-3 activities for brandFactSweepWorkflowV1 (task queue `core`): the due listing is platform-level (the runtime
 * declares the platform job itself); each brand's sweep runs in its tenant with domain errors translated into the
 * workflow's failure types. Every effect lives in the brand module's runtime (createBrandFactSweepRuntime).
 */
export function createBrandFactSweepActivities(runtime: BrandFactSweepRuntimeV1): BrandFactSweepActivitiesV1 {
  return {
    listBrandFactSweepTargets: (input) =>
      withLogContext({ correlationId: input.correlationId }, () => runtime.listBrandFactSweepTargets(input)),
    sweepBrandFacts: async (input) => {
      try {
        return await inTenant(input, wholeTenant, () => {
          heartbeat(`brand-fact-sweep:${input.brandId}`);
          return runtime.sweepBrandFacts(input);
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
