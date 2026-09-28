import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  RemoteChangeSweepActivitiesV1,
  RemoteChangeSweepResultV1,
} from '@oremedia/contracts/publishing';

/**
 * Closes remote edits and deletions of published posts that never got an outcome (their workflow was lost), so the
 * post can be changed again. Started hourly on task queue `core` by the Temporal schedule `remote-change-sweep`;
 * one activity pass, platform-level (it spans tenants and writes inside each change's own tenant). Once deployed
 * this file is immutable; changes ship as v2.
 */
export async function runRemoteChangeSweep(
  acts: RemoteChangeSweepActivitiesV1,
  host: { now(): number; correlationId: string },
): Promise<RemoteChangeSweepResultV1> {
  return acts.sweepStaleRemoteChanges({
    correlationId: host.correlationId,
    now: new Date(host.now()).toISOString(),
  });
}

export async function remoteChangeSweepWorkflowV1(): Promise<RemoteChangeSweepResultV1> {
  const acts = proxyActivities<RemoteChangeSweepActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 3 },
  });
  const { workflowId, runId } = workflowInfo();
  return runRemoteChangeSweep(acts, { now: () => Date.now(), correlationId: `${workflowId}:${runId}` });
}
