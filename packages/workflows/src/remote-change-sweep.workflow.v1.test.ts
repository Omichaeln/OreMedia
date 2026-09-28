import { describe, expect, it } from 'vitest';
import type { RemoteChangeSweepInputV1 } from '@oremedia/contracts/publishing';
import { runRemoteChangeSweep } from './remote-change-sweep.workflow.v1';

describe('remoteChangeSweepWorkflowV1', () => {
  it('runs one platform-level pass with the workflow clock and its own correlation id', async () => {
    const calls: RemoteChangeSweepInputV1[] = [];
    const result = await runRemoteChangeSweep(
      {
        sweepStaleRemoteChanges: async (i) => {
          calls.push(i);
          return { closed: 2 };
        },
      },
      { now: () => Date.parse('2026-09-28T10:00:00.000Z'), correlationId: 'remote-change-sweep:run-1' },
    );
    expect(result).toEqual({ closed: 2 });
    expect(calls).toEqual([{ correlationId: 'remote-change-sweep:run-1', now: '2026-09-28T10:00:00.000Z' }]);
  });
});
