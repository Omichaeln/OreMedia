import type { SourceCapabilityV1 } from '../../source-contract';

/**
 * Google Search Console site as a read-only source (ledger R2-1). Values from current Google documentation
 * knowledge; quota figures are re-verified during certification (docs/platform-apps/google.md). `certifiedAt`
 * stays null until then.
 */
export const searchConsoleSiteCapability: SourceCapabilityV1 = {
  key: 'search_console_site',
  version: 1,
  vendor: 'Google',
  requiredScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  // Search analytics data is final about two to three days after the day it covers.
  latencyHours: 72,
  // Search Console API: per-site and per-project query-per-minute quotas.
  rateLimits: [
    { scope: 'account', limit: 200, windowSec: 60 },
    { scope: 'app', limit: 1200, windowSec: 60 },
  ],
  certifiedAt: null,
};
