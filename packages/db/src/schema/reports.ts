import { boolean, foreignKey, index, json, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { brandId, createdAt, id, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

/**
 * D-29 monthly client reports: one row per brand and calendar month holding what a person edits on the builder
 * (the comparison, the sections, the executive summary and recommendations text, prepared-for/by, the theme) and
 * the record of its send. The figures are never stored: every read composes them from the measurement module.
 */
export const reports = mysqlTable(
  'reports',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    /** The calendar month the report covers, YYYY-MM in the brand's zone. */
    periodMonth: varchar('period_month', { length: 7 }).notNull(),
    compareMode: mysqlEnum('compare_mode', ['previous_month', 'last_year']).notNull().default('previous_month'),
    sections: json('sections').$type<string[]>().notNull(),
    executiveSummary: text('executive_summary').notNull(),
    recommendations: text('recommendations').notNull(),
    preparedFor: varchar('prepared_for', { length: 200 }).notNull().default(''),
    preparedBy: varchar('prepared_by', { length: 200 }).notNull().default(''),
    theme: mysqlEnum('theme', ['dark', 'light']).notNull().default('dark'),
    state: mysqlEnum('state', ['draft', 'sent']).notNull().default('draft'),
    sentAt: ts('sent_at'),
    sentTo: varchar('sent_to', { length: 320 }),
    sentByUserId: varchar('sent_by_user_id', { length: 32 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_report_tbi').on(t.tenantId, t.brandId, t.id),
    uniqueIndex('uq_report_month').on(t.tenantId, t.brandId, t.periodMonth),
    index('ix_report_updated').on(t.tenantId, t.brandId, t.updatedAt),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_report_brand',
    }),
  ],
);

/** Per brand: whether a draft should be made on the 1st of each month (a stored preference; no job acts on it yet). */
export const reportPreferences = mysqlTable(
  'report_preferences',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    autoDraft: boolean('auto_draft').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_report_preference_tbi').on(t.tenantId, t.brandId, t.id),
    uniqueIndex('uq_report_preference_brand').on(t.tenantId, t.brandId),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_report_preference_brand',
    }),
  ],
);
