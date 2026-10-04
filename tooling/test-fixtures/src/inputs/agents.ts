import type { CrossTenantFixture, OwnTenantFixture } from '../cross-tenant-inputs';

/** One entry per agents.* procedure, every id pointing at the foreign tenant's rows from AGENTS_SEED (spec 19.3). */
export const AGENTS_INPUTS: Record<string, CrossTenantFixture> = {
  'agents.runs.start': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      servicePrincipalId: f['servicePrincipalId'],
      requestedAutonomy: 'create',
      taskKind: 'copywriting',
      brief: { objective: 'foreign' },
    }),
  },
  'agents.budgets.read': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'agents.budgets.setLimit': {
    buildInput: (f) => ({ brandId: f['brandId'], period: 'day', limitMicros: 1_000_000 }),
  },
  'agents.runs.get': { buildInput: (f) => ({ runId: f['agentRunId'] }) },
  'agents.runs.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'agents.runs.cancel': { buildInput: (f) => ({ runId: f['agentRunId'], reason: 'x' }) },
  'agents.runs.steps': { buildInput: (f) => ({ runId: f['agentRunId'], page: { limit: 50 } }) },
  'agents.runs.pendingProposals': {
    buildInput: (f) => ({ brandId: f['brandId'], documentId: f['creativeDocumentId'] }),
  },
  'agents.runs.effectiveLimits': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      servicePrincipalId: f['servicePrincipalId'],
      taskKind: 'copywriting',
      requestedAutonomy: 'create',
    }),
  },
  'agents.runs.approveProposal': {
    buildInput: (f) => ({ runId: f['agentRunId'], stepId: f['agentStepId'], decision: 'accept' }),
  },
  'agents.routingPolicy.get': {
    buildInput: null,
    reason: "no input; reads the caller's own tenant policy (tenant from the verified membership)",
  },
  'agents.routingPolicy.set': {
    buildInput: null,
    reason: "no resource ids; the policy document is stored in the caller's tenant",
  },
};

/**
 * Ledger G14: the agents.* procedures above whose fixture is `buildInput: null` take no foreign reference, so there is
 * no foreign id to try. Each is called as the caller's own tenant instead (OwnTenantFixture), and must answer only
 * that tenant's data and leave the other tenant unchanged. A block of its own, apart from the fixtures above.
 */
export const AGENTS_OWN_TENANT_INPUTS: Record<string, OwnTenantFixture> = {
  'agents.routingPolicy.get': {
    why: "takes no input: reads the routing policy of the caller's verified tenant",
    input: () => undefined,
  },
  'agents.routingPolicy.set': {
    why: "takes a policy document (vendors, regions, model names) and its version, no id: stored for the caller's tenant",
    input: () => ({
      policy: {
        schemaVersion: 1,
        defaultModel: 'fake-model',
        permittedVendors: ['anthropic'],
        permittedRegions: [],
        deniedModels: [],
      },
    }),
  },
};
