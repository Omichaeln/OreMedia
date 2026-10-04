import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  DefaultLogger,
  Runtime,
  Worker,
  bundleWorkflowCode,
  type WorkflowBundleWithSourceMap,
} from '@temporalio/worker';
import {
  MANIFEST_PATH,
  QUEUE_ENTRIES,
  REPO_ROOT,
  WORKFLOWS_SRC,
  eventTypesOf,
  historyPath,
  metaPath,
  queueEntryPath,
  readManifest,
  sha256,
  type HistoryMeta,
  type QueueEntry,
} from './catalogue';
import { RECORDING_CASES } from './cases';
import type { CaseContext, Handle, Recorder, RecordingCase } from './cases/types';
import { RECORDER_IDENTITY, sanitisationProblems, sanitiseHistory } from './sanitise';

/**
 * Records the retained replay histories (spec 19.4): each case in ./cases runs once on a Temporal CLI dev server
 * (TEMPORAL_CLI_PATH) against the queue entry bundled exactly as the worker apps bundle it, with fake activities.
 * The history is sanitised, checked, replayed once against the same bundle and written beside its provenance.
 *
 * It only ever ADDS histories: a case whose file exists is kept as it is (files are opened with `wx`), so a retained
 * history is never regenerated in place. It refuses to run when packages/workflows/src differs from HEAD, so the
 * commit recorded in each <case>.meta.json is the code the history came from.
 *
 *   TEMPORAL_CLI_PATH=/path/to/temporal pnpm replay:record [workflowType | workflowType/case ...]
 */
const out = (line: string) => process.stdout.write(`${line}\n`);
const git = (args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const STATUS_STATE: Record<string, HistoryMeta['state'] | undefined> = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'canceled',
  CONTINUED_AS_NEW: 'continued_as_new',
  RUNNING: 'open',
};

async function main() {
  const cli = process.env['TEMPORAL_CLI_PATH'];
  if (!cli) throw new Error('TEMPORAL_CLI_PATH must point at a Temporal CLI binary (its dev server records)');
  const dirty = git(['status', '--porcelain', '--', WORKFLOWS_SRC])
    .split('\n')
    .filter((line) => line.endsWith('.ts'))
    .join('\n');
  if (dirty)
    throw new Error(`workflow sources in packages/workflows/src differ from HEAD; commit first:\n${dirty}`);
  const commit = git(['rev-parse', 'HEAD']);
  const temporalSdk = (
    createRequire(import.meta.url)('@temporalio/worker/package.json') as { version: string }
  ).version;
  const server = execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim();

  const seen = new Set<string>();
  for (const c of RECORDING_CASES) {
    const key = `${c.workflowType}/${c.name}`;
    if (seen.has(key)) throw new Error(`duplicate recording case ${key}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.name)) throw new Error(`case name ${key} is not kebab-case`);
    seen.add(key);
  }
  const filters = process.argv.slice(2);
  const selected = RECORDING_CASES.filter(
    (c) =>
      filters.length === 0 ||
      filters.some((f) => f === c.workflowType || f === `${c.workflowType}/${c.name}`),
  );
  const todo = selected.filter((c) => {
    const kept = existsSync(historyPath(c.workflowType, c.name));
    if (kept) out(`kept      ${c.workflowType}/${c.name} (retained histories are never regenerated)`);
    return !kept;
  });
  if (todo.length === 0) return out('nothing to record');

  Runtime.install({ logger: new DefaultLogger('ERROR') });
  const env = await TestWorkflowEnvironment.createLocal({
    server: { executable: { type: 'existing-path', path: cli } },
    client: { identity: RECORDER_IDENTITY },
  });
  const bundles = new Map<QueueEntry, WorkflowBundleWithSourceMap>();
  const bundleFor = async (entry: QueueEntry) => {
    const bundle = bundles.get(entry) ?? (await bundleWorkflowCode({ workflowsPath: queueEntryPath(entry) }));
    bundles.set(entry, bundle);
    return bundle;
  };
  const failures: string[] = [];
  try {
    for (const c of todo) {
      try {
        await record(env, await bundleFor(c.queue), c, { commit, temporalSdk, server });
        out(`recorded  ${c.workflowType}/${c.name}`);
      } catch (err) {
        failures.push(`${c.workflowType}/${c.name}: ${(err as Error).message}`);
        out(`FAILED    ${c.workflowType}/${c.name}: ${(err as Error).message}`);
      }
    }
  } finally {
    await env.teardown();
  }
  if (failures.length) throw new Error(`${failures.length} case(s) failed:\n${failures.join('\n')}`);
  const listed = new Set(
    existsSync(MANIFEST_PATH)
      ? readManifest().workflows.flatMap((e) => e.histories.map((h) => `${e.workflowType}/${h}`))
      : [],
  );
  for (const c of todo)
    if (!listed.has(`${c.workflowType}/${c.name}`))
      out(`add to ${MANIFEST_PATH}: ${c.workflowType} (queue ${c.queue}) → "${c.name}"`);
}

async function record(
  env: TestWorkflowEnvironment,
  bundle: WorkflowBundleWithSourceMap,
  c: RecordingCase,
  provenance: { commit: string; temporalSdk: string; server: string },
) {
  const calls: string[] = [];
  const rec: Recorder = (impl) => {
    const wrapped: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(impl as Record<string, unknown>))
      wrapped[name] =
        typeof fn === 'function'
          ? async (input: unknown) => {
              calls.push(name);
              return await (fn as (i: unknown) => unknown)(input);
            }
          : fn;
    return wrapped as typeof impl;
  };
  const activities = c.activities(rec);
  const entry = QUEUE_ENTRIES[c.queue];
  const taskQueue = c.taskQueue ?? entry.taskQueues[0];
  const queues = new Set<string>([...entry.taskQueues, ...Object.keys(activities)]);
  const workers = await Promise.all(
    [...queues].map((q) =>
      Worker.create({
        connection: env.nativeConnection,
        taskQueue: q,
        identity: RECORDER_IDENTITY,
        ...((entry.taskQueues as readonly string[]).includes(q) ? { workflowBundle: bundle } : {}),
        activities: activities[q] ?? {},
      }),
    ),
  );
  const running = workers.map((w) => w.run());
  let history: unknown;
  let state: HistoryMeta['state'] | undefined;
  try {
    const ctx: CaseContext = {
      client: env.client,
      calls,
      untilCall: (name, times = 1) =>
        until(() => calls.filter((n) => n === name).length >= times, `${times}× ${name}`),
      untilEvent: (handle, eventType, times = 1) =>
        until(
          async () =>
            eventTypesOf(await handle.fetchHistory()).filter((t) => t === eventType).length >= times,
          `${times}× ${eventType}`,
        ),
      // The handle names the first run, so a continue-as-new is recorded as that run, not the next one.
      start: async (workflowType, args, workflowId, queue) => {
        const started = await env.client.workflow.start(workflowType, {
          taskQueue: queue ?? taskQueue,
          workflowId,
          args,
        });
        return env.client.workflow.getHandle(workflowId, started.firstExecutionRunId);
      },
    };
    await c.before?.(ctx);
    const args = typeof c.args === 'function' ? c.args() : c.args;
    let handle: Handle = await ctx.start(c.workflowType, args, c.workflowId);
    handle = (await c.drive?.(handle, ctx)) ?? handle;
    if (c.state === 'open') await ctx.untilEvent(handle, c.openAt ?? 'TIMER_STARTED');
    else
      await until(
        async () => (await handle.describe()).status.name !== 'RUNNING',
        `${c.workflowType} to close`,
      );
    history = await handle.fetchHistory();
    state = STATUS_STATE[(await handle.describe()).status.name];
  } finally {
    // Nothing outlives a case: open executions (the recorded one, abandoned children, relay targets) end here.
    for await (const w of env.client.workflow.list({ query: 'ExecutionStatus="Running"' }))
      await env.client.workflow
        .getHandle(w.workflowId, w.runId)
        .terminate('replay recorder: case finished')
        .catch(() => undefined);
    workers.forEach((w) => w.shutdown());
    await Promise.allSettled(running);
  }
  if (state !== c.state) throw new Error(`expected the execution to be ${c.state}, it is ${state}`);

  const json = sanitiseHistory(JSON.parse(historyToJSON(history as never)) as unknown);
  const problems = sanitisationProblems(json, [hostname(), REPO_ROOT]);
  if (problems.length) throw new Error(`history is not sanitised:\n${problems.join('\n')}`);
  const replay = await Worker.runReplayHistory({ workflowBundle: bundle }, json, c.workflowId).then(
    () => undefined,
    (err: Error) => err,
  );
  if (replay) throw new Error(`the history does not replay: ${replay.message}`);

  const text = `${JSON.stringify(json, null, 2)}\n`;
  const meta: HistoryMeta = {
    workflowType: c.workflowType,
    case: c.name,
    description: c.description,
    queue: c.queue,
    state: c.state,
    generatedFromCommit: provenance.commit,
    generatedAt: new Date().toISOString(),
    generator: `packages/workflows/replay/record.ts on the Temporal CLI dev server (${provenance.server.split('\n')[0]})`,
    temporalSdk: provenance.temporalSdk,
    historySha256: sha256(text),
  };
  mkdirSync(dirname(historyPath(c.workflowType, c.name)), { recursive: true });
  writeFileSync(historyPath(c.workflowType, c.name), text, { flag: 'wx' });
  writeFileSync(metaPath(c.workflowType, c.name), `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
}

main().then(
  () => process.exit(0),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
