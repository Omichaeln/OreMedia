import { describe, expect, it } from 'vitest';
import type {
  DestinationRefreshActivitiesV1,
  DestinationRefreshInputV1,
} from '@oremedia/contracts/destinations';
import {
  DESTINATION_REFRESH_ACTOR,
  runDestinationTokenRefresh,
} from './destination-token-refresh.workflow.v1';

describe('destinationTokenRefreshWorkflowV1 orchestration (ledger R2-1)', () => {
  const input = { correlationId: 'c', now: '2026-10-01T03:10:00.000Z', withinHours: 24 };

  it('lists the due destinations once and refreshes each in its own tenant as the platform actor', async () => {
    const seen: DestinationRefreshInputV1[] = [];
    const listed: unknown[] = [];
    const acts: DestinationRefreshActivitiesV1 = {
      listDueDestinationRefreshes: async (i) => {
        listed.push(i);
        return [
          { tenantId: 'ten_a', destinationId: 'dst_1' },
          { tenantId: 'ten_b', destinationId: 'dst_2' },
          { tenantId: 'ten_b', destinationId: 'dst_3' },
          { tenantId: 'ten_c', destinationId: 'dst_4' },
        ];
      },
      refreshDestinationCredential: async (i) => {
        seen.push(i);
        if (i.destinationId === 'dst_2') return { ok: false, reason: 'reconnect_required' };
        if (i.destinationId === 'dst_3') return { ok: false, reason: 'locked' };
        if (i.destinationId === 'dst_4') return { ok: false, reason: 'transient' };
        return { ok: true, tokenExpiresAt: '2026-10-01T04:10:00.000Z' };
      },
    };
    expect(await runDestinationTokenRefresh(acts, input)).toEqual({
      due: 4,
      refreshed: 1,
      reconnectNeeded: 1,
      skipped: 1,
      failed: 1,
    });
    expect(listed).toEqual([input]);
    expect(seen.map((s) => [s.tenantId, s.destinationId])).toEqual([
      ['ten_a', 'dst_1'],
      ['ten_b', 'dst_2'],
      ['ten_b', 'dst_3'],
      ['ten_c', 'dst_4'],
    ]);
    expect(
      seen.every((s) => s.actor.kind === DESTINATION_REFRESH_ACTOR.kind && s.correlationId === 'c'),
    ).toBe(true);
  });

  it('one destination failing never blocks the others; nothing is retried in the same run', async () => {
    const calls: string[] = [];
    const acts: DestinationRefreshActivitiesV1 = {
      listDueDestinationRefreshes: async () => [
        { tenantId: 'ten_a', destinationId: 'dst_1' },
        { tenantId: 'ten_a', destinationId: 'dst_2' },
      ],
      refreshDestinationCredential: async (i) => {
        calls.push(i.destinationId);
        if (i.destinationId === 'dst_1') throw new Error('PolicyDenied');
        return { ok: true, tokenExpiresAt: null };
      },
    };
    expect(await runDestinationTokenRefresh(acts, input)).toEqual({
      due: 2,
      refreshed: 1,
      reconnectNeeded: 0,
      skipped: 0,
      failed: 1,
    });
    expect(calls).toEqual(['dst_1', 'dst_2']);
  });
});
