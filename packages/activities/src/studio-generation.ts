import type {
  StudioGenerationActivitiesV1,
  StudioGenerationInputV1,
  StudioGenerationRuntimeV1,
} from '@oremedia/contracts/generation';
import { toActivityFailure } from './agent-run';
import { loadActorGrants, resolveActivityActor } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * STU-1b activities for studioGenerationWorkflowV1 (task queue `agents`): thin wrappers that establish tenant
 * context with the requesting person's grants as they are now (spec 5.2), resolve that person for the steps that act
 * on the document, heartbeat around the model call and translate domain errors into the workflow's failure types.
 * apps/worker-core wires @oremedia/module-agents' createStudioGenerationRuntime.
 */
export function createStudioGenerationActivities(
  runtime: StudioGenerationRuntimeV1,
): StudioGenerationActivitiesV1 {
  const guarded =
    <I extends StudioGenerationInputV1, R>(fn: (input: I) => Promise<R>) =>
    async (input: I): Promise<R> => {
      try {
        return await inTenant(input, loadActorGrants, () => fn(input));
      } catch (err) {
        throw toActivityFailure(err);
      }
    };
  return {
    beginGeneration: guarded((input) => runtime.begin(input)),
    reserveGenerationBudget: guarded((input) => runtime.reserve(input)),
    callGenerationModel: guarded(async (input) => {
      heartbeat(`generation:${input.jobId}:start`);
      const { actor } = await resolveActivityActor(input);
      return runtime.callModel(input, actor, { heartbeat });
    }),
    saveGeneration: guarded(async (input) => runtime.save(input, (await resolveActivityActor(input)).actor)),
    failGeneration: guarded((input) => runtime.fail(input, input.code, input.detail)),
    settleGenerationBudget: guarded((input) => runtime.settle(input)),
  };
}
