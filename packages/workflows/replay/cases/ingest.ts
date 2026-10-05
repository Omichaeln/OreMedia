import type {
  DestinationReportFetchResultV1,
  DestinationReportPlanV1,
  DestinationReportSweepActivitiesV1,
  DestinationReportsActivitiesV1,
} from '@oremedia/contracts/destinations';
import type {
  CollectionPlanV1,
  CommentIngestionActivitiesV1,
  MetricCollectionActivitiesV1,
} from '@oremedia/contracts/measurement';
import type {
  SeoAuditActivitiesV1,
  SeoAuditCrawlPageResultV1,
  SeoAuditPlanV1,
  SeoAuditSweepActivitiesV1,
} from '@oremedia/contracts/seo-audit';
import { LONG_AGO, next, nonRetryable, tenant, type Recorder, type RecordingCase } from './types';

/**
 * Task queues `ingest-metrics` and `ingest-comments` (worker-ingest): metric and comment collection, the daily
 * destination report sweep and its children, and the weekly SEO audit (v1 and v2) and its children. Each case is
 * one representative execution; see ./types.ts.
 */
const plan = (p: Partial<CollectionPlanV1> = {}): CollectionPlanV1 => ({
  collectable: true,
  providerKey: 'replay_provider',
  publishedAt: LONG_AGO,
  latencyHours: 2,
  commentsReadable: true,
  ...p,
});
const comments = (rec: Recorder, p: () => CollectionPlanV1) => {
  const pages = new Map<number, number>();
  return rec<CommentIngestionActivitiesV1>({
    readCollectionPlan: async () => p(),
    pullComments: async (i) => {
      const page = (pages.get(i.pullIndex) ?? 0) + 1;
      pages.set(i.pullIndex, page);
      return {
        ingested: 2,
        duplicates: 0,
        nextCursor: page === 1 && i.pullIndex === 0 ? 'cursor_replay_2' : null,
      };
    },
  });
};
const metrics = (rec: Recorder, p: () => CollectionPlanV1, failIndex?: number) =>
  rec<MetricCollectionActivitiesV1>({
    readCollectionPlan: async () => p(),
    pullMetrics: async (i) => {
      if (i.pullIndex === failIndex)
        throw nonRetryable('ValidationFailed', 'metric not supported (replay fixture)');
      return { written: 5, skipped: 0, unavailable: 1 };
    },
  });
const pubInput = (n: number) => ({ ...tenant(1, `corr_replay_m_${n}`), publicationId: `pub_replay_m_${n}` });
const justNow = () => {
  let at: string | undefined;
  return () => (at ??= new Date().toISOString());
};

const reports = (
  rec: Recorder,
  planned: DestinationReportPlanV1,
  results: Array<DestinationReportFetchResultV1 | Error>,
  pruneFails = false,
) => {
  const queue = [...results];
  return rec<DestinationReportsActivitiesV1>({
    planDestinationReports: async () => planned,
    fetchDestinationReport: async () => {
      const r = next(queue);
      if (r instanceof Error) throw r;
      return r;
    },
    finishDestinationReports: async (i) => ({ health: i.health }),
    pruneDestinationReports: async () => {
      if (pruneFails) throw nonRetryable('ValidationFailed');
      return { deleted: 3, cutoff: '2025-10-01' };
    },
  });
};
const twoReports: DestinationReportPlanV1 = {
  outcome: 'planned',
  reports: [
    { reportKey: 'ga4_sessions', start: '2026-01-01', end: '2026-01-04' },
    { reportKey: 'gsc_queries', start: '2026-01-01', end: '2026-01-04' },
  ],
};
const reportsInput = (n: number) => ({
  ...tenant(1, `corr_replay_dr_${n}`),
  actor: { kind: 'platform_operator' as const, id: 'destination-report-sweep' },
  destinationId: `dst_replay_dr_${n}`,
  now: LONG_AGO,
});
const reportsCase = (
  name: string,
  description: string,
  n: number,
  planned: DestinationReportPlanV1,
  results: Array<DestinationReportFetchResultV1 | Error>,
  pruneFails = false,
): RecordingCase => ({
  workflowType: 'destinationReportsWorkflowV1',
  name,
  description,
  queue: 'ingest',
  activities: (rec) => ({ 'ingest-metrics': reports(rec, planned, results, pruneFails) }),
  args: [reportsInput(n)],
  workflowId: `destination-reports:dst_replay_dr_${n}:2026-01-05`,
  state: 'completed',
});

const seo = (
  rec: Recorder,
  planned: SeoAuditPlanV1,
  crawl: (url: string) => SeoAuditCrawlPageResultV1 | Error,
  pruneFails = false,
) =>
  rec<SeoAuditActivitiesV1>({
    planSeoAudit: async () => planned,
    crawlSeoAuditPage: async (i) => {
      const r = crawl(i.url);
      if (r instanceof Error) throw r;
      return r;
    },
    finishSeoAudit: async () => ({ outcome: 'completed', pages: 3 }),
    pruneSeoAudits: async () => {
      if (pruneFails) throw nonRetryable('ValidationFailed');
      return { deleted: 1 };
    },
  });
const SITE = 'https://site.example';
const seoPlan: SeoAuditPlanV1 = {
  outcome: 'planned',
  runId: 'sar_replay_1',
  origin: SITE,
  seeds: [`${SITE}/`, `${SITE}/about`],
  limitsHit: ['sitemap_seeds'],
};
const crawled = (links: string[]): SeoAuditCrawlPageResultV1 => ({ outcome: 'crawled', status: 200, links });
const seoInput = (n: number) => ({
  ...tenant(1, `corr_replay_seo_${n}`),
  actor: { kind: 'platform_operator' as const, id: 'seo-audit-sweep' },
  destinationId: `dst_replay_seo_${n}`,
  now: LONG_AGO,
  trigger: 'scheduled' as const,
});
const seoCase = (
  workflowType: 'seoAuditWorkflowV1' | 'seoAuditWorkflowV2',
  name: string,
  description: string,
  n: number,
  planned: SeoAuditPlanV1,
  crawl: (url: string) => SeoAuditCrawlPageResultV1 | Error,
  extra: Partial<RecordingCase> = {},
): RecordingCase => ({
  workflowType,
  name,
  description,
  queue: 'ingest',
  activities: (rec) => ({ 'ingest-metrics': seo(rec, planned, crawl, name.includes('prune-failed')) }),
  args: [seoInput(n)],
  workflowId: `seo-audit:dst_replay_seo_${n}:2026-W02`,
  state: 'completed',
  ...extra,
});
export const ingestCases: RecordingCase[] = [
  {
    workflowType: 'metricCollectionWorkflowV1',
    name: 'all-pulls-due-with-comments',
    description:
      'Published long ago: the comment ingestion child is started on ingest-comments and every scheduled pull is due at once; one pull fails permanently and is counted.',
    queue: 'ingest',
    activities: (rec) => ({
      'ingest-metrics': metrics(rec, () => plan(), 3),
      'ingest-comments': comments(rec, () => plan()),
    }),
    args: [pubInput(1)],
    workflowId: 'metrics:pub_replay_m_1',
    state: 'completed',
  },
  {
    workflowType: 'metricCollectionWorkflowV1',
    name: 'not-collectable',
    description: 'The provider cannot report metrics for this publication: nothing is collected.',
    queue: 'ingest',
    activities: (rec) => ({
      'ingest-metrics': metrics(rec, () => plan({ collectable: false, publishedAt: null })),
    }),
    args: [pubInput(2)],
    workflowId: 'metrics:pub_replay_m_2',
    state: 'completed',
  },
  {
    workflowType: 'metricCollectionWorkflowV1',
    name: 'waiting-open',
    description:
      'In flight: published just now (comments not readable), waiting on the timer for the first pull.',
    queue: 'ingest',
    activities: (rec) => {
      const at = justNow();
      return { 'ingest-metrics': metrics(rec, () => plan({ publishedAt: at(), commentsReadable: false })) };
    },
    args: [pubInput(3)],
    workflowId: 'metrics:pub_replay_m_3',
    state: 'open',
  },
  {
    workflowType: 'commentIngestionWorkflowV1',
    name: 'all-pulls-due-paged',
    description: 'Published long ago: all seven pulls are due at once; the first pull reads two pages.',
    queue: 'ingest',
    taskQueue: 'ingest-comments',
    activities: (rec) => ({ 'ingest-comments': comments(rec, () => plan()) }),
    args: [pubInput(4)],
    workflowId: 'comments:pub_replay_m_4',
    state: 'completed',
  },
  {
    workflowType: 'commentIngestionWorkflowV1',
    name: 'comments-not-readable',
    description: 'The channel cannot read comments: nothing is pulled.',
    queue: 'ingest',
    taskQueue: 'ingest-comments',
    activities: (rec) => ({ 'ingest-comments': comments(rec, () => plan({ commentsReadable: false })) }),
    args: [pubInput(5)],
    workflowId: 'comments:pub_replay_m_5',
    state: 'completed',
  },
  {
    workflowType: 'commentIngestionWorkflowV1',
    name: 'waiting-open',
    description: 'In flight: published just now, waiting on the one-hour timer for the first pull.',
    queue: 'ingest',
    taskQueue: 'ingest-comments',
    activities: (rec) => {
      const at = justNow();
      return { 'ingest-comments': comments(rec, () => plan({ publishedAt: at() })) };
    },
    args: [pubInput(6)],
    workflowId: 'comments:pub_replay_m_6',
    state: 'open',
  },
  {
    workflowType: 'destinationReportSweepWorkflowV1',
    name: 'two-targets',
    description: 'The daily sweep starts one abandoned child per destination with the day in its id.',
    queue: 'ingest',
    activities: (rec) => ({
      'ingest-metrics': {
        ...rec<DestinationReportSweepActivitiesV1>({
          listDestinationReportTargets: async () => [
            { tenantId: 'tnt_replay_1', destinationId: 'dst_replay_drs_1' },
            { tenantId: 'tnt_replay_2', destinationId: 'dst_replay_drs_2' },
          ],
        }),
        ...reports(rec, twoReports, [{ outcome: 'fetched', rows: 10, days: 4 }]),
      },
    }),
    args: [{ correlationId: 'corr_replay_drs', now: '2026-02-02T06:00:00.000Z' }],
    workflowId: 'destination-report-sweep-replay-1',
    state: 'completed',
  },
  reportsCase(
    'fetched',
    'Both planned reports are fetched; the run is recorded healthy and retention applied.',
    1,
    twoReports,
    [{ outcome: 'fetched', rows: 10, days: 4 }],
  ),
  reportsCase(
    'rate-limited',
    'The second report is rate limited: stop there, the destination is degraded for today.',
    2,
    twoReports,
    [
      { outcome: 'fetched', rows: 10, days: 4 },
      { outcome: 'rate_limited', retryAfterMs: 60_000 },
    ],
  ),
  reportsCase(
    'plan-skipped',
    'The source-use policy refuses the read: skipped at the plan, nothing fetched.',
    3,
    {
      outcome: 'skipped',
      reason: 'review_overdue',
    },
    [],
  ),
  reportsCase(
    'fetch-failed-prune-failed',
    'The first fetch fails permanently (degraded) and the prune fails too; the run still records and returns.',
    4,
    twoReports,
    [nonRetryable('ValidationFailed', 'report refused (replay fixture)')],
    true,
  ),
  reportsCase('unreachable', 'The grant was revoked: the destination is unreachable.', 5, twoReports, [
    { outcome: 'unreachable', reason: 'reconnect_required' },
  ]),
  seoCase(
    'seoAuditWorkflowV1',
    'stuck-at-first-activity',
    "In flight as every v1 run is: v1's spread of activity proxies is empty, so its first workflow task fails and Temporal retries it.",
    1,
    seoPlan,
    () => crawled([]),
    { state: 'open', openAt: 'WORKFLOW_TASK_FAILED' },
  ),
  {
    workflowType: 'seoAuditSweepWorkflowV1',
    name: 'two-targets',
    description: 'The weekly v1 sweep starts one abandoned seoAuditWorkflowV1 child per website.',
    queue: 'ingest',
    activities: (rec) => ({
      'ingest-metrics': {
        ...rec<SeoAuditSweepActivitiesV1>({
          listSeoAuditTargets: async () => [
            { tenantId: 'tnt_replay_1', destinationId: 'dst_replay_seos_1' },
            { tenantId: 'tnt_replay_2', destinationId: 'dst_replay_seos_2' },
          ],
        }),
      },
    }),
    args: [{ correlationId: 'corr_replay_seos_1', now: LONG_AGO }],
    workflowId: 'seo-audit-sweep-replay-1',
    state: 'completed',
  },
  seoCase(
    'seoAuditWorkflowV2',
    'crawled',
    'Two seeds and one discovered link crawled 250 ms apart (timers); finished and pruned.',
    2,
    seoPlan,
    (url) => crawled(url === `${SITE}/` ? [`${SITE}/about`, `${SITE}/contact`] : []),
  ),
  seoCase(
    'seoAuditWorkflowV2',
    'skipped',
    'The site was audited this week already: skipped at the plan.',
    3,
    {
      outcome: 'skipped',
      reason: 'already_ran',
    },
    () => crawled([]),
  ),
  seoCase(
    'seoAuditWorkflowV2',
    'page-failed-prune-failed',
    'One page fails permanently and is counted; the prune fails and the audit still finishes.',
    4,
    seoPlan,
    (url) =>
      url.endsWith('/about')
        ? nonRetryable('ValidationFailed', 'page refused (replay fixture)')
        : crawled([]),
  ),
  seoCase(
    'seoAuditWorkflowV2',
    'closed-elsewhere',
    'The run was closed by a later run: the crawl stops and the audit returns failed without finishing it.',
    5,
    seoPlan,
    () => ({ outcome: 'skipped', reason: 'not_running' }),
  ),
  {
    workflowType: 'seoAuditSweepWorkflowV2',
    name: 'two-targets',
    description: 'The weekly v2 sweep starts one abandoned seoAuditWorkflowV2 child per website.',
    queue: 'ingest',
    activities: (rec) => ({
      'ingest-metrics': {
        ...rec<SeoAuditSweepActivitiesV1>({
          listSeoAuditTargets: async () => [
            { tenantId: 'tnt_replay_1', destinationId: 'dst_replay_seos_3' },
            { tenantId: 'tnt_replay_2', destinationId: 'dst_replay_seos_4' },
          ],
        }),
        ...seo(rec, seoPlan, () => crawled([])),
      },
    }),
    args: [{ correlationId: 'corr_replay_seos_2', now: '2026-02-02T06:00:00.000Z' }],
    workflowId: 'seo-audit-sweep-replay-2',
    state: 'completed',
  },
];
