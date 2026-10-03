import { proxyActivities } from '@temporalio/workflow';
import type {
  ChannelRevokeActivitiesV1,
  ChannelRevokeInputV1,
  ChannelRevokeResultV1,
} from '@oremedia/contracts/publishing';

/**
 * RA-01 (task queue `core`), started by the outbox when a channel whose provider can revoke its grant remotely is
 * disconnected (`channel.disconnected` with `remoteRevoke: 'requested'`): one activity opens the credential in the
 * worker, asks the platform to revoke it, records the outcome and destroys the credential row whatever the
 * platform answered. Transient failures are retried by the activity's own policy; a credential already destroyed
 * ends the run. The payload carries ids only (R5). Once deployed this file is immutable; changes ship as v2.
 */
export async function runChannelRevoke(
  acts: ChannelRevokeActivitiesV1,
  input: ChannelRevokeInputV1,
): Promise<ChannelRevokeResultV1> {
  return acts.revokeChannelAccess(input);
}

export async function channelRevokeWorkflowV1(input: ChannelRevokeInputV1): Promise<ChannelRevokeResultV1> {
  const acts = proxyActivities<ChannelRevokeActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '45 seconds',
    retry: {
      initialInterval: '30s',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed', 'NotFound', 'CapabilityUnsupported'],
    },
  });
  return runChannelRevoke(acts, input);
}
