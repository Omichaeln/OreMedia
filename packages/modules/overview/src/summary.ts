import type { z } from 'zod';
import { DESTINATION_KIND_CAPABILITIES } from '@oremedia/contracts/destinations';
import { COMPARISON_MINIMUM_SAMPLE } from '@oremedia/contracts/measurement';
import { OverviewSummary, type OverviewSourceV1, type OverviewSummaryV1 } from '@oremedia/contracts/overview';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { destinationReportService, destinationService, seoAuditService } from '@oremedia/module-destinations';
import { definitionService, metricService, releasedPublications } from '@oremedia/module-measurement';
import { channelService } from '@oremedia/module-publishing';
import {
  auditSourceOf,
  channelSource,
  limitsOf,
  socialOf,
  splitsOf,
  webSourceOf,
  type ReleasedPublication,
} from './compose';

/**
 * R2-5 read model: the overview composes the other modules' public services (never their tables, spec 4.2) and
 * applies the rules in compose.ts. brand.read on the brand; a foreign brand is NOT_FOUND. Each composed service
 * asserts its own action (insight.read for the social numbers), so a role without it reads the same refusal the
 * Performance screen would.
 */
const DAY_MS = 86_400_000;
/** The query's own bound (MetricsQuery: metricKeys ≤ 50); the subjects are the window's whole population. */
const KEYS_MAX = 50;

export interface OverviewQueryOptions {
  now?: () => Date;
}

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};

/** The inclusive UTC day keys of a datetime window (the web sources report by calendar day). */
const dayWindow = (windowStart: string, windowEnd: string) => {
  const start = windowStart.slice(0, 10);
  const end = windowEnd.slice(0, 10);
  const length = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  return { start, end, length: Math.max(1, length) };
};

/** Released channel publications of a window, every one of them (the measurement source reads to the end). */
const released = async (brandId: string, from: Date, to: Date, tx?: Tx): Promise<ReleasedPublication[]> =>
  (await releasedPublications(brandId, from, to, tx)).map((p) => ({
    publicationId: p.publicationId,
    channelConnectionId: p.channelConnectionId,
  }));

export function createOverviewService(opts: OverviewQueryOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const service = {
    async summary(
      actor: ResolvedActor,
      input: z.infer<typeof OverviewSummary>,
      tx?: Tx,
    ): Promise<OverviewSummaryV1> {
      const parsed = OverviewSummary.parse(input);
      await brandService.assertExist([parsed.brandId], tx); // a foreign brand does not exist (spec 5.3)
      await policy.assert(actor, 'brand.read', brandResource(parsed.brandId), {}, tx);
      const at = now();
      const windowStart = new Date(parsed.windowStart);
      const windowEnd = new Date(parsed.windowEnd);
      const length = windowEnd.getTime() - windowStart.getTime();
      const days = dayWindow(parsed.windowStart, parsed.windowEnd);
      const brandId = parsed.brandId;

      // The independent reads at once: the brand rollup (UX-11, which counts the window's posts but not per
      // channel), the channels, both windows' released publications (the measurement source, read whole), the
      // dictionary, the destinations and the sources this deployment lists.
      const [brandSummary, channels, current, previous, definitions, destinations, sources] =
        await Promise.all([
          metricService.brandSummary(
            actor,
            {
              brandId,
              windowStart: parsed.windowStart,
              windowEnd: parsed.windowEnd,
              ...(parsed.ageDays ? { ageDays: parsed.ageDays } : {}),
            },
            tx,
          ),
          channelService.list(actor, { brandId }, tx),
          released(brandId, windowStart, windowEnd, tx),
          released(
            brandId,
            new Date(windowStart.getTime() - length),
            new Date(windowStart.getTime() - 1),
            tx,
          ),
          definitionService.list(actor, {}, tx),
          destinationService.list(actor, { brandId }, tx),
          destinationService.sources.list(),
        ]);

      // (a) social: the rollup's figures and, per channel, every released post of the window with its latest
      // values (the population query reads them in chunks: no newest-200 cut).
      const social = socialOf(brandSummary);
      const providers = new Set(channels.map((c) => c.providerKey));
      const keys = [
        ...new Set(
          definitions
            .filter(
              (d) => d.aggregation !== 'series' && (d.providerKey === null || providers.has(d.providerKey)),
            )
            .map((d) => d.key),
        ),
      ].slice(0, KEYS_MAX);
      const values =
        current.length > 0 && keys.length > 0
          ? (
              await metricService.queryPopulation(
                actor,
                {
                  brandId,
                  subjectType: 'publication',
                  subjectIds: current.map((p) => p.publicationId),
                  metricKeys: keys,
                  windowStart: parsed.windowStart,
                  windowEnd: parsed.windowEnd,
                  grouping: 'subject',
                  ...(parsed.ageDays ? { ageDays: parsed.ageDays } : {}),
                },
                tx,
              )
            ).values
          : [];
      const composed: OverviewSourceV1[] = channels.map((c) =>
        channelSource(c, current, previous, values, COMPARISON_MINIMUM_SAMPLE),
      );

      // (b), (c) web sources and audits: every active destination whose kind is auditable or has a report source,
      // their summaries read at once.
      const active = destinations.items.filter((d) => d.status === 'active');
      const listed = sources.items;
      const listedKinds = new Set(listed.map((s) => s.kind));
      const uncertified: Array<{ kind: string; label: string }> = [];
      for (const d of active) {
        const source = listed.find((s) => s.kind === d.kind);
        if (source && !source.certified && !uncertified.some((u) => u.kind === d.kind))
          uncertified.push({ kind: d.kind, label: source.label });
      }
      const audits = await Promise.all(
        active
          .filter((d) => DESTINATION_KIND_CAPABILITIES[d.kind]?.auditable)
          .map(async (d) =>
            auditSourceOf(d, await seoAuditService.summary(actor, { brandId, destinationId: d.id }, tx), at),
          ),
      );
      const reports = await Promise.all(
        active
          .filter((d) => !DESTINATION_KIND_CAPABILITIES[d.kind]?.auditable && listedKinds.has(d.kind))
          .map(async (d) => ({
            destination: d,
            summary: await destinationReportService.summary(
              actor,
              { brandId, destinationId: d.id, windowStart: parsed.windowStart, windowEnd: parsed.windowEnd },
              tx,
            ),
          })),
      );
      const web = reports
        .filter((r) => r.summary.presentation !== null) // a kind without a registered report source
        .map((r) => webSourceOf(r.destination, r.summary, days.length));
      composed.push(...audits.map((a) => a.source), ...web.map((w) => w.source));

      const splits = splitsOf(social, definitions);
      return {
        brandId,
        windowStart: parsed.windowStart,
        windowEnd: parsed.windowEnd,
        days,
        social,
        web: web.map((w) => w.entry),
        audits: audits.map((a) => a.entry),
        sources: composed,
        organicVsPaid: splits.organicVsPaid,
        oremediaVsNative: splits.oremediaVsNative,
        limits: limitsOf({
          sources: composed,
          web: web.map((w) => w.entry),
          audits: audits.map((a) => a.entry),
          social,
          splits,
          uncertified,
        }),
        computedAt: at.toISOString(),
      };
    },
  };
  return service;
}

export const overviewService = createOverviewService();
