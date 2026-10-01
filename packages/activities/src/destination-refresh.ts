import type {
  DestinationRefreshActivitiesV1,
  DestinationRefreshRuntimeV1,
} from '@oremedia/contracts/destinations';
import { withLogContext } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/** The refresh is a platform job applied inside each tenant: no requesting actor, every brand of the tenant. */
export const DESTINATION_REFRESH_ACTOR = {
  kind: 'platform_operator' as const,
  id: 'destination-token-refresh',
};
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

/**
 * Ledger R2-1 activities for destinationTokenRefreshWorkflowV1 (task queue `core`): the due listing is
 * platform-level (the runtime declares the platform job itself); each refresh runs in its destination's tenant
 * with domain errors translated into the workflow's failure types. Every effect lives in the destinations module's
 * runtime (createDestinationRuntime).
 */
export function createDestinationRefreshActivities(
  runtime: DestinationRefreshRuntimeV1,
): DestinationRefreshActivitiesV1 {
  return {
    listDueDestinationRefreshes: (input) =>
      withLogContext({ correlationId: input.correlationId }, () =>
        runtime.listDueDestinationRefreshes(input),
      ),
    refreshDestinationCredential: async (input) => {
      try {
        return await inTenant(input, wholeTenant, () => {
          heartbeat(`destination-refresh:${input.destinationId}`);
          return runtime.refreshDestinationCredential(input);
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
