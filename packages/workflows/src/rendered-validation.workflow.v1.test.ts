import { describe, expect, it } from 'vitest';
import {
  RENDERED_VALIDATION_DELAYS_MS as CONTRACT_DELAYS_MS,
  type RenderedValidationActivitiesV1,
  type RenderedValidationInputV1,
  type RenderedValidationResultV1,
} from '@oremedia/contracts/publishing';
import { RENDERED_VALIDATION_DELAYS_MS, runRenderedValidation } from './rendered-validation.workflow.v1';

describe('renderedValidationWorkflowV1 orchestration (RA-04)', () => {
  const publishedAt = '2026-10-02T10:00:00.000Z';
  const input: RenderedValidationInputV1 = {
    tenantId: 'ten_a',
    actor: { kind: 'user', id: 'usr_1' },
    correlationId: 'c',
    publicationId: 'pub_1',
    publishedAt,
  };
  const harness = (startOffsetMs: number, answers: RenderedValidationResultV1[]) => {
    let clock = new Date(publishedAt).getTime() + startOffsetMs;
    const sleeps: number[] = [];
    const seen: RenderedValidationInputV1[] = [];
    const acts: RenderedValidationActivitiesV1 = {
      validateRenderedPublication: async (i) => {
        seen.push(i);
        return answers[seen.length - 1] ?? { outcome: 'skipped', reason: 'exhausted' };
      },
    };
    const host = {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    };
    return { acts, host, sleeps, seen };
  };

  it("the delays are the contract's (workflow code imports no values, so the constant is mirrored)", () => {
    expect([...RENDERED_VALIDATION_DELAYS_MS]).toEqual([...CONTRACT_DELAYS_MS]);
  });

  it('checks the page at 2 and 15 minutes after publish, each with the ids it was started with', async () => {
    const { acts, host, sleeps, seen } = harness(RENDERED_VALIDATION_DELAYS_MS[0], [
      { outcome: 'validated', ok: true, verification: 'verified' },
      { outcome: 'validated', ok: false, verification: 'failed' },
    ]);
    const out = await runRenderedValidation(acts, input, host);
    expect(sleeps).toEqual([RENDERED_VALIDATION_DELAYS_MS[1] - RENDERED_VALIDATION_DELAYS_MS[0]]);
    expect(seen).toEqual([input, input]);
    expect(out.results.map((r) => r.outcome)).toEqual(['validated', 'validated']);
  });

  it('a run started late (the outbox was behind) checks at once and still waits for the later delay', async () => {
    const { acts, host, sleeps, seen } = harness(5 * 60_000, [
      { outcome: 'validated', ok: true, verification: 'verified' },
      { outcome: 'validated', ok: true, verification: 'verified' },
    ]);
    await runRenderedValidation(acts, input, host);
    expect(sleeps).toEqual([10 * 60_000]);
    expect(seen).toHaveLength(2);
  });

  it('a publication that is no longer a live article ends the run after the first look', async () => {
    const { acts, host, sleeps, seen } = harness(0, [{ outcome: 'skipped', reason: 'remote_reverted' }]);
    const out = await runRenderedValidation(acts, input, host);
    expect(sleeps).toEqual([RENDERED_VALIDATION_DELAYS_MS[0]]);
    expect(seen).toHaveLength(1);
    expect(out.results).toEqual([{ outcome: 'skipped', reason: 'remote_reverted' }]);
  });
});
