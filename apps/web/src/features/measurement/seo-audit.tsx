import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, EmptyState, Skeleton, cn, type Tone } from '@oremedia/ui';
import {
  SEO_AUDIT_DESTINATION_KIND,
  SEO_AUDIT_MAX_DEPTH,
  SEO_AUDIT_MAX_PAGES,
  type SeoAuditLimit,
  type SeoAuditPageSeverity,
  type SeoAuditSeverity,
} from '@oremedia/contracts/seo-audit';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { brandPath } from '../brand/brand-context';
import { useDestinations, type DestinationDto } from '../destinations/use-destinations';
import { ageText } from '../intelligence/intelligence-helpers';
import { formatNumber } from './performance-helpers';
import {
  useRunSeoAudit,
  useSeoAuditFindings,
  useSeoAuditPages,
  useSeoAuditSummary,
  type SeoAuditFindingDto,
  type SeoAuditPageDto,
  type SeoAuditRunDto,
} from './use-seo-audit';

/**
 * The Performance screen's "Audit" section (R2-4), beside "Web": each connected website with its last bounded
 * crawl (pages, critical / major / minor, the caps it hit, when it ran), the findings grouped by check with the
 * task each suggests (read-only: a person copies the task into a brief; nothing here creates work), the pages
 * drill-down filtered by severity, and the "Run audit" button (seo_audit.run; disabled while a run is in
 * progress). Everything is lab data the crawler measured; field data is not connected and the section says so.
 * A website whose source-use policy does not allow `cms.audit` reads says so and points at Settings → Destinations.
 */
const SEVERITY_TONE: Record<SeoAuditSeverity, Tone> = {
  critical: 'critical',
  major: 'warning',
  minor: 'info',
};
const SEVERITY_LABEL: Record<SeoAuditPageSeverity, string> = {
  ok: 'OK',
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
};
const LIMIT_LABEL: Record<SeoAuditLimit, string> = {
  max_pages: `${SEO_AUDIT_MAX_PAGES} pages`,
  max_depth: `depth ${SEO_AUDIT_MAX_DEPTH}`,
  deadline: 'run deadline',
  sitemap_seeds: 'sitemap seeds',
  robots_rules: 'robots rules',
};
const settingsHref = (companyId: string, brandId: string) =>
  `${brandPath(companyId, brandId, 'settings')}?tab=destinations`;

export function SeoAuditSection({ companyId, brandId }: { companyId: string; brandId: string }) {
  const destinations = useDestinations(brandId, SEO_AUDIT_DESTINATION_KIND);
  const sites = (destinations.data?.items ?? []).filter((d) => d.status === 'active');
  return (
    <Section id="audit-heading" title="Audit" testId="seo-audit">
      {destinations.isError && (
        <RequestError
          error={destinations.error}
          title="Websites could not load"
          onRetry={() => void destinations.refetch()}
        />
      )}
      {destinations.isPending && <Skeleton label="Loading websites" lines={2} />}
      {destinations.isSuccess && sites.length === 0 && (
        <EmptyState
          title="No website connected"
          description="Connect the brand's website to audit its pages: titles, descriptions, headings, canonical links, broken internal links and more, on the site's own origin only."
          action={
            <Link to={settingsHref(companyId, brandId)} className="text-sm underline underline-offset-2">
              Settings → Destinations
            </Link>
          }
        />
      )}
      {sites.map((d) => (
        <SeoAuditCard key={d.id} companyId={companyId} brandId={brandId} destination={d} />
      ))}
    </Section>
  );
}

/** How long a started run holds the button while the summary has not yet reported it (as the stale rule's window). */
const AWAITING_RUN_MAX_MS = 30_000;

function SeoAuditCard({
  companyId,
  brandId,
  destination,
}: {
  companyId: string;
  brandId: string;
  destination: DestinationDto;
}) {
  const [severity, setSeverity] = useState<SeoAuditPageSeverity | undefined>(undefined);
  const summary = useSeoAuditSummary(brandId, destination.id);
  const allowed = summary.data?.policy.allowed === true;
  const lastRun = summary.data?.lastRun ?? null;
  const findings = useSeoAuditFindings(brandId, destination.id, allowed && lastRun !== null);
  const pages = useSeoAuditPages(brandId, destination.id, severity, allowed && lastRun !== null);
  const run = useRunSeoAudit();
  // A started run holds the button from the click until the summary reports it (or a newer last run) or the start
  // failed: the mutation settles before the refetch lands, and without this the button re-enables for a frame.
  const [awaitingRun, setAwaitingRun] = useState<{ since: number; lastRunId: string | null } | null>(null);
  const summaryRunning = summary.data?.running === true;
  const summaryLastRunId = lastRun?.id ?? null;
  useEffect(() => {
    if (!awaitingRun) return;
    if (run.isError || summaryRunning || summaryLastRunId !== awaitingRun.lastRunId) {
      setAwaitingRun(null);
      return;
    }
    // Never stranded: if the summary says nothing new within the window, the button is released.
    const timer = setTimeout(
      () => setAwaitingRun(null),
      Math.max(0, AWAITING_RUN_MAX_MS - (Date.now() - awaitingRun.since)),
    );
    return () => clearTimeout(timer);
  }, [awaitingRun, run.isError, summaryRunning, summaryLastRunId]);
  const running = summaryRunning || run.isPending || awaitingRun !== null;
  const canRun = summary.data?.canRun === true;

  return (
    <article
      className="flex flex-col gap-4 py-3"
      data-testid={`seo-audit-${destination.id}`}
      aria-labelledby={`seo-audit-${destination.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={`seo-audit-${destination.id}`} className="text-sm font-semibold">
          {destination.displayName}
          <span className="ml-2 font-normal text-muted-foreground">
            {summary.data?.origin ?? destination.externalId}
          </span>
        </h3>
        {allowed && (
          <Button
            size="sm"
            variant="primary"
            data-testid="seo-audit-run"
            disabled={!canRun || running}
            disabledReason={
              !canRun
                ? 'Only admins and publishers can start an audit'
                : running
                  ? 'An audit is in progress'
                  : undefined
            }
            onClick={() => {
              setAwaitingRun({ since: Date.now(), lastRunId: summaryLastRunId });
              run.mutate({ brandId, destinationId: destination.id });
            }}
          >
            {running ? 'Audit running…' : 'Run audit'}
          </Button>
        )}
      </div>

      {summary.isError && (
        <RequestError
          error={summary.error}
          title="This audit could not load"
          onRetry={() => void summary.refetch()}
        />
      )}
      {run.isError && (
        <RequestError error={run.error} title="The audit could not start" onRetry={() => run.reset()} />
      )}
      {summary.isPending && <Skeleton label={`Loading ${destination.displayName}`} lines={3} />}

      {summary.data && !summary.data.policy.allowed && (
        <p className="text-sm text-muted-foreground" data-testid="seo-audit-policy-blocked">
          Audits not allowed by the source-use policy ({summary.data.policy.reason.replace(/_/g, ' ')} for{' '}
          {summary.data.policy.dataType}).{' '}
          <Link to={settingsHref(companyId, brandId)} className="underline underline-offset-2">
            Settings → Destinations
          </Link>
        </p>
      )}

      {summary.data?.policy.allowed && !lastRun && (
        <p className="text-sm text-muted-foreground" data-testid="seo-audit-none">
          {running
            ? 'The first audit is running; its findings appear here when it finishes.'
            : 'No audit yet. The weekly sweep runs on Mondays; an admin or publisher can run one now.'}
        </p>
      )}

      {summary.data?.policy.allowed && lastRun && (
        <>
          <div
            role="group"
            aria-label={`${destination.displayName} audit`}
            className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3"
          >
            <Tile
              testId="seo-audit-tile-pages"
              label="Pages crawled"
              value={formatNumber(lastRun.pagesCrawled)}
            />
            <Tile
              testId="seo-audit-tile-critical"
              label="Critical"
              value={formatNumber(lastRun.summary.critical)}
              tone="critical"
            />
            <Tile
              testId="seo-audit-tile-major"
              label="Major"
              value={formatNumber(lastRun.summary.major)}
              tone="warning"
            />
            <Tile
              testId="seo-audit-tile-minor"
              label="Minor"
              value={formatNumber(lastRun.summary.minor)}
              tone="info"
            />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="seo-audit-meta">
            <RunLine run={lastRun} />
            {' · '}
            <span data-testid="seo-audit-data-note">{summary.data.data.note}</span>
            {summary.data.running && (
              <>
                {' · '}
                <Badge tone="info">Running</Badge>
              </>
            )}
          </p>

          <div className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Findings</h4>
            {findings.isError && (
              <RequestError
                error={findings.error}
                title="Findings could not load"
                onRetry={() => void findings.refetch()}
              />
            )}
            {findings.isPending && findings.fetchStatus !== 'idle' && (
              <Skeleton label="Loading findings" lines={3} />
            )}
            {findings.data && findings.data.items.length === 0 && (
              <p className="text-sm text-muted-foreground">Every crawled page passed every check.</p>
            )}
            {findings.data && findings.data.items.length > 0 && (
              <ul className="flex flex-col divide-y divide-border" data-testid="seo-audit-findings">
                {findings.data.items.map((f) => (
                  <Finding key={f.check} finding={f} />
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pages</h4>
              <div role="group" aria-label="Severity" className="flex flex-wrap gap-1">
                {([undefined, 'critical', 'major', 'minor', 'ok'] as const).map((s) => {
                  const active = s === severity;
                  return (
                    <button
                      key={s ?? 'all'}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSeverity(s)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'border-accent bg-secondary font-medium'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {s ? SEVERITY_LABEL[s] : 'All'}
                    </button>
                  );
                })}
              </div>
            </div>
            <div data-testid="seo-audit-pages">
              {pages.isError && (
                <RequestError
                  error={pages.error}
                  title="Pages could not load"
                  onRetry={() => void pages.refetch()}
                />
              )}
              {pages.isPending && pages.fetchStatus !== 'idle' && (
                <Skeleton label="Loading pages" lines={3} />
              )}
              {pages.data && <PagesTable pages={pages.data.items} origin={lastRun.origin} />}
            </div>
          </div>
        </>
      )}
    </article>
  );
}

function RunLine({ run }: { run: SeoAuditRunDto }) {
  const at = run.finishedAt ?? run.startedAt;
  const ageHours = Math.max(0, (Date.now() - Date.parse(at)) / 3_600_000);
  return (
    <>
      Last run {ageText(ageHours)} ({run.trigger === 'scheduled' ? 'weekly sweep' : 'on demand'})
      {run.outcome === 'failed' && (
        <>
          {' · '}
          <Badge tone="critical">Failed{run.reason ? `: ${run.reason.replace(/_/g, ' ')}` : ''}</Badge>
        </>
      )}
      {run.limitsHit.length > 0 && (
        <span data-testid="seo-audit-limits">
          {' · '}limits hit: {run.limitsHit.map((l) => LIMIT_LABEL[l]).join(', ')}
        </span>
      )}
      {run.limitsHit.length === 0 && run.outcome === 'completed' && ' · no limit hit'}
    </>
  );
}

function Tile({ testId, label, value, tone }: { testId: string; label: string; value: string; tone?: Tone }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-4"
      data-testid={testId}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {tone && (
        <Badge tone={tone} glyph={false}>
          {label}
        </Badge>
      )}
    </div>
  );
}

/** A finding with its suggested task; copying the task is how a person carries it into a brief. */
function Finding({ finding }: { finding: SeoAuditFindingDto }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(finding.suggestedTask);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <li className="flex flex-col gap-1 py-2 text-sm" data-testid={`seo-audit-finding-${finding.check}`}>
      <span className="flex flex-wrap items-baseline gap-2">
        <Badge tone={SEVERITY_TONE[finding.severity]} glyph={false}>
          {SEVERITY_LABEL[finding.severity]}
        </Badge>
        <span className="font-medium">{finding.label}</span>
        <span className="text-xs text-muted-foreground">
          {finding.count} {finding.count === 1 ? 'page' : 'pages'}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">{finding.suggestedTask}</span>
      <span className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copy()}
          aria-label={`Copy task for ${finding.label}`}
        >
          {copied ? 'Task copied' : 'Copy task'}
        </Button>
        <span className="min-w-0 break-all text-xs text-muted-foreground">
          e.g. {finding.examples.map((u) => u.replace(/^https?:\/\/[^/]+/, '') || '/').join(', ')}
        </span>
      </span>
    </li>
  );
}

function PagesTable({ pages, origin }: { pages: SeoAuditPageDto[]; origin: string }) {
  if (pages.length === 0)
    return <p className="text-sm text-muted-foreground">No pages at this severity in the last run.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              Page
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Severity
            </th>
            <th scope="col" className="py-1 font-medium">
              Failed checks
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {pages.map((p) => {
            const failed = p.checks.filter((c) => !c.ok);
            return (
              <tr key={p.id} data-severity={p.severity}>
                <td className="max-w-xs truncate py-1.5 pr-3" title={p.url}>
                  {p.url.startsWith(origin) ? p.url.slice(origin.length) || '/' : p.url}
                </td>
                <td className="py-1.5 pr-3 tabular-nums">{p.status ?? 'unreachable'}</td>
                <td className="py-1.5 pr-3">
                  {p.severity === 'ok' ? (
                    <Badge tone="good">OK</Badge>
                  ) : (
                    <Badge tone={SEVERITY_TONE[p.severity]}>{SEVERITY_LABEL[p.severity]}</Badge>
                  )}
                </td>
                <td className="py-1.5 text-xs text-muted-foreground">
                  {failed.length === 0
                    ? '—'
                    : failed
                        .map((c) => `${c.key.replace(/_/g, ' ')}${c.detail ? ` (${c.detail})` : ''}`)
                        .join(', ')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
