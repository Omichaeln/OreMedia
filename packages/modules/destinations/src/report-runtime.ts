import type { ActivityHooks } from '@oremedia/contracts/agents';
import {
  REPORT_CACHE_DAYS,
  REPORT_FIRST_RUN_DAYS,
  reportDataType,
  type DestinationReportFetchInputV1,
  type DestinationReportFetchResultV1,
  type DestinationReportFinishInputV1,
  type DestinationReportPlanV1,
  type DestinationReportRangeV1,
  type DestinationReportSweepInputV1,
  type DestinationReportsInputV1,
  type DestinationReportsRuntimeV1,
  type DestinationRefreshRuntimeV1,
  type SourceUseCheckResult,
} from '@oremedia/contracts/destinations';
import {
  CapabilityUnsupportedError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import { requireTenant, runAsPlatform, withTransaction, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { MemoryRateLimiterStore, audit, type RateLimiterStore } from '@oremedia/module-operations';
import { aadFor, credentialBroker, providerClientFor } from '@oremedia/module-publishing';
import { logger } from '@oremedia/observability';
import {
  ProviderTransportError,
  SOURCE_ACCESS_REQUIRED,
  SourceReadError,
  type SourceReportRow,
  type SourceReportSpec,
} from '@oremedia/providers';
import { sourceAvailable } from './hooks';
import {
  BrandDestinationRepository,
  DestinationReportRowRepository,
  DestinationReportTargetRepository,
  SourceUsePolicyRepository,
} from './repositories';
import { sourceUseDecision } from './service';
import { registry, sourceAdapterFor, sourceIO } from './sources';

const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();
const rowsRepo = new DestinationReportRowRepository();
const targetsRepo = new DestinationReportTargetRepository();
/** The platform job the target listing declares (spec 5.3); references only leave it. */
const REPORT_JOB = 'destination-report-sweep';
/** One run per destination at a time; a second plan inside the window is skipped (the next day's run reads on). */
const REPORT_LOCK_SECONDS = 15 * 60;
/**
 * Pages read per report and run (Search Console: 1000 rows each). A report that needs more is not stored at all
 * (a truncated window would read as the day's truth and never be re-read): the fetch ends `transient` with reason
 * `page_cap`, the destination is degraded for today and the whole range is read again tomorrow.
 */
export const MAX_REPORT_PAGES = 50;
const DAY_MS = 86_400_000;
type ReportRowInsert = Parameters<DestinationReportRowRepository['replaceWindow']>[5][number];

/** Raised inside the broker call when a report exceeds the page cap; mapped to a `transient` result, never stored. */
class ReportPageCapError extends Error {
  constructor() {
    super('report page cap reached');
    this.name = 'ReportPageCapError';
  }
}

/** The source-use data types a kind's reports fall under (one per report-key prefix: `ga4.reports`). */
export const reportDataTypes = (reports: readonly { key: string }[]): string[] => [
  ...new Set(reports.map((r) => reportDataType(r.key))),
];

/** One use of every data type of the kind's reports: the first refusal stands, else allowed (D-17). */
export async function reportUseDecision(
  brandId: string,
  kind: string,
  reports: readonly { key: string }[],
  use: 'read' | 'retain',
  now: Date,
  tx?: Tx,
): Promise<{ dataType: string; decision: SourceUseCheckResult }> {
  const dataTypes = reportDataTypes(reports);
  let last: { dataType: string; decision: SourceUseCheckResult } = {
    dataType: dataTypes[0] ?? `${kind}.reports`,
    decision: { allowed: false, reason: 'no_policy', policy: null },
  };
  for (const dataType of dataTypes) {
    const decision = sourceUseDecision(await policiesRepo.findByKey(brandId, kind, dataType, tx), use, now);
    last = { dataType, decision };
    if (!decision.allowed) return last;
  }
  return last;
}

export const dateKey = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (date: string, days: number): string =>
  dateKey(new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS));

/**
 * The incremental range of one report (pure, unit-tested): from the last stored day minus the report's latency
 * (a day's figures move until they are final) to yesterday, capped at the report's longest range; a first run
 * reads REPORT_FIRST_RUN_DAYS. Null when there is nothing new to read.
 */
export function reportRange(
  spec: { key: string; latencyHours: number; maxRangeDays: number },
  latestDate: string | null,
  now: Date,
): DestinationReportRangeV1 | null {
  const end = addDays(dateKey(now), -1);
  const floor = addDays(end, -(spec.maxRangeDays - 1));
  let start = latestDate
    ? addDays(latestDate, -Math.ceil(spec.latencyHours / 24))
    : addDays(end, -(REPORT_FIRST_RUN_DAYS - 1));
  if (start < floor) start = floor;
  if (start > end) return null;
  return { reportKey: spec.key, start, end };
}

export interface DestinationReportRuntimeOptions {
  now?: () => Date;
  /** Per-destination run lock (Redis-backed in production; memory by default). */
  reportLock?: RateLimiterStore;
}

/**
 * The runtime behind destinationReportSweepWorkflowV1 and destinationReportsWorkflowV1 (R2-1 part B; worker-ingest,
 * a process whose KMS may decrypt): the destinations to read across tenants, and per destination the policy gate,
 * the incremental plan, the paged read through the broker (a 401 refreshed once through the part A refresh, then
 * retried), the window replacement, the health and audit of the outcome and the retention prune. Modelled on the
 * refresh runtime (runtime.ts) and the metric collection runtime (module-measurement). Rows never enter Temporal.
 */
export function createDestinationReportRuntime(
  refresh: DestinationRefreshRuntimeV1,
  opts: DestinationReportRuntimeOptions = {},
): DestinationReportsRuntimeV1 {
  const now = opts.now ?? (() => new Date());
  const reportLock = opts.reportLock ?? new MemoryRateLimiterStore();
  const log = logger().child('destinations');
  const workflowActor = () => requireTenant().actor;
  /** Certified, enabled kinds whose adapter declares reports: the only ones the sweep visits. */
  const kindsWithReports = () =>
    registry()
      .list()
      .filter((s) => s.certified && s.capability.reports.length > 0 && sourceAvailable(s.key))
      .map((s) => s.key);

  const skippedAudit = (row: { id: string; brandId: string; kind: string }, reason: string, tx: Tx) =>
    audit.record(
      workflowActor(),
      'destination.report.skipped',
      { type: 'brand_destination', id: row.id },
      'denied',
      tx,
      { brandId: row.brandId, kind: row.kind, reason },
    );

  /**
   * The fetch's failure as the workflow reads it (a returned result, never a thrown error: the activity retry
   * policy does not apply, the destination is degraded for today and the next day's run reads again); anything
   * that is not a platform answer propagates.
   */
  const failureOf = (err: unknown): DestinationReportFetchResultV1 => {
    if (err instanceof ReportPageCapError) return { outcome: 'transient', reason: 'page_cap' };
    if (err instanceof SourceReadError) {
      switch (err.classification.kind) {
        case 'rate_limited':
          return { outcome: 'rate_limited', retryAfterMs: err.classification.retryAfterMs ?? null };
        case 'reconnect_required':
          return { outcome: 'unreachable', reason: 'reconnect_required' };
        case 'rejected':
          // The platform API is not enabled for this deployment (R2-2): the grant is intact, so the destination is
          // degraded with the reason and read again tomorrow, once the operator has the access.
          return err.classification.code === SOURCE_ACCESS_REQUIRED
            ? { outcome: 'transient', reason: SOURCE_ACCESS_REQUIRED }
            : { outcome: 'unreachable', reason: 'rejected' };
        case 'refresh_token':
          return { outcome: 'transient', reason: 'refresh_token' };
        case 'unknown':
          return { outcome: 'transient', reason: `http_${err.status}` };
      }
    }
    if (err instanceof ProviderTransportError)
      return { outcome: 'transient', reason: `transport_${err.phase}` };
    if (err instanceof PolicyDeniedError && err.reason === 'credential_destroyed')
      return { outcome: 'unreachable', reason: 'reconnect_required' };
    throw err;
  };

  return {
    listDestinationReportTargets: ({ correlationId }: DestinationReportSweepInputV1) =>
      runAsPlatform(REPORT_JOB, correlationId, () => targetsRepo.listTargets(kindsWithReports())),

    async planDestinationReports({
      tenantId,
      destinationId,
      now: at,
    }: DestinationReportsInputV1): Promise<DestinationReportPlanV1> {
      const row = await destinationsRepo.getById(destinationId); // a foreign id is NOT_FOUND
      if (row.status !== 'active' || !row.credentialRefId)
        return { outcome: 'skipped', reason: 'not_active' };
      let reports: SourceReportSpec[];
      try {
        reports = sourceAvailable(row.kind) ? sourceAdapterFor(row.kind).capability.reports : [];
      } catch (err) {
        if (!(err instanceof CapabilityUnsupportedError)) throw err;
        reports = []; // not certified for tenants (yet): nothing is read
      }
      if (reports.length === 0) return { outcome: 'skipped', reason: 'source_not_enabled' };
      // D-17: no read without a current policy allowing it; the refusal is recorded, nothing is fetched.
      const { dataType, decision } = await reportUseDecision(
        row.brandId,
        row.kind,
        reports,
        'read',
        new Date(at),
      );
      if (!decision.allowed) {
        await withTransaction((tx) => skippedAudit(row, `${decision.reason}:${dataType}`, tx));
        return {
          outcome: 'skipped',
          reason: decision.reason as 'no_policy' | 'review_overdue' | 'not_allowed',
        };
      }
      const lock = await reportLock.hit(
        `lock:${REPORT_JOB}:${tenantId}:${destinationId}`,
        REPORT_LOCK_SECONDS,
      );
      if (lock.count > 1) return { outcome: 'skipped', reason: 'locked' };
      const planned: DestinationReportRangeV1[] = [];
      for (const spec of reports) {
        const range = reportRange(
          spec,
          await rowsRepo.latestDate(row.brandId, row.id, spec.key),
          new Date(at),
        );
        if (range) planned.push(range);
      }
      if (planned.length === 0) return { outcome: 'skipped', reason: 'up_to_date' };
      return { outcome: 'planned', reports: planned };
    },

    async fetchDestinationReport(
      input: DestinationReportFetchInputV1,
      hooks?: ActivityHooks,
    ): Promise<DestinationReportFetchResultV1> {
      const { tenantId, destinationId, reportKey, start, end } = input;
      const row = await destinationsRepo.getById(destinationId);
      if (row.status !== 'active' || !row.credentialRefId)
        return { outcome: 'skipped', reason: 'not_active' };
      const adapter = sourceAdapterFor(row.kind);
      const spec = adapter.capability.reports.find((r) => r.key === reportKey);
      if (!spec)
        throw new ValidationFailedError(
          [{ path: 'reportKey', issue: `unknown_report:${reportKey}` }],
          `${row.kind} has no report ${reportKey}`,
        );
      const client = providerClientFor(adapter.key);
      const read = (credentialRefId: string) =>
        credentialBroker.withCredentialRef(
          { tenantId, credentialRefId, aad: aadFor(tenantId, row.id) },
          async (creds) => {
            const rows: SourceReportRow[] = [];
            let pageToken: string | undefined;
            for (let page = 0; page < MAX_REPORT_PAGES; page++) {
              hooks?.heartbeat(`report:${destinationId}:${reportKey}:${page}`);
              const result = await adapter.fetchReport(creds, client, sourceIO(adapter.key, tenantId), {
                externalId: row.externalId,
                report: reportKey,
                dateRange: { start, end },
                ...(pageToken ? { pageToken } : {}),
              });
              rows.push(...result.rows);
              if (!result.nextPageToken) return rows;
              pageToken = result.nextPageToken;
            }
            log.warn({ destinationId, reportKey, pages: MAX_REPORT_PAGES }, 'report page cap reached');
            throw new ReportPageCapError();
          },
        );
      let fetched: SourceReportRow[];
      try {
        fetched = await read(row.credentialRefId);
      } catch (err) {
        // An expired access token is refreshed once through the daily refresh's own path, then the read is retried.
        if (!(err instanceof SourceReadError) || err.classification.kind !== 'refresh_token')
          return failureOf(err);
        const refreshed = await refresh.refreshDestinationCredential({
          tenantId,
          destinationId,
          actor: input.actor,
          correlationId: input.correlationId,
        });
        if (!refreshed.ok)
          return refreshed.reason === 'reconnect_required'
            ? { outcome: 'unreachable', reason: 'reconnect_required' }
            : { outcome: 'transient', reason: `refresh_${refreshed.reason}` };
        const rotated = await destinationsRepo.getById(destinationId);
        if (rotated.status !== 'active' || !rotated.credentialRefId)
          return { outcome: 'skipped', reason: 'not_active' };
        try {
          fetched = await read(rotated.credentialRefId);
        } catch (again) {
          return failureOf(again);
        }
      }
      // One row per (day, dimensions) inside the window; the platform's last word on a duplicate wins.
      const fetchedAt = now();
      const byKey = new Map<string, ReportRowInsert>();
      for (const r of fetched) {
        if (r.date < start || r.date > end) continue;
        const dimensions = Object.fromEntries(
          Object.entries(r.dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
        const dimensionKey = hashCanonical(dimensions);
        byKey.set(`${r.date}|${dimensionKey}`, {
          id: newId('destinationReportRow'),
          brandId: row.brandId,
          destinationId: row.id,
          reportKey,
          date: r.date,
          dimensions,
          dimensionKey,
          metrics: r.metrics,
          fetchedAt,
          source: 'provider',
        });
      }
      const rows = [...byKey.values()];
      await withTransaction((tx) =>
        rowsRepo.replaceWindow(row.brandId, row.id, reportKey, start, end, rows, tx),
      );
      return { outcome: 'fetched', rows: rows.length, days: new Set(rows.map((r) => r.date)).size };
    },

    /** The run's record and the destination's health from it, under the row lock as setHealth writes it. */
    async finishDestinationReports({
      destinationId,
      health,
      fetched,
      reason,
    }: DestinationReportFinishInputV1) {
      return withTransaction(async (tx) => {
        const locked = await destinationsRepo.lock(destinationId, tx);
        if (locked.status !== 'active') return { health: locked.health };
        if (locked.health !== health) {
          await destinationsRepo.update(locked.id, locked.version, { health, healthCheckedAt: now() }, tx);
          await audit.record(
            workflowActor(),
            'destination.health',
            { type: 'brand_destination', id: locked.id },
            'allowed',
            tx,
            { brandId: locked.brandId, fromState: locked.health, toState: health },
          );
        } else await destinationsRepo.update(locked.id, locked.version, { healthCheckedAt: now() }, tx);
        await audit.record(
          workflowActor(),
          'destination.report.fetched',
          { type: 'brand_destination', id: locked.id },
          health === 'healthy' ? 'allowed' : 'denied',
          tx,
          {
            brandId: locked.brandId,
            kind: locked.kind,
            count: fetched.reduce((n, f) => n + f.rows, 0),
            scope: fetched.map((f) => f.reportKey).join(','),
            reason,
            fromState: locked.health,
            toState: health,
          },
        );
        return { health };
      });
    },

    /**
     * Retention: the policy's retentionDays when `retain` is allowed, else the operational cache (D-17 working
     * default): days before the cut-off are deleted, every report of the destination.
     */
    async pruneDestinationReports({ destinationId, now: at }: DestinationReportsInputV1) {
      const row = await destinationsRepo.getById(destinationId);
      const reports = registry().capability(row.kind)?.reports ?? [];
      const cutoffFor = (days: number) => addDays(dateKey(new Date(at)), -days);
      if (reports.length === 0) return { deleted: 0, cutoff: cutoffFor(REPORT_CACHE_DAYS) };
      const { dataType, decision } = await reportUseDecision(
        row.brandId,
        row.kind,
        reports,
        'retain',
        new Date(at),
      );
      const days =
        decision.allowed && decision.policy?.retentionDays
          ? decision.policy.retentionDays
          : REPORT_CACHE_DAYS;
      const cutoff = cutoffFor(days);
      const deleted = await withTransaction(async (tx) => {
        const n = await rowsRepo.deleteBefore(row.brandId, row.id, cutoff, tx);
        if (n > 0)
          await audit.record(
            workflowActor(),
            'destination.report.pruned',
            { type: 'brand_destination', id: row.id },
            'allowed',
            tx,
            {
              brandId: row.brandId,
              kind: row.kind,
              count: n,
              scope: dataType,
              reason: `cutoff=${cutoff},retentionDays=${days}`,
            },
          );
        return n;
      });
      return { deleted, cutoff };
    },
  };
}
