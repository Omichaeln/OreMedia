// Brand destinations and source-use policy (ledger R2-0, D-16/D-17/D-18): the non-social places a brand reads
// from or writes to, registered with their owner, scopes, health and capability version, and the per-kind,
// per-data-type policy that says what the product may do with each source's data, versioned with a review date.
// R2-1 part A: a Google grant attached to a destination through the connect flow (source adapters behind the
// certification gate, the grant sealed by the credential broker) and the daily token refresh behind
// destinationTokenRefreshWorkflowV1 on task queue `core`.
// Every write here is a person's: destination.connect, destination.manage and source_use.manage are AGENT_NEVER.
export { destinationService, sourceUsePolicyService, configureDestinationConnectStateStore } from './service';
export {
  BrandDestinationRepository,
  DestinationRefreshDueRepository,
  PendingDestinationGrantRepository,
  SourceUsePolicyRepository,
} from './repositories';
export {
  configureSourceAvailability,
  sourceAvailable,
  sourceAvailabilityFromEnv,
  sourceCapabilities,
  type SourceAvailability,
} from './hooks';
export {
  configureDestinationSources,
  sourceAdapterFor,
  sourceIO,
  registry as sourceRegistryInUse,
  type DestinationSourceOptions,
} from './sources';
export { createDestinationRuntime, type DestinationRuntime, type DestinationRuntimeOptions } from './runtime';
/** Spec 14.7 pattern for the daily refresh: one Temporal schedule per namespace on task queue `core`. */
export const DESTINATION_TOKEN_REFRESH_WORKFLOW_TYPE = 'destinationTokenRefreshWorkflowV1';
export const DESTINATION_TOKEN_REFRESH_SCHEDULE_ID = 'destination-token-refresh';
/** Test fixtures only (an in-memory source); never registered by a production composition root. */
export {
  FixtureSourceAdapter,
  fixtureSourceCapability,
  type RefreshBehaviour as FixtureRefreshBehaviour,
} from './testing/fixture-source';
