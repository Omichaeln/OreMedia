import { describe, expect, it } from 'vitest';
import type { ConnectChoicePurgeActivitiesV1 } from '@oremedia/contracts/publishing';
import { runConnectChoicePurge } from './connect-choice-purge.workflow.v1';

describe('connectChoicePurgeWorkflowV1 orchestration (spec 14.7)', () => {
  it('purges once with the schedule time and correlation id, returning the rows removed', async () => {
    const seen: unknown[] = [];
    const acts: ConnectChoicePurgeActivitiesV1 = {
      purgeExpiredConnectChoices: async (input) => {
        seen.push(input);
        return { rows: 3 };
      },
    };
    const input = { correlationId: 'c', now: '2026-09-28T12:00:00.000Z' };
    expect(await runConnectChoicePurge(acts, input)).toEqual({ rows: 3 });
    expect(seen).toEqual([input]);
  });
});
