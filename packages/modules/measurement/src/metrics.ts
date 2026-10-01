import type { z } from 'zod';
import { NotFoundError } from '@oremedia/contracts/errors';
import {
  BrandPerformanceSummary,
  COMPARISON_MINIMUM_SAMPLE,
  EngagementQualityGet,
  MetricsQueryV1,
  type MetricAggregateV1,
  type MetricValueV1,
} from '@oremedia/contracts/measurement';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { Tx } from '@oremedia/db';
import { policy } from '@oremedia/module-access';
import { BrandObjectiveRepository } from '@oremedia/module-brand';
import { PublicationRepository } from '@oremedia/module-publishing';
import { brandResource, latencyHoursFor, providerKeyOfSource } from './common';
import { definitionService } from './definitions';
import { assertBrandExists, releasedPublications } from './hooks';
import {
  aggregateByComparableGroup,
  ageWindowSeconds,
  atAge,
  comparableGroupFor,
  coverageOf,
  freshnessOf,
  latestPerSubjectMetric,
} from './normalise';
import { engagementQuality, type QualityComponent, type QualityComponentInput } from './quality';
import {
  ConversationRepository,
  MessageRepository,
  MetricDefinitionRepository,
  MetricSnapshotRepository,
} from './repositories';

/**
 * Spec 15.2 query surface: values with freshness and completeness, aggregates only within a comparable_group,
 * and a coverage statement with every result. Spec 15.3: the engagement quality composite with drill-down.
 */
const snapshotsRepo = new MetricSnapshotRepository();
const definitionsRepo = new MetricDefinitionRepository();
const conversationsRepo = new ConversationRepository();
const messagesRepo = new MessageRepository();
const objectivesRepo = new BrandObjectiveRepository();
const publicationsRepo = new PublicationRepository();

export interface MetricsQueryOptions {
  now?: () => Date;
}

type SnapshotRow = Awaited<ReturnType<MetricSnapshotRepository['getById']>>;

async function toValues(rows: SnapshotRow[], now: Date, tx?: Tx): Promise<MetricValueV1[]> {
  const groups = new Map<string, string>();
  const out: MetricValueV1[] = [];
  for (const s of rows) {
    const providerKey = providerKeyOfSource(s.source);
    const cacheKey = `${s.metricKey}@${providerKey}`;
    let comparableGroup = groups.get(cacheKey);
    if (!comparableGroup) {
      const definition =
        (await definitionService.resolve(s.metricKey, providerKey, tx)) ??
        (await definitionService.resolve(s.metricKey, null, tx));
      comparableGroup = definition?.comparableGroup ?? comparableGroupFor(s.metricKey);
      groups.set(cacheKey, comparableGroup);
    }
    out.push({
      snapshotId: s.id,
      subjectType: s.subjectType,
      subjectId: s.subjectId,
      metricKey: s.metricKey,
      comparableGroup,
      value: s.value,
      series: s.series ?? null,
      completeness: s.completeness,
      freshness: freshnessOf(s.fetchedAt, latencyHoursFor(providerKey), now),
      source: s.source,
      definitionVersion: s.definitionVersion,
      windowStart: s.windowStart.toISOString(),
      windowEnd: s.windowEnd.toISOString(),
      brandTimezone: s.brandTimezone,
      numeratorSnapshotId: s.numeratorSnapshotId,
      denominatorSnapshotId: s.denominatorSnapshotId,
    });
  }
  return out;
}

const groupBy = <T>(items: T[], key: (t: T) => string): Array<{ key: string; values: T[] }> => {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return [...m.entries()].map(([k, values]) => ({ key: k, values }));
};

/** The query's own bounds (MetricsQuery: subjectIds ≤ 200, metricKeys ≤ 50). */
const SUBJECTS_MAX = 200;
const KEYS_MAX = 50;

export function createMetricService(opts: MetricsQueryOptions = {}) {
  const now = opts.now ?? (() => new Date());
  /**
   * The scalar metric keys the register holds (every provider's, the derived rates); the brand's connected
   * providers decide which carry numbers. Rates and flows first, so the cap keeps what the rollup reads.
   */
  const scalarKeys = async (tx?: Tx) => {
    const defs = (await definitionsRepo.list(undefined, tx)).filter((d) => d.aggregation !== 'series');
    const rank = (group: string) => (group.startsWith('rate:') ? 0 : group.startsWith('other:') ? 2 : 1);
    return [
      ...new Set(defs.sort((a, b) => rank(a.comparableGroup) - rank(b.comparableGroup)).map((d) => d.key)),
    ].slice(0, KEYS_MAX);
  };
  const service = {
    /**
     * insight.read on the brand; the latest fetch per (subject, metric) inside the range is the number, or with
     * `ageDays` the post's total at that age (normalise.atAge).
     */
    async query(actor: ResolvedActor, input: z.infer<typeof MetricsQueryV1>, tx?: Tx) {
      const parsed = MetricsQueryV1.parse(input);
      await assertBrandExists(parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(parsed.brandId), {}, tx);
      const windowStart = new Date(parsed.windowStart);
      const windowEnd = new Date(parsed.windowEnd);
      const snapshots = await snapshotsRepo.listForQuery(
        parsed.brandId,
        parsed.subjectType,
        parsed.subjectIds,
        parsed.metricKeys,
        windowStart,
        windowEnd,
        tx,
        parsed.ageDays ? ageWindowSeconds(parsed.ageDays) : undefined,
      );
      const rows = parsed.ageDays ? atAge(snapshots, parsed.ageDays) : latestPerSubjectMetric(snapshots);
      const at = now();
      const values = await toValues(rows, at, tx);
      const coverage = coverageOf(values, {
        subjectIds: parsed.subjectIds,
        metricKeys: parsed.metricKeys,
        windowStart,
        windowEnd,
      });
      let aggregates: MetricAggregateV1[] = [];
      let groups: Array<{ key: string; values: MetricValueV1[] }>;
      switch (parsed.grouping) {
        case 'comparable_group':
          aggregates = aggregateByComparableGroup(values);
          groups = groupBy(values, (v) => v.comparableGroup);
          break;
        case 'metric':
          groups = groupBy(values, (v) => v.metricKey);
          break;
        default:
          groups = groupBy(values, (v) => v.subjectId);
      }
      return {
        grouping: parsed.grouping,
        values,
        groups,
        aggregates,
        coverage,
        computedAt: at.toISOString(),
      };
    },

    /**
     * Per publication, the engagement and impressions flows (summed within their groups, D-15) the attribute
     * aggregate pools; a publication with no impressions number is left out (never zero). insight.read is asserted
     * by the query it runs.
     */
    async brandOutcomes(
      actor: ResolvedActor,
      brandId: string,
      publicationIds: string[],
      windowStart: Date,
      windowEnd: Date,
      tx?: Tx,
    ): Promise<Map<string, { engagement: number; impressions: number }>> {
      const out = new Map<string, { engagement: number; impressions: number }>();
      const keys = await scalarKeys(tx);
      if (publicationIds.length === 0 || keys.length === 0) return out;
      const result = await service.query(
        actor,
        {
          brandId,
          subjectType: 'publication',
          subjectIds: publicationIds.slice(0, SUBJECTS_MAX),
          metricKeys: keys,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          grouping: 'subject',
        },
        tx,
      );
      for (const v of result.values) {
        if (v.series !== null || v.value === null || v.completeness === 'unavailable') continue;
        if (v.comparableGroup !== 'engagement' && v.comparableGroup !== 'impressions') continue;
        const cell = out.get(v.subjectId) ?? { engagement: 0, impressions: 0 };
        if (v.comparableGroup === 'engagement') cell.engagement += v.value;
        else cell.impressions += v.value;
        out.set(v.subjectId, cell);
      }
      for (const [id, cell] of out) if (cell.impressions === 0) out.delete(id);
      return out;
    },

    /**
     * UX-11 (D-14, D-15): the brand's released publications in the window and the aggregates over them, with the
     * previous window of equal length for comparison at the same post age. Flows and pooled rates compare; unique
     * counts, levels and gauges are listed, never summed. Below the minimum sample on either side the comparison
     * reads insufficient. insight.read on the brand; a foreign brand is NOT_FOUND.
     */
    async brandSummary(actor: ResolvedActor, input: z.infer<typeof BrandPerformanceSummary>, tx?: Tx) {
      const parsed = BrandPerformanceSummary.parse(input);
      await assertBrandExists(parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(parsed.brandId), {}, tx);
      const windowStart = new Date(parsed.windowStart);
      const windowEnd = new Date(parsed.windowEnd);
      const length = windowEnd.getTime() - windowStart.getTime();
      const keys = await scalarKeys(tx);
      const window = async (from: Date, to: Date) => {
        const publications = (await releasedPublications(parsed.brandId, from, to, tx)).slice(
          0,
          SUBJECTS_MAX,
        );
        if (publications.length === 0 || keys.length === 0)
          return {
            windowStart: from.toISOString(),
            windowEnd: to.toISOString(),
            publications: publications.length,
            aggregates: [] as MetricAggregateV1[],
            coverage: coverageOf([], { subjectIds: [], metricKeys: keys, windowStart: from, windowEnd: to }),
          };
        const result = await service.query(
          actor,
          {
            brandId: parsed.brandId,
            subjectType: 'publication',
            subjectIds: publications.map((p) => p.publicationId),
            metricKeys: keys,
            windowStart: from.toISOString(),
            windowEnd: to.toISOString(),
            grouping: 'comparable_group',
            ...(parsed.ageDays ? { ageDays: parsed.ageDays } : {}),
          },
          tx,
        );
        return {
          windowStart: from.toISOString(),
          windowEnd: to.toISOString(),
          publications: publications.length,
          aggregates: result.aggregates,
          coverage: result.coverage,
        };
      };
      const current = await window(windowStart, windowEnd);
      const previous = await window(
        new Date(windowStart.getTime() - length),
        new Date(windowStart.getTime() - 1),
      );
      const sufficient =
        current.publications >= COMPARISON_MINIMUM_SAMPLE &&
        previous.publications >= COMPARISON_MINIMUM_SAMPLE;
      const comparison = current.aggregates
        .filter((a) => a.kind === 'flow' || a.kind === 'rate')
        .map((a) => {
          const before = previous.aggregates.find((b) => b.comparableGroup === a.comparableGroup) ?? null;
          const change =
            sufficient && a.value !== null && before && before.value !== null && before.value > 0
              ? (a.value - before.value) / before.value
              : null;
          return {
            comparableGroup: a.comparableGroup,
            kind: a.kind,
            current: a.value,
            previous: before ? before.value : null,
            change,
          };
        });
      return {
        brandId: parsed.brandId,
        ageDays: parsed.ageDays ?? null,
        current,
        previous,
        comparison,
        sample: {
          current: current.publications,
          previous: previous.publications,
          minimum: COMPARISON_MINIMUM_SAMPLE,
          sufficient,
        },
        computedAt: now().toISOString(),
      };
    },

    /**
     * Spec 15.3: saves, shares and negative feedback from the latest snapshots of the publication; substantive
     * comments and repeat engagers from the ingested messages (classification by the intelligence module); weights
     * from the brand's active objective (engagement_quality_weights), default equal.
     */
    async quality(actor: ResolvedActor, input: z.infer<typeof EngagementQualityGet>, tx?: Tx) {
      const parsed = EngagementQualityGet.parse(input);
      await assertBrandExists(parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(parsed.brandId), {}, tx);
      const publication = await publicationsRepo.getById(parsed.publicationId, tx);
      if (publication.brandId !== parsed.brandId)
        throw new NotFoundError('Publication', parsed.publicationId);
      const at = now();
      const windowStart = new Date(parsed.windowStart);
      const windowEnd = new Date(parsed.windowEnd);
      const rows = latestPerSubjectMetric(
        await snapshotsRepo.listForQuery(
          parsed.brandId,
          'publication',
          [publication.id],
          await allMetricKeys(parsed.brandId, publication.id, windowStart, windowEnd, tx),
          windowStart,
          windowEnd,
          tx,
        ),
      );
      const values = await toValues(rows, at, tx);
      const fromGroup = (group: string): QualityComponentInput => {
        const list = values.filter(
          (v) =>
            v.comparableGroup === group &&
            v.series === null &&
            v.completeness !== 'unavailable' &&
            v.value !== null,
        );
        if (list.length === 0) return { value: null, evidence: [] };
        return {
          value: list.reduce((s, v) => s + (v.value as number), 0),
          evidence: list.map((v) => v.snapshotId),
        };
      };
      const impressions = fromGroup('impressions');
      const conversations = await conversationsRepo.listForPublication(parsed.brandId, publication.id, tx);
      // Customer comments only: the brand's own replies (outbound) are neither engagement nor a repeat engager.
      const messages = (
        await messagesRepo.listForConversations(
          parsed.brandId,
          conversations.map((c) => c.id),
          tx,
        )
      ).filter((m) => m.direction === 'inbound');
      const classified = messages.filter((m) => m.substantive !== null);
      const substantive = classified.filter((m) => m.substantive === 'yes');
      const byAuthor = new Map<string, number>();
      for (const m of messages) byAuthor.set(m.authorHash, (byAuthor.get(m.authorHash) ?? 0) + 1);
      const repeat = [...byAuthor.entries()].filter(([, n]) => n > 1);
      const inputs: Record<QualityComponent, QualityComponentInput> = {
        saves: fromGroup('saves'),
        shares: fromGroup('shares'),
        substantive_comments:
          classified.length === 0
            ? { value: null, evidence: [] }
            : { value: substantive.length, evidence: substantive.map((m) => m.id) },
        repeat_engagers:
          messages.length === 0
            ? { value: null, evidence: [] }
            : { value: repeat.length, evidence: repeat.map(([hash]) => hash) },
        negative_feedback: fromGroup('negative_feedback'),
      };
      const objective = (await objectivesRepo.listActive(parsed.brandId, at, tx)).find(
        (o) => o.engagementQualityWeights,
      );
      const result = engagementQuality(
        inputs,
        objective?.engagementQualityWeights ?? null,
        impressions.value,
      );
      return {
        publicationId: publication.id,
        objectiveId: objective?.id ?? null,
        ...result,
        freshness: values.map((v) => ({ metricKey: v.metricKey, ...v.freshness })),
        coverage: coverageOf(values, {
          subjectIds: [publication.id],
          metricKeys: [...new Set(values.map((v) => v.metricKey))],
          windowStart,
          windowEnd,
        }),
        computedAt: at.toISOString(),
      };
    },
  };
  return service;
}

/** The metric keys with any snapshot for the publication in the window (the composite reads them all). */
async function allMetricKeys(brandId: string, publicationId: string, from: Date, to: Date, tx?: Tx) {
  const keys = new Set<string>();
  for (const s of await snapshotsRepo.listKeysForSubject(brandId, 'publication', publicationId, from, to, tx))
    keys.add(s);
  return keys.size ? [...keys] : ['__none__'];
}

export const metricService = createMetricService();
