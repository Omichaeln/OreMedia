import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { ageText } from '../intelligence/intelligence-helpers';
import { dayKey, trailingDayKeys } from '../publishing/publication-state';
import { LIMIT_LABEL, SOURCE_STATE, comparisonText, drillDownHref, formatFigure } from './overview-helpers';
import { PERIODS, formatNumber } from './performance-helpers';
import { useOverviewSummary, type OverviewFigureDto, type OverviewSourceDto } from './use-overview';

/**
 * Overview (ledger R2-5): the executive view of what the brand did in a window, from the overview read model
 * that composes the measurement, destinations and publishing modules' own numbers. One chip per source with its
 * state and reason; headline figures per metric kind with the previous window beside them or "insufficient
 * sample" (D-14); every figure named with its source and freshness; the organic vs paid and Oremedia vs native
 * panels stating what is not connected rather than estimating it; and the limits: every consent and blocker
 * statement (D-17, D-19, R3-4). Each source drills down into the Performance screen's own section. The window is
 * the Performance screen's (`period`), sent as UTC day bounds as its Web section sends them.
 */
const settingsHref = (companyId: string, brandId: string) =>
  `${brandPath(companyId, brandId, 'settings')}?tab=destinations`;

export function OverviewScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const timeZone = brand.timezone || 'UTC';
  const [params, setParams] = useSearchParams();
  const days = PERIODS.find(([d]) => String(d) === params.get('period'))?.[0] ?? 30;
  const todayKey = dayKey(new Date(), timeZone);
  const window = useMemo(() => {
    const { fromKey, toKey } = trailingDayKeys(days, todayKey);
    return { start: `${fromKey}T00:00:00.000Z`, end: `${toKey}T23:59:59.999Z` };
  }, [days, todayKey]);
  const overview = useOverviewSummary(brandId, window.start, window.end);
  const data = overview.data;
  const setPeriod = (d: number) => {
    const p = new URLSearchParams(params);
    p.set('period', String(d));
    setParams(p, { replace: true });
  };

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {brand.name} · the last {days} days against the {days} before · every figure with its source and
            freshness
          </p>
        </div>
        <div role="group" aria-label="Period" className="flex gap-1">
          {PERIODS.map(([d, label]) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'secondary' : 'ghost'}
              aria-pressed={days === d}
              onClick={() => setPeriod(d)}
            >
              {label}
            </Button>
          ))}
        </div>
      </header>

      {overview.isError && (
        <RequestError
          error={overview.error}
          title="The overview could not load"
          onRetry={() => void overview.refetch()}
        />
      )}
      {overview.isPending && <Skeleton label="Loading overview" lines={4} />}

      {data && (
        <>
          <Section id="sources-heading" title="Sources" testId="overview-sources">
            {data.sources.length === 0 ? (
              <EmptyState
                title="No source connected"
                description="Connect a channel in Settings, or a web source or website under Settings → Destinations, to see what the brand did."
                action={
                  <Link
                    to={settingsHref(companyId, brandId)}
                    className="text-sm underline underline-offset-2"
                  >
                    Settings → Destinations
                  </Link>
                }
              />
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {data.sources.map((s) => (
                  <SourceRow
                    key={`${s.kind}:${s.id}`}
                    source={s}
                    companyId={companyId}
                    brandId={brandId}
                    days={days}
                  />
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="social-heading"
            title="Social channels"
            testId="overview-social"
            action={
              <Link
                to={`${brandPath(companyId, brandId, 'performance')}?period=${days}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                Open Performance
              </Link>
            }
          >
            {data.social.figures.length === 0 ? (
              <EmptyState
                title={`No social figure in the last ${days} days`}
                description={
                  data.social.sample.current === 0
                    ? 'Nothing published on a channel in the window; figures appear once posts publish and their channels report back.'
                    : 'Posts published, but no channel has reported a number yet (collection runs at each channel’s reporting delay).'
                }
              />
            ) : (
              <div
                role="group"
                aria-label="Social figures"
                className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3"
              >
                {data.social.figures.map((f) => (
                  <FigureTile key={f.key} figure={f} testId={`overview-figure-${f.key}`} />
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground" data-testid="overview-social-sample">
              {data.social.sample.current} {data.social.sample.current === 1 ? 'publication' : 'publications'}{' '}
              in the window, {data.social.sample.previous} before ·{' '}
              {data.social.sample.sufficient
                ? 'compared with the previous window'
                : `insufficient sample (${data.social.sample.minimum} needed on each side, D-14)`}
              {' · '}
              {data.social.coverage.subjectsWithData} of {data.social.coverage.subjectsRequested} have numbers
              {data.social.coverage.staleValues > 0 &&
                ` · ${data.social.coverage.staleValues} stale ${data.social.coverage.staleValues === 1 ? 'value' : 'values'}`}
              {' · '}totals add only flows of one kind; unique counts and levels are never summed; a missing
              number is never zero
            </p>
          </Section>

          <Section id="web-heading" title="Web sources" testId="overview-web">
            {data.web.length === 0 && (
              <EmptyState
                title="No web source connected"
                description="Connect a Google Analytics 4 property or a Search Console site to see what the website did."
                action={
                  <Link
                    to={settingsHref(companyId, brandId)}
                    className="text-sm underline underline-offset-2"
                  >
                    Settings → Destinations
                  </Link>
                }
              />
            )}
            {data.web.map((w) => (
              <article
                key={w.source.id}
                className="flex flex-col gap-3 py-3"
                data-testid={`overview-web-${w.source.id}`}
                aria-labelledby={`overview-web-${w.source.id}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 id={`overview-web-${w.source.id}`} className="text-sm font-semibold">
                    {w.source.label}
                    <span className="ml-2 font-normal text-muted-foreground">{w.source.platform}</span>
                  </h3>
                  <Link
                    to={drillDownHref(companyId, brandId, w.source, days)}
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    Open in Performance
                  </Link>
                </div>
                {!w.policy.allowed && (
                  <p className="text-sm text-muted-foreground" data-testid="overview-web-blocked">
                    Reads not allowed by the source-use policy ({w.policy.reason.replace(/_/g, ' ')} for{' '}
                    {w.policy.dataType}).{' '}
                    <Link to={settingsHref(companyId, brandId)} className="underline underline-offset-2">
                      Settings → Destinations
                    </Link>
                  </p>
                )}
                {w.policy.allowed && w.figures.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No day of this source read yet in the window.
                  </p>
                )}
                {w.figures.length > 0 && (
                  <div
                    role="group"
                    aria-label={`${w.source.label} figures`}
                    className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3"
                  >
                    {w.figures.map((f) => (
                      <FigureTile key={f.key} figure={f} testId={`overview-web-tile-${f.key}`} />
                    ))}
                  </div>
                )}
                {w.console && (
                  <p className="text-xs text-muted-foreground">
                    AI search: no official API is verified, so no figure is shown here (D-19).{' '}
                    <a
                      href={w.console.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      Open {w.console.label} (external)
                    </a>
                  </p>
                )}
              </article>
            ))}
          </Section>

          <Section id="audit-heading" title="Audit" testId="overview-audit">
            {data.audits.length === 0 && (
              <EmptyState
                title="No website connected"
                description="Connect the brand's website to audit its pages on the site's own origin."
                action={
                  <Link
                    to={settingsHref(companyId, brandId)}
                    className="text-sm underline underline-offset-2"
                  >
                    Settings → Destinations
                  </Link>
                }
              />
            )}
            {data.audits.map((a) => (
              <article
                key={a.source.id}
                className="flex flex-col gap-3 py-3"
                data-testid={`overview-audit-${a.source.id}`}
                aria-labelledby={`overview-audit-${a.source.id}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 id={`overview-audit-${a.source.id}`} className="text-sm font-semibold">
                    {a.source.label}
                    <span className="ml-2 font-normal text-muted-foreground">{a.source.platform}</span>
                  </h3>
                  <Link
                    to={drillDownHref(companyId, brandId, a.source, days)}
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    Open in Performance
                  </Link>
                </div>
                {!a.policy.allowed && (
                  <p className="text-sm text-muted-foreground" data-testid="overview-audit-blocked">
                    Audits not allowed by the source-use policy ({a.policy.reason.replace(/_/g, ' ')} for{' '}
                    {a.policy.dataType}).{' '}
                    <Link to={settingsHref(companyId, brandId)} className="underline underline-offset-2">
                      Settings → Destinations
                    </Link>
                  </p>
                )}
                {a.policy.allowed && !a.lastRun && (
                  <p className="text-sm text-muted-foreground">
                    {a.running
                      ? 'The first audit is running.'
                      : 'No audit yet; the weekly sweep runs on Mondays.'}
                  </p>
                )}
                {a.policy.allowed && a.lastRun && (
                  <>
                    <div
                      role="group"
                      aria-label={`${a.source.label} audit`}
                      className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3"
                    >
                      <PlainTile label="Pages crawled" value={formatNumber(a.lastRun.pagesCrawled)} />
                      <PlainTile label="Critical" value={formatNumber(a.lastRun.summary.critical)} />
                      <PlainTile label="Major" value={formatNumber(a.lastRun.summary.major)} />
                      <PlainTile label="Minor" value={formatNumber(a.lastRun.summary.minor)} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.source.label} · {a.lastRun.trigger === 'scheduled' ? 'weekly sweep' : 'on demand'}
                      {a.lastRun.finishedAt &&
                        ` · finished ${ageText((Date.now() - Date.parse(a.lastRun.finishedAt)) / 3_600_000)}`}
                      {' · '}
                      {a.data.note}
                      {a.running && (
                        <>
                          {' · '}
                          <Badge tone="info">Running</Badge>
                        </>
                      )}
                    </p>
                  </>
                )}
              </article>
            ))}
          </Section>

          <div className="grid gap-8 lg:grid-cols-2">
            <Section id="paid-heading" title="Organic vs paid" testId="overview-paid">
              <SplitRow
                label="Organic"
                figure={`${formatNumber(data.organicVsPaid.organic.publications)} ${data.organicVsPaid.organic.publications === 1 ? 'publication' : 'publications'}`}
                note={data.organicVsPaid.organic.note}
              />
              <SplitRow label="Paid" state="Not connected" note={data.organicVsPaid.paid.reason} />
              {data.organicVsPaid.paid.separatingDefinitions.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Definitions that separate paid from organic once a connector reports them:{' '}
                  {data.organicVsPaid.paid.separatingDefinitions.join(', ')}.
                </p>
              )}
            </Section>
            <Section id="native-heading" title="Oremedia vs native" testId="overview-native">
              <SplitRow
                label="Through Oremedia"
                figure={`${formatNumber(data.oremediaVsNative.oremedia.publications)} ${data.oremediaVsNative.oremedia.publications === 1 ? 'publication' : 'publications'}`}
                note={data.oremediaVsNative.oremedia.note}
              />
              <SplitRow label="Native" state="Not observed" note={data.oremediaVsNative.native.reason} />
            </Section>
          </div>

          <Section id="limits-heading" title="Limits" testId="overview-limits">
            <ul className="flex flex-col divide-y divide-border">
              {data.limits.map((l, i) => (
                <li
                  key={`${l.code}:${l.source?.id ?? i}`}
                  className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-baseline sm:gap-3"
                  data-limit={l.code}
                >
                  <span className="shrink-0">
                    <Badge tone="neutral" glyph={false}>
                      {LIMIT_LABEL[l.code]}
                    </Badge>
                  </span>
                  <span className="min-w-0">
                    {l.statement}
                    {l.link && (
                      <>
                        {' '}
                        <a
                          href={l.link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2"
                        >
                          {l.link.label}
                        </a>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <p className="text-xs text-muted-foreground">
            Computed {new Date(data.computedAt).toLocaleString()} · window {data.days.start} to{' '}
            {data.days.end} (UTC days)
          </p>
        </>
      )}
    </main>
  );
}

/** One source of the roll-up: its state as a badge with the glyph, the reason, and the drill-down. */
function SourceRow({
  source,
  companyId,
  brandId,
  days,
}: {
  source: OverviewSourceDto;
  companyId: string;
  brandId: string;
  days: number;
}) {
  const state = SOURCE_STATE[source.state];
  return (
    <li
      className="flex flex-col gap-1 py-2.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
      data-testid={`overview-source-${source.id}`}
      data-source-state={source.state}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="font-medium">{source.label}</span>
        <span className="text-xs text-muted-foreground">{source.platform}</span>
        <span className="text-xs text-muted-foreground">· {source.reason}</span>
        {source.freshness?.asOf && source.freshness.ageHours !== null && (
          <span className="text-xs text-muted-foreground">· as of {ageText(source.freshness.ageHours)}</span>
        )}
      </span>
      <Link
        to={drillDownHref(companyId, brandId, source, days)}
        className="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
      >
        Open in Performance
      </Link>
    </li>
  );
}

/** A headline figure with its source label, coverage and freshness, and the comparison or why there is none. */
function FigureTile({ figure, testId }: { figure: OverviewFigureDto; testId: string }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-4"
      data-testid={testId}
    >
      <span className="text-xs text-muted-foreground">{figure.label}</span>
      <span className="text-2xl font-semibold tabular-nums">
        {figure.value !== null
          ? formatFigure(figure.kind, figure.value)
          : figure.note
            ? 'Not summed'
            : 'Unavailable'}
      </span>
      <span className="text-xs text-muted-foreground">{comparisonText(figure)}</span>
      <span className="text-xs text-muted-foreground">
        {figure.source.label} · {figure.coverage.withData} of {figure.coverage.requested}{' '}
        {figure.coverage.unit}
        {figure.freshness?.ageHours !== null &&
          figure.freshness?.ageHours !== undefined &&
          ` · ${ageText(figure.freshness.ageHours)}`}
      </span>
      {figure.freshness?.stale && (
        <span>
          <Badge tone="warning">Stale</Badge>
        </span>
      )}
    </div>
  );
}

function PlainTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** One side of a split: a figure with its note, or the explicit state of what is not connected. */
function SplitRow({
  label,
  figure,
  state,
  note,
}: {
  label: string;
  figure?: string;
  state?: string;
  note: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm" data-split={label}>
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{label}</span>
        {figure && <span className="tabular-nums">{figure}</span>}
        {state && (
          <Badge tone="neutral" glyph={false}>
            {state}
          </Badge>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}
