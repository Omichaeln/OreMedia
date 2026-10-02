import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fromK6, fromVitest, type K6Summary, type LoadResult, type VitestJsonReport } from './report';

/**
 * The two external runners the acceptance job drives as child processes from the repository checkout: vitest for
 * the browser suites (apps/web/e2e) and the k6 binary for tooling/load/top-of-hour.js. Their output streams
 * through to the job log; their machine-readable results are read from a file each writes. The credentials the
 * suites need travel in the child's environment only, never on its command line (a command line is visible to
 * every process of the container; the environment of a child is not).
 */
export interface RunOptions {
  repoDir: string;
  env: Record<string, string | undefined>;
  /** Hard stop for the child (SIGTERM), after which the run counts as failed. */
  timeoutMs: number;
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function run(command: string, args: string[], opts: RunOptions): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.repoDir,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
}

const scratch = () => mkdtemp(path.join(tmpdir(), 'oremedia-acceptance-'));

/**
 * `pnpm exec vitest run --project unit <files>` with the JSON reporter; returns one result per test (report.ts
 * `fromVitest`). A run that produced no report (vitest did not start, or was stopped at the timeout) is one
 * failing result per requested file.
 */
export async function runVitest(files: string[], opts: RunOptions): Promise<ReturnType<typeof fromVitest>> {
  const dir = await scratch();
  const outputFile = path.join(dir, 'vitest.json');
  try {
    const exit = await run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--project',
        'unit',
        '--reporter=json',
        `--outputFile=${outputFile}`,
        ...files,
      ],
      opts,
    );
    let report: VitestJsonReport | null = null;
    try {
      report = JSON.parse(await readFile(outputFile, 'utf8')) as VitestJsonReport;
    } catch {
      report = null;
    }
    if (!report) {
      const reason = exit.timedOut
        ? `stopped after ${opts.timeoutMs / 1000} s`
        : `vitest exited ${exit.code ?? exit.signal ?? 'unknown'} without a report`;
      return files.map((f) => ({
        name: `e2e:${path.basename(f, '.e2e.test.ts')}`,
        outcome: 'fail',
        detail: reason,
      }));
    }
    return fromVitest(report);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `k6 run --summary-export <file> <script>`; returns one result per threshold (report.ts `fromK6`). k6 exits 99
 * when a threshold fails and the summary still records every threshold; any other failure (the script threw in
 * setup, k6 missing, the timeout) is one failing result.
 */
export async function runK6(script: string, opts: RunOptions): Promise<LoadResult[]> {
  const dir = await scratch();
  const summaryFile = path.join(dir, 'k6-summary.json');
  try {
    let exit: Exit;
    try {
      exit = await run('k6', ['run', '--summary-export', summaryFile, script], opts);
    } catch (err) {
      return [{ name: 'k6', ok: false, detail: err instanceof Error ? err.message : 'k6 did not start' }];
    }
    let summary: K6Summary | null = null;
    try {
      summary = JSON.parse(await readFile(summaryFile, 'utf8')) as K6Summary;
    } catch {
      summary = null;
    }
    const thresholds = summary ? fromK6(summary) : [];
    if (thresholds.length === 0)
      return [
        {
          name: 'k6',
          ok: false,
          detail: exit.timedOut
            ? `stopped after ${opts.timeoutMs / 1000} s`
            : `k6 exited ${exit.code ?? exit.signal ?? 'unknown'} without threshold results`,
        },
      ];
    if (exit.code !== 0 && exit.code !== 99 && thresholds.every((t) => t.ok))
      thresholds.push({
        name: 'k6',
        ok: false,
        detail: `k6 exited ${exit.code ?? exit.signal ?? 'unknown'}`,
      });
    return thresholds;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
