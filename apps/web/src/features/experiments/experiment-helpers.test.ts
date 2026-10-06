import { describe, expect, it } from 'vitest';
import {
  allocationText,
  conclusionText,
  experimentProgress,
  modeNote,
  stoppingText,
  variantsLine,
  windowText,
  EMPTY_DESIGN,
  differenceText,
  intervalText,
  experimentStateChip,
  formatRate,
  isDesignChanged,
  parseDesign,
  resultsRefusalText,
  shortHash,
  windowEnd,
} from './experiment-helpers';

describe('experimentStateChip', () => {
  it('labels every contract state and names an unknown one', () => {
    expect(experimentStateChip('pre_registered').label).toBe('Pre-registered');
    expect(experimentStateChip('odd').label).toBe('Unknown state (odd)');
  });
});

describe('resultsRefusalText', () => {
  it('explains the sample-and-window refusal (spec 16.6)', () => {
    const lines = resultsRefusalText([
      { path: 'at', issue: 'window_not_reached_until_2026-10-01T00:00:00.000Z' },
      { path: 'observations', issue: 'sample_below_30_per_arm' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('has not ended');
    expect(lines[1]).toContain('minimum of 30 per arm');
  });
  it('drops the "reached" markers and keeps unknown issues verbatim', () => {
    expect(resultsRefusalText([{ path: 'at', issue: 'window_reached' }, { issue: 'other_issue' }])).toEqual([
      'other_issue',
    ]);
  });
  it('names a changed design', () => {
    const details = [{ path: 'preRegistrationHash', issue: 'design_changed' }];
    expect(isDesignChanged(details)).toBe(true);
    expect(resultsRefusalText(details)[0]).toContain('changed after pre-registration');
  });
});

describe('formatting', () => {
  it('formats rates, estimates, hashes, labels and window ends', () => {
    expect(formatRate(null)).toBe('unavailable');
    expect(formatRate(0.1234)).toBe('12.3%');
    expect(differenceText(null)).toContain('No estimate');
    expect(differenceText(0.02)).toBe('Difference +2.0 pp');
    expect(intervalText([-0.01, 0.05], 0.0123)).toBe('95% interval -1.0 pp to +5.0 pp · p = 0.012');
    expect(intervalText(null, null)).toBe('');
    expect(shortHash(null)).toBe('—');
    expect(shortHash('a'.repeat(64))).toBe(`${'a'.repeat(12)}…`);
    expect(conclusionText('directional; not causal')).toBe('directional; not causal');
    expect(windowEnd('2026-01-01T00:00:00.000Z', 24).toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('parseDesign', () => {
  it('rejects an empty form with paths', () => {
    const r = parseDesign(EMPTY_DESIGN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('hypothesis');
  });
  it('an arm without a package or a design without a metric is refused beside its field, never sent empty', () => {
    const r = parseDesign({
      ...EMPTY_DESIGN,
      hypothesis: 'x',
      variants: [
        { label: 'A', contentRevisionId: 'cr_a', allocationWeight: '1' },
        { label: 'B', contentRevisionId: '', allocationWeight: '1' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues).toEqual([
        { path: 'primaryMetricKey', issue: 'Choose a metric.' },
        { path: 'variants.1.contentRevisionId', issue: 'Choose a content package.' },
      ]);
  });
  it('builds a pre-registration document from a complete form', () => {
    const r = parseDesign({
      ...EMPTY_DESIGN,
      hypothesis: 'Shorter hooks lift saves',
      variants: [
        { label: 'A', contentRevisionId: 'cr_a', allocationWeight: '1' },
        { label: 'B', contentRevisionId: 'cr_b', allocationWeight: '1' },
      ],
      primaryMetricKey: 'saves',
      guardrailMetricKeys: ['complaints', 'unfollows'],
      stoppingRule: 'sequential_msprt',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.design.guardrailMetricKeys).toEqual(['complaints', 'unfollows']);
      expect(r.design.stoppingRule.kind).toBe('sequential_msprt');
      expect(r.design.minSamplePerArm).toBe(30);
    }
  });
});

describe('detail lines (interface pre-registration table)', () => {
  it('names the arms, the split, the window and the stopping rule', () => {
    expect(variantsLine([{ label: 'A' }, { label: 'B' }])).toBe('A vs. B');
    expect(allocationText('matched_slots', [{ allocationWeight: 1 }, { allocationWeight: 1 }])).toBe(
      'Matched slots, 50/50',
    );
    expect(windowText(168)).toBe('7 days');
    expect(windowText(24)).toBe('1 day');
    expect(windowText(36)).toBe('36 h');
    expect(stoppingText({ kind: 'fixed_horizon', alpha: 0.05 })).toBe('Fixed horizon, α = 0.05');
  });
  it('keeps the conclusion label verbatim in the mode note', () => {
    expect(modeNote('structured_comparison', 'directional; not causal')).toContain('directional; not causal');
    expect(modeNote('randomised', 'causal_when_sound')).toContain('Can support causal claims');
  });
});

describe('experimentProgress', () => {
  const x = {
    startedAt: '2026-10-01T00:00:00.000Z',
    observationWindowHours: 168,
    minSamplePerArm: 1000,
    variants: [{ id: 'a' }, { id: 'b' }],
  };
  it('with a result, measures the smallest arm against the minimum sample', () => {
    const p = experimentProgress(x, { perVariant: { a: { n: 1000 }, b: { n: 400 } } });
    expect(p.fraction).toBe(0.4);
    expect(p.label).toBe(`${(400).toLocaleString()} / ${(1000).toLocaleString()} per arm`);
  });
  it('running without a result, shows the window passed, never an invented sample', () => {
    const p = experimentProgress(x, null, new Date('2026-10-03T12:00:00.000Z'));
    expect(p.label).toBe('Day 3 of 7 · window');
    expect(p.fraction).toBeCloseTo(60 / 168);
    expect(experimentProgress(x, null, new Date('2026-11-01T00:00:00.000Z')).fraction).toBe(1);
  });
  it('not started: nothing has passed', () => {
    expect(experimentProgress({ ...x, startedAt: null }, null).fraction).toBe(0);
  });
});
