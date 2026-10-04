import { describe, expect, it } from 'vitest';
import type {
  StudioVideoJobActivitiesV1,
  StudioVideoJobInputV1,
  VideoJobStepOutcomeV1,
} from '@oremedia/contracts/video-ai';
import { runStudioVideoJob, videoJobFailureCode } from './studio-video.workflow.v1';

const input: StudioVideoJobInputV1 = {
  tenantId: 'ten_1',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_1',
  jobId: 'svj_1',
  attempt: 1,
};
const GO: VideoJobStepOutcomeV1 = { proceed: true };
const failure = (type: string) => Object.assign(new Error(`${type} happened`), { type });

function fakes(over: Partial<StudioVideoJobActivitiesV1> = {}) {
  const calls: string[] = [];
  const acts: StudioVideoJobActivitiesV1 = {
    beginVideoJob: async () => (calls.push('begin'), GO),
    reserveVideoJobBudget: async () => (calls.push('reserve'), GO),
    callVideoJobModel: async () => (calls.push('model'), GO),
    saveVideoJob: async () => (calls.push('save'), { jobId: 'svj_1', state: 'completed' }),
    failVideoJob: async (i) => (calls.push(`fail:${i.code}`), { jobId: 'svj_1', state: 'failed' }),
    settleVideoJobBudget: async () => {
      calls.push('settle');
    },
    ...over,
  };
  return { acts, calls };
}
const host = (cancelled = () => false) => ({ cancelled, nonCancellable: <T>(fn: () => Promise<T>) => fn() });

describe('studioVideoJobWorkflowV1 orchestration', () => {
  it('begins, reserves, calls the model once, saves and always settles', async () => {
    const f = fakes();
    expect(await runStudioVideoJob(f.acts, input, host())).toEqual({ jobId: 'svj_1', state: 'completed' });
    expect(f.calls).toEqual(['begin', 'reserve', 'model', 'save', 'settle']);
  });

  it('a budget refusal fails the job as budget_exhausted before any model call', async () => {
    const f = fakes({
      reserveVideoJobBudget: async () => {
        throw failure('BudgetExhausted');
      },
    });
    expect(await runStudioVideoJob(f.acts, input, host())).toMatchObject({ state: 'failed' });
    expect(f.calls).toEqual(['begin', 'fail:budget_exhausted', 'settle']);
  });

  it('a cancel between steps stops the attempt without saving', async () => {
    let cancelled = false;
    const f = fakes({
      callVideoJobModel: async () => {
        cancelled = true;
        return GO;
      },
    });
    expect(
      await runStudioVideoJob(
        f.acts,
        input,
        host(() => cancelled),
      ),
    ).toEqual({
      jobId: 'svj_1',
      state: 'stopped',
    });
    expect(f.calls).toEqual(['begin', 'reserve', 'settle']);
  });

  it('an attempt the job no longer runs (cancelled through the API) stops at once', async () => {
    const f = fakes({ beginVideoJob: async () => ({ proceed: false, reason: 'cancelled' }) });
    expect(await runStudioVideoJob(f.acts, input, host())).toMatchObject({ state: 'stopped' });
    expect(f.calls).toEqual(['settle']);
  });

  it('maps failures to job codes by type and phase', () => {
    expect(videoJobFailureCode(failure('PolicyDenied'), 'save')).toBe('policy_denied');
    expect(videoJobFailureCode(failure('ValidationFailed'), 'save')).toBe('validation_failed');
    expect(videoJobFailureCode(new Error('provider down'), 'model')).toBe('model_failed');
    expect(videoJobFailureCode(new Error('db down'), 'save')).toBe('failed');
  });
});
