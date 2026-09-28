import { describe, expect, it } from 'vitest';
import type {
  CommunityReplyControlActivitiesV1,
  RecordReplyOutcomeInputV1,
  ReplySendResultV1,
} from '@oremedia/contracts/community';
import { MAX_SEND_ATTEMPTS, PRE_SEND_BACKOFF_MS, runCommunityReply } from './community-reply.workflow.v1';

const input = {
  tenantId: 'ten_A',
  actor: { kind: 'user' as const, id: 'usr_1' },
  correlationId: 'c',
  responseDraftId: 'rdft_1',
};

function fakes(sends: Array<ReplySendResultV1 | Error>, providerKey: string | null = 'fixture_provider') {
  const recorded: RecordReplyOutcomeInputV1[] = [];
  const sleeps: number[] = [];
  const queues: string[] = [];
  let calls = 0;
  const control: CommunityReplyControlActivitiesV1 = {
    readReplyRoute: async () => ({ providerKey }),
    recordReplyOutcome: async (i) => {
      recorded.push(i);
      const state =
        i.result.outcome === 'accepted'
          ? 'sent'
          : i.result.outcome === 'unknown'
            ? 'outcome_unknown'
            : 'failed';
      return { state, messageId: state === 'sent' ? 'msg_out' : null, changed: true };
    },
  };
  const host = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    providerActivities: (key: string) => {
      queues.push(`publish-${key}`);
      return {
        sendReplyOnce: async () => {
          const next = sends[Math.min(calls++, sends.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        },
      };
    },
  };
  return { control, host, recorded, sleeps, queues, sent: () => calls };
}

const accepted: ReplySendResultV1 = { outcome: 'accepted', remoteMessageId: 'c_9', remoteUrl: null };
const preSend: ReplySendResultV1 = { outcome: 'retryable_error', code: 'pre_send', message: 'x' };

describe('communityReplyWorkflowV1 (comment inbox reply)', () => {
  it('sends once on the provider queue and records the accepted reply', async () => {
    const f = fakes([accepted]);
    expect(await runCommunityReply(f.control, input, f.host)).toEqual({
      state: 'sent',
      messageId: 'msg_out',
      changed: true,
    });
    expect(f.queues).toEqual(['publish-fixture_provider']);
    expect(f.sent()).toBe(1);
    expect(f.recorded).toEqual([{ ...input, result: accepted }]);
  });

  it('a rejection or an unknown outcome is recorded as it is, never sent again', async () => {
    for (const result of [
      { outcome: 'rejected', code: 'validation', message: 'too long' } as const,
      { outcome: 'unknown', code: 'transport_after_send', message: 'reset' } as const,
    ]) {
      const f = fakes([result, accepted]);
      await runCommunityReply(f.control, input, f.host);
      expect(f.sent()).toBe(1);
      expect(f.recorded[0]!.result).toEqual(result);
    }
  });

  it('a lost worker or a timeout is an unknown outcome (the activity is never retried)', async () => {
    const f = fakes([new Error('activity timed out'), accepted]);
    await runCommunityReply(f.control, input, f.host);
    expect(f.sent()).toBe(1);
    expect(f.recorded[0]!.result).toMatchObject({ outcome: 'unknown', code: 'activity_failed' });
  });

  it('a failure proven before the send boundary is retried with backoff, then recorded when exhausted', async () => {
    const f = fakes([preSend, { ...preSend, retryAfterMs: 90_000 }, accepted]);
    await runCommunityReply(f.control, input, f.host);
    expect(f.sent()).toBe(3);
    expect(f.sleeps).toEqual([PRE_SEND_BACKOFF_MS[0], Math.max(PRE_SEND_BACKOFF_MS[1], 90_000)]);
    expect(f.recorded[0]!.result).toEqual(accepted);

    const g = fakes([preSend]);
    await runCommunityReply(g.control, input, g.host);
    expect(g.sent()).toBe(MAX_SEND_ATTEMPTS);
    expect(g.sleeps).toHaveLength(MAX_SEND_ATTEMPTS - 1);
    expect(g.recorded[0]!.result).toEqual(preSend);
  });

  it('a channel that cannot reply is recorded as failed without any provider call', async () => {
    const f = fakes([accepted], null);
    await runCommunityReply(f.control, input, f.host);
    expect(f.queues).toEqual([]);
    expect(f.recorded[0]!.result).toMatchObject({ outcome: 'rejected', code: 'comments_reply_unsupported' });
  });
});
