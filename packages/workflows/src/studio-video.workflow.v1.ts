import {
  CancellationScope,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  StudioVideoJobActivitiesV1,
  StudioVideoJobInputV1,
  StudioVideoJobResultV1,
  StudioVideoJobSignalV1,
  VideoAiErrorCode,
  VideoJobStepOutcomeV1,
} from '@oremedia/contracts/video-ai';

/**
 * STU-3: one attempt of a studio video AI job (workflow id `studio-video:<jobId>:<attempt>`, task queue `agents`):
 * a storyboard from a brief, or a recut of the timeline. Deterministic orchestration only: begin (queued →
 * generating), reserve the budget before the model call, one bounded model call (its checked output stored on the
 * job), then save: check and compile, guard, validate and write the storyboard, the proposal or the new-format
 * document; the job completes only after that commit. Any exhausted or non-retryable failure fails the job with a
 * code; the reservation's remainder is always settled. A cancel (the API moves the row first) is also signalled so the
 * attempt stops between steps. Once deployed this file is immutable; changes ship as v2.
 */
export const cancelVideoJob = defineSignal('cancelVideoJob');

const NON_RETRYABLE = ['PolicyDenied', 'BudgetExhausted', 'ValidationFailed'];

export type VideoJobPhase = 'begin' | 'reserve' | 'model' | 'save';

/** Walks the failure chain (ActivityFailure → ApplicationFailure) for the failure `type` (never a class name). */
function failureTypeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { type?: string | null; cause?: unknown };
    if (typeof e.type === 'string' && e.type) return e.type;
    current = e.cause;
  }
  return undefined;
}

function detailOf(err: unknown): string {
  let current: unknown = err;
  let last = '';
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (typeof e.message === 'string' && e.message) last = e.message;
    current = e.cause;
  }
  return last.slice(0, 500);
}

/** The code a failed job records for a failure in a phase. */
export function videoJobFailureCode(err: unknown, phase: VideoJobPhase): VideoAiErrorCode {
  const type = failureTypeOf(err);
  if (type === 'BudgetExhausted') return 'budget_exhausted';
  if (type === 'PolicyDenied') return 'policy_denied';
  if (type === 'ValidationFailed') return 'validation_failed';
  return phase === 'model' ? 'model_failed' : 'failed';
}

/** The signal state and scopes of the workflow, separated so the orchestration runs with fakes in unit tests. */
export interface StudioVideoJobHost {
  cancelled(): boolean;
  /** CancellationScope.nonCancellable in the workflow; the identity in tests. */
  nonCancellable<T>(fn: () => Promise<T>): Promise<T>;
}

/** The orchestration with the activity proxies and the signal state injected. */
export async function runStudioVideoJob(
  acts: StudioVideoJobActivitiesV1,
  input: StudioVideoJobInputV1,
  host: StudioVideoJobHost,
): Promise<StudioVideoJobResultV1> {
  const stopped: StudioVideoJobResultV1 = { jobId: input.jobId, state: 'stopped' };
  const goOn = (step: VideoJobStepOutcomeV1) => step.proceed && !host.cancelled();
  let phase: VideoJobPhase = 'begin';
  try {
    if (!goOn(await acts.beginVideoJob(input))) return stopped;
    phase = 'reserve';
    if (!goOn(await acts.reserveVideoJobBudget(input))) return stopped; // throws BudgetExhausted
    phase = 'model';
    if (!goOn(await acts.callVideoJobModel(input))) return stopped;
    phase = 'save';
    return await acts.saveVideoJob(input);
  } catch (err) {
    const code = videoJobFailureCode(err, phase);
    return await host.nonCancellable(() => acts.failVideoJob({ ...input, code, detail: detailOf(err) }));
  } finally {
    await host.nonCancellable(() => acts.settleVideoJobBudget(input));
  }
}

export async function studioVideoJobWorkflowV1(
  input: StudioVideoJobInputV1,
): Promise<StudioVideoJobResultV1> {
  const control = proxyActivities<StudioVideoJobActivitiesV1>({
    startToCloseTimeout: '1 minute',
    retry: { initialInterval: '2s', maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE },
  });
  // The model call: bounded by the adapter's timeout, heartbeating, retried a few times on provider failures.
  const model = proxyActivities<StudioVideoJobActivitiesV1>({
    startToCloseTimeout: '4 minutes',
    heartbeatTimeout: '90 seconds',
    retry: {
      initialInterval: '5s',
      maximumInterval: '1 minute',
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE,
    },
  });
  // The save compiles and evaluates up to a few hundred timeline operations in one transaction.
  const save = proxyActivities<StudioVideoJobActivitiesV1>({
    startToCloseTimeout: '3 minutes',
    retry: { initialInterval: '2s', maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE },
  });
  let cancelled = false;
  setHandler(cancelVideoJob, () => {
    cancelled = true;
  });
  return runStudioVideoJob(
    {
      beginVideoJob: control.beginVideoJob,
      reserveVideoJobBudget: control.reserveVideoJobBudget,
      callVideoJobModel: model.callVideoJobModel,
      saveVideoJob: save.saveVideoJob,
      failVideoJob: control.failVideoJob,
      settleVideoJobBudget: control.settleVideoJobBudget,
    },
    input,
    {
      cancelled: () => cancelled,
      nonCancellable: (fn) => CancellationScope.nonCancellable(fn),
    },
  );
}

/**
 * Relays a cancel from the outbox to the running attempt. The API writes the event in the cancel's transaction; a
 * relay for an attempt that already ended fails harmlessly (the workflow is gone).
 */
export async function studioVideoJobSignalRelayV1(input: StudioVideoJobSignalV1): Promise<void> {
  try {
    await getExternalWorkflowHandle(input.workflowId).signal(cancelVideoJob);
  } catch {
    // Not running any more: nothing to stop.
  }
}
