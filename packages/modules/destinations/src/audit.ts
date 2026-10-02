import type { z } from 'zod';
import { ConflictError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { Page } from '@oremedia/contracts/pagination';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  CMS_AUDIT_DATA_TYPE,
  SEO_AUDIT_DATA_NOTE,
  SEO_AUDIT_DESTINATION_KIND,
  SEO_AUDIT_RUN_STALE_MS,
  SEO_FINDING_WORK_TYPE,
  SeoAuditCheckKey,
  SeoAuditCreateWork,
  SeoAuditFindings,
  SeoAuditPagesList,
  SeoAuditRun,
  SeoAuditRunsList,
  SeoAuditSeverity,
  SeoAuditSummary,
  seoFindingId,
  type SeoAuditCheckV1,
  type SeoAuditFindingV1,
  type SeoAuditLimit,
  type SeoAuditPageV1,
  type SeoAuditRunV1,
  type SeoAuditSummaryV1,
  type SeoFindingWorkV1,
} from '@oremedia/contracts/seo-audit';
import type { SourceUseCheckResult } from '@oremedia/contracts/destinations';
import type { Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { audit, outbox } from '@oremedia/module-operations';
import { FINDING_RULES, findingsOf } from './audit-crawl';
import { findingWork, type FindingWorkRef } from './hooks';
import {
  BrandDestinationRepository,
  SeoAuditPageRepository,
  SeoAuditRunRepository,
  SeoFindingWorkRepository,
  SourceUsePolicyRepository,
} from './repositories';
import { brandResource, destinationOf, sourceUseDecision, visibleBrand } from './service';

/**
 * R2-4 read model over the stored audit runs and pages (restricted view under the brand's `cms.audit` policy,
 * D-17): the summary with the last run's tiles, the runs, the pages drill-down by severity and the findings
 * grouped by check with a suggested task each; and the one command, `run`, which opens an on-demand run (once
 * per destination per day; refused while one is in progress) and asks the worker to crawl through the outbox.
 * RA-11: `createWork` turns one or many findings into the product's tracked work (a recommendation, through the
 * finding-work hook the intelligence module registers) with the finding's provenance, once per finding; the
 * findings list carries each one's status and work, and the audit finish resolves what a later run no longer
 * reports. Nothing here creates work on its own: a person asks, under insight.manage.
 */
const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();
const runsRepo = new SeoAuditRunRepository();
const pagesRepo = new SeoAuditPageRepository();
const workRepo = new SeoFindingWorkRepository();
const DAY_MS = 86_400_000;

type RunRow = Awaited<ReturnType<SeoAuditRunRepository['getById']>>;
type PageRow = Awaited<ReturnType<SeoAuditPageRepository['getById']>>;
type WorkRow = Awaited<ReturnType<SeoFindingWorkRepository['getById']>>;

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

/** Versioned JSON is validated on read (spec 6.1): a stored check or severity outside the catalogue never reaches a DTO. */
const toWorkDto = (w: WorkRow, ref: FindingWorkRef | null): SeoFindingWorkV1 => ({
  id: w.id,
  findingId: seoFindingId(w.runId, SeoAuditCheckKey.parse(w.check)),
  brandId: w.brandId,
  destinationId: w.destinationId,
  runId: w.runId,
  check: SeoAuditCheckKey.parse(w.check),
  severity: SeoAuditSeverity.parse(w.severity),
  pageCount: w.pageCount,
  examples: w.examples,
  workType: SEO_FINDING_WORK_TYPE,
  workId: w.workId,
  title: ref?.title ?? null,
  state: ref?.state ?? null,
  createdById: w.createdById,
  createdAt: w.createdAt.toISOString(),
  resolvedAt: w.resolvedAt ? w.resolvedAt.toISOString() : null,
  resolvedRunId: w.resolvedRunId,
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
        canCreateWork:
          actor.kind === 'user' && policy.allows(actor, 'insight.manage', brandResource(row.brandId), at),
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

    /**
     * One finding per check with failing pages, worst first, each with the task it suggests and (RA-11) its
     * status: tracked with its work when an open work link exists for the check (or the run's own finding created
     * one), open otherwise; the links the run resolved are listed after them as resolved (count 0: the run no
     * longer reports the check).
     */
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
      const reported = findingsOf(pages.map((p) => ({ url: p.url, checks: p.checks as SeoAuditCheckV1[] })));
      const links = await workRepo.listForRun(row.brandId, row.id, run.id, tx);
      const refs =
        links.length > 0
          ? await findingWork.describe(
              row.brandId,
              links.map((l) => l.workId),
              tx,
            )
          : [];
      const work = (l: WorkRow) => toWorkDto(l, refs.find((r) => r.workId === l.workId) ?? null);
      const open = links.filter((l) => l.resolvedAt === null);
      const items: SeoAuditFindingV1[] = reported.map((f) => {
        // The open work for the check, else the work this run's finding created (resolved by a later run since).
        const link =
          open.find((l) => l.check === f.check) ??
          links.find((l) => l.check === f.check && l.runId === run.id) ??
          null;
        return {
          findingId: seoFindingId(run.id, f.check),
          ...f,
          status: link ? 'tracked' : 'open',
          work: link ? work(link) : null,
        };
      });
      for (const l of links.filter((l) => l.resolvedRunId === run.id)) {
        const check = SeoAuditCheckKey.parse(l.check);
        if (reported.some((f) => f.check === check)) continue; // reported again later: an open finding
        items.push({
          findingId: seoFindingId(l.runId, check),
          check,
          label: FINDING_RULES[check].label,
          severity: SeoAuditSeverity.parse(l.severity),
          count: 0,
          examples: l.examples,
          suggestedTask: FINDING_RULES[check].task(l.pageCount),
          status: 'resolved',
          work: work(l),
        });
      }
      return { runId: run.id, items };
    },

    /**
     * RA-11: turns one or many findings of a run into tracked work (a recommendation through the finding-work
     * hook) with the finding's provenance, under insight.manage (a person decides what becomes work; never an
     * agent). Idempotent per finding: a check with an open work link returns that link. A check the run does
     * not report is refused before anything is written.
     */
    async createWork(
      actor: ResolvedActor,
      input: z.infer<typeof SeoAuditCreateWork>,
      tx: Tx,
    ): Promise<{ runId: string; items: SeoFindingWorkV1[] }> {
      const parsed = SeoAuditCreateWork.parse(input);
      const at = now();
      const { row, decision } = await readable(actor, parsed.brandId, parsed.destinationId, at, tx);
      await policy.assert(actor, 'insight.manage', brandResource(row.brandId), {}, tx);
      if (actor.kind !== 'user')
        throw new PolicyDeniedError('agent_never', 'A person decides which findings become work');
      allowedOrThrow(decision);
      const run = await runOf(row.brandId, row.id, parsed.runId, tx);
      if (!run) throw new ValidationFailedError([{ path: 'runId', issue: 'no_finished_run' }]);
      const pages = await pagesRepo.listForRun(row.brandId, run.id, tx);
      const reported = findingsOf(pages.map((p) => ({ url: p.url, checks: p.checks as SeoAuditCheckV1[] })));
      const checks = [...new Set(parsed.checks)];
      const missing = checks.filter((c) => !reported.some((f) => f.check === c));
      if (missing.length > 0)
        throw new ValidationFailedError(
          missing.map((c) => ({ path: 'checks', issue: `not_reported:${c}` })),
          'the run does not report every check asked for',
        );
      // The destination row lock serialises concurrent "create work" calls (two people, or a retry): the second
      // waits and then finds the first one's open row instead of creating a second recommendation.
      await destinationsRepo.lock(row.id, tx);
      const items: SeoFindingWorkV1[] = [];
      // In the order asked for, so a caller matches results to checks.
      for (const finding of checks.flatMap((c) => reported.find((f) => f.check === c) ?? [])) {
        const check = finding.check;
        const existing = await workRepo.findOpen(row.brandId, row.id, check, tx, true);
        if (existing) {
          const ref = (await findingWork.describe(row.brandId, [existing.workId], tx))[0] ?? null;
          items.push(toWorkDto(existing, ref));
          continue;
        }
        const findingId = seoFindingId(run.id, check);
        const created = await findingWork.create(
          actor,
          {
            brandId: row.brandId,
            title: `${finding.label} on ${run.origin}`.slice(0, 200),
            rationale: finding.suggestedTask,
            provenance: {
              findingId,
              runId: run.id,
              check,
              severity: finding.severity,
              destinationId: row.id,
              origin: run.origin,
              pageCount: finding.count,
              pages: finding.examples,
            },
          },
          tx,
        );
        const id = newId('seoFindingWork');
        await workRepo.create(
          {
            id,
            brandId: row.brandId,
            destinationId: row.id,
            runId: run.id,
            check,
            severity: finding.severity,
            pageCount: finding.count,
            examples: finding.examples,
            workType: created.workType,
            workId: created.workId,
            createdById: actor.id,
            resolvedAt: null,
            resolvedRunId: null,
          },
          tx,
        );
        await audit.record(
          { kind: actor.kind, id: actor.id },
          'seo_audit.work_created',
          { type: 'brand_destination', id: row.id },
          'allowed',
          tx,
          {
            brandId: row.brandId,
            runId: run.id,
            scope: findingId,
            downstreamType: created.workType,
            downstreamId: created.workId,
          },
        );
        items.push(toWorkDto(await workRepo.getById(id, tx), created));
      }
      return { runId: run.id, items };
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
      // A run that completed today is today's run; a failed one (e.g. closed as `locked`) may be asked for again.
      const earlier = today.find((r) => r.outcome === 'completed');
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
