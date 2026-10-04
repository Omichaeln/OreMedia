import { randomUUID } from 'node:crypto';
import type { CrossTenantFixture, OwnTenantFixture } from '../cross-tenant-inputs';

/** One entry per measurement.* procedure, every id pointing at the foreign tenant's rows from MEASUREMENT_SEED (spec 19.3). */
export const MEASUREMENT_INPUTS: Record<string, CrossTenantFixture> = {
  'measurement.definitions.list': {
    buildInput: null,
    reason: 'no resource ids; lists global definitions plus the caller’s own tenant definitions',
  },
  'measurement.definitions.get': { buildInput: (f) => ({ definitionId: f['metricDefinitionId'] }) },
  'measurement.definitions.create': {
    buildInput: null,
    reason: 'no resource ids; the definition is created in the caller’s tenant',
  },
  'measurement.metrics.query': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      subjectType: 'publication',
      subjectIds: [f['publicationId']],
      metricKeys: ['impressionCount'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
    }),
  },
  'measurement.metrics.brandSummary': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
    }),
  },
  'measurement.metrics.publicationValues': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      metricKeys: ['impressionCount'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
      page: { limit: 50 },
    }),
  },
  'measurement.attributes.aggregate': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
    }),
  },
  'measurement.quality.get': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      publicationId: f['publicationId'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
    }),
  },
  'measurement.links.list': {
    buildInput: (f) => ({ brandId: f['brandId'], variantId: f['channelVariantId'], page: { limit: 50 } }),
  },
  'measurement.attributes.get': { buildInput: (f) => ({ attributeId: f['creativeAttributesId'] }) },
  'measurement.attributes.correct': {
    buildInput: (f) => ({
      attributeId: f['creativeAttributesId'],
      expectedVersion: 0,
      attributes: { cta: 'x' },
    }),
  },
};

/**
 * Ledger G14: the measurement.* procedures above whose fixture is `buildInput: null` take no foreign reference, so there is
 * no foreign id to try. Each is called as the caller's own tenant instead (OwnTenantFixture), and must answer only
 * that tenant's data and leave the other tenant unchanged. A block of its own, apart from the fixtures above.
 */
export const MEASUREMENT_OWN_TENANT_INPUTS: Record<string, OwnTenantFixture> = {
  'measurement.definitions.list': {
    why: "takes an optional provider key (a global name, not a tenant resource): global definitions plus the caller's",
    input: () => ({}),
  },
  'measurement.definitions.create': {
    why: "takes a metric key and its definition (no id, no brand): the definition is created in the caller's tenant",
    input: () => ({
      key: `own_tenant_${randomUUID().slice(0, 8)}`,
      providerKey: null,
      nativeName: 'own tenant metric',
      unit: 'count',
      aggregation: 'sum',
      comparableGroup: 'organic',
      definitionVersion: 1,
    }),
  },
};
