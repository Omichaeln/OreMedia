import { useMemo } from 'react';
import { Link } from 'react-router';
import { COMPARISON_MINIMUM_SAMPLE } from '@oremedia/contracts/measurement';
import { Badge, Button, EmptyState, Skeleton, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { brandPath } from '../brand/brand-context';
import { PackageTitle } from '../content/package-title';
import { ageText } from '../intelligence/intelligence-helpers';
import { RecommendationCard } from '../intelligence/recommendation-card';
import { useWorkspace } from '../intelligence/use-intelligence';
import type { CalendarPublicationDto } from '../publishing/use-publishing';
import {
  SLOTS,
  WEEKDAYS,
  formatNumber,
  percent,
  publicationCalendarHref,
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
/** Shading steps for a cell at or above the minimum sample; below it a rate is shown but never shaded (D-14). */
const SHADE = ['bg-accent/10', 'bg-accent/20', 'bg-accent/30', 'bg-accent/40'] as const;
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
 * UX-12 "when it lands": the brand's released posts by weekday and six-hour slot on the brand's clock, each cell
 * the pooled engagement rate of its measured posts (D-15). A cell with posts but no numbers says so; an empty
 * cell is empty. The table is the record; the shading only helps comparison.
 */
export function SlotHeatmap({ posts, timeZone }: { posts: SlotPost[]; timeZone: string }) {
  const cells = useMemo(() => slotCells(posts, timeZone), [posts, timeZone]);
  const sufficient = (c: { measured: number }) => c.measured >= COMPARISON_MINIMUM_SAMPLE;
  const max = Math.max(0, ...cells.filter(sufficient).map((c) => c.rate ?? 0));
  const measured = cells.reduce((n, c) => n + c.measured, 0);
  return (
    <Section id="slots-heading" title="When it lands" testId="slot-heatmap">
      {measured === 0 ? (
        <p className="text-sm text-muted-foreground">
          No post in the period has both engagement and impressions yet, so no slot has a rate.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-xs">
            <caption className="sr-only">Engagement rate by weekday and six-hour slot, {timeZone}</caption>
            <thead>
              <tr>
                <th scope="col" className="py-1 pr-2 text-left font-medium text-muted-foreground">
                  {timeZone}
                </th>
                {SLOTS.map((s) => (
                  <th key={s} scope="col" className="py-1 text-center font-medium text-muted-foreground">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAYS.map((day, weekday) => (
                <tr key={day}>
                  <th scope="row" className="py-0.5 pr-2 text-left font-medium text-muted-foreground">
                    {day}
                  </th>
                  {cells
                    .filter((c) => c.weekday === weekday)
                    .map((c) => (
                      <td key={c.slot} className="p-0.5">
                        <div
                          className={cn(
                            'flex h-9 flex-col items-center justify-center rounded border border-border tabular-nums',
                            (c.rate === null || !sufficient(c)) && 'text-muted-foreground',
                            c.rate !== null && sufficient(c) && max > 0 && shadeClass(c.rate, max),
                          )}
                          data-testid="slot-cell"
                          data-slot={`${weekday}:${c.slot}`}
                          data-sufficient={sufficient(c)}
                          title={
                            c.publications === 0
                              ? `${day} ${SLOTS[c.slot]}: no posts`
                              : `${day} ${SLOTS[c.slot]}: ${c.publications} ${c.publications === 1 ? 'post' : 'posts'}, ${c.measured} measured`
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
                            <span className="text-[0.65rem] text-muted-foreground">
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
          <p className="mt-2 text-xs text-muted-foreground">
            Each cell pools engagement over impressions of its measured posts (never a mean of rates);
            measured over posted is shown under the rate. Only a cell with at least{' '}
            {COMPARISON_MINIMUM_SAMPLE} measured posts is shaded; a smaller one is a hint, not a finding.
          </p>
        </div>
      )}
    </Section>
  );
}

/**
 * UX-12 "what the creative did": the pooled engagement rate of the posts carrying each captured attribute value,
 * beside the brand's rate over the same posts. A value under the minimum sample (D-14) is listed, not compared.
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
    <Section id="attributes-heading" title="What the creative did" testId="creative-attributes">
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
    </Section>
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
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" data-testid="attributes-brand">
        Brand rate{' '}
        <span className="font-medium tabular-nums">
          {data.brand.rate !== null ? percent(data.brand.rate) : '—'}
        </span>{' '}
        <span className="text-muted-foreground">
          over {data.withNumbers} measured {data.withNumbers === 1 ? 'post' : 'posts'} on all channels,{' '}
          {data.withAttributes} of {data.publications} with attributes · a value with fewer than{' '}
          {data.minimum} posts is listed, not compared
        </span>
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {byFeature.map(([feature, values]) => (
          <div key={feature} className="flex flex-col gap-1" data-testid="attribute-feature">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {featureLabel(feature)}
            </dt>
            {values.map((v) => (
              <dd
                key={v.value}
                className="flex items-baseline justify-between gap-3 text-sm"
                data-testid="attribute-value"
                data-sufficient={v.sufficient}
              >
                <span className="min-w-0 break-words">{v.value}</span>
                <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                  <span className={cn(!v.sufficient && 'text-muted-foreground')}>
                    {v.rate !== null ? percent(v.rate) : '—'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {v.publications} {v.publications === 1 ? 'post' : 'posts'}
                  </span>
                  {!v.sufficient && <Badge tone="neutral">Small sample</Badge>}
                  {v.sufficient &&
                    v.rate !== null &&
                    data.brand.rate !== null &&
                    v.rate > data.brand.rate && <Badge tone="good">Above brand</Badge>}
                </span>
              </dd>
            ))}
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
 * UX-12 one post: its engagement quality composite (spec 15.3) with every component and what is unavailable, and
 * the tracked links with the clicks the redirector recorded (spec 15.4).
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
      className="flex flex-col gap-4 rounded-md border border-border bg-background p-4"
      data-testid="post-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="post-detail-heading" className="font-medium">
            <PackageTitle contentPackageId={publication.contentPackageId} />
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {channelName} ·{' '}
            {new Date(publication.scheduledFor).toLocaleString(undefined, {
              timeZone,
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            ·{' '}
            <Link to={calendarHref} className="underline-offset-2 hover:underline">
              Open in calendar
            </Link>
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <section aria-labelledby="quality-heading" className="flex flex-col gap-2">
        <h3
          id="quality-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
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
              <span className="text-2xl font-semibold tabular-nums">
                {quality.data.score !== null ? quality.data.score.toFixed(2) : 'Unavailable'}
              </span>{' '}
              <span className="text-xs text-muted-foreground">
                {quality.data.score !== null
                  ? `per 1,000 impressions · weights from ${quality.data.weightsSource === 'brand_objective' ? 'the brand objective' : 'the default (equal)'}`
                  : 'no component has data yet'}
              </span>
            </p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
              {quality.data.components.map((c) => (
                <div key={c.component} className="contents" data-testid="quality-component">
                  <dt className={cn(!c.available && 'text-muted-foreground')}>
                    {COMPONENT_LABEL[c.component] ?? c.component}
                    {c.weight !== 1 && <span className="text-xs text-muted-foreground"> ×{c.weight}</span>}
                  </dt>
                  <dd className="text-right tabular-nums">
                    {c.available && c.value !== null ? (
                      <>
                        {formatNumber(c.value)}
                        {c.normalised !== null && (
                          <span className="text-xs text-muted-foreground"> · {c.normalised.toFixed(2)}‰</span>
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
                The composite is computed over the components with data; the rest are left out, never counted
                as zero.
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="links-heading" className="flex flex-col gap-2">
        <h3
          id="links-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
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
          <ul className="flex flex-col divide-y divide-border text-sm" data-testid="post-links">
            {links.data.items.map((l) => (
              <li key={l.id} className="flex flex-col gap-0.5 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-all">{l.destination}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatNumber(l.clicks)} {l.clicks === 1 ? 'click' : 'clicks'}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {l.shortUrl} · created {ageText((Date.now() - Date.parse(l.createdAt)) / 3_600_000)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

/**
 * UX-12 "what to do next cycle": the brand's open recommendations whose action is a brief, with the same card
 * the intelligence workspace uses so a decision here is the same decision there.
 */
export function NextCyclePanel({ companyId, brandId }: { companyId: string; brandId: string }) {
  const workspace = useWorkspace(brandId, false);
  const briefs = useMemo(
    () =>
      (workspace.data?.whatToDoNext.items ?? []).filter(
        (r) => r.state === 'proposed' && r.proposedAction === 'create_brief',
      ),
    [workspace.data],
  );
  const intelligenceHref = brandPath(companyId, brandId, 'intelligence');
  return (
    <Section
      id="next-cycle-heading"
      title="Next cycle"
      testId="next-cycle"
      action={
        <Link to={intelligenceHref} className="underline-offset-2 hover:underline">
          All recommendations
        </Link>
      }
    >
      {workspace.isError && (
        <RequestError
          error={workspace.error}
          title="Recommendations could not load"
          onRetry={() => void workspace.refetch()}
        />
      )}
      {workspace.isPending && <Skeleton label="Loading recommendations" lines={2} />}
      {workspace.data && briefs.length === 0 && (
        <EmptyState
          title="No brief is recommended"
          description="Recommendations that propose a brief appear here once an analysis finds something worth a post. Run the analyst from the intelligence workspace."
        />
      )}
      {workspace.data && briefs.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Recommended briefs">
          {briefs.map((r) => (
            <RecommendationCard
              key={r.id}
              companyId={companyId}
              brandId={brandId}
              recommendation={r}
              position={null}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}
