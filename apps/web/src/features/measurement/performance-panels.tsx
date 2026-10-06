import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { COMPARISON_MINIMUM_SAMPLE } from '@oremedia/contracts/measurement';
import { Badge, Button, Skeleton, StatusBanner, cn } from '@oremedia/ui';
import { Drawer, DrawerContent, DrawerTrigger } from '../../components/drawer';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { brandPath } from '../brand/brand-context';
import { PackageTitle } from '../content/package-title';
import { ageText, freshnessText, insightLabel } from '../intelligence/intelligence-helpers';
import { AnalyseNowForm } from '../intelligence/intelligence-workspace';
import { RecommendationCard } from '../intelligence/recommendation-card';
import { useWorkspace, type AnalystRunDto, type InsightDto } from '../intelligence/use-intelligence';
import type { CalendarPublicationDto } from '../publishing/use-publishing';
import {
  SLOTS,
  WEEKDAYS,
  bestSlot,
  formatNumber,
  liftOf,
  percent,
  publicationCalendarHref,
  signedPercent,
  slotCells,
  type SlotPost,
} from './performance-helpers';
import {
  useAttributeAggregate,
  usePublicationQuality,
  useTrackedLinks,
  type AttributeAggregateDto,
} from './use-measurement';

/** The features the aggregate groups by (attributes.ts AGGREGATED_FEATURES, cta and subtitles), as the screen names them. */
const FEATURE_LABEL: Record<string, string> = {
  hookType: 'Hook',
  imageryKind: 'Imagery',
  layoutKey: 'Layout',
  colourTreatment: 'Colour treatment',
  templateVersionId: 'Template version',
  distribution: 'Distribution',
  pacing: 'Pacing',
  cta: 'Call to action',
  subtitles: 'Subtitles',
};
/** Sequential steps of the accent for a cell at or above the minimum sample; below it a rate is shown, never shaded (D-14). */
const SHADE = ['bg-accent/15', 'bg-accent/30', 'bg-accent/45', 'bg-accent/60'] as const;
const shadeClass = (rate: number, max: number) =>
  SHADE[Math.min(SHADE.length - 1, Math.floor((rate / max) * SHADE.length))];
const featureLabel = (feature: string) =>
  FEATURE_LABEL[feature] ?? feature.replace(/([A-Z])/g, ' $1').toLowerCase();

/** Spec 15.3 components as the screen names them. */
const COMPONENT_LABEL: Record<string, string> = {
  saves: 'Saves',
  shares: 'Shares',
  substantive_comments: 'Substantive comments',
  repeat_engagers: 'Repeat engagers',
  negative_feedback: 'Negative feedback',
};

/**
 * One of the interface's white panels on Performance: a 15 px heading with a muted line on the right, then content.
 * A region of the page (`aria-labelledby` the heading), so the e2e and screen readers address it by name.
 */
export function PerformanceCard({
  id,
  title,
  eyebrow,
  meta,
  testId,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn('flex min-w-0 flex-col gap-3.5 rounded-xl border border-border bg-card p-5', className)}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          {eyebrow && <p className="om-eyebrow text-accent-ink">{eyebrow}</p>}
          <h2 id={id} className={cn('font-bold', eyebrow ? 'text-lg' : 'text-md')}>
            {title}
          </h2>
        </div>
        {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * UX-12 "when it lands": the brand's released posts by weekday (columns) and six-hour slot (rows) on the brand's
 * clock, each cell the pooled engagement rate of its measured posts (D-15). A cell with posts but no numbers says
 * so; an empty cell is empty. The text in each cell is the record; the shading only helps comparison.
 */
export function SlotHeatmap({ posts, timeZone }: { posts: SlotPost[]; timeZone: string }) {
  const cells = useMemo(() => slotCells(posts, timeZone), [posts, timeZone]);
  const sufficient = (c: { measured: number }) => c.measured >= COMPARISON_MINIMUM_SAMPLE;
  const max = Math.max(0, ...cells.filter(sufficient).map((c) => c.rate ?? 0));
  const measured = cells.reduce((n, c) => n + c.measured, 0);
  const best = bestSlot(cells, COMPARISON_MINIMUM_SAMPLE);
  return (
    <PerformanceCard
      id="slots-heading"
      title="When it lands"
      meta={`Engagement rate by slot · ${timeZone}`}
      testId="slot-heatmap"
    >
      {measured === 0 ? (
        <p className="text-sm text-muted-foreground">
          No post in the period has both engagement and impressions yet, so no slot has a rate.
        </p>
      ) : (
        <>
          <table className="w-full table-fixed border-separate border-spacing-1 text-2xs">
            <caption className="sr-only">Engagement rate by six-hour slot and weekday, {timeZone}</caption>
            <thead>
              <tr>
                <td className="w-11" />
                {WEEKDAYS.map((day) => (
                  <th key={day} scope="col" className="text-center font-normal text-muted-foreground">
                    {day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SLOTS.map((slot, s) => (
                <tr key={slot}>
                  <th scope="row" className="text-left text-xs font-normal text-muted-foreground">
                    {slot}
                  </th>
                  {cells
                    .filter((c) => c.slot === s)
                    .map((c) => (
                      <td key={c.weekday} className="p-0">
                        <div
                          className={cn(
                            'flex h-9 flex-col items-center justify-center rounded-sm leading-tight tabular-nums',
                            c.rate !== null && sufficient(c) && max > 0
                              ? shadeClass(c.rate, max)
                              : 'bg-muted text-muted-foreground',
                          )}
                          data-testid="slot-cell"
                          data-slot={`${c.weekday}:${c.slot}`}
                          data-sufficient={sufficient(c)}
                          title={
                            c.publications === 0
                              ? `${WEEKDAYS[c.weekday]} ${slot}: no posts`
                              : `${WEEKDAYS[c.weekday]} ${slot}: ${c.publications} ${c.publications === 1 ? 'post' : 'posts'}, ${c.measured} measured`
                          }
                        >
                          {c.rate !== null ? (
                            <span className="font-medium">{percent(c.rate)}</span>
                          ) : c.publications > 0 ? (
                            <span>no rate</span>
                          ) : (
                            <span aria-hidden="true">·</span>
                          )}
                          {c.publications > 0 && (
                            <span className="text-muted-foreground">
                              {c.measured}/{c.publications}
                            </span>
                          )}
                        </div>
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">
            {best
              ? `Best slot: ${WEEKDAYS[best.weekday]} ${SLOTS[best.slot]} (${percent(best.rate ?? 0)} over ${best.measured} measured posts). `
              : `No slot has ${COMPARISON_MINIMUM_SAMPLE} measured posts yet, so none is called best. `}
            Each cell pools engagement over impressions (never a mean of rates), with measured over posted
            under it; only a cell with at least {COMPARISON_MINIMUM_SAMPLE} measured posts is shaded.
          </p>
        </>
      )}
    </PerformanceCard>
  );
}

/**
 * UX-12 "what the creative did": the pooled engagement rate of the posts carrying each captured attribute value,
 * drawn as its lift over the brand's rate on the same posts. A value under the minimum sample (D-14) is listed, not
 * compared: no lift bar is drawn for it.
 */
export function CreativeAttributesPanel({
  brandId,
  windowStart,
  windowEnd,
  enabled,
}: {
  brandId: string;
  windowStart: string;
  windowEnd: string;
  enabled: boolean;
}) {
  const aggregate = useAttributeAggregate(brandId, windowStart, windowEnd, enabled);
  return (
    <PerformanceCard
      id="attributes-heading"
      title="What the creative did"
      meta="Lift in engagement rate vs. the brand’s rate · attributes captured at approval"
      testId="creative-attributes"
    >
      {aggregate.isError && (
        <RequestError
          error={aggregate.error}
          title="Creative attributes could not load"
          onRetry={() => void aggregate.refetch()}
        />
      )}
      {aggregate.isPending && aggregate.fetchStatus !== 'idle' && (
        <Skeleton label="Loading creative attributes" lines={3} />
      )}
      {aggregate.data && <AttributeRows data={aggregate.data} />}
    </PerformanceCard>
  );
}

function AttributeRows({ data }: { data: AttributeAggregateDto }) {
  const byFeature = useMemo(() => {
    const map = new Map<string, AttributeAggregateDto['features']>();
    for (const f of data.features) map.set(f.feature, [...(map.get(f.feature) ?? []), f]);
    for (const list of map.values()) list.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
    return [...map.entries()];
  }, [data.features]);
  if (data.withNumbers === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No post in the period has engagement and impressions yet, so nothing can be read from the creative.
      </p>
    );
  if (data.withAttributes === 0)
    return (
      <p className="text-sm text-muted-foreground">
        None of the {data.withNumbers} measured {data.withNumbers === 1 ? 'post carries' : 'posts carry'}{' '}
        captured attributes. Attributes are extracted when a revision is approved; older posts have none.
      </p>
    );
  const liftFor = (v: AttributeAggregateDto['features'][number]) =>
    v.sufficient ? liftOf(v.rate, data.brand.rate) : null;
  const span = Math.max(0.1, ...data.features.map((v) => Math.abs(liftFor(v) ?? 0)));
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground" data-testid="attributes-brand">
        Brand rate{' '}
        <span className="font-medium text-foreground tabular-nums">
          {data.brand.rate !== null ? percent(data.brand.rate) : '—'}
        </span>{' '}
        over {data.withNumbers} measured {data.withNumbers === 1 ? 'post' : 'posts'} on all channels,{' '}
        {data.withAttributes} of {data.publications} with attributes · a value with fewer than {data.minimum}{' '}
        posts is listed, not compared
      </p>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-6">
        {byFeature.map(([feature, values]) => (
          <div key={feature} className="flex flex-col gap-2.5" data-testid="attribute-feature">
            <dt className="om-label">{featureLabel(feature)}</dt>
            {values.map((v) => {
              const lift = liftFor(v);
              const width = lift === null ? 0 : Math.max(2, (Math.abs(lift) / span) * 50);
              return (
                <dd
                  key={v.value}
                  className="grid grid-cols-[110px_minmax(0,1fr)_64px] items-center gap-2 text-xs"
                  data-testid="attribute-value"
                  data-sufficient={v.sufficient}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate" title={v.value}>
                      {v.value}
                    </span>
                    <span className="text-2xs text-muted-foreground tabular-nums">
                      {v.rate !== null ? percent(v.rate) : '—'} · {v.publications}{' '}
                      {v.publications === 1 ? 'post' : 'posts'}
                    </span>
                  </span>
                  <span aria-hidden="true" className="relative h-2 rounded-sm bg-muted">
                    <span className="absolute -inset-y-0.5 left-1/2 w-px bg-border-strong" />
                    {lift !== null && (
                      <span
                        className={cn(
                          'absolute inset-y-0 rounded-sm',
                          lift >= 0 ? 'bg-status-good-dot' : 'bg-status-critical-dot',
                        )}
                        style={
                          lift >= 0
                            ? { left: '50%', width: `${width}%` }
                            : { left: `${50 - width}%`, width: `${width}%` }
                        }
                      />
                    )}
                  </span>
                  <span
                    className={cn(
                      'text-right tabular-nums',
                      lift === null
                        ? 'text-2xs text-muted-foreground'
                        : lift >= 0
                          ? 'text-status-good'
                          : 'text-status-critical',
                    )}
                  >
                    {v.sufficient ? (lift === null ? '—' : signedPercent(lift)) : 'Small sample'}
                  </span>
                </dd>
              );
            })}
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Attributes describe the creative, not why it worked: a difference here is an observation (spec 16.3),
        never a finding, until an experiment tests it.
      </p>
    </div>
  );
}

/**
 * UX-12 one post, opened under its row of the content table: its engagement quality composite (spec 15.3) with
 * every component and what is unavailable, and the tracked links with the clicks the redirector recorded (15.4).
 */
export function PublicationDetail({
  companyId,
  brandId,
  publication,
  timeZone,
  windowStart,
  windowEnd,
  channelName,
  onClose,
}: {
  companyId: string;
  brandId: string;
  publication: CalendarPublicationDto;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  channelName: string;
  onClose: () => void;
}) {
  const quality = usePublicationQuality(brandId, publication.publicationId, windowStart, windowEnd);
  const links = useTrackedLinks(brandId, publication.publicationId);
  const calendarHref = publicationCalendarHref(companyId, brandId, publication, timeZone);
  return (
    <aside
      aria-labelledby="post-detail-heading"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card-tint px-3.5 py-3"
      data-testid="post-detail"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="om-eyebrow text-accent-ink">This post</p>
          <h2 id="post-detail-heading" className="text-sm font-medium">
            <PackageTitle contentPackageId={publication.contentPackageId} />
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {channelName} ·{' '}
            {new Date(publication.scheduledFor).toLocaleString(undefined, {
              timeZone,
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" asChild>
            <Link to={calendarHref}>Open in calendar</Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <section aria-labelledby="quality-heading" className="flex min-w-0 flex-col gap-2">
          <h3 id="quality-heading" className="om-label">
            Engagement quality
          </h3>
          {quality.isError && (
            <RequestError
              error={quality.error}
              title="Quality could not load"
              onRetry={() => void quality.refetch()}
            />
          )}
          {quality.isPending && <Skeleton label="Loading engagement quality" lines={3} />}
          {quality.data && (
            <div className="flex flex-col gap-2" data-testid="post-quality">
              <p className="text-sm">
                <span className="text-xl font-bold">
                  {quality.data.score !== null ? quality.data.score.toFixed(2) : 'Unavailable'}
                </span>{' '}
                <span className="text-xs text-muted-foreground">
                  {quality.data.score !== null
                    ? `per 1,000 impressions · weights from ${quality.data.weightsSource === 'brand_objective' ? 'the brand objective' : 'the default (equal)'}`
                    : 'no component has data yet'}
                </span>
              </p>
              <dl className="flex flex-col text-sm">
                {quality.data.components.map((c) => (
                  <div
                    key={c.component}
                    className="flex items-baseline justify-between gap-4 border-t border-border py-1.5"
                    data-testid="quality-component"
                  >
                    <dt className={cn(!c.available && 'text-muted-foreground')}>
                      {COMPONENT_LABEL[c.component] ?? c.component}
                      {c.weight !== 1 && <span className="text-xs text-muted-foreground"> ×{c.weight}</span>}
                    </dt>
                    <dd className="text-right tabular-nums">
                      {c.available && c.value !== null ? (
                        <>
                          {formatNumber(c.value)}
                          {c.normalised !== null && (
                            <span className="text-xs text-muted-foreground">
                              {' '}
                              · {c.normalised.toFixed(2)}‰
                            </span>
                          )}
                        </>
                      ) : (
                        <Badge tone="neutral">Unavailable</Badge>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {quality.data.unavailable.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  The composite is computed over the components with data; the rest are left out, never
                  counted as zero.
                </p>
              )}
            </div>
          )}
        </section>

        <section aria-labelledby="links-heading" className="flex min-w-0 flex-col gap-2">
          <h3 id="links-heading" className="om-label">
            Tracked links
          </h3>
          {links.isError && (
            <RequestError
              error={links.error}
              title="Links could not load"
              onRetry={() => void links.refetch()}
            />
          )}
          {links.isPending && <Skeleton label="Loading tracked links" lines={2} />}
          {links.data && links.data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">This post carries no tracked link.</p>
          )}
          {links.data && links.data.items.length > 0 && (
            <ul className="flex flex-col text-sm" data-testid="post-links">
              {links.data.items.map((l) => (
                <li key={l.id} className="flex flex-col gap-0.5 border-t border-border py-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 break-all">{l.destination}</span>
                    <span className="shrink-0 tabular-nums">
                      {formatNumber(l.clicks)} {l.clicks === 1 ? 'click' : 'clicks'}
                    </span>
                  </div>
                  <span className="break-all text-xs text-muted-foreground">
                    {l.shortUrl} · created {ageText((Date.now() - Date.parse(l.createdAt)) / 3_600_000)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

interface Analysis {
  run: AnalystRunDto;
  /** The "What changed" freshness before the run: the output has arrived once this changes. */
  asOfBefore: string | null;
}

/** One ruled list of the AI review (the interface's Worked / Didn't / Likely reasons form). */
function ReviewList({
  label,
  note,
  glyph,
  glyphClass,
  items,
  testId,
}: {
  label: string;
  note?: string;
  glyph: string;
  glyphClass?: string;
  items: InsightDto[];
  testId: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col" data-testid={testId}>
      <h3 className="om-label mb-1.5">
        {label}
        {note && <span className="font-normal normal-case tracking-normal"> — {note}</span>}
      </h3>
      <ul className="flex flex-col">
        {items.map((i) => (
          <li key={i.id} className="flex gap-2.5 border-t border-border py-2 text-sm">
            <span aria-hidden="true" className={cn('w-3 shrink-0 text-center', glyphClass)}>
              {glyph}
            </span>
            <span className="min-w-0 text-pretty">
              <span className="sr-only">{insightLabel(i.kind, i.strength)}: </span>
              {i.statement}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The interface's AI review and next content cycle, side by side, from the intelligence workspace: the brand
 * analyst's latest movements, findings and hypotheses (each labelled as what it is, spec 16.3), and the open
 * recommendations that propose a brief, kept (accepted: the brief is created) or dropped (dismissed with a reason)
 * through the same procedures as the workspace. Nothing reads as decided until the server returns the decision. The
 * analyst is run from a side sheet, as on Intelligence; the views poll until its output lands.
 */
export function AnalystReview({
  companyId,
  brandId,
  days,
}: {
  companyId: string;
  brandId: string;
  days: number;
}) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analystOpen, setAnalystOpen] = useState(false);
  const workspace = useWorkspace(brandId, analysis !== null);
  const ws = workspace.data;
  const asOf = ws?.whatChanged.freshness.asOf;
  const analysing = analysis !== null && ws !== undefined && asOf === analysis.asOfBefore;
  // The run is over for this screen once the "What changed" view carries newer input than before it started.
  useEffect(() => {
    if (analysis !== null && ws !== undefined && asOf !== analysis.asOfBefore) setAnalysis(null);
  }, [analysis, ws, asOf]);
  const briefs = useMemo(
    () =>
      (ws?.whatToDoNext.items ?? []).filter(
        (r) => r.state === 'proposed' && r.proposedAction === 'create_brief',
      ),
    [ws],
  );
  const intelligenceHref = brandPath(companyId, brandId, 'intelligence');
  const hypotheses = ws ? [...ws.whatWeLearned.observations, ...ws.whatWeLearned.directional] : [];
  const reviewed =
    ws !== undefined &&
    ws.whatChanged.items.length + ws.whatWeLearned.experimentallySupported.length + hypotheses.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {workspace.isError && (
        <RequestError
          error={workspace.error}
          title={
            toUiError(workspace.error).kind === 'forbidden'
              ? 'Permission denied'
              : 'The analyst’s review could not load'
          }
          onRetry={() => void workspace.refetch()}
        />
      )}
      {workspace.isPending && <Skeleton label="Loading the analyst’s review" lines={3} />}
      {analysing && analysis && (
        <StatusBanner
          tone="info"
          busy
          title="Analysis running"
          description={`Workflow ${analysis.run.workflowId} reviews ${new Date(analysis.run.periodStart).toLocaleDateString()} to ${new Date(analysis.run.periodEnd).toLocaleDateString()}. The review and the cycle refresh when its insights land.`}
          data-testid="analysis-running"
        />
      )}
      {ws && (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <PerformanceCard
            id="ai-review-heading"
            eyebrow="AI review · brand analyst"
            title={reviewed ? 'What the analyst found' : 'No review yet'}
            meta={
              <span className="flex flex-wrap items-center gap-1.5">
                {freshnessText(ws.whatChanged.freshness)}
                {ws.whatChanged.freshness.stale && ws.whatChanged.freshness.asOf !== null && (
                  <Badge tone="warning">Stale</Badge>
                )}
              </span>
            }
            testId="ai-review"
          >
            <p className="text-pretty text-base">{ws.whatChanged.coverage.statement}</p>
            <ReviewList
              label="Movements"
              glyph="→"
              glyphClass="text-muted-foreground"
              items={ws.whatChanged.items}
              testId="ai-review-movements"
            />
            <ReviewList
              label="Findings"
              note="experimentally supported"
              glyph="✓"
              glyphClass="text-status-good"
              items={ws.whatWeLearned.experimentallySupported}
              testId="ai-review-findings"
            />
            <ReviewList
              label="Likely reasons"
              note="hypotheses, not findings"
              glyph="?"
              glyphClass="text-muted-foreground"
              items={hypotheses}
              testId="ai-review-hypotheses"
            />
            {!reviewed && (
              <p className="text-sm text-muted-foreground">
                The brand analyst has not reviewed this brand yet. Run it once metric snapshots exist; until
                then nothing is shown and nothing is estimated.
              </p>
            )}
            <Link to={intelligenceHref} className="self-start text-sm font-medium hover:opacity-60">
              Open intelligence <span aria-hidden="true">→</span>
            </Link>
          </PerformanceCard>

          <PerformanceCard
            id="next-cycle-heading"
            eyebrow="Next content cycle · suggested"
            title="Recommended briefs"
            meta={
              <Link to={intelligenceHref} className="underline-offset-2 hover:underline">
                All recommendations
              </Link>
            }
            testId="next-cycle"
          >
            <p className="text-xs text-muted-foreground">{ws.whatToDoNext.statement}</p>
            {briefs.length === 0 ? (
              <p className="border-t border-border py-3 text-sm text-muted-foreground">
                No brief is recommended. Recommendations that propose a brief appear here once an analysis
                finds something worth a post.
              </p>
            ) : (
              <ul className="flex flex-col" aria-label="Recommended briefs">
                {briefs.map((r) => (
                  <RecommendationCard
                    key={r.id}
                    companyId={companyId}
                    brandId={brandId}
                    recommendation={r}
                    position={null}
                    layout="row"
                  />
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Drawer open={analystOpen} onOpenChange={setAnalystOpen}>
                <DrawerTrigger asChild>
                  <Button variant="primary" disabled={analysing}>
                    {analysing ? 'Analysis running…' : 'Run brand analyst'}
                  </Button>
                </DrawerTrigger>
                <DrawerContent
                  title="Run the brand analyst"
                  side="right"
                  className="w-[min(92vw,26rem)] overflow-y-auto p-5"
                >
                  <div className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">
                      Reviews the period’s metric snapshots and comments and writes insights and
                      recommendations. The review and the cycle refresh when they land.
                    </p>
                    <AnalyseNowForm
                      brandId={brandId}
                      defaultPeriodDays={days}
                      onStarted={(run) => {
                        setAnalysis({ run, asOfBefore: ws.whatChanged.freshness.asOf });
                        setAnalystOpen(false);
                      }}
                    />
                  </div>
                </DrawerContent>
              </Drawer>
              <span className="text-xs text-muted-foreground">
                Keeping a recommendation creates its brief with the evidence attached. Nothing is scheduled
                until reviewed.
              </span>
            </div>
          </PerformanceCard>
        </div>
      )}
    </div>
  );
}
