import { describe, expect, it } from 'vitest';
import { gradingSummary } from './checks';

const result = (over: Partial<Parameters<typeof gradingSummary>[0][number]> = {}) => ({
  skillVersionId: 'skv_1',
  modelVersion: 'openrouter:vendor/model',
  scores: { tone: 2.5, clarity: 4 },
  deterministicChecks: { 'case_1/no_prohibited_phrases': true, 'case_1/within_length': false },
  passed: false,
  createdAt: '2026-10-03T08:18:30.000Z',
  ...over,
});

describe('gradingSummary (a grading that ran but scored below the bar)', () => {
  it('names the grader, the failing checks and every score of the newest result since the request', () => {
    const older = result({ createdAt: '2026-10-03T08:00:00.000Z', scores: { tone: 1 } });
    expect(gradingSummary([older, result()], 'skv_1', '2026-10-03T08:10:00.000Z')).toBe(
      'graded below the bar by openrouter:vendor/model; failing checks: case_1/within_length; scores: tone=2.5, clarity=4',
    );
  });

  it('is null without a result for that version since the request', () => {
    expect(gradingSummary([result()], 'skv_other', '2026-10-03T08:10:00.000Z')).toBeNull();
    expect(gradingSummary([result()], 'skv_1', '2026-10-03T09:00:00.000Z')).toBeNull();
  });

  it('says none when no check failed or no rubric was scored', () => {
    expect(
      gradingSummary(
        [result({ deterministicChecks: { 'case_1/x': true }, scores: {} })],
        'skv_1',
        '2026-10-03T08:10:00.000Z',
      ),
    ).toBe('graded below the bar by openrouter:vendor/model; failing checks: none; scores: none');
  });
});
