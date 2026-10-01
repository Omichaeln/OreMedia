import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per overview.* procedure, every id pointing at the foreign tenant's rows (spec 19.3). */
export const OVERVIEW_INPUTS: Record<string, CrossTenantFixture> = {
  'overview.summary': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
    }),
  },
};
