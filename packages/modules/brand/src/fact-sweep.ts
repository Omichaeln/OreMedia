import type { BrandFactSweepRuntimeV1 } from '@oremedia/contracts/fact-sweep';
import { runAsPlatform, withTransaction } from '@oremedia/db';
import { PlatformFactSweepRepository } from './repositories';
import { brandService } from './service';

export const BRAND_FACT_SWEEP_WORKFLOW_TYPE = 'brandFactSweepWorkflowV1';
export const BRAND_FACT_SWEEP_SCHEDULE_ID = 'brand-fact-sweep';
const SWEEP_JOB = 'brand-fact-sweep';

const dueRepo = new PlatformFactSweepRepository();

/**
 * BSC-3: the effects behind brandFactSweepWorkflowV1's activities. The listing spans tenants as a declared platform
 * job (references only); each brand's sweep is one transaction in the tenant context the activity established.
 */
export function createBrandFactSweepRuntime(): BrandFactSweepRuntimeV1 {
  return {
    listBrandFactSweepTargets: ({ correlationId, now }) =>
      runAsPlatform(SWEEP_JOB, correlationId, () => dueRepo.listDue(new Date(now))),
    sweepBrandFacts: ({ brandId, now }) =>
      withTransaction((tx) => brandService.facts.sweep(brandId, new Date(now), tx)),
  };
}
