import type { Tone } from '@oremedia/ui';
import type { OverviewLimitCode, OverviewSourceState } from '@oremedia/contracts/overview';
import { brandPath } from '../brand/brand-context';
import { formatNumber, percent } from './performance-helpers';
import type { OverviewFigureDto, OverviewSourceDto } from './use-overview';

/**
 * The overview's presentation rules (R2-5): a source state's label and tone (status tones carry state and nothing
 * else; a neutral chip is a fact, not a warning), the drill-down into the Performance screen's own section, and
 * the words under a figure (the comparison or why there is none, D-14).
 */
export const SOURCE_STATE: Readonly<Record<OverviewSourceState, { label: string; tone: Tone }>> = {
  fresh: { label: 'Fresh', tone: 'good' },
  stale: { label: 'Stale', tone: 'warning' },
  blocked: { label: 'Blocked by policy', tone: 'critical' },
  not_connected: { label: 'Not connected', tone: 'neutral' },
  no_data: { label: 'No data', tone: 'neutral' },
  insufficient_sample: { label: 'Insufficient sample', tone: 'info' },
};

export const LIMIT_LABEL: Readonly<Record<OverviewLimitCode, string>> = {
  policy_blocked: 'Policy',
  source_uncertified: 'Uncertified',
  not_connected: 'Not connected',
  field_data_not_connected: 'Lab data',
  ai_search_external: 'AI search',
  paid_not_connected: 'Paid',
  native_not_observed: 'Native',
  insufficient_sample: 'Sample',
  stale: 'Stale',
  latest_fetch_comparison: 'Comparison',
};

/** Where a source drills down: the Performance screen's channel filter, its Web section or its Audit section. */
export function drillDownHref(
  companyId: string,
  brandId: string,
  source: Pick<OverviewSourceDto, 'kind' | 'id'>,
  days: number,
): string {
  const base = `${brandPath(companyId, brandId, 'performance')}?period=${days}`;
  if (source.kind === 'channel') return `${base}&channel=${encodeURIComponent(source.id)}`;
  return `${base}#${source.kind === 'web' ? 'web-heading' : 'audit-heading'}`;
}

/** A value in its figure's own unit (D-15): a rate as a percentage, a gauge to one decimal, a count otherwise. */
export function formatFigure(kind: string, value: number | null): string {
  if (value === null) return 'Unavailable';
  if (kind === 'rate') return percent(value);
  if (kind === 'gauge') return value.toFixed(1);
  return formatNumber(Math.round(value));
}

const formatChange = (c: number) => `${c >= 0 ? '+' : ''}${(c * 100).toFixed(1)}%`;

/** The comparison line under a figure: the change, or why there is none, in the dictionary's words. */
export function comparisonText(figure: OverviewFigureDto): string {
  if (figure.note) return figure.note;
  if (!figure.sufficient)
    return `insufficient sample (${figure.sample.current} and ${figure.sample.previous} ${figure.coverage.unit} of ${figure.sample.minimum})`;
  if (figure.change !== null)
    return `${formatChange(figure.change)} vs previous ${formatFigure(figure.kind, figure.previous)}`;
  if (figure.previous !== null) return `previous ${formatFigure(figure.kind, figure.previous)}`;
  return 'no previous value';
}
