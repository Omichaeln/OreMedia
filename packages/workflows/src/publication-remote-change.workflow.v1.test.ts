import { describe, expect, it } from 'vitest';
import type { RemoteMutationOutcome } from '@oremedia/contracts/providers';
import type {
  PublicationRemoteChangeInputV1,
  RecordRemoteChangeInputV1,
  RemoteChangeAttemptResultV1,
  RemoteChangeControlActivitiesV1,
  RemoteChangeProviderActivitiesV1,
} from '@oremedia/contracts/publishing';
import {
  REMOTE_CHANGE_BACKOFF_MAX_MS,
  REMOTE_CHANGE_MAX_ATTEMPTS,
  remoteChangeBackoffMs,
  runRemoteChange,
} from './publication-remote-change.workflow.v1';

const input: PublicationRemoteChangeInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'c',
  publicationId: 'pub_1',
  changeId: 'prc_1',
  providerKey: 'fixture_provider',
};

/** Scripted provider answers, one per call (the last repeats), and a recording control activity. */
function fakes(script: Array<RemoteChangeAttemptResultV1 | Error>) {
  const calls: string[] = [];
  const recorded: RecordRemoteChangeInputV1[] = [];
  const sleeps: number[] = [];
  const next = async (name: string): Promise<RemoteChangeAttemptResultV1> => {
    calls.push(name);
    const r = script.length > 1 ? script.shift()! : script[0]!;
    if (r instanceof Error) throw r;
    return r;
  };
  const provider: RemoteChangeProviderActivitiesV1 = {
    deleteRemotePost: () => next('deleteRemotePost'),
    editRemotePost: () => next('editRemotePost'),
  };
  const control: RemoteChangeControlActivitiesV1 = {
    recordRemoteChangeOutcome: async (i) => {
      recorded.push(i);
      return { state: 'succeeded', publicationState: 'published', changed: true };
    },
  };
  const host = { sleep: async (ms: number) => void sleeps.push(ms) };
  return { provider, control, host, calls, recorded, sleeps };
}

const retryable = (retryAfterMs?: number): RemoteMutationOutcome => ({
  outcome: 'retryable_error',
  code: 'rate_limited',
  message: 'slow down',
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});

describe('publicationRemoteDeleteWorkflowV1 / publicationRemoteEditWorkflowV1 orchestration', () => {
  it('delete: one platform call, the outcome recorded once', async () => {
    const f = fakes([{ outcome: 'done' }]);
    const out = await runRemoteChange('delete', f.provider, f.control, input, f.host);
    expect(out).toEqual({ outcome: 'recorded', attempts: 1, result: { outcome: 'done' } });
    expect(f.calls).toEqual(['deleteRemotePost']);
    expect(f.recorded).toEqual([{ ...input, result: { outcome: 'done' } }]);
  });

  it('a post that is already gone is recorded as such (a success)', async () => {
    const f = fakes([{ outcome: 'already_absent' }]);
    await runRemoteChange('delete', f.provider, f.control, input, f.host);
    expect(f.recorded[0]?.result).toEqual({ outcome: 'already_absent' });
  });

  it('edit calls editRemotePost; a rejection is final and recorded without a retry', async () => {
    const rejected: RemoteMutationOutcome = { outcome: 'rejected', code: 'meta_100', message: 'no' };
    const f = fakes([rejected]);
    const out = await runRemoteChange('edit', f.provider, f.control, input, f.host);
    expect(f.calls).toEqual(['editRemotePost']);
    expect(out.attempts).toBe(1);
    expect(f.recorded[0]?.result).toEqual(rejected);
    expect(f.sleeps).toEqual([]);
  });

  it('retries a retryable outcome with backoff (never below Retry-After), then records the success', async () => {
    const f = fakes([retryable(), retryable(90_000), { outcome: 'done' }]);
    const out = await runRemoteChange('delete', f.provider, f.control, input, f.host);
    expect(out).toMatchObject({ outcome: 'recorded', attempts: 3 });
    expect(f.sleeps).toEqual([30_000, 90_000]);
    expect(f.recorded).toHaveLength(1);
    expect(f.recorded[0]?.result).toEqual({ outcome: 'done' });
  });

  it('bounded: after the last attempt the retryable outcome is recorded as the failure', async () => {
    const f = fakes([retryable()]);
    const out = await runRemoteChange('edit', f.provider, f.control, input, f.host);
    expect(out.attempts).toBe(REMOTE_CHANGE_MAX_ATTEMPTS);
    expect(f.calls).toHaveLength(REMOTE_CHANGE_MAX_ATTEMPTS);
    expect(f.sleeps).toHaveLength(REMOTE_CHANGE_MAX_ATTEMPTS - 1);
    expect(f.recorded).toEqual([{ ...input, result: retryable() }]);
  });

  it('a change that is no longer requested is skipped: nothing is recorded', async () => {
    const f = fakes([{ outcome: 'skipped', reason: 'change_succeeded' }]);
    const out = await runRemoteChange('delete', f.provider, f.control, input, f.host);
    expect(out.outcome).toBe('skipped');
    expect(f.recorded).toEqual([]);
  });

  it('activity failures: a domain refusal is final, anything else is retried', async () => {
    const denied = Object.assign(new Error('activity failed'), {
      cause: { type: 'PolicyDenied', message: 'credential_destroyed' },
    });
    const a = fakes([denied]);
    await runRemoteChange('delete', a.provider, a.control, input, a.host);
    expect(a.calls).toHaveLength(1);
    expect(a.recorded[0]?.result).toEqual({
      outcome: 'rejected',
      code: 'PolicyDenied',
      message: 'credential_destroyed',
    });
    const b = fakes([new Error('worker lost'), { outcome: 'done' }]);
    await runRemoteChange('delete', b.provider, b.control, input, b.host);
    expect(b.calls).toHaveLength(2);
    expect(b.recorded[0]?.result).toEqual({ outcome: 'done' });
  });

  it('backoff doubles from 30 s and is capped', () => {
    expect([1, 2, 3, 4].map((n) => remoteChangeBackoffMs(n))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(remoteChangeBackoffMs(20)).toBe(REMOTE_CHANGE_BACKOFF_MAX_MS);
    expect(remoteChangeBackoffMs(1, 10 * 3600_000)).toBe(REMOTE_CHANGE_BACKOFF_MAX_MS);
  });
});
