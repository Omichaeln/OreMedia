import type {
  DestinationVerifyActivitiesV1,
  DestinationVerifyRuntimeV1,
} from '@oremedia/contracts/destinations';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Ledger R2-3 activity for destinationVerifyWorkflowV1 (task queue `core`): runs in the destination's tenant as
 * the person who connected it (grants re-loaded at the point of effect, spec 5.2), with domain errors translated
 * into the workflow's failure types. The effect lives in the destinations module's runtime.
 */
export function createDestinationVerifyActivities(
  runtime: DestinationVerifyRuntimeV1,
): DestinationVerifyActivitiesV1 {
  return {
    verifyDestinationCredential: async (input) => {
      try {
        return await inTenant(input, loadActorGrants, () => {
          heartbeat(`destination-verify:${input.destinationId}`);
          return runtime.verifyDestinationCredential(input);
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
