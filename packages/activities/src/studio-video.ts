import type {
  StudioVideoJobActivitiesV1,
  StudioVideoJobInputV1,
  StudioVideoJobRuntimeV1,
} from '@oremedia/contracts/video-ai';
import { toActivityFailure } from './agent-run';
import { loadActorGrants, resolveActivityActor } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * STU-3 activities for studioVideoJobWorkflowV1 (task queue `agents`): thin wrappers that establish tenant context
 * with the requesting person's grants as they are now (spec 5.2), resolve that person for the steps that act on the
 * document, heartbeat around the model call and translate domain errors into the workflow's failure types.
 * apps/worker-core wires @oremedia/module-agents' createStudioVideoRuntime.
 */
export function createStudioVideoActivities(runtime: StudioVideoJobRuntimeV1): StudioVideoJobActivitiesV1 {
  const guarded =
    <I extends StudioVideoJobInputV1, R>(fn: (input: I) => Promise<R>) =>
    async (input: I): Promise<R> => {
      try {
        return await inTenant(input, loadActorGrants, () => fn(input));
      } catch (err) {
        throw toActivityFailure(err);
      }
    };
  return {
    beginVideoJob: guarded((input) => runtime.begin(input)),
    reserveVideoJobBudget: guarded((input) => runtime.reserve(input)),
    callVideoJobModel: guarded(async (input) => {
      heartbeat(`video-job:${input.jobId}:start`);
      const { actor } = await resolveActivityActor(input);
      return runtime.callModel(input, actor, { heartbeat });
    }),
    saveVideoJob: guarded(async (input) => runtime.save(input, (await resolveActivityActor(input)).actor)),
    failVideoJob: guarded((input) => runtime.fail(input, input.code, input.detail)),
    settleVideoJobBudget: guarded((input) => runtime.settle(input)),
  };
}
