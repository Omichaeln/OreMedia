import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { ReportCompareMode } from '@oremedia/contracts/reports';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type ReportDto = NonNullable<inferOutput<Trpc['reports']['get']>>;
export type ReportFiguresDto = inferOutput<Trpc['reports']['figures']>;
export type ReportDeliveryDto = inferOutput<Trpc['reports']['delivery']>;
export type ReportPreferencesDto = inferOutput<Trpc['reports']['preferences']['get']>;
export type ReportDraftDto = inferOutput<Trpc['reports']['draftSummary']>;
export type ReportAskDto = inferOutput<Trpc['reports']['ask']>;

/** One hook per query (spec 21.1); the tenant header comes from the URL. */
export function useReports(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.reports.list.queryOptions({ brandId, page: { limit: 50 } }));
}

/** The month's saved report, or null until "Save draft" (the builder then shows the defaults). */
export function useReport(brandId: string, periodMonth: string) {
  const trpc = useTRPC();
  return useQuery(trpc.reports.get.queryOptions({ brandId, periodMonth }));
}

/** D-29: the month's figures composed from the measurement module under D-14/D-15; the preview reads them. */
export function useReportFigures(brandId: string, periodMonth: string, compareMode: ReportCompareMode) {
  const trpc = useTRPC();
  return useQuery(trpc.reports.figures.queryOptions({ brandId, periodMonth, compareMode }));
}

/** What this deployment can do with a finished report (email, link, PDF); the controls read it. */
export function useReportDelivery(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.reports.delivery.queryOptions({ brandId }));
}

export function useReportPreferences(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.reports.preferences.get.queryOptions({ brandId }));
}
