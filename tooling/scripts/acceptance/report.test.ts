import { describe, expect, it } from 'vitest';
import {
  fail,
  formatAcceptance,
  formatDone,
  formatLoad,
  formatModelEval,
  fromK6,
  fromSmoke,
  fromVitest,
  pass,
  safeDetail,
  skip,
  summarize,
} from './report';

describe('acceptance report lines', () => {
  it('prints one ACCEPTANCE_<OUTCOME> line per check and counts only the checks that ran', () => {
    const results = [pass('a'), fail('b', 'HTTP 500'), skip('c', 'no channel')];
    expect(results.map(formatAcceptance)).toEqual([
      'ACCEPTANCE_PASS a',
      'ACCEPTANCE_FAIL b HTTP 500',
      'ACCEPTANCE_SKIP c no channel',
    ]);
    const s = summarize(results);
    expect(s).toEqual({ passed: 1, failed: 1, skipped: 1, total: 2 });
    expect(formatDone(s)).toBe('ACCEPTANCE_DONE 1/2 (1 skipped)');
    expect(formatDone(summarize([pass('a'), pass('b')]))).toBe('ACCEPTANCE_DONE 2/2');
  });

  it('never prints a token, a signed URL query or a setup-link fragment', () => {
    expect(safeDetail('session ses_abc.DEF-1 issued')).toBe('session ses_[redacted] issued');
    expect(safeDetail('link https://web.test/set-password#token=pst_secret')).toBe(
      'link https://web.test/set-password#token=[redacted]',
    );
    expect(safeDetail('PUT https://store.test/key?X-Amz-Signature=abc failed')).toBe(
      'PUT https://store.test/key failed',
    );
    expect(safeDetail('key ak_1234 and reviewer rl_99 and support sup_x.y')).toBe(
      'key ak_[redacted] and reviewer rl_[redacted] and support sup_[redacted]',
    );
    expect(formatAcceptance(fail('x', 'bearer ses_abc'))).toBe('ACCEPTANCE_FAIL x bearer ses_[redacted]');
    expect(safeDetail(`x${'y'.repeat(500)}`)).toHaveLength(400);
    expect(safeDetail(`x${'y'.repeat(500)}`).endsWith('…')).toBe(true);
    expect(
      formatModelEval({ taskKind: 'copywriting', ok: false, steps: 0, costMicros: 0, reason: 'ses_abc' }),
    ).toBe('MODEL_EVAL_FAIL copywriting ses_[redacted]');
  });

  it('prefixes the smoke checks', () => {
    expect(fromSmoke([{ name: 'health', outcome: 'pass', detail: 'HTTP 200' }])).toEqual([
      { name: 'smoke:health', outcome: 'pass', detail: 'HTTP 200' },
    ]);
  });

  it('reads vitest JSON: one result per test, a suite that failed before its tests is one failure', () => {
    const results = fromVitest({
      testResults: [
        {
          name: '/src/apps/web/e2e/studio.e2e.test.ts',
          status: 'failed',
          assertionResults: [
            { title: 'signs in', status: 'passed' },
            { title: 'saves', status: 'failed', failureMessages: ['expected 2 to be 3\n at x'] },
            { title: 'needs the mock', status: 'skipped' },
          ],
        },
        { name: '/src/apps/web/e2e/a11y.e2e.test.ts', status: 'failed', message: 'build first\nstack' },
        { name: '/src/apps/web/e2e/deployed.e2e.test.ts', status: 'passed', assertionResults: [] },
      ],
    });
    expect(results).toEqual([
      { name: 'e2e:studio:signs in', outcome: 'pass', detail: '' },
      { name: 'e2e:studio:saves', outcome: 'fail', detail: 'expected 2 to be 3' },
      { name: 'e2e:studio:needs the mock', outcome: 'skip', detail: 'skipped' },
      { name: 'e2e:a11y', outcome: 'fail', detail: 'build first' },
      { name: 'e2e:deployed', outcome: 'skip', detail: 'no test ran' },
    ]);
  });

  it('reads k6 thresholds: LOAD_PASS / LOAD_FAIL per threshold with the values that matter', () => {
    const results = fromK6({
      metrics: {
        oremedia_schedule_latency: {
          thresholds: { 'p(95)<400': { ok: true }, 'p(99)<1000': { ok: false } },
          values: { 'p(95)': 120.5, 'p(99)': 1500, avg: 80, min: 2 },
        },
        http_req_failed: { thresholds: { 'rate<0.01': false }, values: { rate: 0 } },
        iterations: { values: { count: 100 } },
      },
    });
    expect(results.map(formatLoad)).toEqual([
      'LOAD_PASS http_req_failed rate<0.01 rate=0',
      'LOAD_PASS oremedia_schedule_latency p(95)<400 p(95)=120.50 p(99)=1500 avg=80',
      'LOAD_FAIL oremedia_schedule_latency p(99)<1000 p(95)=120.50 p(99)=1500 avg=80',
    ]);
    expect(formatModelEval({ taskKind: 'copywriting', ok: true, steps: 4, costMicros: 1200 })).toBe(
      'MODEL_EVAL_PASS copywriting 4 1200',
    );
  });
});
