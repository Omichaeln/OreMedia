// Brand destinations and source-use policy (ledger R2-0, D-16/D-17/D-18): the non-social places a brand reads
// from or writes to, registered with their owner, scopes, health and capability version, and the per-kind,
// per-data-type policy that says what the product may do with each source's data, versioned with a review date.
// R2-1 part A: a Google grant attached to a destination through the connect flow (source adapters behind the
// certification gate, the grant sealed by the credential broker) and the daily token refresh behind
// destinationTokenRefreshWorkflowV1 on task queue `core`.
// Every write here is a person's: destination.connect, destination.manage and source_use.manage are AGENT_NEVER.
// R2-1 part B: the daily report sweep (destinationReportSweepWorkflowV1 on task queue `ingest-metrics`, worker-ingest)
// stores GA4 and Search Console report rows per destination under the source-use policy; destinationReportService
// is the restricted read model (summary, drill-down rows, opportunities) the Performance screen reads.
export {
  destinationService,
  sourceUsePolicyService,
  sourceUseDecision,
  configureDestinationConnectStateStore,
} from './service';
// R2-3: a website connected with a sealed secret, verified by destinationVerifyWorkflowV1 (core); the article
// publisher the publishing module reaches through its destination hook (createArticle as a draft by default, the
// read-back, the conflict-refusing edit, the revert to draft, the rendered-page validation).
export { destinationArticles, effectivePublishMode } from './articles';
export {
  configureDestinationCms,
  cmsAdapterFor,
  cmsIO,
  cmsRegistryInUse,
  type DestinationCmsOptions,
} from './cms';
export {
  registerDestinationOutboxRoutes,
  DESTINATION_VERIFY_WORKFLOW_TYPE,
  destinationVerifyWorkflowId,
} from './outbox-routes';
export {
  destinationReportService,
  createDestinationReportService,
  reportFreshness,
  reportComparison,
} from './reports';
export {
  createDestinationReportRuntime,
  reportRange,
  type DestinationReportRuntimeOptions,
} from './report-runtime';
export {
  BrandDestinationRepository,
  DestinationRefreshDueRepository,
  DestinationReportRowRepository,
  DestinationReportTargetRepository,
  PendingDestinationGrantRepository,
  SourceUsePolicyRepository,
} from './repositories';
export {
  configureSourceAvailability,
  sourceAvailable,
  sourceAvailabilityFromEnv,
  sourceCapabilities,
  cmsCapabilities,
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
/** R2-1 part B: the daily report sweep, one schedule per namespace on task queue `ingest-metrics` (worker-ingest). */
export const DESTINATION_REPORT_SWEEP_WORKFLOW_TYPE = 'destinationReportSweepWorkflowV1';
export const DESTINATION_REPORT_SWEEP_SCHEDULE_ID = 'destination-report-sweep';
/** Test fixtures only (an in-memory source); never registered by a production composition root. */
export {
  FixtureSourceAdapter,
  fixtureSourceCapability,
  type RefreshBehaviour as FixtureRefreshBehaviour,
  type ReportBehaviour as FixtureReportBehaviour,
} from './testing/fixture-source';
