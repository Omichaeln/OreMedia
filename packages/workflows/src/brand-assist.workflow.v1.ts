import {
  CancellationScope,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  BrandAssistActivitiesV1,
  BrandAssistFinishResultV1,
  BrandAssistInputV1,
  BrandAssistSignalV1,
  BrandSourceCaptureActivitiesV1,
  BrandSourceExtractActivitiesV1,
} from '@oremedia/contracts/brand-assist';

/**
 * BSC-4: one AI assist job (`brand-assist:<jobId>`, task queue `agents`). Websites are read on worker-ingest's
 * `ingest-metrics` queue (the workers with outbound fetch), documents on worker-render's `media` queue (untrusted
 * parsers and the object store), and the budget, the model calls and the suggestions on `agents`. A source that cannot
 * be read is recorded with its reason and the job goes on; a section whose call keeps failing is recorded as failed
 * and the others go on (partial success); a cancel signal stops the next step; the job is always closed and its
 * reservation settled. Payloads carry ids, statuses and counts only. Once deployed this file is immutable; changes
 * ship as v2.
 */
export const cancelBrandAssist = defineSignal('cancelBrandAssist');

export const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed', 'BudgetExhausted'];

/** Walks the failure chain (ActivityFailure → ApplicationFailure) for the failure `type`. */
function failureTypeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { type?: string | null; cause?: unknown };
    if (typeof e.type === 'string' && e.type) return e.type;
    current = e.cause;
  }
  return undefined;
}
const reasonOf = (err: unknown): string => {
  const type = failureTypeOf(err);
  return type === 'PolicyDenied'
    ? 'not_allowed'
    : type === 'BudgetExhausted'
      ? 'budget_exhausted'
      : type === 'ValidationFailed'
        ? 'invalid'
        : 'model_failed';
};

export interface BrandAssistHost {
  cancelled(): boolean;
  /** CancellationScope.nonCancellable in the workflow; the identity in tests. */
  nonCancellable<T>(fn: () => Promise<T>): Promise<T>;
}

/** The orchestration, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runBrandAssist(
  acts: BrandAssistActivitiesV1,
  capture: BrandSourceCaptureActivitiesV1,
  extract: BrandSourceExtractActivitiesV1,
  input: BrandAssistInputV1,
  host: BrandAssistHost,
): Promise<BrandAssistFinishResultV1> {
  let failure: string | null = null;
  const finish = () =>
    host.nonCancellable(() => acts.finishBrandAssist({ ...input, cancelled: host.cancelled(), failure }));
  try {
    const plan = await acts.beginBrandAssist(input);
    if (plan.outcome === 'skipped')
      return host.nonCancellable(() =>
        acts.finishBrandAssist({
          ...input,
          cancelled: plan.reason === 'cancelled' || host.cancelled(),
          failure: null,
        }),
      );
    for (const sourceId of plan.urlSourceIds) {
      if (host.cancelled()) break;
      try {
        await capture.captureBrandSourceUrl({ ...input, sourceId });
      } catch {
        await acts.recordBrandSourceFailure({ ...input, sourceId, reason: 'capture_failed' });
      }
    }
    if (plan.documentSourceIds.length && !host.cancelled()) {
      await acts.markBrandAssistStage({ ...input, stage: 'extracting' });
      for (const sourceId of plan.documentSourceIds) {
        if (host.cancelled()) break;
        try {
          await extract.extractBrandSourceDocument({ ...input, sourceId });
        } catch {
          await acts.recordBrandSourceFailure({ ...input, sourceId, reason: 'capture_failed' });
        }
      }
    }
    if (!host.cancelled()) {
      const prepared = await acts.prepareBrandAssistProposals(input);
      if (prepared.outcome === 'failed') failure = prepared.reason;
      if (prepared.outcome === 'run')
        for (const section of prepared.sections) {
          if (host.cancelled()) break;
          try {
            await acts.proposeBrandAssistSection({ ...input, section });
          } catch (err) {
            await acts.recordBrandAssistSectionFailure({ ...input, section, reason: reasonOf(err) });
          }
        }
    }
  } catch (err) {
    failure = reasonOf(err);
  }
  return finish();
}

export async function brandAssistWorkflowV1(input: BrandAssistInputV1): Promise<BrandAssistFinishResultV1> {
  const control = proxyActivities<Omit<BrandAssistActivitiesV1, 'proposeBrandAssistSection'>>({
    startToCloseTimeout: '1 minute',
    retry: { initialInterval: '5s', maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  // One bounded model call per attempt; a provider failure or an answer that does not fit its schema is retried once.
  const model = proxyActivities<Pick<BrandAssistActivitiesV1, 'proposeBrandAssistSection'>>({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '10s', maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  const capture = proxyActivities<BrandSourceCaptureActivitiesV1>({
    taskQueue: 'ingest-metrics',
    startToCloseTimeout: '4 minutes',
    heartbeatTimeout: '2 minutes',
    retry: { initialInterval: '10s', maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  const extract = proxyActivities<BrandSourceExtractActivitiesV1>({
    taskQueue: 'media',
    startToCloseTimeout: '3 minutes',
    retry: { initialInterval: '10s', maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  let cancelled = false;
  setHandler(cancelBrandAssist, () => {
    cancelled = true;
  });
  // An activity proxy has no own keys (it answers any name), so it is never spread: each activity is named.
  const acts: BrandAssistActivitiesV1 = {
    beginBrandAssist: control.beginBrandAssist,
    markBrandAssistStage: control.markBrandAssistStage,
    recordBrandSourceFailure: control.recordBrandSourceFailure,
    prepareBrandAssistProposals: control.prepareBrandAssistProposals,
    proposeBrandAssistSection: model.proposeBrandAssistSection,
    recordBrandAssistSectionFailure: control.recordBrandAssistSectionFailure,
    finishBrandAssist: control.finishBrandAssist,
  };
  return runBrandAssist(acts, capture, extract, input, {
    cancelled: () => cancelled,
    nonCancellable: (fn) => CancellationScope.nonCancellable(fn),
  });
}

/** Relays a cancellation from the outbox to the running job (after the cancel committed); a finished job is gone. */
export async function brandAssistSignalRelayV1(input: BrandAssistSignalV1): Promise<void> {
  await getExternalWorkflowHandle(input.workflowId).signal(cancelBrandAssist);
}
