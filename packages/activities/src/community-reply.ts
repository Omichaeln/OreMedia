import type {
  CommunityReplyControlActivitiesV1,
  CommunityReplyProviderActivitiesV1,
  CommunityReplyRuntimeV1,
} from '@oremedia/contracts/community';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

const guarded =
  <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
  async (input: I): Promise<R> => {
    try {
      return await inTenant(input, loadActorGrants, () => fn(input));
    } catch (err) {
      throw toActivityFailure(err);
    }
  };

/**
 * communityReplyWorkflowV1 provider activity (task queue `publish-<providerKey>`, beside publishOnce: the worker
 * whose broker opens the channel's credentials). maximumAttempts 1 in the workflow; the runtime never re-sends a
 * reply that reached its send boundary. The payload carries the draft id only (spec 14.7 R5).
 */
export function createCommunityReplyProviderActivities(
  runtime: CommunityReplyRuntimeV1,
): CommunityReplyProviderActivitiesV1 {
  return {
    sendReplyOnce: guarded((input) => {
      heartbeat(`reply:${input.responseDraftId}:start`);
      return runtime.sendReplyOnce(input, { heartbeat });
    }),
  };
}

/** communityReplyWorkflowV1 control activities (task queue `core`; idempotent). */
export function createCommunityReplyControlActivities(
  runtime: CommunityReplyRuntimeV1,
): CommunityReplyControlActivitiesV1 {
  return {
    readReplyRoute: guarded((input) => runtime.readReplyRoute(input)),
    recordReplyOutcome: guarded((input) => runtime.recordReplyOutcome(input)),
  };
}
