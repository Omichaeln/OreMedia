import type { CrossTenantFixture } from '../cross-tenant-inputs';

export const OPERATIONS_INPUTS: Record<string, CrossTenantFixture> = {
  'operations.audit.query': {
    buildInput: (f) => ({ query: { resourceId: f['membershipId'] }, page: { limit: 50 } }),
    expectEmpty: true,
  },
  'operations.flags.snapshot': { buildInput: null, reason: 'no input' },
  'operations.flags.list': {
    buildInput: null,
    reason:
      "no input; operator-only, and shows the global default plus the session's own tenant (never other tenant ids)",
  },
  // The tenant id is not secret, so a foreign one is FORBIDDEN (a tenant member is refused before it is read; a
  // support session bound to tenant A targeting tenant B is tenant_mismatch: feature-flags.integration.test.ts).
  'operations.flags.set': {
    buildInput: (f) => ({
      key: 'experiments.randomised',
      target: { kind: 'tenant', tenantId: f['tenantId'] },
      enabled: true,
      expectedVersion: null,
      reason: 'cross-tenant probe',
    }),
    expectCode: 'FORBIDDEN',
  },
  'operations.providers.list': {
    buildInput: null,
    reason:
      'Lists the registered provider adapters of the deployment with their activation state; takes no ids and returns no tenant content.',
  },
  'operations.killSwitch.get': { buildInput: (f) => ({ scope: 'release_dispatch', brandId: f['brandId'] }) },
  'operations.killSwitch.set': {
    buildInput: (f) => ({ scope: 'release_dispatch', brandId: f['brandId'], engaged: true, reason: 'x' }),
  },
  'operations.outbox.deadLetters': { buildInput: null, reason: "no input; lists only the caller's tenant" },
  'operations.outbox.replay': { buildInput: (f) => ({ eventId: f['outboxEventId'] }) },
  'operations.deletion.request': {
    buildInput: (f) => ({ subjectType: 'brand', subjectId: f['brandId'], reason: 'x' }),
  },
};
