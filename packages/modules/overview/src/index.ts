// Overview (ledger R2-5): the unified performance overview, a read model that composes the measurement module's
// brand rollup and per-publication query, the destinations module's report and audit summaries and the publishing
// module's channels through their public services, with the composition rules in compose.ts (source states with
// reasons, source-labelled figures with freshness, the organic vs paid and Oremedia vs native limits, the
// consent / blocker statements). It owns no table.
export { overviewService, createOverviewService, type OverviewQueryOptions } from './summary';
export {
  socialFigures,
  socialOf,
  channelSource,
  webFigures,
  webSourceOf,
  auditSourceOf,
  splitsOf,
  limitsOf,
  type BrandSummaryResult,
  type ChannelRow,
  type ReleasedPublication,
} from './compose';
