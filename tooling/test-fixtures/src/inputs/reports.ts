import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per reports.* procedure, every id pointing at the foreign tenant's rows from REPORTS_SEED (spec 19.3). */
export const REPORTS_INPUTS: Record<string, CrossTenantFixture> = {
  'reports.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'reports.get': { buildInput: (f) => ({ brandId: f['brandId'], periodMonth: '2026-09' }) },
  'reports.figures': {
    buildInput: (f) => ({ brandId: f['brandId'], periodMonth: '2026-09', compareMode: 'previous_month' }),
  },
  'reports.delivery': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'reports.save': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      periodMonth: '2026-09',
      expectedVersion: 0,
      fields: {
        compareMode: 'previous_month',
        sections: ['cover', 'overview'],
        executiveSummary: 'foreign',
        recommendations: '',
        preparedFor: '',
        preparedBy: '',
        theme: 'dark',
      },
    }),
  },
  'reports.markSent': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      reportId: f['reportId'],
      expectedVersion: 0,
      sentTo: 'client@example.test',
    }),
  },
  'reports.draftSummary': {
    buildInput: (f) => ({ brandId: f['brandId'], periodMonth: '2026-09', compareMode: 'previous_month' }),
  },
  'reports.ask': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      periodMonth: '2026-09',
      compareMode: 'previous_month',
      question: 'foreign',
    }),
  },
  'reports.preferences.get': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'reports.preferences.set': { buildInput: (f) => ({ brandId: f['brandId'], autoDraft: true }) },
};
