import type { z } from 'zod';
import { COMPARISON_MINIMUM_SAMPLE } from '@oremedia/contracts/measurement';
import { OverviewSummary, type OverviewSourceV1, type OverviewSummaryV1 } from '@oremedia/contracts/overview';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { SEO_AUDIT_DESTINATION_KIND } from '@oremedia/contracts/seo-audit';
import { requireTenant, type Tx } from '@oremedia/db';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { destinationReportService, destinationService, seoAuditService } from '@oremedia/module-destinations';
import { definitionService, metricService } from '@oremedia/module-measurement';
import { channelService, publicationService } from '@oremedia/module-publishing';
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
/** The query's own bounds (MetricsQuery: subjectIds ≤ 200, metricKeys ≤ 50). */
const SUBJECTS_MAX = 200;
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

const released = (
  publications: Array<{ publicationId: string; channelConnectionId: string | null; state: string }>,
): ReleasedPublication[] =>
  publications.flatMap((p) =>
    p.channelConnectionId !== null && (p.state === 'published' || p.state === 'removed')
      ? [{ publicationId: p.publicationId, channelConnectionId: p.channelConnectionId }]
      : [],
  );

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

      // (a) social: the brand rollup (UX-11) and, per channel, the window's released posts with their values.
      const brandSummary = await metricService.brandSummary(
        actor,
        {
          brandId: parsed.brandId,
          windowStart: parsed.windowStart,
          windowEnd: parsed.windowEnd,
          ...(parsed.ageDays ? { ageDays: parsed.ageDays } : {}),
        },
        tx,
      );
      const social = socialOf(brandSummary);
      const channels = await channelService.list(actor, { brandId: parsed.brandId }, tx);
      const current = released(
        await publicationService.calendarRange(parsed.brandId, windowStart, windowEnd, tx),
      ).slice(0, SUBJECTS_MAX);
      const previous = released(
        await publicationService.calendarRange(
          parsed.brandId,
          new Date(windowStart.getTime() - length),
          new Date(windowStart.getTime() - 1),
          tx,
        ),
      );
      const definitions = await definitionService.list(actor, {}, tx);
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
              await metricService.query(
                actor,
                {
                  brandId: parsed.brandId,
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
      const sources: OverviewSourceV1[] = channels.map((c) =>
        channelSource(c, current, previous, values, COMPARISON_MINIMUM_SAMPLE),
      );

      // (b), (c) web sources and audits: every active destination whose kind has a report source or is auditable.
      const destinations = (
        await destinationService.list(actor, { brandId: parsed.brandId }, tx)
      ).items.filter((d) => d.status === 'active');
      const listed = (await destinationService.sources.list()).items;
      const web: OverviewSummaryV1['web'] = [];
      const audits: OverviewSummaryV1['audits'] = [];
      const uncertified: Array<{ kind: string; label: string }> = [];
      for (const destination of destinations) {
        const source = listed.find((s) => s.kind === destination.kind) ?? null;
        if (source && !source.certified && !uncertified.some((u) => u.kind === destination.kind))
          uncertified.push({ kind: destination.kind, label: source.label });
        if (destination.kind === SEO_AUDIT_DESTINATION_KIND) {
          const summary = await seoAuditService.summary(
            actor,
            { brandId: parsed.brandId, destinationId: destination.id },
            tx,
          );
          const composed = auditSourceOf(destination, summary, at);
          audits.push(composed.entry);
          sources.push(composed.source);
          continue;
        }
        if (!source) continue;
        const summary = await destinationReportService.summary(
          actor,
          {
            brandId: parsed.brandId,
            destinationId: destination.id,
            windowStart: parsed.windowStart,
            windowEnd: parsed.windowEnd,
          },
          tx,
        );
        if (summary.presentation === null) continue; // a kind without a registered report source
        const composed = webSourceOf(destination, summary, days.length);
        web.push(composed.entry);
        sources.push(composed.source);
      }

      const splits = splitsOf(social, definitions);
      return {
        brandId: parsed.brandId,
        windowStart: parsed.windowStart,
        windowEnd: parsed.windowEnd,
        days,
        social,
        web,
        audits,
        sources,
        organicVsPaid: splits.organicVsPaid,
        oremediaVsNative: splits.oremediaVsNative,
        limits: limitsOf({ sources, web, audits, social, splits, uncertified }),
        computedAt: at.toISOString(),
      };
    },
  };
  return service;
}

export const overviewService = createOverviewService();
