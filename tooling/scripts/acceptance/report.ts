import type { CheckResult } from '../smoke/checks';

/**
 * The acceptance job's output contract (docs/runbooks/staging-acceptance.md): one line per check,
 * `ACCEPTANCE_PASS <name>`, `ACCEPTANCE_FAIL <name> <reason>` or `ACCEPTANCE_SKIP <name> <reason>`, then
 * `ACCEPTANCE_DONE <passed>/<total>` where total counts the checks that ran (skips are listed, not counted). The load
 * test and the model evaluation have their own prefixes. No line ever carries a credential: every detail passes
 * through `safeDetail`, which strips opaque tokens, signed-URL queries and setup-link fragments.
 */
export type Outcome = CheckResult['outcome'];

export interface AcceptanceResult {
  name: string;
  outcome: Outcome;
  detail: string;
}

/** The token prefixes the access module issues (sessions, API keys, reviewer links, setup links, support sessions). */
const TOKEN = /\b(?:ses|ak|rl|pst|sup)_[A-Za-z0-9._-]+/g;

/** The longest detail one line carries (a database driver's message can quote a whole statement). */
const DETAIL_MAX = 400;

/**
 * A detail as it may be printed: no opaque token, no URL query (signatures live there), no `#token=` fragment, one
 * line, at most DETAIL_MAX characters.
 */
export const safeDetail = (detail: string): string => {
  const clean = detail
    .replace(/#token=[^\s]*/g, '#token=[redacted]')
    .replace(/\?[^\s)]*/g, '')
    .replace(TOKEN, (m) => `${m.slice(0, m.indexOf('_') + 1)}[redacted]`)
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX - 1)}…` : clean;
};

export const pass = (name: string, detail = ''): AcceptanceResult => ({ name, outcome: 'pass', detail });
export const fail = (name: string, detail: string): AcceptanceResult => ({ name, outcome: 'fail', detail });
export const skip = (name: string, detail: string): AcceptanceResult => ({ name, outcome: 'skip', detail });

export const formatAcceptance = (r: AcceptanceResult): string => {
  const detail = safeDetail(r.detail);
  return `ACCEPTANCE_${r.outcome.toUpperCase()} ${r.name}${detail ? ` ${detail}` : ''}`;
};

export interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  /** Checks that ran: passed + failed. */
  total: number;
}

export function summarize(results: readonly AcceptanceResult[]): Summary {
  const passed = results.filter((r) => r.outcome === 'pass').length;
  const failed = results.filter((r) => r.outcome === 'fail').length;
  const skipped = results.filter((r) => r.outcome === 'skip').length;
  return { passed, failed, skipped, total: passed + failed };
}

export const formatDone = (s: Summary): string =>
  `ACCEPTANCE_DONE ${s.passed}/${s.total}${s.skipped ? ` (${s.skipped} skipped)` : ''}`;

/** The smoke checks (tooling/scripts/smoke) under the `smoke:` prefix. */
export const fromSmoke = (results: readonly CheckResult[]): AcceptanceResult[] =>
  results.map((r) => ({ name: `smoke:${r.name}`, outcome: r.outcome, detail: r.detail }));

/** The subset of vitest's JSON reporter output the job reads (`--reporter=json --outputFile=<file>`). */
export interface VitestJsonReport {
  testResults?: Array<{
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: Array<{
      fullName?: string;
      title?: string;
      status?: string;
      failureMessages?: string[];
    }>;
  }>;
}

const suiteName = (file: string | undefined): string =>
  (file ?? 'suite')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.e2e\.test\.ts$/, '') ?? 'suite';

/**
 * One acceptance result per browser test: `e2e:<suite>:<test title>`. A suite that failed outside its tests (a
 * missing build, a browser that did not launch) is one failing result named after the suite. Skipped tests (a
 * suite's real-API skips) are listed as skips so the log says what was not exercised.
 */
export function fromVitest(report: VitestJsonReport): AcceptanceResult[] {
  const out: AcceptanceResult[] = [];
  for (const file of report.testResults ?? []) {
    const suite = suiteName(file.name);
    const tests = file.assertionResults ?? [];
    if (tests.length === 0) {
      out.push(
        file.status === 'passed'
          ? skip(`e2e:${suite}`, 'no test ran')
          : fail(`e2e:${suite}`, (file.message ?? 'suite failed before its tests').split('\n')[0] ?? ''),
      );
      continue;
    }
    for (const t of tests) {
      const name = `e2e:${suite}:${(t.title ?? t.fullName ?? 'test').replace(/\s+/g, ' ').trim()}`;
      if (t.status === 'passed') out.push(pass(name));
      else if (t.status === 'failed')
        out.push(fail(name, (t.failureMessages?.[0] ?? 'failed').split('\n')[0] ?? 'failed'));
      else out.push(skip(name, t.status ?? 'skipped'));
    }
  }
  return out;
}

/** The subset of k6's end-of-test summary the job reads (`handleSummary` data / `--summary-export`). */
export interface K6Summary {
  metrics?: Record<
    string,
    {
      thresholds?: Record<string, { ok?: boolean } | boolean>;
      values?: Record<string, number>;
    }
  >;
}

export interface LoadResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * One result per threshold of tooling/load/top-of-hour.js, `LOAD_PASS <metric> <expression>` or
 * `LOAD_FAIL <metric> <expression> <values>`. k6 writes `{ ok }` per threshold in handleSummary's data and in
 * `--summary-export`; a bare boolean (older exports) is read as "failed".
 */
export function fromK6(summary: K6Summary): LoadResult[] {
  const out: LoadResult[] = [];
  for (const [metric, m] of Object.entries(summary.metrics ?? {})) {
    for (const [expr, state] of Object.entries(m.thresholds ?? {})) {
      const ok = typeof state === 'boolean' ? !state : state.ok === true;
      const values = Object.entries(m.values ?? {})
        .filter(([k]) => /^(p\(95\)|p\(99\)|rate|count|avg)$/.test(k))
        .map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(2)}`)
        .join(' ');
      out.push({ name: `${metric} ${expr}`, ok, detail: values });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const formatLoad = (r: LoadResult): string =>
  `${r.ok ? 'LOAD_PASS' : 'LOAD_FAIL'} ${r.name}${r.detail ? ` ${r.detail}` : ''}`;

export interface ModelEvalResult {
  taskKind: string;
  ok: boolean;
  steps: number;
  costMicros: number;
  reason?: string;
}

export const formatModelEval = (r: ModelEvalResult): string =>
  r.ok
    ? `MODEL_EVAL_PASS ${r.taskKind} ${r.steps} ${r.costMicros}`
    : `MODEL_EVAL_FAIL ${r.taskKind} ${safeDetail(r.reason ?? 'failed')}`;
