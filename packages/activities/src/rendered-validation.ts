import type {
  RenderedValidationActivitiesV1,
  RenderedValidationRuntimeV1,
} from '@oremedia/contracts/publishing';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * RA-04 activity for renderedValidationWorkflowV1 (task queue `core`): runs in the publication's tenant as the
 * actor the publish ran as (grants re-loaded at the point of effect, spec 5.2), with domain errors translated into
 * the workflow's failure types. The effect lives in the publishing module's runtime; no credential is opened (the
 * page is public), so a foreign publication id is NOT_FOUND before any fetch.
 */
export function createRenderedValidationActivities(
  runtime: RenderedValidationRuntimeV1,
): RenderedValidationActivitiesV1 {
  return {
    validateRenderedPublication: async (input) => {
      try {
        return await inTenant(input, loadActorGrants, () => {
          heartbeat(`rendered-validation:${input.publicationId}`);
          return runtime.validateRenderedPublication(input);
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
