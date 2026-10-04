import {
  CancellationScope,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  GenerationErrorCode,
  GenerationStepOutcomeV1,
  StudioGenerationActivitiesV1,
  StudioGenerationInputV1,
  StudioGenerationResultV1,
  StudioGenerationSignalV1,
} from '@oremedia/contracts/generation';

/**
 * STU-1b: one attempt of a studio generation job (workflow id `studio-gen:<jobId>:<attempt>`, task queue `agents`).
 * Deterministic orchestration only: begin (queued → generating), reserve the budget before any model call, one
 * bounded model call (its output stored on the job), then save: compile, guard, validate and write the revisions or
 * the proposal; the job completes only after that commit. Any exhausted or non-retryable failure fails the job with a
 * code; the reservation's remainder is always settled. A cancel (the API moves the row first) is also signalled so
 * the attempt stops between steps. Once deployed this file is immutable; changes ship as v2.
 */
export const cancelGeneration = defineSignal('cancelGeneration');

const NON_RETRYABLE = ['PolicyDenied', 'BudgetExhausted', 'ValidationFailed'];

export type GenerationPhase = 'begin' | 'reserve' | 'model' | 'save';

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
export function generationFailureCode(err: unknown, phase: GenerationPhase): GenerationErrorCode {
  const type = failureTypeOf(err);
  if (type === 'BudgetExhausted') return 'budget_exhausted';
  if (type === 'PolicyDenied') return 'policy_denied';
  if (type === 'ValidationFailed') return 'validation_failed';
  return phase === 'model' ? 'model_failed' : 'failed';
}

/** The signal state and scopes of the workflow, separated so the orchestration runs with fakes in unit tests. */
export interface StudioGenerationHost {
  cancelled(): boolean;
  /** CancellationScope.nonCancellable in the workflow; the identity in tests. */
  nonCancellable<T>(fn: () => Promise<T>): Promise<T>;
}

/** The orchestration with the activity proxies and the signal state injected. */
export async function runStudioGeneration(
  acts: StudioGenerationActivitiesV1,
  input: StudioGenerationInputV1,
  host: StudioGenerationHost,
): Promise<StudioGenerationResultV1> {
  const stopped: StudioGenerationResultV1 = { jobId: input.jobId, state: 'stopped' };
  const goOn = (step: GenerationStepOutcomeV1) => step.proceed && !host.cancelled();
  let phase: GenerationPhase = 'begin';
  try {
    if (!goOn(await acts.beginGeneration(input))) return stopped;
    phase = 'reserve';
    if (!goOn(await acts.reserveGenerationBudget(input))) return stopped; // throws BudgetExhausted
    phase = 'model';
    if (!goOn(await acts.callGenerationModel(input))) return stopped;
    phase = 'save';
    return await acts.saveGeneration(input);
  } catch (err) {
    const code = generationFailureCode(err, phase);
    return await host.nonCancellable(() => acts.failGeneration({ ...input, code, detail: detailOf(err) }));
  } finally {
    await host.nonCancellable(() => acts.settleGenerationBudget(input));
  }
}

export async function studioGenerationWorkflowV1(
  input: StudioGenerationInputV1,
): Promise<StudioGenerationResultV1> {
  const control = proxyActivities<StudioGenerationActivitiesV1>({
    startToCloseTimeout: '1 minute',
    retry: { initialInterval: '2s', maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE },
  });
  // The model call: bounded by the adapter's timeout, heartbeating, retried a few times on provider failures.
  const model = proxyActivities<StudioGenerationActivitiesV1>({
    startToCloseTimeout: '4 minutes',
    heartbeatTimeout: '90 seconds',
    retry: {
      initialInterval: '5s',
      maximumInterval: '1 minute',
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE,
    },
  });
  let cancelled = false;
  setHandler(cancelGeneration, () => {
    cancelled = true;
  });
  return runStudioGeneration(
    {
      beginGeneration: control.beginGeneration,
      reserveGenerationBudget: control.reserveGenerationBudget,
      callGenerationModel: model.callGenerationModel,
      saveGeneration: control.saveGeneration,
      failGeneration: control.failGeneration,
      settleGenerationBudget: control.settleGenerationBudget,
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
export async function studioGenerationSignalRelayV1(input: StudioGenerationSignalV1): Promise<void> {
  await getExternalWorkflowHandle(input.workflowId).signal(cancelGeneration);
}
