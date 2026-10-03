import type {
  DestinationRevokeActivitiesV1,
  DestinationRevokeRuntimeV1,
} from '@oremedia/contracts/destinations';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/** RA-01: the revoke is a platform job applied inside the destination's tenant (as the channel revoke is). */
export const DESTINATION_REVOKE_ACTOR = { kind: 'platform_operator' as const, id: 'destination-revoke' };
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

/**
 * Activity for destinationRevokeWorkflowV1 (task queue `core`): runs in the destination's tenant as the platform
 * job (no actor's grants are read, so a removed membership can never leave a live token), with domain errors
 * translated into the workflow's failure types. The effect lives in the destinations module's runtime.
 */
export function createDestinationRevokeActivities(
  runtime: DestinationRevokeRuntimeV1,
): DestinationRevokeActivitiesV1 {
  return {
    revokeDestinationAccess: async (input) => {
      try {
        return await inTenant({ ...input, actor: DESTINATION_REVOKE_ACTOR }, wholeTenant, () => {
          heartbeat(`destination-revoke:${input.destinationId}`);
          return runtime.revokeDestinationAccess(input);
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
