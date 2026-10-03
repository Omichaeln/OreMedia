import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  BrandFactSweepActivitiesV1,
  BrandFactSweepArgsV1,
  BrandFactSweepInputV1,
} from '@oremedia/contracts/fact-sweep';

/**
 * BSC-3 (task queue `core`), started daily by the Temporal schedule `brand-fact-sweep`: every brand with fact work
 * due is swept in its own tenant, one activity per brand, so one failing brand never blocks the others. Per brand
 * an approved fact whose validity ended emits `brand.fact_expired` once (routed to brandChangeImpactWorkflowV1), a
 * fact past its review date is flagged once, and a fact without a duplicate key gets one; the markers make a re-run
 * (or the next day's run) a no-op. Modelled on destinationTokenRefreshWorkflowV1. The payload carries ids only.
 * Once deployed this file is immutable; changes ship as v2.
 */
/** The actor every brand's sweep runs as: a platform job applied inside each tenant (no person requested it). */
export const BRAND_FACT_SWEEP_ACTOR = { kind: 'platform_operator' as const, id: 'brand-fact-sweep' };

export interface BrandFactSweepOutcome {
  brands: number;
  expired: number;
  reviewDue: number;
  keyed: number;
  failed: number;
}

/** The orchestration, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runBrandFactSweep(
  acts: BrandFactSweepActivitiesV1,
  input: BrandFactSweepInputV1,
): Promise<BrandFactSweepOutcome> {
  const targets = await acts.listBrandFactSweepTargets(input);
  const outcome: BrandFactSweepOutcome = {
    brands: targets.length,
    expired: 0,
    reviewDue: 0,
    keyed: 0,
    failed: 0,
  };
  for (const ref of targets) {
    try {
      const result = await acts.sweepBrandFacts({
        tenantId: ref.tenantId,
        brandId: ref.brandId,
        actor: BRAND_FACT_SWEEP_ACTOR,
        correlationId: input.correlationId,
        now: input.now,
      });
      outcome.expired += result.expired;
      outcome.reviewDue += result.reviewDue;
      outcome.keyed += result.keyed;
    } catch {
      outcome.failed += 1; // picked up again by the next run; the activity already retried transient errors
    }
  }
  return outcome;
}

export async function brandFactSweepWorkflowV1(
  args: BrandFactSweepArgsV1 = {},
): Promise<BrandFactSweepOutcome> {
  const acts = proxyActivities<BrandFactSweepActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '30s',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed'],
    },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  const input: BrandFactSweepInputV1 = {
    correlationId: args.correlationId ?? `brand-fact-sweep:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  };
  return runBrandFactSweep(acts, input);
}
