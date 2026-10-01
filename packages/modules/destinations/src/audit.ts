import type { z } from 'zod';
import { ConflictError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { Page } from '@oremedia/contracts/pagination';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  CMS_AUDIT_DATA_TYPE,
  SEO_AUDIT_DATA_NOTE,
  SEO_AUDIT_DESTINATION_KIND,
  SEO_AUDIT_RUN_STALE_MS,
  SeoAuditFindings,
  SeoAuditPagesList,
  SeoAuditRun,
  SeoAuditRunsList,
  SeoAuditSummary,
  type SeoAuditCheckV1,
  type SeoAuditFindingV1,
  type SeoAuditLimit,
  type SeoAuditPageV1,
  type SeoAuditRunV1,
  type SeoAuditSummaryV1,
} from '@oremedia/contracts/seo-audit';
import type { SourceUseCheckResult } from '@oremedia/contracts/destinations';
import type { Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { audit, outbox } from '@oremedia/module-operations';
import { findingsOf } from './audit-crawl';
import {
  BrandDestinationRepository,
  SeoAuditPageRepository,
  SeoAuditRunRepository,
  SourceUsePolicyRepository,
} from './repositories';
import { brandResource, destinationOf, sourceUseDecision, visibleBrand } from './service';

/**
 * R2-4 read model over the stored audit runs and pages (restricted view under the brand's `cms.audit` policy,
 * D-17): the summary with the last run's tiles, the runs, the pages drill-down by severity and the findings
 * grouped by check with a suggested task each; and the one command, `run`, which opens an on-demand run (once
 * per destination per day; refused while one is in progress) and asks the worker to crawl through the outbox.
 * Findings are read-only: a person turns a task into a brief; nothing here creates work on its own.
 */
const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();
const runsRepo = new SeoAuditRunRepository();
const pagesRepo = new SeoAuditPageRepository();
const DAY_MS = 86_400_000;

type RunRow = Awaited<ReturnType<SeoAuditRunRepository['getById']>>;
type PageRow = Awaited<ReturnType<SeoAuditPageRepository['getById']>>;

const toRunDto = (r: RunRow): SeoAuditRunV1 => ({
  id: r.id,
  brandId: r.brandId,
  destinationId: r.destinationId,
  origin: r.origin,
  trigger: r.trigger,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  outcome: r.outcome,
  reason: r.reason,
  pagesCrawled: r.pagesCrawled,
  limitsHit: r.limitsHit as SeoAuditLimit[],
  summary: r.summary,
});
const toPageDto = (p: PageRow): SeoAuditPageV1 => ({
  id: p.id,
  runId: p.runId,
  url: p.url,
  depth: p.depth,
  status: p.status,
  bytes: p.bytes,
  severity: p.severity,
  checks: p.checks as SeoAuditCheckV1[],
  fetchedAt: p.fetchedAt.toISOString(),
});

export interface SeoAuditQueryOptions {
  now?: () => Date;
}

export function createSeoAuditService(opts: SeoAuditQueryOptions = {}) {
  const now = opts.now ?? (() => new Date());

  /** The destination under its brand (foreign → NOT_FOUND), brand.read asserted, with the `cms.audit` decision. */
  async function readable(actor: ResolvedActor, brandId: string, destinationId: string, at: Date, tx?: Tx) {
    await visibleBrand(actor, brandId, tx);
    const row = await destinationOf(
      brandId,
      destinationId,
      await destinationsRepo.findById(destinationId, tx),
    );
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    const decision: SourceUseCheckResult = sourceUseDecision(
      await policiesRepo.findByKey(row.brandId, row.kind, CMS_AUDIT_DATA_TYPE, tx),
      'read',
      at,
    );
    return { row, decision };
  }
  const allowedOrThrow = (decision: SourceUseCheckResult) => {
    if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
  };
  /** The run a read defaults to: the one asked for (of this destination), else the latest finished one. */
  async function runOf(brandId: string, destinationId: string, runId: string | undefined, tx?: Tx) {
    if (runId) {
      const run = await runsRepo.findById(runId, tx);
      return run && run.brandId === brandId && run.destinationId === destinationId ? run : null;
    }
    return (
      (await runsRepo.latest(brandId, destinationId, 'completed', tx)) ??
      (await runsRepo.latest(brandId, destinationId, 'failed', tx))
    );
  }
  const inProgress = (run: RunRow | null, at: Date): RunRow | null =>
    run && run.outcome === 'running' && at.getTime() - run.startedAt.getTime() < SEO_AUDIT_RUN_STALE_MS
      ? run
      : null;

  const service = {
    /** The last finished run's tiles and whether one is in progress; brand.read on the brand. */
    async summary(
      actor: ResolvedActor,
      input: z.infer<typeof SeoAuditSummary>,
      tx?: Tx,
    ): Promise<SeoAuditSummaryV1> {
      const parsed = SeoAuditSummary.parse(input);
      const at = now();
      const { row, decision } = await readable(actor, parsed.brandId, parsed.destinationId, at, tx);
      const running = decision.allowed
        ? inProgress(await runsRepo.latest(row.brandId, row.id, 'running', tx), at)
        : null;
      const last = decision.allowed ? await runOf(row.brandId, row.id, undefined, tx) : null;
      return {
        brandId: row.brandId,
        destinationId: row.id,
        origin: row.externalId,
        policy: { allowed: decision.allowed, reason: decision.reason, dataType: CMS_AUDIT_DATA_TYPE },
        canRun:
          row.kind === SEO_AUDIT_DESTINATION_KIND &&
          row.status === 'active' &&
          policy.allows(actor, 'seo_audit.run', brandResource(row.brandId), at),
        running: running !== null,
        lastRun: last ? toRunDto(last) : null,
        data: { kind: 'lab', note: SEO_AUDIT_DATA_NOTE },
        fieldData: null,
        computedAt: at.toISOString(),
      };
    },

    runs: {
      /** The destination's runs, newest first (retention keeps a handful). */
      async list(
        actor: ResolvedActor,
        input: z.input<typeof SeoAuditRunsList>,
        tx?: Tx,
      ): Promise<{ items: SeoAuditRunV1[] }> {
        const parsed = SeoAuditRunsList.parse(input);
        const { row, decision } = await readable(actor, parsed.brandId, parsed.destinationId, now(), tx);
        allowedOrThrow(decision);
        const rows = await runsRepo.listForDestination(row.brandId, row.id, parsed.limit, tx);
        return { items: rows.map(toRunDto) };
      },
    },

    pages: {
      /** The pages of a run (the last finished one by default) in fetch order, by severity, paged by cursor. */
      async list(
        actor: ResolvedActor,
        input: z.input<typeof SeoAuditPagesList>,
        tx?: Tx,
      ): Promise<Page<SeoAuditPageV1>> {
        const parsed = SeoAuditPagesList.parse(input);
        const { row, decision } = await readable(actor, parsed.brandId, parsed.destinationId, now(), tx);
        allowedOrThrow(decision);
        const run = await runOf(row.brandId, row.id, parsed.runId, tx);
        if (!run) return { items: [], nextCursor: null };
        const page = await pagesRepo.pageByRun(
          row.brandId,
          run.id,
          parsed.severity,
          { limit: parsed.limit, cursor: parsed.cursor },
          tx,
        );
        return { items: page.items.map(toPageDto), nextCursor: page.nextCursor };
      },
    },

    /** Read-only: one finding per check with failing pages, worst first, each with the task it suggests. */
    async findings(
      actor: ResolvedActor,
      input: z.infer<typeof SeoAuditFindings>,
      tx?: Tx,
    ): Promise<{ runId: string | null; items: SeoAuditFindingV1[] }> {
      const parsed = SeoAuditFindings.parse(input);
      const { row, decision } = await readable(actor, parsed.brandId, parsed.destinationId, now(), tx);
      allowedOrThrow(decision);
      const run = await runOf(row.brandId, row.id, parsed.runId, tx);
      if (!run) return { runId: null, items: [] };
      const pages = await pagesRepo.listForRun(row.brandId, run.id, tx);
      return {
        runId: run.id,
        items: findingsOf(pages.map((p) => ({ url: p.url, checks: p.checks as SeoAuditCheckV1[] }))),
      };
    },

    /**
     * Opens an on-demand run (seo_audit.run; AGENT_NEVER) and asks the worker to crawl. Idempotent per
     * destination per day: a run already started today is returned as it is; one in progress is a conflict.
     */
    async run(actor: ResolvedActor, input: z.infer<typeof SeoAuditRun>, tx: Tx): Promise<SeoAuditRunV1> {
      const parsed = SeoAuditRun.parse(input);
      const at = now();
      await visibleBrand(actor, parsed.brandId, tx);
      const row = await destinationOf(
        parsed.brandId,
        parsed.destinationId,
        await destinationsRepo.findById(parsed.destinationId, tx),
      );
      await policy.assert(actor, 'seo_audit.run', brandResource(row.brandId), {}, tx);
      if (row.kind !== SEO_AUDIT_DESTINATION_KIND || row.status !== 'active')
        throw new ValidationFailedError([{ path: 'destinationId', issue: 'not_an_active_site' }]);
      const decision = sourceUseDecision(
        await policiesRepo.findByKey(row.brandId, row.kind, CMS_AUDIT_DATA_TYPE, tx),
        'read',
        at,
      );
      allowedOrThrow(decision);
      const dayStart = new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);
      const today = await runsRepo.startedBetween(
        row.brandId,
        row.id,
        dayStart,
        new Date(dayStart.getTime() + DAY_MS),
        tx,
      );
      const running = inProgress(await runsRepo.latest(row.brandId, row.id, 'running', tx), at);
      if (running) throw new ConflictError('SeoAuditRun', running.id, running.version);
      const earlier = today.find((r) => r.outcome !== 'running');
      if (earlier) return toRunDto(earlier);
      const id = newId('seoAuditRun');
      await runsRepo.create(
        {
          id,
          brandId: row.brandId,
          destinationId: row.id,
          origin: row.externalId,
          trigger: 'on_demand',
          requestedById: actor.id,
          startedAt: at,
          outcome: 'running',
        },
        tx,
      );
      await audit.record(
        { kind: actor.kind, id: actor.id },
        'seo_audit.requested',
        { type: 'brand_destination', id: row.id },
        'allowed',
        tx,
        { brandId: row.brandId, kind: row.kind, runId: id },
      );
      await outbox.add(
        'destination.audit_requested',
        { type: 'brand_destination', id: row.id, version: row.version },
        { destinationId: row.id, runId: id, actorKind: actor.kind, actorId: actor.id },
        tx,
        { brandId: row.brandId },
      );
      return toRunDto(await runsRepo.getById(id, tx));
    },
  };
  return service;
}

export const seoAuditService = createSeoAuditService();
