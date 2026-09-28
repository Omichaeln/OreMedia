import { proxyActivities, sleep } from '@temporalio/workflow';
import type { RemoteMutationOutcome } from '@oremedia/contracts/providers';
import type {
  PublicationRemoteChangeInputV1,
  RemoteChangeAttemptResultV1,
  RemoteChangeControlActivitiesV1,
  RemoteChangeProviderActivitiesV1,
} from '@oremedia/contracts/publishing';

/**
 * Edit or delete a live post on its platform (publication.edit_remote / delete_remote), one workflow per request
 * (workflow id `pub:<publicationId>:remote:<changeId>`, task queue `core`). The platform call runs on the
 * provider's own queue (`publish-<providerKey>`) once per activity (maximumAttempts 1); the workflow retries a
 * retryable outcome with bounded backoff, which is safe because both calls converge on a repeat (a second delete
 * finds the post gone, a second edit sets the same text). The outcome is recorded once on `core`: a confirmed
 * deletion moves the publication to `removed`, a failure stays on the change with its reason. A change that is no
 * longer requested is skipped without a call. Once deployed this file is immutable; changes ship as v2.
 */
export const REMOTE_CHANGE_MAX_ATTEMPTS = 5;
export const REMOTE_CHANGE_BACKOFF_MIN_MS = 30_000;
export const REMOTE_CHANGE_BACKOFF_MAX_MS = 30 * 60_000;

/** Domain errors that no retry can fix (a foreign id, a lost permission, an illegal state). */
const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed'];

export type RemoteChangeKindV1 = 'edit' | 'delete';

export interface RemoteChangeHost {
  sleep(ms: number): Promise<void>;
}

export interface RemoteChangeOutcomeV1 {
  outcome: 'recorded' | 'skipped';
  attempts: number;
  result: RemoteChangeAttemptResultV1;
}

/** 30 s · 2^(n-1) capped at 30 minutes, never below the platform's Retry-After. */
export function remoteChangeBackoffMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(
    REMOTE_CHANGE_BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1),
    REMOTE_CHANGE_BACKOFF_MAX_MS,
  );
  return Math.max(base, Math.min(retryAfterMs ?? 0, REMOTE_CHANGE_BACKOFF_MAX_MS));
}

/** An activity failure becomes an outcome: a domain refusal is final, anything else is retried like a 5xx. */
function failureOutcome(err: unknown): RemoteMutationOutcome {
  const e = err as { message?: string; cause?: { type?: string; message?: string } } | undefined;
  const message = (e?.cause?.message ?? e?.message ?? String(err)).slice(0, 500);
  const type = e?.cause?.type;
  return type && NON_RETRYABLE_ERROR_TYPES.includes(type)
    ? { outcome: 'rejected', code: type, message }
    : { outcome: 'retryable_error', code: 'activity_failed', message };
}

export async function runRemoteChange(
  kind: RemoteChangeKindV1,
  provider: RemoteChangeProviderActivitiesV1,
  control: RemoteChangeControlActivitiesV1,
  input: PublicationRemoteChangeInputV1,
  host: RemoteChangeHost,
): Promise<RemoteChangeOutcomeV1> {
  const call = kind === 'delete' ? provider.deleteRemotePost : provider.editRemotePost;
  let last: RemoteMutationOutcome = {
    outcome: 'retryable_error',
    code: 'not_attempted',
    message: 'no attempt was made',
  };
  let attempts = 0;
  while (attempts < REMOTE_CHANGE_MAX_ATTEMPTS) {
    attempts += 1;
    const result: RemoteChangeAttemptResultV1 = await call(input).catch(failureOutcome);
    if (result.outcome === 'skipped') return { outcome: 'skipped', attempts, result };
    last = result;
    if (result.outcome !== 'retryable_error') break;
    if (attempts < REMOTE_CHANGE_MAX_ATTEMPTS)
      await host.sleep(remoteChangeBackoffMs(attempts, result.retryAfterMs));
  }
  // A retryable outcome left after the last attempt is recorded as the failure it is, with its own code.
  await control.recordRemoteChangeOutcome({ ...input, result: last });
  return { outcome: 'recorded', attempts, result: last };
}

function proxies(providerKey: string) {
  return {
    provider: proxyActivities<RemoteChangeProviderActivitiesV1>({
      taskQueue: `publish-${providerKey}`,
      startToCloseTimeout: '5 minutes',
      heartbeatTimeout: '2 minutes',
      retry: { maximumAttempts: 1 }, // the workflow owns the retries (bounded, with backoff)
    }),
    control: proxyActivities<RemoteChangeControlActivitiesV1>({
      startToCloseTimeout: '1 minute',
      retry: { maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES }, // idempotent
    }),
  };
}

const temporalHost: RemoteChangeHost = { sleep: (ms) => sleep(ms) };

export async function publicationRemoteDeleteWorkflowV1(
  input: PublicationRemoteChangeInputV1,
): Promise<RemoteChangeOutcomeV1> {
  const { provider, control } = proxies(input.providerKey);
  return runRemoteChange('delete', provider, control, input, temporalHost);
}

export async function publicationRemoteEditWorkflowV1(
  input: PublicationRemoteChangeInputV1,
): Promise<RemoteChangeOutcomeV1> {
  const { provider, control } = proxies(input.providerKey);
  return runRemoteChange('edit', provider, control, input, temporalHost);
}
