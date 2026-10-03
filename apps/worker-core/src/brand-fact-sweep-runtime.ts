import type { BrandFactSweepRuntimeV1 } from '@oremedia/contracts/fact-sweep';
import { withTransaction } from '@oremedia/db';
import { brandService, listBrandFactSweepTargets } from '@oremedia/module-brand';
import { publicationService } from '@oremedia/module-publishing';
import { reviewService } from '@oremedia/module-review';

/**
 * BSC-3: the effects behind brandFactSweepWorkflowV1's activities, composed here because the brand module (facts),
 * the review module (what a fact reaches, the brand's policy) and the publishing module (holding or flagging the
 * scheduled publications) never import each other (spec 4.2), as brand-change-runtime.ts does for revocations.
 * One transaction per brand in the tenant context the activity established, under the platform job's actor: the
 * expiry markers, the audit and the holds commit together, so a re-run finds nothing left to do and every hold is
 * attributed to the sweep, never to a person.
 */
export function createBrandFactSweepRuntime(): BrandFactSweepRuntimeV1 {
  return {
    listBrandFactSweepTargets,
    sweepBrandFacts: ({ brandId, now }) =>
      withTransaction(async (tx) => {
        const { expiredFactIds, ...counts } = await brandService.facts.sweep(brandId, new Date(now), tx);
        for (const factId of expiredFactIds) {
          const scope = await reviewService.factRevocationScope(brandId, factId, tx);
          await publicationService.applyFactRevocation(
            {
              brandId,
              factId,
              contentRevisionIds: scope.contentRevisionIds,
              hold: scope.hold,
              cause: 'fact_expired',
            },
            tx,
          );
        }
        return counts;
      }),
  };
}
