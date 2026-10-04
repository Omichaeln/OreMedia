import type { CmsCapabilityV1 } from '../../cms-contract';

/**
 * WordPress (REST API v2 with an Application Password) as the `cms_site` adapter of this deployment (ledger
 * R2-3, D-16 working assumption). Values from current WordPress documentation knowledge; a self-hosted site has
 * no documented request quota, so the limiter is a courtesy bound. `certifiedAt` stays null until the read-back
 * tests ran against the pilot site with its own application password (docs/decisions D-16).
 */
export const wordpressCmsCapability: CmsCapabilityV1 = {
  key: 'cms_site',
  version: 1,
  vendor: 'WordPress',
  credential: {
    label: 'Application password',
    hint: 'Created under the site user’s profile (Users → Profile → Application Passwords); the user needs the editor or administrator role.',
  },
  rateLimits: [
    { scope: 'account', limit: 60, windowSec: 60 },
    { scope: 'app', limit: 600, windowSec: 60 },
  ],
  edit: true,
  delete: true,
  unpublish: true,
  // PR-03: core WordPress has no conditional update (no ETag / If-Match on /wp/v2/posts, verified against 7.1.2 and
  // trunk); updates of existing articles are atomic only on a site running the Oremedia conditional-write plugin
  // (infra/wordpress/oremedia-conditional-write), which the adapter detects per site before every update.
  conditionalWrite: 'extension',
  certifiedAt: null,
};
