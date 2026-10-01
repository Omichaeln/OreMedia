import type { CrossTenantFixture } from '../cross-tenant-inputs';

const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

/** One entry per destinations.* procedure, every id pointing at the foreign tenant's rows from DESTINATIONS_SEED (spec 19.3). */
export const DESTINATIONS_INPUTS: Record<string, CrossTenantFixture> = {
  'destinations.list': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'destinations.get': {
    buildInput: (f) => ({ brandId: f['brandId'], destinationId: f['destinationId'] }),
  },
  'destinations.register': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'ga4_property',
      externalId: 'properties/424242',
      displayName: 'Foreign property',
    }),
  },
  'destinations.setHealth': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      destinationId: f['destinationId'],
      health: 'healthy',
      expectedVersion: 0,
    }),
  },
  'destinations.disconnect': {
    buildInput: (f) => ({ brandId: f['brandId'], destinationId: f['destinationId'], expectedVersion: 0 }),
  },
  // R2-1 connect flow: the brand is read first (NOT_FOUND); a state or pending id of another tenant is unknown
  // here (VALIDATION_FAILED, as the channel flow answers), so nothing is revealed and nothing is written.
  'destinations.sources.list': {
    buildInput: null,
    reason:
      'Lists the registered source adapters of the deployment; takes no ids and returns no tenant content.',
  },
  'destinations.connect.start': {
    buildInput: (f) => ({ brandId: f['brandId'], kind: 'ga4_property' }),
  },
  'destinations.connect.complete': {
    buildInput: (f) => ({ state: f['pendingDestinationGrantId'], code: 'code_foreign' }),
  },
  'destinations.connect.select': {
    buildInput: (f) => ({ pendingId: f['pendingDestinationGrantId'], externalId: 'properties/424242' }),
  },
  'destinations.connect.cancel': { buildInput: (f) => ({ pendingId: f['pendingDestinationGrantId'] }) },
  // R2-3: the brand is read first (NOT_FOUND), so no secret is ever sealed for a foreign brand.
  'destinations.connect.withSecret': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'cms_site',
      siteUrl: 'https://site.example',
      username: 'editor',
      secret: 'not-a-real-secret',
    }),
  },
  // R2-3: the publication is read first (NOT_FOUND); nothing is fetched for a foreign publication.
  'destinations.articles.validate': { buildInput: (f) => ({ publicationId: f['publicationId'] }) },
  // R2-1 part B: the brand is read first (NOT_FOUND), so a foreign destination's rows are never aggregated.
  'destinations.reports.summary': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      destinationId: f['destinationId'],
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-30T23:59:59.999Z',
    }),
  },
  'destinations.reports.rows': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      destinationId: f['destinationId'],
      reportKey: 'ga4.acquisition',
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-30T23:59:59.999Z',
    }),
  },
  'destinations.reports.opportunities': {
    buildInput: (f) => ({ brandId: f['brandId'], destinationId: f['destinationId'] }),
  },
  'destinations.sourceUse.list': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'destinations.sourceUse.set': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      destinationKind: 'ga4_property',
      dataType: 'ga4.reports',
      allowedUses: ['read'],
      reviewDueAt: future(),
      expectedVersion: 1,
    }),
  },
  'destinations.sourceUse.check': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      destinationKind: 'ga4_property',
      dataType: 'ga4.reports',
      use: 'read',
    }),
  },
};
