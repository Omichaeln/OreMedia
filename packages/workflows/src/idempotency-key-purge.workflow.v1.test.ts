import { describe, expect, it } from 'vitest';
import type { IdempotencyKeyPurgeActivitiesV1 } from '@oremedia/contracts/operations';
import { runIdempotencyKeyPurge } from './idempotency-key-purge.workflow.v1';

describe('idempotencyKeyPurgeWorkflowV1 orchestration (spec 7.3)', () => {
  it('purges once with the schedule time and correlation id, returning the rows removed', async () => {
    const seen: unknown[] = [];
    const acts: IdempotencyKeyPurgeActivitiesV1 = {
      purgeExpiredIdempotencyKeys: async (input) => {
        seen.push(input);
        return { rows: 5 };
      },
    };
    const input = { correlationId: 'c', now: '2026-10-03T12:00:00.000Z' };
    expect(await runIdempotencyKeyPurge(acts, input)).toEqual({ rows: 5 });
    expect(seen).toEqual([input]);
  });
});
