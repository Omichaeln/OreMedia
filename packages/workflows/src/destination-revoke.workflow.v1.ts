import { proxyActivities } from '@temporalio/workflow';
import type {
  DestinationRevokeActivitiesV1,
  DestinationRevokeInputV1,
  DestinationRevokeResultV1,
} from '@oremedia/contracts/destinations';

/**
 * RA-01 (task queue `core`), started by the outbox when a destination whose adapter can revoke its grant remotely
 * is disconnected (`destination.disconnected` with `remoteRevoke: 'requested'`): one activity opens the
 * credential in the worker, asks the platform to revoke it, records the outcome and destroys the credential row
 * whatever the platform answered. Transient failures are retried by the activity's own policy; a credential
 * already destroyed ends the run. The payload carries ids only (R5). Once deployed this file is immutable;
 * changes ship as v2.
 */
export async function runDestinationRevoke(
  acts: DestinationRevokeActivitiesV1,
  input: DestinationRevokeInputV1,
): Promise<DestinationRevokeResultV1> {
  return acts.revokeDestinationAccess(input);
}

export async function destinationRevokeWorkflowV1(
  input: DestinationRevokeInputV1,
): Promise<DestinationRevokeResultV1> {
  const acts = proxyActivities<DestinationRevokeActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '45 seconds',
    retry: {
      initialInterval: '30s',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed', 'NotFound', 'CapabilityUnsupported'],
    },
  });
  return runDestinationRevoke(acts, input);
}
