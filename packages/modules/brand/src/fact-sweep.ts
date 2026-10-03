import type { BrandFactSweepInputV1, BrandFactSweepRefV1 } from '@oremedia/contracts/fact-sweep';
import { runAsPlatform } from '@oremedia/db';
import { PlatformFactSweepRepository } from './repositories';

export const BRAND_FACT_SWEEP_WORKFLOW_TYPE = 'brandFactSweepWorkflowV1';
export const BRAND_FACT_SWEEP_SCHEDULE_ID = 'brand-fact-sweep';
const SWEEP_JOB = 'brand-fact-sweep';

const dueRepo = new PlatformFactSweepRepository();

/**
 * BSC-3: the brands with fact work due at `now`, across tenants as a declared platform job (references only). Each
 * brand's sweep (brandService.facts.sweep, composed with the holds in worker-core) runs in its own tenant.
 */
export const listBrandFactSweepTargets = ({
  correlationId,
  now,
}: BrandFactSweepInputV1): Promise<BrandFactSweepRefV1[]> =>
  runAsPlatform(SWEEP_JOB, correlationId, () => dueRepo.listDue(new Date(now)));
