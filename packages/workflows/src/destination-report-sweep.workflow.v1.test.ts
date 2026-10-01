import { describe, expect, it } from 'vitest';
import type {
  DestinationReportFetchInputV1,
  DestinationReportFinishInputV1,
  DestinationReportSweepActivitiesV1,
  DestinationReportsActivitiesV1,
  DestinationReportsInputV1,
} from '@oremedia/contracts/destinations';
import {
  DESTINATION_REPORTS_ACTOR,
  destinationReportsWorkflowId,
  runDestinationReportSweep,
  runDestinationReports,
} from './destination-report-sweep.workflow.v1';

const input: DestinationReportsInputV1 = {
  tenantId: 'ten_a',
  actor: DESTINATION_REPORTS_ACTOR,
  correlationId: 'c:dst_1',
  destinationId: 'dst_1',
  now: '2026-09-29T04:00:00.000Z',
};
const planned = [
  { reportKey: 'ga4.acquisition', start: '2026-09-01', end: '2026-09-28' },
  { reportKey: 'ga4.landing_pages', start: '2026-09-01', end: '2026-09-28' },
  { reportKey: 'ga4.engagement', start: '2026-09-26', end: '2026-09-28' },
];

function fakes(overrides: Partial<DestinationReportsActivitiesV1> = {}) {
  const fetched: DestinationReportFetchInputV1[] = [];
  const finished: DestinationReportFinishInputV1[] = [];
  const pruned: string[] = [];
  const acts: DestinationReportsActivitiesV1 = {
    planDestinationReports: async () => ({ outcome: 'planned', reports: planned }),
    fetchDestinationReport: async (i) => {
      fetched.push(i);
      return { outcome: 'fetched', rows: 10, days: 5 };
    },
    finishDestinationReports: async (i) => {
      finished.push(i);
      return { health: i.health };
    },
    pruneDestinationReports: async (i) => {
      pruned.push(i.destinationId);
      return { deleted: 2, cutoff: '2026-09-22' };
    },
    ...overrides,
  };
  return { acts, fetched, finished, pruned };
}

describe('destinationReportsWorkflowV1 orchestration (ledger R2-1 part B)', () => {
  it('fetches every planned range in order, records healthy with the counts, then prunes', async () => {
    const f = fakes();
    expect(await runDestinationReports(f.acts, input)).toEqual({
      outcome: 'fetched',
      reason: null,
      reports: 3,
      rows: 30,
      pruned: 2,
    });
    expect(f.fetched.map((i) => [i.reportKey, i.start, i.end])).toEqual(
      planned.map((p) => [p.reportKey, p.start, p.end]),
    );
    expect(f.finished).toEqual([
      {
        ...input,
        health: 'healthy',
        fetched: planned.map((p) => ({ reportKey: p.reportKey, rows: 10 })),
        reason: null,
      },
    ]);
    expect(f.pruned).toEqual(['dst_1']);
  });

  it('a policy or lock refusal ends the run before any read, with nothing finished or pruned', async () => {
    const f = fakes({ planDestinationReports: async () => ({ outcome: 'skipped', reason: 'no_policy' }) });
    expect(await runDestinationReports(f.acts, input)).toEqual({
      outcome: 'skipped',
      reason: 'no_policy',
      reports: 0,
      rows: 0,
      pruned: 0,
    });
    expect(f.fetched).toEqual([]);
    expect(f.finished).toEqual([]);
    expect(f.pruned).toEqual([]);
  });

  it('a quota 429 stops the reads there (never a tight retry), records degraded and still prunes', async () => {
    const f = fakes({
      fetchDestinationReport: async (i) => {
        f.fetched.push(i);
        return i.reportKey === 'ga4.landing_pages'
          ? { outcome: 'rate_limited', retryAfterMs: 60_000 }
          : { outcome: 'fetched', rows: 4, days: 2 };
      },
    });
    expect(await runDestinationReports(f.acts, input)).toEqual({
      outcome: 'degraded',
      reason: 'rate_limited',
      reports: 1,
      rows: 4,
      pruned: 2,
    });
    expect(f.fetched.map((i) => i.reportKey)).toEqual(['ga4.acquisition', 'ga4.landing_pages']);
    expect(f.finished[0]).toMatchObject({
      health: 'degraded',
      reason: 'rate_limited',
      fetched: [{ reportKey: 'ga4.acquisition', rows: 4 }],
    });
  });

  it('a revoked grant records unreachable; a failed activity (after the host retried) records degraded', async () => {
    const revoked = fakes({
      fetchDestinationReport: async () => ({ outcome: 'unreachable', reason: 'reconnect_required' }),
    });
    expect(await runDestinationReports(revoked.acts, input)).toMatchObject({
      outcome: 'unreachable',
      reason: 'reconnect_required',
      reports: 0,
    });
    expect(revoked.finished[0]?.health).toBe('unreachable');
    const failing = fakes({
      fetchDestinationReport: async () => {
        throw new Error('PolicyDenied');
      },
    });
    expect(await runDestinationReports(failing.acts, input)).toMatchObject({
      outcome: 'degraded',
      reason: 'activity_failed:ga4.acquisition',
    });
    expect(failing.finished[0]?.health).toBe('degraded');
  });

  it('a prune failure never fails the read', async () => {
    const f = fakes({
      pruneDestinationReports: async () => {
        throw new Error('ValidationFailed');
      },
    });
    expect(await runDestinationReports(f.acts, input)).toMatchObject({ outcome: 'fetched', pruned: 0 });
  });
});

describe('destinationReportSweepWorkflowV1 orchestration', () => {
  const sweep = { correlationId: 'sweep', now: '2026-09-29T04:00:00.000Z' };
  const acts: DestinationReportSweepActivitiesV1 = {
    listDestinationReportTargets: async () => [
      { tenantId: 'ten_a', destinationId: 'dst_1' },
      { tenantId: 'ten_b', destinationId: 'dst_2' },
      { tenantId: 'ten_b', destinationId: 'dst_3' },
    ],
  };

  it('starts one child per target with a deterministic daily id, as the platform actor, in its own tenant', async () => {
    const started: Array<[string, DestinationReportsInputV1]> = [];
    const outcome = await runDestinationReportSweep(acts, sweep, {
      startReports: async (child, workflowId) => {
        started.push([workflowId, child]);
      },
    });
    expect(outcome).toEqual({ targets: 3, started: 3, alreadyStarted: 0, failed: 0 });
    expect(started.map(([id]) => id)).toEqual([
      'destination-reports:dst_1:2026-09-29',
      'destination-reports:dst_2:2026-09-29',
      'destination-reports:dst_3:2026-09-29',
    ]);
    expect(started.map(([, c]) => [c.tenantId, c.destinationId, c.correlationId, c.now])).toEqual([
      ['ten_a', 'dst_1', 'sweep:dst_1', sweep.now],
      ['ten_b', 'dst_2', 'sweep:dst_2', sweep.now],
      ['ten_b', 'dst_3', 'sweep:dst_3', sweep.now],
    ]);
    expect(started.every(([, c]) => c.actor.kind === DESTINATION_REPORTS_ACTOR.kind)).toBe(true);
    expect(destinationReportsWorkflowId('dst_9', '2026-10-01T04:00:00.000Z')).toBe(
      'destination-reports:dst_9:2026-10-01',
    );
  });

  it('a child that already ran today is joined, a failed start never blocks the others', async () => {
    const outcome = await runDestinationReportSweep(acts, sweep, {
      startReports: async (child) => {
        if (child.destinationId === 'dst_1')
          throw Object.assign(new Error('started'), { name: 'WorkflowExecutionAlreadyStartedError' });
        if (child.destinationId === 'dst_2') throw new Error('boom');
      },
    });
    expect(outcome).toEqual({ targets: 3, started: 1, alreadyStarted: 1, failed: 1 });
  });
});
