import type {
  CommunityReplyControlActivitiesV1,
  CommunityReplyProviderActivitiesV1,
  ReplySendResultV1,
} from '@oremedia/contracts/community';
import type { PendingCheck, ReconcileResult, RemoteMutationOutcome } from '@oremedia/contracts/providers';
import type {
  AttemptResult,
  ClaimResultV1,
  PublicationState,
  PublishControlActivitiesV1,
  PublishProviderActivitiesV1,
  ReleaseEvaluationResultV1,
  RemoteChangeAttemptResultV1,
  RemoteChangeControlActivitiesV1,
  RemoteChangeProviderActivitiesV1,
  RetryResultV1,
  TransitionResultV1,
} from '@oremedia/contracts/publishing';
import { LONG_AGO, next, nonRetryable, tenant, type Recorder, type RecordingCase } from './types';

/**
 * Task queue `core` with the provider's activity queue `publish-replay_provider`: the publication workflow and its
 * reconcile and signal relay, remote edits and deletes, and comment replies. Each case is one representative
 * execution; see ./types.ts.
 */
const PROVIDER = 'replay_provider';
const PROVIDER_QUEUE = `publish-${PROVIDER}`;
const DAY_MS = 86_400_000;

const ok = (state: PublicationState): TransitionResultV1 => ({ state, version: 2, changed: true });

interface PublicationScript {
  /** Called on every readSchedule; may change between reads (a reschedule). */
  schedule?: () => { state?: PublicationState; scheduledFor: string };
  claim?: ClaimResultV1;
  release?: ReleaseEvaluationResultV1;
  /** One entry per publishOnce; `throw` is an activity failure (a timeout or a lost worker). */
  publish?: Array<Omit<AttemptResult, 'attemptId'> | 'throw'>;
  check?: PendingCheck[];
  finalize?: PendingCheck;
  find?: ReconcileResult[];
  retry?: RetryResultV1[];
}

function publication(rec: Recorder, s: PublicationScript) {
  const publish = [...(s.publish ?? [{ outcome: 'accepted', remotePostId: 'post_replay_1' }])];
  const check = [...(s.check ?? [{ status: 'ready' as const }])];
  const find = [...(s.find ?? [{ status: 'cannot_determine' as const, reason: 'replay fixture' }])];
  const retry = [...(s.retry ?? [{ retried: false as const, reason: 'state' as const }])];
  const control: PublishControlActivitiesV1 = {
    readSchedule: async () => {
      const { state, scheduledFor } = s.schedule?.() ?? { scheduledFor: LONG_AGO };
      return { state: state ?? 'scheduled', scheduledFor, version: 1 };
    },
    cancelIfNotStarted: async () => ok('cancelled'),
    claimForDispatch: async () =>
      s.claim ?? { ok: true, fencingToken: 1, providerKey: PROVIDER, channelConnectionId: 'cc_replay_1' },
    evaluateRelease: async () => s.release ?? { allow: true },
    hold: async () => ok('held'),
    releaseClaimAndCancel: async () => ok('cancelled'),
    openAttempt: async () => 'att_replay_1',
    markProcessing: async () => ok('processing'),
    markPublished: async () => ok('published'),
    markFailed: async () => ok('failed'),
    markOutcomeUnknown: async () => ok('outcome_unknown'),
    markRetryEligible: async () => ok('retry_eligible'),
    holdForHuman: async () => ok('held'),
    retryAfterProvenNoEffect: async () => next(retry),
  };
  const provider: PublishProviderActivitiesV1 = {
    publishOnce: async (i) => {
      const r = next(publish);
      if (r === 'throw') throw new Error('provider call timed out (replay fixture)');
      return { attemptId: i.attemptId, ...r };
    },
    checkStatus: async () => next(check),
    finalize: async () =>
      s.finalize ?? {
        status: 'completed',
        remotePostId: 'post_replay_1',
        remoteUrl: 'https://social.example/p/1',
      },
    findRemotePost: async () => next(find),
  };
  return { core: rec(control), [PROVIDER_QUEUE]: rec(provider) };
}

/** A schedule that is fixed relative to the first read (the time the case runs). */
const dueIn = (ms: number) => {
  let at: string | undefined;
  return () => ({ scheduledFor: (at ??= new Date(Date.now() + ms).toISOString()) });
};

let pubSeq = 0;
const pubInput = (n = ++pubSeq) => ({
  ...tenant(1, `corr_replay_pub_${n}`),
  publicationId: `pub_replay_${n}`,
});
const pubCase = (
  name: string,
  description: string,
  script: PublicationScript,
  extra: Partial<RecordingCase> = {},
): RecordingCase => {
  const input = pubInput();
  return {
    workflowType: 'publicationWorkflowV1',
    name,
    description,
    queue: 'core',
    activities: (rec) => publication(rec, script),
    args: [input],
    workflowId: `pub:${input.publicationId}`,
    state: 'completed',
    ...extra,
  };
};

/** A rescheduled row: the next read after the signal returns the earlier time. */
const reschedulable = () => {
  const row = { scheduledFor: '' };
  return {
    row,
    schedule: () => ({ scheduledFor: (row.scheduledFor ||= new Date(Date.now() + DAY_MS).toISOString()) }),
  };
};
const rescheduled = reschedulable();

const relayTarget =
  (n: number): RecordingCase['before'] =>
  async (ctx) => {
    const input = { ...tenant(1, `corr_replay_relay_${n}`), publicationId: `pub_replay_relay_${n}` };
    const target = await ctx.start('publicationWorkflowV1', [input], `pub:${input.publicationId}`);
    await ctx.untilEvent(target, 'TIMER_STARTED');
  };

const remote = (results: Array<RemoteChangeAttemptResultV1 | Error>) => {
  const queue = [...results];
  const call = async () => {
    const r = next(queue);
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    provider: { deleteRemotePost: call, editRemotePost: call } satisfies RemoteChangeProviderActivitiesV1,
    control: {
      recordRemoteChangeOutcome: async (i) => ({
        state: i.result.outcome === 'done' || i.result.outcome === 'already_absent' ? 'succeeded' : 'failed',
        publicationState: 'published',
        changed: true,
      }),
    } satisfies RemoteChangeControlActivitiesV1,
  };
};
const done: RemoteMutationOutcome = { outcome: 'done' };
const retryable: RemoteMutationOutcome = {
  outcome: 'retryable_error',
  code: 'rate_limited',
  message: 'slow down',
};
const remoteCase = (
  workflowType: 'publicationRemoteDeleteWorkflowV1' | 'publicationRemoteEditWorkflowV1',
  name: string,
  description: string,
  results: Array<RemoteChangeAttemptResultV1 | Error>,
  n: number,
  state: RecordingCase['state'] = 'completed',
): RecordingCase => ({
  workflowType,
  name,
  description,
  queue: 'core',
  activities: (rec) => {
    const r = remote(results);
    return { core: rec(r.control), [PROVIDER_QUEUE]: rec(r.provider) };
  },
  args: [
    {
      ...tenant(1, `corr_replay_rc_${n}`),
      publicationId: `pub_replay_rc_${n}`,
      changeId: `rc_replay_${n}`,
      providerKey: PROVIDER,
    },
  ],
  workflowId: `remote-change:rc_replay_${n}`,
  state,
});

const reply = (route: string | null, results: Array<ReplySendResultV1 | Error>) => {
  const queue = [...results];
  return {
    control: {
      readReplyRoute: async () => ({ providerKey: route }),
      recordReplyOutcome: async (i) => ({
        state:
          i.result.outcome === 'accepted'
            ? 'sent'
            : i.result.outcome === 'unknown'
              ? 'outcome_unknown'
              : 'failed',
        messageId: i.result.outcome === 'accepted' ? 'msg_replay_2' : null,
        changed: true,
      }),
    } satisfies CommunityReplyControlActivitiesV1,
    provider: {
      sendReplyOnce: async () => {
        const r = next(queue);
        if (r instanceof Error) throw r;
        return r;
      },
    } satisfies CommunityReplyProviderActivitiesV1,
  };
};
const replyCase = (
  name: string,
  description: string,
  route: string | null,
  results: Array<ReplySendResultV1 | Error>,
  n: number,
  state: RecordingCase['state'] = 'completed',
): RecordingCase => ({
  workflowType: 'communityReplyWorkflowV1',
  name,
  description,
  queue: 'core',
  activities: (rec) => {
    const r = reply(route, results);
    return { core: rec(r.control), [PROVIDER_QUEUE]: rec(r.provider) };
  },
  args: [{ ...tenant(1, `corr_replay_reply_${n}`), responseDraftId: `rd_replay_${n}` }],
  workflowId: `reply:rd_replay_${n}`,
  state,
});

const reconcileInput = (n: number) => ({
  ...tenant(1, `corr_replay_rec_${n}`),
  publicationId: `pub_replay_rec_${n}`,
  attemptId: `att_replay_rec_${n}`,
  providerKey: PROVIDER,
});

export const corePublishingCases: RecordingCase[] = [
  pubCase('published-immediately', 'Due already: claimed, released, sent once and accepted.', {}),
  pubCase(
    'published-after-wait',
    'Due in a few seconds: a durable wait (timer), the row re-read, then published.',
    {
      schedule: dueIn(4_000),
    },
  ),
  pubCase(
    'cancelled-during-wait',
    'A cancel signal during the wait cancels before any claim; nothing is sent.',
    { schedule: dueIn(DAY_MS) },
    {
      drive: async (h, ctx) => {
        await ctx.untilEvent(h, 'TIMER_STARTED');
        await h.signal('cancelSignal');
      },
    },
  ),
  pubCase(
    'rescheduled-during-wait',
    'A reschedule to an earlier time wakes the wait (signal); the row is re-read and it publishes then.',
    { schedule: rescheduled.schedule },
    {
      drive: async (h, ctx) => {
        await ctx.untilEvent(h, 'TIMER_STARTED');
        rescheduled.row.scheduledFor = LONG_AGO;
        await h.signal('rescheduleSignal');
      },
    },
  ),
  pubCase(
    'waiting-open',
    'In flight: scheduled a day ahead, the workflow waits on its re-read timer.',
    { schedule: dueIn(DAY_MS) },
    { state: 'open' },
  ),
  pubCase('not-scheduled', 'The row is no longer scheduled when the workflow reads it: nothing to do.', {
    schedule: () => ({ state: 'cancelled', scheduledFor: LONG_AGO }),
  }),
  pubCase('claim-refused', 'Another claimant already took the row: the claim is refused and the run ends.', {
    claim: { ok: false, state: 'dispatching' },
  }),
  pubCase('held-by-release-gate', 'The release gate refuses (a stale approval): the publication is held.', {
    release: { allow: false, reasons: ['approval_stale'] },
  }),
  pubCase('rejected', 'The platform rejects the post definitively: marked failed.', {
    publish: [{ outcome: 'rejected', errorCode: 'content_policy', errorDetail: 'refused (replay fixture)' }],
  }),
  pubCase('pending-finalized', 'An asynchronous publish: processing, ready, finalised once and published.', {
    publish: [{ outcome: 'pending', remoteJobId: 'job_replay_1' }],
  }),
  pubCase(
    'pending-polled-then-failed',
    'An asynchronous publish polled after its 15 s timer, then failed remotely.',
    {
      publish: [{ outcome: 'pending', remoteJobId: 'job_replay_2' }],
      check: [
        { status: 'processing' },
        { status: 'failed', code: 'media_invalid', message: 'bad media (replay fixture)' },
      ],
    },
  ),
  pubCase(
    'retryable-retried-then-published',
    'A pre-send retryable error proven to have no effect: back to scheduled, the loop claims again and publishes.',
    {
      publish: [
        { outcome: 'retryable_error', errorCode: 'rate_limited' },
        { outcome: 'accepted', remotePostId: 'post_replay_2' },
      ],
      retry: [{ retried: true, scheduledFor: LONG_AGO }],
    },
  ),
  pubCase(
    'unknown-reconciling-open',
    'In flight: the send failed with an unknown outcome; marked outcome_unknown, waiting on the first reconcile delay.',
    { publish: ['throw'] },
    { state: 'open' },
  ),
  {
    workflowType: 'publicationReconcileWorkflowV1',
    name: 'waiting-open',
    description: 'In flight: reconciliation started by the sweeper, waiting on the first one-minute delay.',
    queue: 'core',
    activities: (rec) => publication(rec, {}),
    args: [reconcileInput(1)],
    workflowId: 'reconcile:pub_replay_rec_1',
    state: 'open',
  },
  {
    workflowType: 'publicationReconcileWorkflowV1',
    name: 'found-after-first-delay',
    description: 'After the one-minute delay the post is found remotely: outcome_unknown → published.',
    queue: 'core',
    activities: (rec) =>
      publication(rec, {
        find: [
          {
            status: 'found',
            remotePostId: 'post_replay_3',
            remoteUrl: 'https://social.example/p/3',
            matchedBy: 'fingerprint',
          },
        ],
      }),
    args: [reconcileInput(2)],
    workflowId: 'reconcile:pub_replay_rec_2',
    state: 'completed',
  },
  {
    workflowType: 'publicationReconcileWorkflowV1',
    name: 'absent-after-first-delay',
    description:
      'After the one-minute delay the post is definitely absent: outcome_unknown → retry_eligible.',
    queue: 'core',
    activities: (rec) => publication(rec, { find: [{ status: 'definitely_absent' }] }),
    args: [reconcileInput(3)],
    workflowId: 'reconcile:pub_replay_rec_3',
    state: 'completed',
  },
  {
    workflowType: 'publicationSignalRelayV1',
    name: 'relay-cancel',
    description: 'The outbox relays a cancel to a waiting publication workflow (external signal).',
    queue: 'core',
    activities: (rec) => publication(rec, { schedule: dueIn(DAY_MS) }),
    before: relayTarget(1),
    args: [{ workflowId: 'pub:pub_replay_relay_1', signal: 'cancel' }],
    workflowId: 'publication-signal-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'publicationSignalRelayV1',
    name: 'relay-reschedule',
    description: 'The outbox relays a reschedule to a waiting publication workflow (external signal).',
    queue: 'core',
    activities: (rec) => publication(rec, { schedule: dueIn(DAY_MS) }),
    before: relayTarget(2),
    args: [{ workflowId: 'pub:pub_replay_relay_2', signal: 'reschedule' }],
    workflowId: 'publication-signal-replay-2',
    state: 'completed',
  },
  remoteCase(
    'publicationRemoteDeleteWorkflowV1',
    'done',
    'The post is deleted on the first call; the outcome is recorded.',
    [done],
    1,
  ),
  remoteCase(
    'publicationRemoteDeleteWorkflowV1',
    'skipped',
    'The change is no longer requested: skipped, nothing sent or recorded.',
    [{ outcome: 'skipped', reason: 'not_requested' }],
    2,
  ),
  remoteCase(
    'publicationRemoteDeleteWorkflowV1',
    'retryable-backoff-open',
    'In flight: a retryable error, the workflow waits on its 30 s backoff timer.',
    [retryable],
    3,
    'open',
  ),
  remoteCase(
    'publicationRemoteEditWorkflowV1',
    'done',
    'The edit lands on the first call; the outcome is recorded.',
    [done],
    4,
  ),
  remoteCase(
    'publicationRemoteEditWorkflowV1',
    'activity-rejected',
    'The provider activity fails non-retryably (ValidationFailed): recorded as rejected.',
    [nonRetryable('ValidationFailed')],
    5,
  ),
  remoteCase(
    'publicationRemoteEditWorkflowV1',
    'retryable-then-done',
    'A retryable error, the 30 s backoff timer, then the edit lands.',
    [retryable, done],
    6,
  ),
  replyCase(
    'accepted',
    'The reply is sent on the provider queue and recorded as sent.',
    PROVIDER,
    [{ outcome: 'accepted', remoteMessageId: 'rm_replay_1', remoteUrl: null }],
    1,
  ),
  replyCase(
    'unsupported-channel',
    'The channel cannot reply: nothing is sent, rejected is recorded.',
    null,
    [],
    2,
  ),
  replyCase(
    'send-failed-unknown',
    'The send activity fails (a lost worker): recorded as an unknown outcome, never sent again.',
    PROVIDER,
    [new Error('worker lost (replay fixture)')],
    3,
  ),
  replyCase(
    'retryable-backoff-open',
    'In flight: a pre-send retryable error, the workflow waits on its 30 s backoff timer.',
    PROVIDER,
    [{ outcome: 'retryable_error', code: 'rate_limited', message: 'slow down' }],
    4,
    'open',
  ),
];
