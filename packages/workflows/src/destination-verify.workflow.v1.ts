import { proxyActivities } from '@temporalio/workflow';
import type {
  DestinationVerifyActivitiesV1,
  DestinationVerifyInputV1,
  DestinationVerifyResultV1,
} from '@oremedia/contracts/destinations';

/**
 * Ledger R2-3 (task queue `core`), started by the outbox when a destination is registered with a sealed secret
 * (`destination.registered` with `verify`): one activity opens the secret in the worker, asks the adapter to
 * verify it against the site and records the health found. Transient failures are retried by the activity's own
 * policy; a locked or no longer active destination ends the run. The payload carries ids only (R5). Once deployed
 * this file is immutable; changes ship as v2.
 */
export async function runDestinationVerify(
  acts: DestinationVerifyActivitiesV1,
  input: DestinationVerifyInputV1,
): Promise<DestinationVerifyResultV1> {
  return acts.verifyDestinationCredential(input);
}

export async function destinationVerifyWorkflowV1(
  input: DestinationVerifyInputV1,
): Promise<DestinationVerifyResultV1> {
  const acts = proxyActivities<DestinationVerifyActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '30s',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed', 'NotFound', 'CapabilityUnsupported'],
    },
  });
  return runDestinationVerify(acts, input);
}
