import { NOT_SUMMED, kindFor, type MetricValueV1 } from '@oremedia/contracts/measurement';
import {
  REPORT_BOTTOM_POSTS,
  REPORT_GROUPS,
  REPORT_MINIMUM_SAMPLE,
  REPORT_RECOMMENDATIONS,
  REPORT_TOP_POSTS,
  type ReportChannelV1,
  type ReportCompareMode,
  type ReportFigureV1,
  type ReportFiguresV1,
  type ReportFormatV1,
  type ReportPostV1,
  type ReportRecommendationV1,
  type ReportTrendPointV1,
} from '@oremedia/contracts/reports';
import { aggregateByComparableGroup } from '@oremedia/module-measurement';

/**
 * The pure composition rules of a monthly report (D-29): how the measurement module's per-publication values become
 * the overview figures (flows summed, the engagement rate pooled, unique counts listed and never summed), the
 * per-channel rows, the ranked posts and the trend, under the D-14 sample rule on every comparison. No I/O and
 * contracts only, so the web's mock transport composes with the same functions; service.ts reads the services and
 * hands their results in.
 */

/** A released channel publication of a window, as the measurement source lists it. */
export interface ReportPublication {
  publicationId: string;
  contentRevisionId: string;
  channelConnectionId: string;
  scheduledFor: string;
}
/** One window's publications with their latest values (measurement.metrics.query, grouping `subject`). */
export interface WindowData {
  publications: ReportPublication[];
  values: MetricValueV1[];
}
/** A channel connection as the publishing module lists it. */
export interface ReportChannelRow {
  id: string;
  providerKey: string;
  displayName: string;
}
/** One cell of the creative attribute aggregate (measurement.attributes.aggregate). */
export interface FeatureCell {
  feature: string;
  value: string;
  publications: number;
  rate: number | null;
  sufficient: boolean;
}
/** A recommendation as the intelligence module lists it. */
export interface RecommendationRow {
  id: string;
  title: string;
  rationale: string;
  state: string;
  expectedBenefit: { metricKey: string; direction: 'up' | 'down'; magnitude?: string };
  rank: number;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const partsOf = (periodMonth: string) => {
  const [y, m] = periodMonth.split('-').map(Number) as [number, number];
  return { year: y, month: m };
};
export const monthKeyOf = (year: number, month: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
/** The calendar month `by` months after `periodMonth` (negative for before). */
export function shiftMonth(periodMonth: string, by: number): string {
  const { year, month } = partsOf(periodMonth);
  const index = year * 12 + (month - 1) + by;
  return monthKeyOf(Math.floor(index / 12), (index % 12) + 1);
}
/** The month the report compares against under the mode (D-14: the previous period of equal length). */
export const compareMonthOf = (periodMonth: string, mode: ReportCompareMode): string =>
  shiftMonth(periodMonth, mode === 'last_year' ? -12 : -1);
/** "September 2026". */
export function monthLabel(periodMonth: string): string {
  const { year, month } = partsOf(periodMonth);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}
/** "Sep" / "Sep 2025": how a comparison names its month. */
export function monthShort(periodMonth: string, withYear = false): string {
  const { year, month } = partsOf(periodMonth);
  const name = (MONTH_NAMES[month - 1] as string).slice(0, 3);
  return withYear ? `${name} ${year}` : name;
}

/** The zone's offset from UTC at an instant, in ms (an unknown zone reads as UTC). */
const zoneOffsetMs = (instant: number, timeZone: string): number => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));
  } catch {
    return 0;
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
};
/** The instant a calendar month starts (local midnight of its 1st) in the zone. */
const monthStart = (periodMonth: string, timeZone: string): number => {
  const { year, month } = partsOf(periodMonth);
  const guess = Date.UTC(year, month - 1, 1);
  // The zone's offset at the UTC instant is a first guess; across a DST change the offset is read again at the
  // instant that guess gives, which is on the day (as the destinations module's dayEnd does).
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
};
/** A calendar month's window in the brand's zone: its first midnight to the last millisecond before the next. */
export function monthWindow(periodMonth: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: new Date(monthStart(periodMonth, timeZone)),
    end: new Date(monthStart(shiftMonth(periodMonth, 1), timeZone) - 1),
  };
}

const usable = (v: MetricValueV1) =>
  v.series === null && v.value !== null && v.completeness !== 'unavailable';

/** A flow's total over the values (summed within its group, D-15); null when none carries a number. */
const flowOf = (values: readonly MetricValueV1[], group: string): number | null => {
  const rows = values.filter((v) => v.comparableGroup === group && usable(v));
  return rows.length ? rows.reduce((s, v) => s + (v.value as number), 0) : null;
};
/** A post's own unique count: never summed, so across a post's keys the largest reported number stands. */
const uniqueOf = (values: readonly MetricValueV1[], group: string): number | null => {
  const rows = values.filter((v) => v.comparableGroup === group && usable(v));
  return rows.length ? Math.max(...rows.map((v) => v.value as number)) : null;
};
/** Spec 15.2: Σ engagement ÷ Σ impressions over the posts that carry both; never a mean of per-post rates. */
export function pooledRate(byPost: ReadonlyMap<string, MetricValueV1[]>): number | null {
  let engagement = 0;
  let impressions = 0;
  let any = false;
  for (const values of byPost.values()) {
    const e = flowOf(values, 'engagement');
    const i = flowOf(values, 'impressions');
    if (e === null || i === null) continue;
    engagement += e;
    impressions += i;
    any = true;
  }
  return any && impressions > 0 ? engagement / impressions : null;
}
const groupBySubject = (values: readonly MetricValueV1[]) => {
  const out = new Map<string, MetricValueV1[]>();
  for (const v of values) out.set(v.subjectId, [...(out.get(v.subjectId) ?? []), v]);
  return out;
};
/** Relative change; null below the sample, without both sides, or against nothing. */
const changeOf = (sufficient: boolean, current: number | null, previous: number | null): number | null =>
  sufficient && current !== null && previous !== null && previous > 0
    ? (current - previous) / previous
    : null;

export const sampleOf = (current: number, previous: number) => ({
  current,
  previous,
  minimum: REPORT_MINIMUM_SAMPLE,
  sufficient: current >= REPORT_MINIMUM_SAMPLE && previous >= REPORT_MINIMUM_SAMPLE,
});

/** The overview page's figures: one per reported group, the rate pooled, the non-additive ones listed. */
export function figuresOf(current: WindowData, previous: WindowData, sufficient: boolean): ReportFigureV1[] {
  const now = aggregateByComparableGroup(current.values);
  const before = aggregateByComparableGroup(previous.values);
  const rateNow = pooledRate(groupBySubject(current.values));
  const rateBefore = pooledRate(groupBySubject(previous.values));
  return REPORT_GROUPS.map(([key, label]) => {
    const kind = kindFor(key);
    if (kind === 'rate') {
      const posts = [...groupBySubject(current.values).values()].filter(
        (v) => flowOf(v, 'engagement') !== null && flowOf(v, 'impressions') !== null,
      ).length;
      return {
        key,
        label,
        kind,
        value: rateNow,
        previous: rateBefore,
        change: changeOf(sufficient, rateNow, rateBefore),
        notSummed: null,
        coverage: { withData: posts, requested: current.publications.length },
      };
    }
    const agg = now.find((a) => a.comparableGroup === key) ?? null;
    const prev = before.find((a) => a.comparableGroup === key) ?? null;
    const additive = kind === 'flow';
    return {
      key,
      label,
      kind,
      value: additive ? (agg?.value ?? null) : null,
      previous: additive ? (prev?.value ?? null) : null,
      change: additive ? changeOf(sufficient, agg?.value ?? null, prev?.value ?? null) : null,
      notSummed: additive ? null : (NOT_SUMMED[kind] ?? null),
      coverage: { withData: agg?.subjectsWithData ?? 0, requested: current.publications.length },
    };
  });
}

const postOf = (p: ReportPublication, values: MetricValueV1[]): ReportPostV1 => {
  const impressions = flowOf(values, 'impressions');
  const engagement = flowOf(values, 'engagement');
  return {
    publicationId: p.publicationId,
    channelConnectionId: p.channelConnectionId,
    contentRevisionId: p.contentRevisionId,
    scheduledFor: p.scheduledFor,
    impressions,
    engagement,
    reach: uniqueOf(values, 'reach'),
    clicks: flowOf(values, 'clicks'),
    engagementRate:
      engagement !== null && impressions !== null && impressions > 0 ? engagement / impressions : null,
    stale: values.some((v) => usable(v) && v.freshness.stale),
  };
};
const byEngagement = (a: ReportPostV1, b: ReportPostV1) =>
  (b.engagement ?? -1) - (a.engagement ?? -1) || (b.impressions ?? -1) - (a.impressions ?? -1);

/** Every post of the month with at least one number, ranked by engagements (then impressions). */
export function postsOf(current: WindowData): ReportPostV1[] {
  const byPost = groupBySubject(current.values);
  return current.publications
    .map((p) => postOf(p, byPost.get(p.publicationId) ?? []))
    .filter((p) => p.impressions !== null || p.engagement !== null || p.reach !== null || p.clicks !== null)
    .sort(byEngagement);
}

/** The post page: the top posts, the lowest engagement rates below the line, and the top posts' share. */
export function postPageOf(current: WindowData): ReportFiguresV1['posts'] {
  const ranked = postsOf(current);
  const withEngagement = ranked.filter((p) => p.engagement !== null);
  const all = withEngagement.reduce((s, p) => s + (p.engagement as number), 0);
  const top = ranked.slice(0, REPORT_TOP_POSTS).reduce((s, p) => s + (p.engagement ?? 0), 0);
  const lowest = ranked
    .filter((p) => p.engagementRate !== null && !ranked.slice(0, REPORT_TOP_POSTS).includes(p))
    .sort((a, b) => (a.engagementRate as number) - (b.engagementRate as number))
    .slice(0, REPORT_BOTTOM_POSTS);
  return {
    ranked: ranked.slice(0, REPORT_TOP_POSTS),
    lowest,
    total: current.publications.length,
    withNumbers: ranked.length,
    topShare: all > 0 ? top / all : null,
  };
}

/** The channel page: one row per channel with a post in either window, its flows summed and rate pooled. */
export function channelsOf(
  channels: readonly ReportChannelRow[],
  current: WindowData,
  previous: WindowData,
): ReportChannelV1[] {
  const byPost = groupBySubject(current.values);
  const beforeByPost = groupBySubject(previous.values);
  const rows = channels
    .map((c) => {
      const posts = current.publications.filter((p) => p.channelConnectionId === c.id);
      const before = previous.publications.filter((p) => p.channelConnectionId === c.id);
      if (posts.length === 0 && before.length === 0) return null;
      const values = posts.flatMap((p) => byPost.get(p.publicationId) ?? []);
      const beforeValues = before.flatMap((p) => beforeByPost.get(p.publicationId) ?? []);
      const sufficient = posts.length >= REPORT_MINIMUM_SAMPLE && before.length >= REPORT_MINIMUM_SAMPLE;
      const impressions = flowOf(values, 'impressions');
      const best = posts
        .map((p) => postOf(p, byPost.get(p.publicationId) ?? []))
        .filter((p) => p.engagement !== null)
        .sort(byEngagement)[0];
      const row: ReportChannelV1 = {
        channelConnectionId: c.id,
        providerKey: c.providerKey,
        displayName: c.displayName,
        publications: posts.length,
        previousPublications: before.length,
        impressions,
        engagement: flowOf(values, 'engagement'),
        clicks: flowOf(values, 'clicks'),
        engagementRate: pooledRate(
          new Map(posts.map((p) => [p.publicationId, byPost.get(p.publicationId) ?? []])),
        ),
        impressionsChange: changeOf(sufficient, impressions, flowOf(beforeValues, 'impressions')),
        sufficient,
        shareOfImpressions: null,
        bestPublicationId: best?.publicationId ?? null,
      };
      return row;
    })
    .filter((r): r is ReportChannelV1 => r !== null)
    .sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1));
  const total = rows.reduce((s, r) => s + (r.impressions ?? 0), 0);
  return rows.map((r) => ({
    ...r,
    shareOfImpressions: total > 0 && r.impressions !== null ? r.impressions / total : null,
  }));
}

/** The month-by-month impressions (a flow, so a total exists) for the overview page's trend. */
export const trendOf = (months: ReadonlyArray<{ month: string; data: WindowData }>): ReportTrendPointV1[] =>
  months.map(({ month, data }) => ({
    month,
    publications: data.publications.length,
    impressions: flowOf(data.values, 'impressions'),
  }));

/** The creative attribute cells with a rate, largest sample first; the page names the feature it shows. */
export const formatsOf = (cells: readonly FeatureCell[]): ReportFormatV1[] =>
  cells
    .filter((c) => c.rate !== null)
    .map((c) => ({
      feature: c.feature,
      value: c.value,
      publications: c.publications,
      rate: c.rate,
      sufficient: c.sufficient,
    }))
    .sort((a, b) => a.feature.localeCompare(b.feature) || b.publications - a.publications);

/** The recommendations page reads the intelligence module's, proposed first then accepted, by rank. */
export const recommendationsOf = (rows: readonly RecommendationRow[]): ReportRecommendationV1[] =>
  [...rows]
    .sort((a, b) => Number(a.state !== 'proposed') - Number(b.state !== 'proposed') || a.rank - b.rank)
    .slice(0, REPORT_RECOMMENDATIONS)
    .map((r) => ({
      id: r.id,
      title: r.title,
      rationale: r.rationale,
      state: r.state,
      expectedBenefit: r.expectedBenefit,
      rank: r.rank,
    }));

export const freshnessOf = (values: readonly MetricValueV1[]): ReportFiguresV1['freshness'] => {
  const withData = values.filter(usable);
  return {
    latestFetchedAt: withData.reduce<string | null>(
      (m, v) => (!m || v.freshness.fetchedAt > m ? v.freshness.fetchedAt : m),
      null,
    ),
    staleValues: withData.filter((v) => v.freshness.stale).length,
    valuesWithData: withData.length,
  };
};

export interface ComposeInput {
  brand: { id: string; name: string; timeZone: string };
  periodMonth: string;
  compareMode: ReportCompareMode;
  current: WindowData;
  previous: WindowData;
  trend: Array<{ month: string; data: WindowData }>;
  channels: readonly ReportChannelRow[];
  formats: readonly FeatureCell[];
  recommendations: readonly RecommendationRow[];
  computedAt: Date;
}

/** The whole read model from the services' results (service.ts) or the mock's (apps/web/e2e). */
export function composeFigures(input: ComposeInput): ReportFiguresV1 {
  const compareMonth = compareMonthOf(input.periodMonth, input.compareMode);
  const window = monthWindow(input.periodMonth, input.brand.timeZone);
  const compareWindow = monthWindow(compareMonth, input.brand.timeZone);
  const sample = sampleOf(input.current.publications.length, input.previous.publications.length);
  return {
    brandId: input.brand.id,
    brandName: input.brand.name,
    timeZone: input.brand.timeZone,
    periodMonth: input.periodMonth,
    compareMonth,
    compareMode: input.compareMode,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    compareWindow: { start: compareWindow.start.toISOString(), end: compareWindow.end.toISOString() },
    sample,
    figures: figuresOf(input.current, input.previous, sample.sufficient),
    channels: channelsOf(input.channels, input.current, input.previous),
    posts: postPageOf(input.current),
    formats: formatsOf(input.formats),
    trend: trendOf(input.trend),
    recommendations: recommendationsOf(input.recommendations),
    freshness: freshnessOf(input.current.values),
    computedAt: input.computedAt.toISOString(),
  };
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const num = (x: number) => Math.round(x).toLocaleString('en-GB');

/**
 * The computed figures as the statements a drafting prompt may use (the only numbers it is allowed): the sample,
 * every figure with its comparison or why it has none, the channels, the top post and the recommendations.
 */
export function factsOf(f: ReportFiguresV1): string[] {
  const cmp = f.compareMode === 'last_year' ? monthShort(f.compareMonth, true) : monthShort(f.compareMonth);
  const facts: string[] = [
    `Period: ${monthLabel(f.periodMonth)}; comparison: ${monthLabel(f.compareMonth)} (${
      f.compareMode === 'last_year' ? 'the same month last year' : 'the previous month'
    }).`,
    `Posts published: ${f.sample.current} (${f.sample.previous} in ${cmp}).` +
      (f.sample.sufficient
        ? ''
        : ` Comparison: insufficient sample (fewer than ${f.sample.minimum} posts on one side), so no change figures.`),
  ];
  for (const fig of f.figures) {
    if (fig.notSummed) {
      facts.push(`${fig.label}: not totalled (${fig.notSummed}).`);
      continue;
    }
    if (fig.value === null) {
      facts.push(`${fig.label}: no number reported this month.`);
      continue;
    }
    const value = fig.kind === 'rate' ? `${(fig.value * 100).toFixed(1)}%` : num(fig.value);
    const change =
      fig.change !== null
        ? ` (${pct(fig.change)} vs ${cmp})`
        : fig.previous !== null
          ? ` (${cmp}: ${fig.kind === 'rate' ? `${(fig.previous * 100).toFixed(1)}%` : num(fig.previous)}, not compared)`
          : '';
    facts.push(
      `${fig.label}: ${value}${change}; ${fig.coverage.withData} of ${fig.coverage.requested} posts have a number.`,
    );
  }
  for (const c of f.channels)
    facts.push(
      `${c.displayName} (${c.providerKey}): ${c.publications} posts; impressions ${
        c.impressions === null ? 'not reported' : num(c.impressions)
      }${c.impressionsChange !== null ? ` (${pct(c.impressionsChange)} vs ${cmp})` : ''}; engagement rate ${
        c.engagementRate === null ? 'not available' : `${(c.engagementRate * 100).toFixed(1)}%`
      }${c.shareOfImpressions !== null ? `; ${(c.shareOfImpressions * 100).toFixed(1)}% of impressions` : ''}.`,
    );
  const top = f.posts.ranked[0];
  if (top) {
    const channel = f.channels.find((c) => c.channelConnectionId === top.channelConnectionId);
    facts.push(
      `Top post: on ${channel?.displayName ?? 'a channel'}, ${top.engagement === null ? 'engagements not reported' : `${num(top.engagement)} engagements`}${
        top.engagementRate !== null ? ` at ${(top.engagementRate * 100).toFixed(1)}%` : ''
      }${top.reach !== null ? `, reach ${num(top.reach)}` : ''}.`,
    );
  }
  if (f.posts.topShare !== null)
    facts.push(
      `The top ${Math.min(REPORT_TOP_POSTS, f.posts.ranked.length)} posts earned ${(f.posts.topShare * 100).toFixed(0)}% of engagements.`,
    );
  for (const r of f.recommendations) facts.push(`Recommendation (${r.state}): ${r.title}. ${r.rationale}`);
  if (f.freshness.staleValues > 0)
    facts.push(
      `${f.freshness.staleValues} of ${f.freshness.valuesWithData} values are stale (past the provider's reporting latency).`,
    );
  return facts;
}
