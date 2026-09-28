import { proxyActivities, sleep } from '@temporalio/workflow';
import type {
  CommunityReplyControlActivitiesV1,
  CommunityReplyProviderActivitiesV1,
  CommunityReplyWorkflowInputV1,
  RecordReplyOutcomeResultV1,
  ReplySendResultV1,
} from '@oremedia/contracts/community';

/**
 * Comment inbox: posts one reply (workflow id `reply:<responseDraftId>`, task queue `core`). The provider call runs
 * once per attempt on the channel's `publish-<providerKey>` queue, where the credentials are; it is never blindly
 * retried. Only a failure proven before the send boundary (nothing left the process, the draft is still queued) is
 * tried again, with backoff, a bounded number of times. The classified outcome is then recorded on `core`: the
 * outbound message and the draft's final state (sent, failed with the reason, or outcome_unknown). Once deployed
 * this file is immutable; changes ship as v2.
 */
export const MAX_SEND_ATTEMPTS = 5;
/** Waits between pre-send retries (never below the platform's Retry-After). */
export const PRE_SEND_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

/** Domain errors that no retry can fix (a foreign id, a lost permission, an illegal state). */
const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed'];

export interface CommunityReplyHost {
  sleep(ms: number): Promise<void>;
  /** The send activity bound to the provider's task queue (`publish-<providerKey>`). */
  providerActivities(providerKey: string): CommunityReplyProviderActivitiesV1;
}

const summarise = (err: unknown): string => {
  const e = err as { message?: string; cause?: { message?: string } } | undefined;
  return (e?.cause?.message ?? e?.message ?? String(err)).slice(0, 500);
};

/** The orchestration with the activity proxies and timers injected (unit-tested with fakes). */
export async function runCommunityReply(
  control: CommunityReplyControlActivitiesV1,
  input: CommunityReplyWorkflowInputV1,
  host: CommunityReplyHost,
): Promise<RecordReplyOutcomeResultV1> {
  const route = await control.readReplyRoute(input);
  let result: ReplySendResultV1 = {
    outcome: 'rejected',
    code: 'comments_reply_unsupported',
    message: 'the channel cannot reply to comments',
  };
  if (route.providerKey) {
    const provider = host.providerActivities(route.providerKey);
    for (let attempt = 1; ; attempt++) {
      // A timeout or a lost worker is an unknown outcome: recorded as such, never sent again.
      result = await provider
        .sendReplyOnce(input)
        .catch((err) => ({ outcome: 'unknown' as const, code: 'activity_failed', message: summarise(err) }));
      if (result.outcome !== 'retryable_error' || attempt >= MAX_SEND_ATTEMPTS) break;
      const backoff = PRE_SEND_BACKOFF_MS[attempt - 1] ?? PRE_SEND_BACKOFF_MS[3];
      await host.sleep(Math.max(backoff, result.retryAfterMs ?? 0));
    }
  }
  return control.recordReplyOutcome({ ...input, result });
}

export async function communityReplyWorkflowV1(
  input: CommunityReplyWorkflowInputV1,
): Promise<RecordReplyOutcomeResultV1> {
  const control = proxyActivities<CommunityReplyControlActivitiesV1>({
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES }, // idempotent
  });
  return runCommunityReply(control, input, {
    sleep: (ms) => sleep(ms),
    providerActivities: (providerKey) =>
      proxyActivities<CommunityReplyProviderActivitiesV1>({
        taskQueue: `publish-${providerKey}`,
        startToCloseTimeout: '5 minutes',
        heartbeatTimeout: '2 minutes',
        retry: { maximumAttempts: 1 }, // never let Temporal blindly retry a mutation
      }),
  });
}
