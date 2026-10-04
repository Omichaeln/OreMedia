import type { CrossTenantFixture, OwnTenantFixture } from '../cross-tenant-inputs';

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

/**
 * Ledger G14: the operations.* procedures above whose fixture is `buildInput: null` take no foreign reference, so there is
 * no foreign id to try. Each is called as the caller's own tenant instead (OwnTenantFixture), and must answer only
 * that tenant's data and leave the other tenant unchanged. A block of its own, apart from the fixtures above.
 */
export const OPERATIONS_OWN_TENANT_INPUTS: Record<string, OwnTenantFixture> = {
  'operations.flags.snapshot': {
    why: "takes no input: the feature flags evaluated for the caller's verified tenant",
    input: () => undefined,
  },
  'operations.flags.list': {
    why: 'takes no input and is operator-only: a tenant owner is refused, and the refusal names no other tenant',
    input: () => undefined,
    expectError: 'FORBIDDEN',
  },
  'operations.providers.list': {
    why: 'takes no input: the provider adapters registered on the deployment with their activation, no tenant content',
    input: () => undefined,
  },
  'operations.outbox.deadLetters': {
    why: "takes no input: the dead-lettered outbox events of the caller's verified tenant",
    input: () => undefined,
  },
};
