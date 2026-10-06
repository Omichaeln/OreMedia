import { reportPreferences, reports } from '@oremedia/db/schema/reports';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** MySQL's ER_NO_SUCH_TABLE, as mysql2 reports it (Drizzle wraps the driver error as `cause`). */
const isNoSuchTable = (e: unknown): boolean => {
  const errno = (x: unknown) => (x as { errno?: number } | null)?.errno;
  return errno(e) === 1146 || errno((e as { cause?: unknown } | null)?.cause) === 1146;
};

/**
 * A database built at a migration before 0033_reports (the roll-forward tests seed one) has no reports table, so
 * there is nothing to seed; any other failure is rethrown.
 */
async function hasReportsTable(db: Parameters<SeedExtension>[0]): Promise<boolean> {
  try {
    await db.select({ id: reports.id }).from(reports).limit(1);
    return true;
  } catch (e) {
    if (isNoSuchTable(e)) return false;
    throw e;
  }
}

/** Per tenant, on brand 1: one draft report for September 2026 and the brand's preference row (spec 19.3). */
export const REPORTS_SEED: SeedExtension = async (db, { tenantId, brandIds }) => {
  const nothing: Record<string, string> = {};
  if (!(await hasReportsTable(db))) return nothing;
  const brandId = brandIds[0];
  const reportId = newId('report');
  const reportPreferenceId = newId('reportPreference');
  await db.insert(reports).values({
    id: reportId,
    tenantId,
    brandId,
    periodMonth: '2026-09',
    compareMode: 'previous_month',
    sections: ['cover', 'overview', 'channels', 'posts', 'recommendations'],
    executiveSummary: 'Seeded summary',
    recommendations: '',
    preparedFor: 'Seeded client',
    preparedBy: 'Seeded manager',
    theme: 'dark',
    state: 'draft',
  });
  await db.insert(reportPreferences).values({ id: reportPreferenceId, tenantId, brandId, autoDraft: false });
  return { reportId, reportPreferenceId };
};
