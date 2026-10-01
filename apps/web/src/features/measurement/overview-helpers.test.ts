import { describe, expect, it } from 'vitest';
import { comparisonText, drillDownHref, formatFigure } from './overview-helpers';
import type { OverviewFigureDto } from './use-overview';

const figure = (over: Partial<OverviewFigureDto>): OverviewFigureDto => ({
  key: 'impressions',
  label: 'Impressions',
  kind: 'flow',
  value: 100,
  previous: 80,
  change: 0.25,
  sufficient: true,
  sample: { current: 6, previous: 5, minimum: 5 },
  coverage: { requested: 6, withData: 6, unit: 'posts' },
  freshness: null,
  source: { kind: 'social', label: 'Social channels' },
  note: null,
  ...over,
});

describe('overview helpers (R2-5)', () => {
  it('drills down into the Performance screen’s own section for the window', () => {
    expect(drillDownHref('c 1', 'b', { kind: 'channel', id: 'cc 1' }, 7)).toBe(
      '/c/c%201/b/b/performance?period=7&channel=cc%201',
    );
    expect(drillDownHref('c', 'b', { kind: 'web', id: 'd' }, 30)).toBe(
      '/c/c/b/b/performance?period=30#web-heading',
    );
    expect(drillDownHref('c', 'b', { kind: 'audit', id: 'd' }, 90)).toBe(
      '/c/c/b/b/performance?period=90#audit-heading',
    );
  });
  it('formats a value in its own unit and never a missing one as zero', () => {
    expect(formatFigure('rate', 0.1234)).toBe('12.3%');
    expect(formatFigure('gauge', 61.456)).toBe('61.5');
    expect(formatFigure('flow', 1234.4)).toBe((1234).toLocaleString());
    expect(formatFigure('flow', null)).toBe('Unavailable');
  });
  it('words the comparison, or why there is none (D-14, D-15)', () => {
    expect(comparisonText(figure({}))).toBe(`+25.0% vs previous ${(80).toLocaleString()}`);
    expect(comparisonText(figure({ sufficient: false, change: null }))).toBe(
      'insufficient sample (6 and 5 posts of 5)',
    );
    expect(comparisonText(figure({ change: null }))).toBe(`previous ${(80).toLocaleString()}`);
    expect(comparisonText(figure({ change: null, previous: null }))).toBe('no previous value');
    expect(comparisonText(figure({ note: 'unique people: never summed across posts' }))).toBe(
      'unique people: never summed across posts',
    );
  });
});
