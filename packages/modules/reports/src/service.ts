import type { z } from 'zod';
import { BudgetExhaustedError, ConflictError, NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  REPORT_SECTIONS,
  REPORT_TREND_MONTHS,
  ReportAdditionOutput,
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
  type ReportDraftBlocker,
  type ReportDraftRequestV1,
  type ReportDraftUnavailableV1,
  type ReportDrafterDescriptionV1,
  type ReportFiguresV1,
  type ReportPreferencesV1,
  type ReportSection,
  type ReportSummaryDraftV1,
  type ReportV1,
} from '@oremedia/contracts/reports';
import { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { budgets, entitlements } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import { intelligenceService } from '@oremedia/module-intelligence';
import {
  attributeService,
  definitionService,
  metricService,
  releasedPublications,
} from '@oremedia/module-measurement';
import { audit, killSwitch } from '@oremedia/module-operations';
import { channelService } from '@oremedia/module-publishing';
import { logger } from '@oremedia/observability';
import {
  compareMonthOf,
  composeFigures,
  factsOf,
  monthLabel,
  monthShort,
  monthWindow,
  shiftMonth,
  type ReportPublication,
  type WindowData,
} from './figures';
import { reportDrafter } from './hooks';
import { ReportPreferenceRepository, ReportRepository } from './repositories';

const reportsRepo = new ReportRepository();
const preferencesRepo = new ReportPreferenceRepository();

type ReportRow = Awaited<ReturnType<ReportRepository['getById']>>;

/** The query's own bound (MetricsQuery: metricKeys ≤ 50); the subjects are the month's whole population. */
const KEYS_MAX = 50;
/** A drafting reservation outlives the longest model timeout. */
const RESERVATION_TTL_MS = 2 * 3_600_000;
/** The bound on a draft's answer: a summary is a paragraph, an addition one to three sentences. */
const SUMMARY_OUTPUT_TOKENS = 600;
const ADDITION_OUTPUT_TOKENS = 400;
/** A rough prompt size for the estimate: the facts and the voice, four characters a token, plus the frame. */
const PROMPT_FRAME_TOKENS = 700;

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

const toDto = (r: ReportRow): ReportV1 => ({
  id: r.id,
  brandId: r.brandId,
  periodMonth: r.periodMonth,
  compareMode: r.compareMode,
  sections: REPORT_SECTIONS.filter((s) => r.sections.includes(s)),
  executiveSummary: r.executiveSummary,
  recommendations: r.recommendations,
  preparedFor: r.preparedFor,
  preparedBy: r.preparedBy,
  theme: r.theme,
  state: r.state,
  sentAt: iso(r.sentAt),
  sentTo: r.sentTo,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  version: r.version,
});

/** The sections in page order, as the save keeps them (the builder sends them in any order). */
const orderedSections = (sections: readonly ReportSection[]): ReportSection[] =>
  REPORT_SECTIONS.filter((s) => sections.includes(s));

export interface ReportsServiceOptions {
  now?: () => Date;
}

/**
 * D-29 reports: the stored builder state per brand and month (reports), the per-brand preference, the figures
 * composed from the measurement, publishing and intelligence modules' public services (never their tables, spec
 * 4.2) under the rules in figures.ts, and the executive summary and assistant drafted through the registered model
 * gateway within the brand's budgets and policy. brand.read reads; report.edit saves and drafts; report.send
 * records a send. A foreign brand is NOT_FOUND (spec 5.3).
 */
export function createReportsService(opts: ReportsServiceOptions = {}) {
  const now = opts.now ?? (() => new Date());

  /** The month's released channel publications with their latest values, read whole (chunked by the query). */
  const windowData = async (
    actor: ResolvedActor,
    brandId: string,
    periodMonth: string,
    timeZone: string,
    keys: string[],
    tx?: Tx,
  ): Promise<WindowData> => {
    const { start, end } = monthWindow(periodMonth, timeZone);
    const publications: ReportPublication[] = (await releasedPublications(brandId, start, end, tx)).map((p) => ({
      publicationId: p.publicationId,
      contentRevisionId: p.contentRevisionId,
      channelConnectionId: p.channelConnectionId,
      scheduledFor: p.scheduledFor,
    }));
    const values =
      publications.length > 0 && keys.length > 0
        ? (
            await metricService.queryPopulation(
              actor,
              {
                brandId,
                subjectType: 'publication',
                subjectIds: publications.map((p) => p.publicationId),
                metricKeys: keys,
                windowStart: start.toISOString(),
                windowEnd: end.toISOString(),
                grouping: 'subject',
              },
              tx,
            )
          ).values
        : [];
    return { publications, values };
  };

  /** The published brand system's voice, for the drafting prompt; empty when nothing is published. */
  const voiceOf = async (
    actor: ResolvedActor,
    brand: { id: string; publishedVersionId: string | null },
    tx?: Tx,
  ) => {
    if (!brand.publishedVersionId) return { summary: '', tone: [], prohibitedPhrases: [] };
    const version = await brandService.versions.get(
      actor,
      { brandId: brand.id, versionId: brand.publishedVersionId },
      tx,
    );
    const document = BrandSystemDocumentV1.parse(version.document);
    return {
      summary: document.voice.summary,
      tone: document.voice.tone,
      prohibitedPhrases: document.voice.prohibitedPhrases,
    };
  };

  const estimateMicros = (model: ReportDrafterDescriptionV1, req: ReportDraftRequestV1): number => {
    const inputTokens =
      PROMPT_FRAME_TOKENS +
      Math.ceil(
        (req.facts.join('\n').length + req.voice.summary.length + (req.instruction?.length ?? 0)) / 4,
      );
    return Math.ceil(
      (inputTokens * model.inputMicrosPerMillionTokens + req.maxOutputTokens * model.outputMicrosPerMillionTokens) /
        1_000_000,
    );
  };

  const unavailable = (reason: ReportDraftBlocker, message: string): ReportDraftUnavailableV1 => ({
    available: false,
    reason,
    message,
  });

  /**
   * One bounded model call under the same gates brand assist applies (kill switch, routing policy, entitlement,
   * budget reservation before the call and the incurred cost charged after it). A gate that holds returns why,
   * never throws: the summary stays a text field and the assistant says what is missing.
   */
  const callDrafter = async (
    brandId: string,
    req: ReportDraftRequestV1,
    tx?: Tx,
  ): Promise<ReportDraftUnavailableV1 | { available: true; text: string; model: string; costMicros: number }> => {
    const drafter = reportDrafter();
    if (!drafter) return unavailable('model_unavailable', 'No AI model is configured for this service.');
    const { tenantId } = requireTenant();
    if (await killSwitch.isOn('agent_starts', brandId, tx))
      return unavailable('kill_switch_engaged', 'AI work is paused for this brand by an owner or admin.');
    try {
      await drafter.assertRouting(tenantId);
    } catch (err) {
      if (!(err instanceof PolicyDeniedError)) throw err;
      return unavailable(
        'model_routing_denied',
        `${err.message}; an owner or admin changes the model routing policy under Settings.`,
      );
    }
    const entitlement = await entitlements.check(tenantId, 'generation_budget_micros_month', tx);
    if (!entitlement.allowed)
      return unavailable('entitlement_exhausted', "The plan's AI budget for this month is used up.");
    const model = drafter.describe();
    const estimate = estimateMicros(model, req);
    let reservation;
    try {
      reservation = await budgets.reserveSpend(
        brandId,
        req.requestId,
        estimate,
        new Date(now().getTime() + RESERVATION_TTL_MS),
      );
    } catch (err) {
      if (err instanceof BudgetExhaustedError)
        return unavailable('budget_exhausted', "The brand's remaining AI budget is below what this draft would reserve.");
      throw err;
    }
    let result;
    try {
      result = await drafter.draft(req);
    } catch (err) {
      await budgets.settle(req.requestId);
      logger().warn(
        { errorMessage: err instanceof Error ? err.message : String(err), requestId: req.requestId },
        'report draft: model call failed',
      );
      return unavailable('model_failed', 'The model did not answer; write the text yourself or try again.');
    }
    // Cost already incurred is charged before anything else is decided (spec 12.6); one key per call.
    await budgets.consumeIncurred(
      reservation.id,
      brandId,
      'model_tokens',
      result.usage.inputTokens + result.usage.outputTokens,
      'tokens',
      result.costMicros,
      `report-draft:${req.requestId}`,
      `report-draft:${req.requestId}`,
    );
    await budgets.settle(req.requestId);
    return { available: true, text: result.text, model: model.model, costMicros: result.costMicros };
  };

  const draftRequest = (
    kind: ReportDraftRequestV1['kind'],
    brand: { name: string },
    figures: ReportFiguresV1,
    voice: ReportDraftRequestV1['voice'],
    instruction: string | null,
  ): ReportDraftRequestV1 => ({
    tenantId: requireTenant().tenantId,
    requestId: newId('report'),
    kind,
    brandName: brand.name,
    periodLabel: monthLabel(figures.periodMonth),
    compareLabel:
      figures.compareMode === 'last_year'
        ? monthShort(figures.compareMonth, true)
        : monthShort(figures.compareMonth),
    voice,
    facts: factsOf(figures),
    instruction,
    maxOutputTokens: kind === 'summary' ? SUMMARY_OUTPUT_TOKENS : ADDITION_OUTPUT_TOKENS,
  });

  const service = {
    /** The brand's reports newest first (brand.read via brandService.get; a foreign brand is NOT_FOUND). */
    async list(actor: ResolvedActor, input: z.infer<typeof ReportList>, tx?: Tx) {
      const parsed = ReportList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      const page = await reportsRepo.list(brand.id, parsed.page, tx);
      return { items: page.items.map(toDto), nextCursor: page.nextCursor };
    },

    /** The brand's report for a month, or null when none was saved yet (the builder then shows the defaults). */
    async get(actor: ResolvedActor, input: z.infer<typeof ReportGet>, tx?: Tx): Promise<ReportV1 | null> {
      const parsed = ReportGet.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      const row = await reportsRepo.findForMonth(brand.id, parsed.periodMonth, tx);
      return row ? toDto(row) : null;
    },

    /**
     * Save draft: creates the month's report (expectedVersion null) or updates it at the expected version
     * (optimistic concurrency, spec 7.3). A month that already has a report cannot be created twice: CONFLICT.
     */
    async save(actor: ResolvedActor, input: z.infer<typeof ReportSave>, tx: Tx): Promise<ReportV1> {
      const parsed = ReportSave.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'report.edit', brandResource(brand.id), {}, tx);
      const existing = await reportsRepo.findForMonth(brand.id, parsed.periodMonth, tx);
      const fields = { ...parsed.fields, sections: orderedSections(parsed.fields.sections) };
      if (parsed.expectedVersion === null) {
        if (existing) throw new ConflictError('Report', existing.id, existing.version);
        const id = newId('report');
        await reportsRepo.create({ id, brandId: brand.id, periodMonth: parsed.periodMonth, ...fields }, tx);
        return toDto(await reportsRepo.getById(id, tx));
      }
      if (!existing) throw new NotFoundError('Report', `${parsed.brandId}:${parsed.periodMonth}`);
      await reportsRepo.update(existing.id, parsed.expectedVersion, fields, tx);
      return toDto(await reportsRepo.getById(existing.id, tx));
    },

    /**
     * "Send to client" on this deployment: no delivery exists (no mail service, no report link path), so the send is
     * recorded by the person who made it (state sent, to whom, when) and audited; nothing claims to have sent mail.
     */
    async markSent(actor: ResolvedActor, input: z.infer<typeof ReportMarkSent>, tx: Tx): Promise<ReportV1> {
      const parsed = ReportMarkSent.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'report.send', brandResource(brand.id), {}, tx);
      const row = await reportsRepo.getById(parsed.reportId, tx); // foreign → NOT_FOUND
      if (row.brandId !== brand.id) throw new NotFoundError('Report', parsed.reportId);
      const at = now();
      await reportsRepo.update(
        row.id,
        parsed.expectedVersion,
        {
          state: 'sent',
          sentAt: at,
          sentTo: parsed.sentTo,
          sentByUserId: actor.kind === 'user' ? actor.id : null,
        },
        tx,
      );
      await audit.record(actorRef(actor), 'report.mark_sent', { type: 'report', id: row.id }, 'allowed', tx, {
        brandId: brand.id,
        periodMonth: row.periodMonth,
        sentTo: parsed.sentTo,
      });
      return toDto(await reportsRepo.getById(row.id, tx));
    },

    /** What this deployment can do with a finished report; the controls read it rather than assume. */
    async delivery(actor: ResolvedActor, input: z.infer<typeof ReportDelivery>, tx?: Tx): Promise<ReportDeliveryV1> {
      const parsed = ReportDelivery.parse(input);
      await brandService.get(actor, parsed.brandId, tx);
      return {
        email: {
          configured: false,
          reason: 'Email delivery is not configured on this deployment: the platform has no mail service.',
        },
        link: {
          available: false,
          reason:
            'View-only report links are not available: external links exist for review requests only (spec 5.6).',
        },
        pdf: {
          method: 'print',
          note: 'Download PDF prints the report pages through the browser (A4, one page per section).',
        },
      };
    },

    preferences: {
      async get(
        actor: ResolvedActor,
        input: z.infer<typeof ReportPreferencesGet>,
        tx?: Tx,
      ): Promise<ReportPreferencesV1> {
        const parsed = ReportPreferencesGet.parse(input);
        const brand = await brandService.get(actor, parsed.brandId, tx);
        const row = await preferencesRepo.findForBrand(brand.id, tx);
        return { brandId: brand.id, autoDraft: row?.autoDraft ?? false, scheduleActive: false, version: row?.version ?? 0 };
      },
      /** The stored preference only: no job drafts on the 1st on this deployment yet, and the answer says so. */
      async set(
        actor: ResolvedActor,
        input: z.infer<typeof ReportPreferencesSet>,
        tx: Tx,
      ): Promise<ReportPreferencesV1> {
        const parsed = ReportPreferencesSet.parse(input);
        const brand = await brandService.get(actor, parsed.brandId, tx);
        await policy.assert(actor, 'report.edit', brandResource(brand.id), {}, tx);
        const row = await preferencesRepo.findForBrand(brand.id, tx);
        if (row) await preferencesRepo.update(row.id, row.version, { autoDraft: parsed.autoDraft }, tx);
        else
          await preferencesRepo.create(
            { id: newId('reportPreference'), brandId: brand.id, autoDraft: parsed.autoDraft },
            tx,
          );
        const saved = await preferencesRepo.findForBrand(brand.id, tx);
        return { brandId: brand.id, autoDraft: saved?.autoDraft ?? false, scheduleActive: false, version: saved?.version ?? 0 };
      },
    },

    /**
     * The report's figures for a month against its comparison month, composed from the measurement module's
     * per-publication values over the month's whole population (read in query-sized chunks), the publishing
     * module's channels, the attribute aggregate and the intelligence module's recommendations. brand.read on the
     * brand; the measurement reads assert insight.read, so a role without it reads the same refusal the
     * Performance screen would.
     */
    async figures(actor: ResolvedActor, input: z.infer<typeof ReportFigures>, tx?: Tx): Promise<ReportFiguresV1> {
      const parsed = ReportFigures.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand.id), {}, tx);
      const timeZone = brand.timezone || 'UTC';
      const compareMonth = compareMonthOf(parsed.periodMonth, parsed.compareMode);
      const [channels, definitions] = await Promise.all([
        channelService.list(actor, { brandId: brand.id }, tx),
        definitionService.list(actor, {}, tx),
      ]);
      // Flows and unique counts only: the rate is pooled here from the operands (spec 15.2), never read as a key.
      const providers = new Set(channels.map((c) => c.providerKey));
      const keys = [
        ...new Set(
          definitions
            .filter(
              (d) =>
                d.aggregation !== 'series' &&
                !d.comparableGroup.startsWith('rate:') &&
                (d.providerKey === null || providers.has(d.providerKey)),
            )
            .map((d) => d.key),
        ),
      ].slice(0, KEYS_MAX);
      const months = Array.from({ length: REPORT_TREND_MONTHS }, (_, i) =>
        shiftMonth(parsed.periodMonth, i - (REPORT_TREND_MONTHS - 1)),
      );
      const wanted = [...new Set([...months, compareMonth])];
      const read = new Map<string, WindowData>();
      await Promise.all(
        wanted.map(async (month) => {
          read.set(month, await windowData(actor, brand.id, month, timeZone, keys, tx));
        }),
      );
      const current = read.get(parsed.periodMonth) as WindowData;
      const previous = read.get(compareMonth) as WindowData;
      const window = monthWindow(parsed.periodMonth, timeZone);
      const [attributes, proposed, accepted] = await Promise.all([
        attributeService.aggregate(
          actor,
          { brandId: brand.id, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString() },
          tx,
        ),
        intelligenceService.recommendations.list(actor, { brandId: brand.id, state: 'proposed', page: { limit: 10 } }, tx),
        intelligenceService.recommendations.list(actor, { brandId: brand.id, state: 'accepted', page: { limit: 10 } }, tx),
      ]);
      return composeFigures({
        brand: { id: brand.id, name: brand.name, timeZone },
        periodMonth: parsed.periodMonth,
        compareMode: parsed.compareMode,
        current,
        previous,
        trend: months.map((month) => ({ month, data: read.get(month) as WindowData })),
        channels,
        formats: attributes.features,
        recommendations: [...proposed.items, ...accepted.items],
        computedAt: now(),
      });
    },

    /**
     * Re-draft: the executive summary written by the model over the computed figures only (the prompt forbids any
     * other number), in the brand's voice, labelled a draft and returned for the person to edit; never stored by
     * itself. report.edit on the brand. Unavailable (with the reason) rather than failed when a gate holds.
     */
    async draftSummary(
      actor: ResolvedActor,
      input: z.infer<typeof ReportDraftSummary>,
      tx?: Tx,
    ): Promise<ReportSummaryDraftV1 | ReportDraftUnavailableV1> {
      const parsed = ReportDraftSummary.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'report.edit', brandResource(brand.id), {}, tx);
      const figures = await service.figures(actor, parsed, tx);
      const req = draftRequest('summary', brand, figures, await voiceOf(actor, brand, tx), parsed.instruction ?? null);
      const outcome = await callDrafter(brand.id, req, tx);
      if (!outcome.available) return outcome;
      const text = outcome.text.trim();
      if (!text) return unavailable('model_failed', 'The model answered with nothing; write the text yourself or try again.');
      return { available: true, draft: true, text, model: outcome.model, costMicros: outcome.costMicros };
    },

    /**
     * The report assistant: what the person wants added, rewritten as client-ready prose over the computed figures
     * and placed in a section by the model; the person adds it (or not). report.edit on the brand.
     */
    async ask(
      actor: ResolvedActor,
      input: z.infer<typeof ReportAsk>,
      tx?: Tx,
    ): Promise<ReportAdditionV1 | ReportDraftUnavailableV1> {
      const parsed = ReportAsk.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'report.edit', brandResource(brand.id), {}, tx);
      const figures = await service.figures(actor, parsed, tx);
      const req = draftRequest('addition', brand, figures, await voiceOf(actor, brand, tx), parsed.question);
      const outcome = await callDrafter(brand.id, req, tx);
      if (!outcome.available) return outcome;
      const match = outcome.text.match(/\{[\s\S]*\}/);
      let answer: ReportAdditionOutput;
      try {
        answer = ReportAdditionOutput.parse(JSON.parse(match ? match[0] : outcome.text));
      } catch {
        return unavailable('model_failed', 'The model’s answer did not fit the expected shape; try rephrasing.');
      }
      return {
        available: true,
        draft: true,
        section: answer.section,
        text: answer.text.trim(),
        reply: answer.reply.trim(),
        model: outcome.model,
        costMicros: outcome.costMicros,
      };
    },
  };
  return service;
}

export const reportsService = createReportsService();
