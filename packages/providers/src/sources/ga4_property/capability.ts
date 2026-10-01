import type { SourceCapabilityV1 } from '../../source-contract';

/**
 * Google Analytics 4 property as a read-only source (ledger R2-1). Values from current Google documentation
 * knowledge; the quota figures are re-verified during certification with the deployment's own Cloud project
 * (docs/platform-apps/google.md). `certifiedAt` stays null until then.
 */
export const ga4PropertyCapability: SourceCapabilityV1 = {
  key: 'ga4_property',
  version: 1,
  vendor: 'Google',
  requiredScopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  // GA4 standard properties finalise a day's data within 24 to 48 hours.
  latencyHours: 48,
  // Analytics Admin API: a per-project quota (requests per minute); the Data API's per-property token quotas apply
  // to the reports of part B, read behind the same limiter under the account scope.
  rateLimits: [
    { scope: 'account', limit: 300, windowSec: 60 },
    { scope: 'app', limit: 600, windowSec: 60 },
  ],
  certifiedAt: null,
};
