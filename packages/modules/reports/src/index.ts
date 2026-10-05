// Reports (D-29): monthly client reports composed from the measurement, publishing and intelligence modules'
// public services under the dictionary's rules (figures.ts), the builder state and send record per brand and
// month (its own tables), and the executive summary and assistant drafted through the registered model gateway.
export { reportsService, createReportsService, type ReportsServiceOptions } from './service';
export { registerReportDrafter, reportDrafter } from './hooks';
export {
  composeFigures,
  factsOf,
  figuresOf,
  channelsOf,
  postsOf,
  postPageOf,
  trendOf,
  formatsOf,
  recommendationsOf,
  freshnessOf,
  pooledRate,
  sampleOf,
  monthWindow,
  monthLabel,
  monthShort,
  shiftMonth,
  compareMonthOf,
  type ComposeInput,
  type WindowData,
  type ReportPublication,
  type ReportChannelRow,
  type FeatureCell,
  type RecommendationRow,
} from './figures';
export { ReportRepository, ReportPreferenceRepository } from './repositories';
