import { describe, expect, it } from 'vitest';
import type { BrandFactSweepActivitiesV1, BrandFactSweepBrandInputV1 } from '@oremedia/contracts/fact-sweep';
import { BRAND_FACT_SWEEP_ACTOR, runBrandFactSweep } from './brand-fact-sweep.workflow.v1';

describe('brandFactSweepWorkflowV1 orchestration (BSC-3)', () => {
  const input = { correlationId: 'c', now: '2026-10-03T03:20:00.000Z' };

  it('lists the due brands once and sweeps each in its own tenant as the platform actor at the run clock', async () => {
    const seen: BrandFactSweepBrandInputV1[] = [];
    const listed: unknown[] = [];
    const acts: BrandFactSweepActivitiesV1 = {
      listBrandFactSweepTargets: async (i) => {
        listed.push(i);
        return [
          { tenantId: 'ten_a', brandId: 'brd_1' },
          { tenantId: 'ten_b', brandId: 'brd_2' },
        ];
      },
      sweepBrandFacts: async (i) => {
        seen.push(i);
        return i.brandId === 'brd_1'
          ? { expired: 2, reviewDue: 1, keyed: 0 }
          : { expired: 0, reviewDue: 3, keyed: 4 };
      },
    };
    expect(await runBrandFactSweep(acts, input)).toEqual({
      brands: 2,
      expired: 2,
      reviewDue: 4,
      keyed: 4,
      failed: 0,
    });
    expect(listed).toEqual([input]);
    expect(seen.map((s) => [s.tenantId, s.brandId, s.now])).toEqual([
      ['ten_a', 'brd_1', input.now],
      ['ten_b', 'brd_2', input.now],
    ]);
    expect(seen.every((s) => s.actor === BRAND_FACT_SWEEP_ACTOR && s.correlationId === 'c')).toBe(true);
  });

  it('one brand failing never blocks the others', async () => {
    const calls: string[] = [];
    const acts: BrandFactSweepActivitiesV1 = {
      listBrandFactSweepTargets: async () => [
        { tenantId: 'ten_a', brandId: 'brd_1' },
        { tenantId: 'ten_a', brandId: 'brd_2' },
      ],
      sweepBrandFacts: async (i) => {
        calls.push(i.brandId);
        if (i.brandId === 'brd_1') throw new Error('boom');
        return { expired: 1, reviewDue: 0, keyed: 0 };
      },
    };
    expect(await runBrandFactSweep(acts, input)).toEqual({
      brands: 2,
      expired: 1,
      reviewDue: 0,
      keyed: 0,
      failed: 1,
    });
    expect(calls).toEqual(['brd_1', 'brd_2']);
  });
});
