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
  cmsSafeUrl,
  cmsRegistryInUse,
  type DestinationCmsOptions,
} from './cms';
export {
  registerDestinationOutboxRoutes,
  DESTINATION_VERIFY_WORKFLOW_TYPE,
  destinationVerifyWorkflowId,
  DESTINATION_REVOKE_WORKFLOW_TYPE,
  destinationRevokeWorkflowId,
  SEO_AUDIT_WORKFLOW_TYPE,
  seoAuditWorkflowId,
} from './outbox-routes';
// R2-4: the bounded technical SEO audit of a website destination (seoAuditSweepWorkflowV1 weekly on task queue
// `ingest-metrics`, seoAuditWorkflowV1 per run); seoAuditService is the restricted read model (summary, runs,
// pages, findings with suggested tasks) and the on-demand `run` command (seo_audit.run, AGENT_NEVER).
export { seoAuditService, createSeoAuditService } from './audit';
export { createSeoAuditRuntime, type SeoAuditRuntimeOptions } from './audit-runtime';
// Spec 17.5: the TTL handlers worker-core registers with the platform retention sweep (D-17 retention applied
// on the sweep's own clock, independently of any fetch, connection or enabled kind).
export { destinationRetention } from './retention';
export {
  robotsDisallowFor,
  robotsAllows,
  sitemapUrls,
  extractLinks,
  auditPage,
  crossPageChecks,
  findingsOf,
  FINDING_RULES,
} from './audit-crawl';
export {
  destinationReportService,
  createDestinationReportService,
  reportFreshness,
  reportQuality,
  reportComparison,
} from './reports';
export {
  createDestinationReportRuntime,
  reportRange,
  REPORTING_ZONE_RECHECK_DAYS,
  dateKey,
  dayEnd,
  knownTimeZone,
  type DestinationReportRuntimeOptions,
} from './report-runtime';
export {
  BrandDestinationRepository,
  DestinationRefreshDueRepository,
  DestinationReportRowRepository,
  DestinationReportTargetRepository,
  PendingDestinationGrantRepository,
  SeoAuditPageRepository,
  SeoAuditRunRepository,
  SeoAuditTargetRepository,
  SeoFindingWorkRepository,
  SourceUsePolicyRepository,
} from './repositories';
export {
  configureSourceAvailability,
  configureSourceActivation,
  sourceActivationOf,
  sourceActivationFromEnv,
  sourceAvailable,
  sourceAvailabilityFromEnv,
  sourceCapabilities,
  cmsCapabilities,
  registerFindingWork,
  resetFindingWork,
  type SourceAvailability,
  type SourceActivation,
  type SourceActivationSource,
  type FindingWorkHooks,
  type FindingWorkInput,
  type FindingWorkRef,
} from './hooks';
// RA-01: every registered provider (channel, source, CMS) with its activation state on this deployment.
export { providerService, listProviders } from './providers';
export { openDestinationCredential } from './service';
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
/** R2-4: the weekly audit sweep, one schedule per namespace on task queue `ingest-metrics` (worker-ingest). */
export const SEO_AUDIT_SWEEP_WORKFLOW_TYPE = 'seoAuditSweepWorkflowV1';
export const SEO_AUDIT_SWEEP_SCHEDULE_ID = 'seo-audit-sweep';
/** Test fixtures only (an in-memory source); never registered by a production composition root. */
export {
  FixtureSourceAdapter,
  fixtureSourceCapability,
  type RefreshBehaviour as FixtureRefreshBehaviour,
  type ReportBehaviour as FixtureReportBehaviour,
} from './testing/fixture-source';
export { FixtureCmsAdapter, fixtureCmsCapability, fixtureArticleHash } from './testing/fixture-cms';
