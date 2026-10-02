import { z } from 'zod';
import type { ActivityHooks } from './agents';
import type { SourceUseCheckReason } from './destinations';
import type { Page } from './pagination';
import { TenantContextInput } from './tenancy';

/**
 * Technical SEO audit (ledger R2-4): a bounded crawl of a brand's own website (a `cms_site` destination's origin,
 * never a free URL) under the brand's source-use policy for `cms.audit`, recording lab checks per page and a
 * summary per run. Findings are read-only lists with a suggested task a person turns into a brief; nothing here
 * creates work on its own. Field data (real-user measurements) is not connected: the summary says so and keeps a
 * `fieldData: null` slot for a later connector.
 */
export const CMS_AUDIT_DATA_TYPE = 'cms.audit';

// ---- limits (every one of them is a hard cap the crawler enforces; the run records which it hit) ----

export const SEO_AUDIT_MAX_PAGES = 200;
export const SEO_AUDIT_MAX_DEPTH = 3;
export const SEO_AUDIT_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const SEO_AUDIT_FETCH_TIMEOUT_MS = 10_000;
/** The workflow waits at least this long between two fetches of one run. */
export const SEO_AUDIT_FETCH_GAP_MS = 250;
export const SEO_AUDIT_RUN_DEADLINE_MS = 20 * 60_000;
/** Redirects followed per fetch, each hop re-checked against the SSRF policy and the origin. */
export const SEO_AUDIT_MAX_HOPS = 3;
/**
 * Same-origin links kept per page: the frontier is carried by the workflow, so this bounds its history (at most
 * 200 pages × 50 links × 500 bytes ≈ 5 MB of activity results per run, well inside Temporal's limits).
 */
export const SEO_AUDIT_LINKS_PER_PAGE = 50;
/** A longer URL is never followed or seeded (payloads stay bounded; such URLs are tracking artefacts). */
export const SEO_AUDIT_URL_MAX = 500;
/** The destination kind an audit runs against: the brand's own website (its origin is the authorised scope). */
export const SEO_AUDIT_DESTINATION_KIND = 'cms_site';
/** The lock a run holds per destination (longer than the run deadline, so two runs never overlap). */
export const SEO_AUDIT_LOCK_SECONDS = 25 * 60;
/** Sitemap URLs taken as seeds (a sitemap index is read one level deep). */
export const SEO_AUDIT_SITEMAP_SEEDS = 200;
/** robots.txt `Disallow` rules kept for `*` (the rest are ignored; a longer file is still bounded). */
export const SEO_AUDIT_ROBOTS_RULES = 200;
/** Without `retain`, the last runs of a destination are kept (the operational record, D-17 working default). */
export const SEO_AUDIT_KEEP_RUNS = 4;
/** A run still `running` after this long is abandoned (its worker died); the next run marks it failed. */
export const SEO_AUDIT_RUN_STALE_MS = 30 * 60_000;

// ---- the check catalogue (docs/contracts/seo-audit.md) ----

export const SEO_TITLE_MAX = 60;
export const SEO_TITLE_HARD_MAX = 70;
export const SEO_DESCRIPTION_MIN = 50;
export const SEO_DESCRIPTION_MAX = 160;
export const SEO_PAGE_HEAVY_BYTES = Math.round(1.5 * 1024 * 1024);

export const SeoAuditSeverity = z.enum(['critical', 'major', 'minor']);
export type SeoAuditSeverity = z.infer<typeof SeoAuditSeverity>;
/** A page's worst failed check, or `ok`; the pages drill-down filters by it. */
export const SeoAuditPageSeverity = z.enum(['ok', 'critical', 'major', 'minor']);
export type SeoAuditPageSeverity = z.infer<typeof SeoAuditPageSeverity>;

export const SeoAuditCheckKey = z.enum([
  'status',
  'redirect_chain',
  'title',
  'meta_description',
  'h1',
  'canonical',
  'robots_meta',
  'viewport',
  'lang',
  'image_alt',
  'broken_links',
  'hreflang',
  'structured_data',
  'page_size',
  'mixed_content',
  'duplicate_title',
  'duplicate_description',
]);
export type SeoAuditCheckKey = z.infer<typeof SeoAuditCheckKey>;

/** One check's result on one page: pass, or fail with a severity and a short detail (never page content). */
export interface SeoAuditCheckV1 {
  key: SeoAuditCheckKey;
  ok: boolean;
  severity: SeoAuditSeverity | null;
  /** A code or a count, e.g. `length=74`, `count=3`, `status=404`; never a body or a URL. */
  detail: string | null;
}

export const SeoAuditTrigger = z.enum(['scheduled', 'on_demand']);
export type SeoAuditTrigger = z.infer<typeof SeoAuditTrigger>;
export const SeoAuditOutcome = z.enum(['running', 'completed', 'failed']);
export type SeoAuditOutcome = z.infer<typeof SeoAuditOutcome>;
/** Which caps a run reached; a run that reached none crawled the whole reachable site within depth. */
export const SeoAuditLimit = z.enum(['max_pages', 'max_depth', 'deadline', 'sitemap_seeds', 'robots_rules']);
export type SeoAuditLimit = z.infer<typeof SeoAuditLimit>;

export interface SeoAuditSummaryCountsV1 {
  critical: number;
  major: number;
  minor: number;
  /** Pages failing each check, by check key (a check no page failed is absent). */
  byCheck: Record<string, number>;
}

export interface SeoAuditRunV1 {
  id: string;
  brandId: string;
  destinationId: string;
  origin: string;
  trigger: SeoAuditTrigger;
  startedAt: string;
  finishedAt: string | null;
  outcome: SeoAuditOutcome;
  reason: string | null;
  pagesCrawled: number;
  limitsHit: SeoAuditLimit[];
  summary: SeoAuditSummaryCountsV1;
}

export interface SeoAuditPageV1 {
  id: string;
  runId: string;
  url: string;
  depth: number;
  status: number | null;
  bytes: number;
  severity: SeoAuditPageSeverity;
  checks: SeoAuditCheckV1[];
  fetchedAt: string;
}

/**
 * RA-11: where a finding stands as work. `open`: reported by the run and tracked by nothing; `tracked`: turned
 * into work that is still open; `resolved`: the work's finding was no longer reported by a later completed run.
 */
export const SeoFindingStatus = z.enum(['open', 'tracked', 'resolved']);
export type SeoFindingStatus = z.infer<typeof SeoFindingStatus>;
/** The product's trackable work object a finding becomes: a recommendation (spec 16.4), which a person accepts into a brief. */
export const SEO_FINDING_WORK_TYPE = 'recommendation';
/** The identity of a finding as provenance names it: the run it was read from and the rule it failed. */
export const seoFindingId = (runId: string, check: SeoAuditCheckKey): string => `${runId}:${check}`;
/** RA-11: the work a finding was turned into, with its provenance and the work's title and state as read now. */
export interface SeoFindingWorkV1 {
  id: string;
  findingId: string;
  brandId: string;
  destinationId: string;
  runId: string;
  check: SeoAuditCheckKey;
  severity: SeoAuditSeverity;
  /** How many pages failed the check and the example URLs when the work was created. */
  pageCount: number;
  examples: string[];
  workType: typeof SEO_FINDING_WORK_TYPE;
  workId: string;
  /** The work's current title and state (its own module's words); null when the work could not be read. */
  title: string | null;
  state: string | null;
  createdById: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedRunId: string | null;
}

/** A finding: one check across the run, with how many pages fail it, example URLs and the task it suggests. */
export interface SeoAuditFindingV1 {
  /** `<runId>:<check>` (seoFindingId): the provenance a work item names. */
  findingId: string;
  check: SeoAuditCheckKey;
  label: string;
  severity: SeoAuditSeverity;
  count: number;
  examples: string[];
  suggestedTask: string;
  /** RA-11: open, tracked (with the work) or resolved (the work whose check this run no longer reports). */
  status: SeoFindingStatus;
  work: SeoFindingWorkV1 | null;
}
/** What the crawl's rules report before the work links are read beside them (findingsOf). */
export type SeoAuditReportedFindingV1 = Omit<SeoAuditFindingV1, 'findingId' | 'status' | 'work'>;
export const SEO_AUDIT_FINDING_EXAMPLES = 5;

/** Lab data only (what the crawler measured); field data is a slot a later connector fills, never fabricated. */
export const SEO_AUDIT_DATA_NOTE = 'lab data only; field data not connected';
export interface SeoAuditSummaryV1 {
  brandId: string;
  destinationId: string;
  origin: string;
  /** Whether the source-use policy allows `read` of `cms.audit`; nothing is summarised when it does not. */
  policy: { allowed: boolean; reason: SourceUseCheckReason; dataType: string };
  /** Whether the actor may start a run (seo_audit.run); the command still asserts. */
  canRun: boolean;
  /** RA-11: whether the actor may turn findings into work (insight.manage); the command still asserts. */
  canCreateWork: boolean;
  /** A run is in progress (its `run` is refused until it finishes). */
  running: boolean;
  lastRun: SeoAuditRunV1 | null;
  data: { kind: 'lab'; note: string };
  fieldData: null;
  computedAt: string;
}

// ---- router DTOs (destinations.audit.*) ----

export const SeoAuditSummary = z.object({ brandId: z.string(), destinationId: z.string() });
export const SeoAuditRunsList = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  limit: z.number().int().min(1).max(50).default(10),
});
export const SeoAuditPagesList = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  /** A run of the destination; the last finished one by default. */
  runId: z.string().optional(),
  severity: SeoAuditPageSeverity.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export const SeoAuditFindings = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  runId: z.string().optional(),
});
export const SeoAuditRun = z.object({ brandId: z.string(), destinationId: z.string() });
/**
 * RA-11 destinations.audit.createWork: one or many findings of a run (the last finished one by default) become
 * work, idempotent per finding (a finding already tracked returns its work). A check the run does not report is
 * refused (VALIDATION_FAILED).
 */
export const SeoAuditCreateWork = z.object({
  brandId: z.string(),
  destinationId: z.string(),
  runId: z.string().optional(),
  checks: z.array(SeoAuditCheckKey).min(1).max(SeoAuditCheckKey.options.length),
});
export type SeoAuditPagesPage = Page<SeoAuditPageV1>;

// ---- seoAuditSweepWorkflowV1 / seoAuditWorkflowV1 (task queue `ingest-metrics`, worker-ingest) ----

/** The weekly sweep is platform-level (it spans tenants like the report sweep); a schedule starts it with fixed args. */
export const SeoAuditSweepArgsV1 = z.object({
  correlationId: z.string().optional(),
  now: z.string().datetime().optional(),
});
export type SeoAuditSweepArgsV1 = z.infer<typeof SeoAuditSweepArgsV1>;
export interface SeoAuditSweepInputV1 {
  correlationId: string;
  now: string;
}
/** A website to audit this week: references only (spec 14.7 R5). */
export interface SeoAuditTargetV1 {
  tenantId: string;
  destinationId: string;
}
export const SeoAuditInputV1 = TenantContextInput.extend({
  destinationId: z.string(),
  now: z.string().datetime(),
  trigger: SeoAuditTrigger,
  /** An on-demand run's row, created by the API when the person asked; a scheduled run creates its own. */
  runId: z.string().optional(),
});
export type SeoAuditInputV1 = z.infer<typeof SeoAuditInputV1>;
export const SeoAuditPlanSkipReason = z.enum([
  'no_policy',
  'review_overdue',
  'not_allowed',
  'not_active',
  'not_a_site',
  'origin_unsafe',
  'locked',
  'already_ran',
]);
export type SeoAuditPlanSkipReason = z.infer<typeof SeoAuditPlanSkipReason>;
export type SeoAuditPlanV1 =
  | { outcome: 'skipped'; reason: SeoAuditPlanSkipReason }
  | {
      outcome: 'planned';
      runId: string;
      origin: string;
      /** The origin itself and what the sitemap listed, deduplicated, same-origin, robots-allowed. */
      seeds: string[];
      limitsHit: SeoAuditLimit[];
    };
export const SeoAuditCrawlPageInputV1 = SeoAuditInputV1.extend({
  runId: z.string(),
  url: z.string().max(2000),
  depth: z.number().int().min(0),
});
export type SeoAuditCrawlPageInputV1 = z.infer<typeof SeoAuditCrawlPageInputV1>;
export type SeoAuditCrawlPageResultV1 =
  | {
      outcome: 'crawled';
      status: number | null;
      /** Same-origin links found on the page (absolute, fragment-stripped, robots-allowed), capped. */
      links: string[];
    }
  | { outcome: 'skipped'; reason: 'not_running' | 'robots' | 'unsafe' };
export const SeoAuditFinishInputV1 = SeoAuditInputV1.extend({
  runId: z.string(),
  limitsHit: z.array(SeoAuditLimit),
  /** Pages whose activity failed after retries (recorded as a count, never retried tightly). */
  failedPages: z.number().int().min(0),
});
export type SeoAuditFinishInputV1 = z.infer<typeof SeoAuditFinishInputV1>;
export interface SeoAuditActivitiesV1 {
  /** The policy check, the lock, the run row and the seeds (origin, robots.txt, sitemap); a refusal is audited. */
  planSeoAudit(input: SeoAuditInputV1): Promise<SeoAuditPlanV1>;
  /** Fetches one page within the limits, records its checks and returns the links to follow (never a body). */
  crawlSeoAuditPage(input: SeoAuditCrawlPageInputV1): Promise<SeoAuditCrawlPageResultV1>;
  /** The cross-page checks (broken links, duplicates), the summary counts and the run's audit record. */
  finishSeoAudit(input: SeoAuditFinishInputV1): Promise<{ outcome: SeoAuditOutcome; pages: number }>;
  /** Applies the source-use retention (or keeps the last runs) to the destination's runs. */
  pruneSeoAudits(input: SeoAuditInputV1): Promise<{ deleted: number }>;
}
export interface SeoAuditSweepActivitiesV1 {
  listSeoAuditTargets(input: SeoAuditSweepInputV1): Promise<SeoAuditTargetV1[]>;
}
/** The module-side implementation the activities wrap (tenant context is established by the activity host). */
export interface SeoAuditRuntimeV1
  extends SeoAuditSweepActivitiesV1, Omit<SeoAuditActivitiesV1, 'crawlSeoAuditPage'> {
  crawlSeoAuditPage(
    input: SeoAuditCrawlPageInputV1,
    hooks?: ActivityHooks,
  ): Promise<SeoAuditCrawlPageResultV1>;
}
