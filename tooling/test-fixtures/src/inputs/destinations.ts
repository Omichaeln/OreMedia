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
