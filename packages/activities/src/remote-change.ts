import type {
  RemoteChangeControlActivitiesV1,
  RemoteChangeControlRuntimeV1,
  RemoteChangeProviderActivitiesV1,
  RemoteChangeProviderRuntimeV1,
  RemoteChangeSweepActivitiesV1,
  RemoteChangeSweepRuntimeV1,
} from '@oremedia/contracts/publishing';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { toActivityFailure } from './agent-run';
import { withLogContext } from '@oremedia/observability';
import { loadActorGrants, resolveActivityActor } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Activities of publicationRemoteEditWorkflowV1 / publicationRemoteDeleteWorkflowV1. The provider half runs on
 * `publish-<providerKey>` next to publishOnce (credentials are opened by the broker inside the runtime, never in
 * Temporal); the control half runs on `core` and records the outcome. Both re-establish tenant context from the
 * input and re-load the requester's grants at the point of effect (spec 5.2); the provider half also re-resolves
 * the requester and hands it to the runtime, which re-checks publication.edit_remote / delete_remote before
 * anything is sent (as catalogueAsset re-decides asset.approve).
 */
const guarded =
  <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
  async (input: I): Promise<R> => {
    try {
      return await inTenant(input, loadActorGrants, () => fn(input));
    } catch (err) {
      throw toActivityFailure(err);
    }
  };

export function createRemoteChangeProviderActivities(
  runtime: RemoteChangeProviderRuntimeV1,
): RemoteChangeProviderActivitiesV1 {
  return {
    deleteRemotePost: guarded(async (input) =>
      runtime.deleteRemotePost(input, (await resolveActivityActor(input)).actor, { heartbeat }),
    ),
    editRemotePost: guarded(async (input) =>
      runtime.editRemotePost(input, (await resolveActivityActor(input)).actor, { heartbeat }),
    ),
  };
}

export function createRemoteChangeControlActivities(
  runtime: RemoteChangeControlRuntimeV1,
): RemoteChangeControlActivitiesV1 {
  return {
    recordRemoteChangeOutcome: guarded((input) => runtime.recordRemoteChangeOutcome(input)),
  };
}

/** The stale-change sweep is platform-level (no tenant input); the runtime declares the platform job itself. */
export function createRemoteChangeSweepActivities(
  runtime: RemoteChangeSweepRuntimeV1,
): RemoteChangeSweepActivitiesV1 {
  return {
    sweepStaleRemoteChanges: (input) =>
      withLogContext({ correlationId: input.correlationId }, () => runtime.sweepStaleRemoteChanges(input)),
  };
}
