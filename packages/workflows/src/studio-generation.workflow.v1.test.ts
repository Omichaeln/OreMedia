import { describe, expect, it } from 'vitest';
import type {
  StudioGenerationActivitiesV1,
  StudioGenerationFailInputV1,
  StudioGenerationInputV1,
} from '@oremedia/contracts/generation';
import {
  generationFailureCode,
  runStudioGeneration,
  type StudioGenerationHost,
} from './studio-generation.workflow.v1';

const input: StudioGenerationInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_gen',
  jobId: 'sgj_1',
  attempt: 1,
};

/** An activity failure as the workflow sees it: ActivityFailure → ApplicationFailure with a `type`. */
const activityFailure = (type: string | null, message = 'activity failed') =>
  Object.assign(new Error('activity failed'), {
    name: 'ActivityFailure',
    cause: Object.assign(new Error(message), { name: 'ApplicationFailure', type }),
  });

function fakes(
  overrides: Partial<StudioGenerationActivitiesV1> = {},
  cancelAfter?: keyof StudioGenerationActivitiesV1,
) {
  const calls: string[] = [];
  const failures: StudioGenerationFailInputV1[] = [];
  let cancelled = false;
  const track = <K extends keyof StudioGenerationActivitiesV1>(
    name: K,
    fn: StudioGenerationActivitiesV1[K],
  ) =>
    (async (i: never) => {
      calls.push(name);
      const out = await (fn as (i: never) => Promise<unknown>)(i);
      if (cancelAfter === name) cancelled = true;
      return out;
    }) as StudioGenerationActivitiesV1[K];
  const base: StudioGenerationActivitiesV1 = {
    beginGeneration: async () => ({ proceed: true }),
    reserveGenerationBudget: async () => ({ proceed: true }),
    callGenerationModel: async () => ({ proceed: true }),
    saveGeneration: async (i) => ({ jobId: i.jobId, state: 'completed' }),
    failGeneration: async (i) => {
      failures.push(i);
      return { jobId: i.jobId, state: 'failed' };
    },
    settleGenerationBudget: async () => undefined,
    ...overrides,
  };
  const acts = Object.fromEntries(
    Object.entries(base).map(([k, fn]) => [k, track(k as keyof StudioGenerationActivitiesV1, fn as never)]),
  ) as unknown as StudioGenerationActivitiesV1;
  const host: StudioGenerationHost = { cancelled: () => cancelled, nonCancellable: (fn) => fn() };
  return { acts, host, calls, failures };
}

describe('studioGenerationWorkflowV1 orchestration', () => {
  it('begins, reserves before the model call, saves last, and always settles', async () => {
    const f = fakes();
    expect(await runStudioGeneration(f.acts, input, f.host)).toEqual({ jobId: 'sgj_1', state: 'completed' });
    expect(f.calls).toEqual([
      'beginGeneration',
      'reserveGenerationBudget',
      'callGenerationModel',
      'saveGeneration',
      'settleGenerationBudget',
    ]);
  });

  it('a cancel signal stops between steps: nothing is saved, the reservation is settled', async () => {
    const f = fakes({}, 'callGenerationModel');
    expect(await runStudioGeneration(f.acts, input, f.host)).toEqual({ jobId: 'sgj_1', state: 'stopped' });
    expect(f.calls).not.toContain('saveGeneration');
    expect(f.calls.at(-1)).toBe('settleGenerationBudget');
  });

  it('an attempt the job no longer runs (cancelled in the database, superseded) stops without failing it', async () => {
    const f = fakes({ beginGeneration: async () => ({ proceed: false, reason: 'cancelled' }) });
    expect((await runStudioGeneration(f.acts, input, f.host)).state).toBe('stopped');
    expect(f.calls).toEqual(['beginGeneration', 'settleGenerationBudget']);
    expect(f.failures).toEqual([]);
  });

  it('maps failures to job codes by type and phase', async () => {
    const budget = fakes({
      reserveGenerationBudget: async () => {
        throw activityFailure('BudgetExhausted');
      },
    });
    await runStudioGeneration(budget.acts, input, budget.host);
    expect(budget.failures.map((x) => x.code)).toEqual(['budget_exhausted']);
    expect(budget.calls).not.toContain('callGenerationModel');

    const provider = fakes({
      callGenerationModel: async () => {
        throw activityFailure(null, 'upstream 503');
      },
    });
    await runStudioGeneration(provider.acts, input, provider.host);
    expect(provider.failures[0]).toMatchObject({ code: 'model_failed', detail: 'upstream 503' });

    const invalid = fakes({
      saveGeneration: async () => {
        throw activityFailure('ValidationFailed', 'stale_document');
      },
    });
    await runStudioGeneration(invalid.acts, input, invalid.host);
    expect(invalid.failures[0]).toMatchObject({ code: 'validation_failed', detail: 'stale_document' });
    expect(invalid.calls.at(-1)).toBe('settleGenerationBudget');
  });

  it('failure codes', () => {
    expect(generationFailureCode(activityFailure('PolicyDenied'), 'save')).toBe('policy_denied');
    expect(generationFailureCode(new Error('x'), 'save')).toBe('failed');
    expect(generationFailureCode(new Error('x'), 'model')).toBe('model_failed');
  });
});
