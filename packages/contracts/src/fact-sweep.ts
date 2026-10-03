import { z } from 'zod';
import { TenantContextInput } from './tenancy';

/**
 * BSC-3 daily fact sweep (brandFactSweepWorkflowV1, task queue `core`, started by the Temporal schedule
 * `brand-fact-sweep`): for every brand with work due, an approved fact whose validity has ended emits
 * `brand.fact_expired` exactly once and the scheduled work citing it is held (as for a revocation), an approved fact past
 * its review date is flagged once for the workspace and Needs you, and a fact stored before duplicate detection gets
 * its duplicate key. Payloads carry references only.
 */
export const BrandFactSweepArgsV1 = z.object({
  correlationId: z.string().optional(),
  now: z.string().datetime().optional(),
});
export type BrandFactSweepArgsV1 = z.infer<typeof BrandFactSweepArgsV1>;

export interface BrandFactSweepInputV1 {
  correlationId: string;
  now: string;
}

/** A brand with facts due for the sweep: references only. */
export interface BrandFactSweepRefV1 {
  tenantId: string;
  brandId: string;
}

export const BrandFactSweepBrandInputV1 = TenantContextInput.extend({
  brandId: z.string(),
  now: z.string().datetime(),
});
export type BrandFactSweepBrandInputV1 = z.infer<typeof BrandFactSweepBrandInputV1>;

export interface BrandFactSweepBrandResultV1 {
  expired: number;
  reviewDue: number;
  keyed: number;
}

export interface BrandFactSweepActivitiesV1 {
  listBrandFactSweepTargets(input: BrandFactSweepInputV1): Promise<BrandFactSweepRefV1[]>;
  sweepBrandFacts(input: BrandFactSweepBrandInputV1): Promise<BrandFactSweepBrandResultV1>;
}
/** The module-side implementation the activities wrap (tenant context is established by the activity host). */
export type BrandFactSweepRuntimeV1 = BrandFactSweepActivitiesV1;
