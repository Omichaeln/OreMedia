import type { IncomingHttpHeaders } from 'node:http';
import { ConflictError, NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import { QUERY_SUBJECTS_MAX, type MetricValueV1 } from '@oremedia/contracts/measurement';
import {
  REPORT_SECTIONS,
  REPORT_TREND_MONTHS,
  ReportAsk,
  ReportDelivery,
  ReportDraftSummary,
  ReportFigures,
  ReportGet,
  ReportList,
  ReportMarkSent,
  ReportPreferencesGet,
  ReportPreferencesSet,
  ReportSave,
  type ReportAdditionV1,
  type ReportDeliveryV1,
  type ReportDraftUnavailableV1,
  type ReportFiguresV1,
  type ReportPreferencesV1,
  type ReportSummaryDraftV1,
  type ReportV1,
} from '@oremedia/contracts/reports';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import {
  compareMonthOf,
  composeFigures,
  factsOf,
  monthWindow,
  shiftMonth,
  type WindowData,
} from '@oremedia/module-reports';
import type { MockBuilders, MockMember, t } from './mock-api';

/**
 * Reports slice of the UI-only transport (see mock-api.ts): reports.figures composed, as apps/api composes it
 * (packages/modules/reports/src/service.ts), from the other mock routers' own procedures through callers (the
 * per-publication values from measurement, the channels from publishing, the month's publications from the
 * calendar, the recommendations from intelligence) with the module's own composition rules (figures.ts, pure and
 * contracts-only). The builder state and the send record live here; the model gateway is a scripted drafter the
 * tests can switch off to see the honest "unavailable" path. A test double, never a second implementation.
 */
export interface CallerCtx {
  headers: IncomingHttpHeaders;
  correlationId: string;
  member?: MockMember | null;
}
export interface ReportsCallers {
  measurement: (ctx: CallerCtx) => {
    metrics: {
      query: (input: {
        brandId: string;
        subjectType: 'publication';
        subjectIds: string[];
        metricKeys: string[];
        windowStart: string;
        windowEnd: string;
        grouping: 'subject';
      }) => Promise<{ values: MetricValueV1[] }>;
    };
    definitions: {
      list: (
        input: Record<string, never>,
      ) => Promise<Array<{ key: string; providerKey: string | null; aggregation: string; comparableGroup: string }>>;
    };
    attributes: {
      aggregate: (input: { brandId: string; windowStart: string; windowEnd: string }) => Promise<{
        features: Array<{ feature: string; value: string; publications: number; rate: number | null; sufficient: boolean }>;
      }>;
    };
  };
  publishing: (ctx: CallerCtx) => {
    channels: {
      list: (input: { brandId: string }) => Promise<Array<{ id: string; providerKey: string; displayName: string }>>;
    };
  };
  content: (ctx: CallerCtx) => {
    calendar: {
      range: (input: { brandId: string; from: string; to: string }) => Promise<{
        publications: Array<{
          publicationId: string;
          contentRevisionId: string;
          channelConnectionId: string | null;
          scheduledFor: string;
          state: string;
        }>;
      }>;
    };
  };
  intelligence: (ctx: CallerCtx) => {
    recommendations: {
      list: (input: { brandId: string; state?: 'proposed' | 'accepted'; page: { limit: number } }) => Promise<{
        items: Array<{
          id: string;
          title: string;
          rationale: string;
          state: string;
          expectedBenefit: { metricKey: string; direction: 'up' | 'down'; magnitude?: string };
          rank: number;
        }>;
      }>;
    };
  };
}

/** Roles holding report.edit and report.send (packages/domain role-grants). */
const EDIT_ROLES = new Set<MembershipRole>(['owner', 'admin', 'brand_manager', 'analyst']);
const SEND_ROLES = new Set<MembershipRole>(['owner', 'admin', 'brand_manager', 'publisher']);

let seq = 0;
const now = () => new Date().toISOString();

export class ReportsBackend {
  readonly reports = new Map<string, ReportV1>();
  preferences: ReportPreferencesV1;
  /** The scripted model gateway: on by default; off shows the honest "unavailable" path. */
  drafterAvailable = true;
  readonly drafts: Array<{ kind: 'summary' | 'addition'; facts: string[] }> = [];

  constructor(
    readonly brandId: string,
    readonly brandName: string,
    readonly role: () => MembershipRole,
    seed = true,
  ) {
    this.preferences = { brandId, autoDraft: false, scheduleActive: false, version: 0 };
    if (!seed) return;
    // A sent report two months back, as the Recent list shows one.
    const month = shiftMonth(new Date().toISOString().slice(0, 7), -2);
    const at = now();
    this.reports.set(month, {
      id: 'rpt_e2e_sent',
      brandId,
      periodMonth: month,
      compareMode: 'previous_month',
      sections: [...REPORT_SECTIONS],
      executiveSummary: 'A quiet month with steady impressions.',
      recommendations: '',
      preparedFor: 'Kofi Asare, Acme',
      preparedBy: 'E2E person, E2E company',
      theme: 'dark',
      state: 'sent',
      sentAt: at,
      sentTo: 'kofi@acme.example',
      createdAt: at,
      updatedAt: at,
      version: 2,
    });
  }

  brandOf(brandId: string) {
    if (brandId !== this.brandId) throw new NotFoundError('Brand', brandId);
  }
  assert(action: 'report.edit' | 'report.send') {
    const allowed = action === 'report.edit' ? EDIT_ROLES : SEND_ROLES;
    if (!allowed.has(this.role()))
      throw new PolicyDeniedError('role_missing', `Your role does not include ${action} for this brand`);
  }
}

interface ReportsBuilders {
  router: typeof t.router;
  query: MockBuilders['query'];
  mutation: MockBuilders['mutation'];
}

export function reportsRouters(b: ReportsBackend, { router, query, mutation }: ReportsBuilders, callers: ReportsCallers) {
  const unavailable = (): ReportDraftUnavailableV1 => ({
    available: false,
    reason: 'model_unavailable',
    message: 'No AI model is configured for this service.',
  });

  const figuresOf = async (ctx: CallerCtx, input: { brandId: string; periodMonth: string; compareMode: 'previous_month' | 'last_year' }): Promise<ReportFiguresV1> => {
    b.brandOf(input.brandId);
    const measurement = callers.measurement(ctx);
    const calendar = callers.content(ctx).calendar;
    const [channels, definitions] = await Promise.all([
      callers.publishing(ctx).channels.list({ brandId: input.brandId }),
      measurement.definitions.list({}),
    ]);
    const providers = new Set(channels.map((c) => c.providerKey));
    const keys = [
      ...new Set(
        definitions
          .filter((d) => d.aggregation !== 'series' && !d.comparableGroup.startsWith('rate:') && (d.providerKey === null || providers.has(d.providerKey)))
          .map((d) => d.key),
      ),
    ].slice(0, 50);
    const windowData = async (month: string): Promise<WindowData> => {
      const { start, end } = monthWindow(month, 'UTC');
      const range = await calendar.range({ brandId: input.brandId, from: start.toISOString(), to: end.toISOString() });
      const publications = range.publications.flatMap((p) =>
        p.channelConnectionId !== null && (p.state === 'published' || p.state === 'removed')
          ? [{ publicationId: p.publicationId, contentRevisionId: p.contentRevisionId, channelConnectionId: p.channelConnectionId, scheduledFor: p.scheduledFor }]
          : [],
      );
      const values: MetricValueV1[] = [];
      for (let i = 0; keys.length > 0 && i < publications.length; i += QUERY_SUBJECTS_MAX)
        values.push(
          ...(
            await measurement.metrics.query({
              brandId: input.brandId,
              subjectType: 'publication',
              subjectIds: publications.slice(i, i + QUERY_SUBJECTS_MAX).map((p) => p.publicationId),
              metricKeys: keys,
              windowStart: start.toISOString(),
              windowEnd: end.toISOString(),
              grouping: 'subject',
            })
          ).values,
        );
      return { publications, values };
    };
    const compareMonth = compareMonthOf(input.periodMonth, input.compareMode);
    const months = Array.from({ length: REPORT_TREND_MONTHS }, (_, i) => shiftMonth(input.periodMonth, i - (REPORT_TREND_MONTHS - 1)));
    const read = new Map<string, WindowData>();
    for (const month of new Set([...months, compareMonth])) read.set(month, await windowData(month));
    const window = monthWindow(input.periodMonth, 'UTC');
    const [attributes, proposed, accepted] = await Promise.all([
      measurement.attributes.aggregate({ brandId: input.brandId, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString() }),
      callers.intelligence(ctx).recommendations.list({ brandId: input.brandId, state: 'proposed', page: { limit: 10 } }),
      callers.intelligence(ctx).recommendations.list({ brandId: input.brandId, state: 'accepted', page: { limit: 10 } }),
    ]);
    return composeFigures({
      brand: { id: input.brandId, name: b.brandName, timeZone: 'UTC' },
      periodMonth: input.periodMonth,
      compareMode: input.compareMode,
      current: read.get(input.periodMonth) as WindowData,
      previous: read.get(compareMonth) as WindowData,
      trend: months.map((month) => ({ month, data: read.get(month) as WindowData })),
      channels,
      formats: attributes.features,
      recommendations: [...proposed.items, ...accepted.items],
      computedAt: new Date(),
    });
  };

  return router({
    list: query.input(ReportList).query(({ input }) => {
      b.brandOf(input.brandId);
      return { items: [...b.reports.values()].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)), nextCursor: null };
    }),
    get: query.input(ReportGet).query(({ input }) => {
      b.brandOf(input.brandId);
      return b.reports.get(input.periodMonth) ?? null;
    }),
    figures: query.input(ReportFigures).query(({ ctx, input }) => figuresOf(ctx, input)),
    delivery: query.input(ReportDelivery).query(({ input }): ReportDeliveryV1 => {
      b.brandOf(input.brandId);
      return {
        email: { configured: false, reason: 'Email delivery is not configured on this deployment: the platform has no mail service.' },
        link: { available: false, reason: 'View-only report links are not available: external links exist for review requests only (spec 5.6).' },
        pdf: { method: 'print', note: 'Download PDF prints the report pages through the browser (A4, one page per section).' },
      };
    }),
    save: mutation.input(ReportSave).mutation(({ input }): ReportV1 => {
      b.brandOf(input.brandId);
      b.assert('report.edit');
      const existing = b.reports.get(input.periodMonth) ?? null;
      const sections = REPORT_SECTIONS.filter((s) => input.fields.sections.includes(s));
      if (input.expectedVersion === null) {
        if (existing) throw new ConflictError('Report', existing.id, existing.version);
        const at = now();
        const row: ReportV1 = { id: `rpt_e2e_${++seq}`, brandId: input.brandId, periodMonth: input.periodMonth, ...input.fields, sections, state: 'draft', sentAt: null, sentTo: null, createdAt: at, updatedAt: at, version: 0 };
        b.reports.set(input.periodMonth, row);
        return row;
      }
      if (!existing) throw new NotFoundError('Report', input.periodMonth);
      if (existing.version !== input.expectedVersion) throw new ConflictError('Report', existing.id, input.expectedVersion);
      const row: ReportV1 = { ...existing, ...input.fields, sections, updatedAt: now(), version: existing.version + 1 };
      b.reports.set(input.periodMonth, row);
      return row;
    }),
    markSent: mutation.input(ReportMarkSent).mutation(({ input }): ReportV1 => {
      b.brandOf(input.brandId);
      b.assert('report.send');
      const existing = [...b.reports.values()].find((r) => r.id === input.reportId);
      if (!existing) throw new NotFoundError('Report', input.reportId);
      if (existing.version !== input.expectedVersion) throw new ConflictError('Report', existing.id, input.expectedVersion);
      const row: ReportV1 = { ...existing, state: 'sent', sentAt: now(), sentTo: input.sentTo, updatedAt: now(), version: existing.version + 1 };
      b.reports.set(existing.periodMonth, row);
      return row;
    }),
    draftSummary: mutation.input(ReportDraftSummary).mutation(async ({ ctx, input }): Promise<ReportSummaryDraftV1 | ReportDraftUnavailableV1> => {
      b.brandOf(input.brandId);
      b.assert('report.edit');
      if (!b.drafterAvailable) return unavailable();
      const facts = factsOf(await figuresOf(ctx, input));
      b.drafts.push({ kind: 'summary', facts });
      // The scripted draft repeats the facts it was given: nothing invented, as the real prompt demands.
      return { available: true, draft: true, text: `Draft: ${facts.slice(0, 3).join(' ')}`, model: 'fake-model', costMicros: 120 };
    }),
    ask: mutation.input(ReportAsk).mutation(async ({ ctx, input }): Promise<ReportAdditionV1 | ReportDraftUnavailableV1> => {
      b.brandOf(input.brandId);
      b.assert('report.edit');
      if (!b.drafterAvailable) return unavailable();
      const facts = factsOf(await figuresOf(ctx, input));
      b.drafts.push({ kind: 'addition', facts });
      const section = /recommend|should|next month/i.test(input.question) ? 'recommendations' : 'overview';
      return { available: true, draft: true, section, text: input.question.replace(/\.?$/, '.'), reply: `Placed under ${section}; tightened the wording.`, model: 'fake-model', costMicros: 80 };
    }),
    preferences: router({
      get: query.input(ReportPreferencesGet).query(({ input }) => {
        b.brandOf(input.brandId);
        return b.preferences;
      }),
      set: mutation.input(ReportPreferencesSet).mutation(({ input }) => {
        b.brandOf(input.brandId);
        b.assert('report.edit');
        b.preferences = { ...b.preferences, autoDraft: input.autoDraft, version: b.preferences.version + 1 };
        return b.preferences;
      }),
    }),
  });
}
