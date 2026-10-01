import type {
  DestinationReportSweepActivitiesV1,
  DestinationReportsActivitiesV1,
  DestinationReportsRuntimeV1,
} from '@oremedia/contracts/destinations';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { withLogContext } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/** The sweep is a platform job applied inside each tenant: no requesting actor, every brand of the tenant. */
export const DESTINATION_REPORTS_ACTOR = {
  kind: 'platform_operator' as const,
  id: 'destination-report-sweep',
};
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

/**
 * R2-1 part B activities for destinationReportSweepWorkflowV1 and destinationReportsWorkflowV1 (task queue
 * `ingest-metrics`, worker-ingest): the target listing is platform-level (the runtime declares the platform job
 * itself); everything else runs in its destination's tenant with domain errors translated into the workflows'
 * failure types. Every effect lives in the destinations module's report runtime (createDestinationRuntime().reports).
 * Payloads carry ids, ranges and counts only (spec 14.7, R5): rows never enter Temporal.
 */
export function createDestinationReportActivities(
  runtime: DestinationReportsRuntimeV1,
): DestinationReportSweepActivitiesV1 & DestinationReportsActivitiesV1 {
  const guarded =
    <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
    async (input: I): Promise<R> => {
      try {
        return await inTenant(input, wholeTenant, () => fn(input));
      } catch (err) {
        throw toActivityFailure(err);
      }
    };
  return {
    listDestinationReportTargets: (input) =>
      withLogContext({ correlationId: input.correlationId }, () =>
        runtime.listDestinationReportTargets(input),
      ),
    planDestinationReports: guarded((input) => runtime.planDestinationReports(input)),
    fetchDestinationReport: guarded((input) => {
      heartbeat(`report:${input.destinationId}:${input.reportKey}:start`);
      return runtime.fetchDestinationReport(input, { heartbeat });
    }),
    finishDestinationReports: guarded((input) => runtime.finishDestinationReports(input)),
    pruneDestinationReports: guarded((input) => runtime.pruneDestinationReports(input)),
  };
}
