import { OverviewSummary } from '@oremedia/contracts/overview';
import { overviewService } from '@oremedia/module-overview';
import { router, tenantQuery } from '../trpc';

/**
 * Ledger R2-5 overview router: one read model composing the social rollup (measurement), the web sources and the
 * last audit (destinations) with coverage, freshness, splits and limits per source. Read-only.
 */
export const overviewRouter = router({
  summary: tenantQuery
    .input(OverviewSummary)
    .query(({ ctx, input }) => overviewService.summary(ctx.tenant.actor, input)),
});
