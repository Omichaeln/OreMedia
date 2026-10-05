import { reportPreferences, reports } from '@oremedia/db/schema/reports';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** Per tenant, on brand 1: one draft report for September 2026 and the brand's preference row (spec 19.3). */
export const REPORTS_SEED: SeedExtension = async (db, { tenantId, brandIds }) => {
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
