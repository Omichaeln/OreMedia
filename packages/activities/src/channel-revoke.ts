import type { ChannelRevokeActivitiesV1, ChannelRevokeRuntimeV1 } from '@oremedia/contracts/publishing';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/**
 * RA-01: the revoke is a platform job applied inside the connection's tenant, not the disconnecting person's
 * request: a membership removed since the disconnect must never leave a live token because its grants no longer
 * load, so no actor's grants are read (every brand of the tenant).
 */
export const CHANNEL_REVOKE_ACTOR = { kind: 'platform_operator' as const, id: 'channel-revoke' };
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

/**
 * Activity for channelRevokeWorkflowV1 (task queue `core`): runs in the connection's tenant as the platform job,
 * with domain errors translated into the workflow's failure types. The effect (open, revoke at the platform,
 * record, destroy whatever the platform answered, destroy on an unexpected failure too) lives in the publishing
 * runtime; the sweeper is the floor under it.
 */
export function createChannelRevokeActivities(runtime: ChannelRevokeRuntimeV1): ChannelRevokeActivitiesV1 {
  return {
    revokeChannelAccess: async (input) => {
      try {
        return await inTenant({ ...input, actor: CHANNEL_REVOKE_ACTOR }, wholeTenant, () => {
          heartbeat(`channel-revoke:${input.channelConnectionId}`);
          return runtime.revokeChannelAccess(input);
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
