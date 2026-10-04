import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DefaultLogger, Runtime, Worker, bundleWorkflowCode } from '@temporalio/worker';
import {
  HISTORIES_DIR,
  MANIFEST_PATH,
  QUEUE_ENTRIES,
  REPO_ROOT,
  WORKFLOWS_SRC,
  bundledQueueEntries,
  eventTypesOf,
  historiesOnDisk,
  historyPath,
  metaPath,
  queueEntryPath,
  readManifest,
  registeredWorkflowTypes,
  sha256,
  type HistoryMeta,
  type Manifest,
  type QueueEntry,
} from './catalogue';
import { RECORDING_CASES } from './cases';
import { sanitisationProblems } from './sanitise';

/**
 * Spec 19.4 release gate (`pnpm test:replay`, CI job "Temporal workflow replay"): every retained history under
 * tooling/test-fixtures/histories is replayed with Worker.runReplayHistories against the CANDIDATE bundle of its
 * queue entry, built from the current packages/workflows/src exactly as the worker apps build it. Any
 * nondeterminism fails the run. The gate cannot pass by accident: it fails when a registered workflow type has no
 * retained history, when a manifest entry or listed history is missing, when a history is unlisted, edited or
 * regenerated, when a case still registered on the base branch was dropped, or when nothing is discovered (and the
 * vitest project `replay` sets passWithNoTests: false).
 */
Runtime.install({ logger: new DefaultLogger('WARN') });

const manifest: Manifest = readManifest();
const required = manifest.workflows.flatMap((e) => e.histories.map((h) => `${e.workflowType}/${h}`)).sort();
const onDisk = historiesOnDisk();
const entryOf = new Map(manifest.workflows.map((e) => [e.workflowType, e]));
const metaOf = (key: string): HistoryMeta => {
  const [type, name] = key.split('/') as [string, string];
  return JSON.parse(readFileSync(metaPath(type, name), 'utf8')) as HistoryMeta;
};
const historyJson = (key: string): unknown => {
  const [type, name] = key.split('/') as [string, string];
  return JSON.parse(readFileSync(historyPath(type, name), 'utf8'));
};

const CLOSING_EVENT: Record<Exclude<HistoryMeta['state'], 'open'>, string> = {
  completed: 'WORKFLOW_EXECUTION_COMPLETED',
  failed: 'WORKFLOW_EXECUTION_FAILED',
  canceled: 'WORKFLOW_EXECUTION_CANCELED',
  continued_as_new: 'WORKFLOW_EXECUTION_CONTINUED_AS_NEW',
};
const CLOSING_EVENTS = [
  ...Object.values(CLOSING_EVENT),
  'WORKFLOW_EXECUTION_TERMINATED',
  'WORKFLOW_EXECUTION_TIMED_OUT',
];

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const BASE_REF = process.env['REPLAY_BASE_REF'] ?? 'origin/main';

describe('replay gate: the manifest covers every registered workflow version', () => {
  it('discovers histories and manifest entries (an empty gate is a failure, never a pass)', () => {
    expect(manifest.workflows.length).toBeGreaterThan(0);
    expect(required.length).toBeGreaterThan(0);
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it('the worker apps bundle exactly the queue entries the gate replays, each in the app it names', () => {
    const queueFiles = readdirSync(join(WORKFLOWS_SRC, 'queues'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3))
      .sort();
    expect(Object.keys(QUEUE_ENTRIES).sort()).toEqual(queueFiles);
    const bundled = bundledQueueEntries();
    const byEntry = new Map<string, string>();
    for (const [app, entries] of bundled) for (const e of entries) byEntry.set(e, app);
    expect([...byEntry.keys()].sort()).toEqual(queueFiles);
    for (const [entry, { worker }] of Object.entries(QUEUE_ENTRIES))
      expect(byEntry.get(entry), `queue entry ${entry}`).toBe(worker);
  });

  it('every workflow type a worker registers has a manifest entry, and every entry is registered by its queue', async () => {
    const registered = new Map<string, QueueEntry>();
    for (const entry of Object.keys(QUEUE_ENTRIES) as QueueEntry[])
      for (const type of await registeredWorkflowTypes(entry)) registered.set(type, entry);
    expect(registered.size).toBeGreaterThan(0);
    const missing = [...registered.keys()].filter((t) => !entryOf.has(t));
    expect(missing, 'registered workflow types without retained histories').toEqual([]);
    for (const e of manifest.workflows) {
      expect(registered.get(e.workflowType), `${e.workflowType} is not registered by queue ${e.queue}`).toBe(
        e.queue,
      );
      expect(e.status).toBe('supported');
    }
    expect(manifest.workflows.length, 'duplicate manifest entries').toBe(entryOf.size);
    for (const r of manifest.retired) {
      expect(r.reason.length, `retirement of ${r.workflowType} gives no reason`).toBeGreaterThan(0);
      expect(r.retiredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (r.histories === 'all') {
        expect(registered.has(r.workflowType), `${r.workflowType} is retired but still registered`).toBe(
          false,
        );
        expect(entryOf.has(r.workflowType), `${r.workflowType} is both retired and required`).toBe(false);
      }
    }
  });

  it('every manifest entry lists at least one history and every listed history is retained with its provenance', () => {
    for (const e of manifest.workflows) {
      expect(e.histories.length, `${e.workflowType} lists no history`).toBeGreaterThan(0);
      expect(new Set(e.histories).size, `${e.workflowType} lists a history twice`).toBe(e.histories.length);
    }
    const absent = required.filter((key) => {
      const [type, name] = key.split('/') as [string, string];
      return !existsSync(historyPath(type, name)) || !existsSync(metaPath(type, name));
    });
    expect(absent, 'manifest histories with no <case>.json or <case>.meta.json').toEqual([]);
  });

  it('every retained history has the recording case that produced it (packages/workflows/replay/cases)', () => {
    const cases = new Map(RECORDING_CASES.map((c) => [`${c.workflowType}/${c.name}`, c]));
    expect(required.filter((key) => !cases.has(key))).toEqual([]);
    for (const key of required)
      expect(cases.get(key)?.queue, key).toBe(entryOf.get(key.split('/')[0]!)?.queue);
  });

  it('no retained history or stray file is left out of the manifest', () => {
    expect(onDisk.filter((key) => !required.includes(key))).toEqual([]);
    const stray: string[] = [];
    for (const type of readdirSync(HISTORIES_DIR, { withFileTypes: true })) {
      if (!type.isDirectory()) {
        if (type.name !== 'manifest.json') stray.push(type.name);
        continue;
      }
      for (const f of readdirSync(join(HISTORIES_DIR, type.name))) {
        const key = `${type.name}/${f.replace(/(\.meta)?\.json$/, '')}`;
        if (!f.endsWith('.json') || !required.includes(key)) stray.push(`${type.name}/${f}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it(`no history the base branch (${BASE_REF}) requires for a still-registered type was dropped`, () => {
    let base: Manifest | null = null;
    try {
      git(['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`]);
    } catch {
      throw new Error(`${BASE_REF} is not available: fetch it (CI checks out with fetch-depth 0)`);
    }
    try {
      base = JSON.parse(git(['show', `${BASE_REF}:${relative(REPO_ROOT, MANIFEST_PATH)}`])) as Manifest;
    } catch {
      base = null; // the base branch has no manifest yet (the change that introduces the gate)
    }
    const retired = new Set(
      manifest.retired.flatMap((r) =>
        r.histories === 'all' ? [] : r.histories.map((h) => `${r.workflowType}/${h}`),
      ),
    );
    const dropped = (base?.workflows ?? [])
      .filter((b) => entryOf.has(b.workflowType))
      .flatMap((b) => b.histories.map((h) => `${b.workflowType}/${h}`))
      .filter((key) => !required.includes(key) && !retired.has(key));
    expect(
      dropped,
      'retained histories removed (without a retirement entry) while their type is registered',
    ).toEqual([]);
  });
});

describe.each(required)('retained history %s', (key) => {
  it('matches its provenance and manifest entry, and is sanitised', () => {
    const [type, name] = key.split('/') as [string, string];
    const meta = metaOf(key);
    const bytes = readFileSync(historyPath(type, name));
    expect(meta.workflowType).toBe(type);
    expect(meta.case).toBe(name);
    expect(meta.queue).toBe(entryOf.get(type)?.queue);
    expect(meta.generatedFromCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(sha256(bytes), 'the history bytes differ from the sha256 recorded when it was retained').toBe(
      meta.historySha256,
    );
    const history = JSON.parse(bytes.toString('utf8')) as {
      events: Array<{ workflowExecutionStartedEventAttributes?: { workflowType?: { name?: string } } }>;
    };
    expect(history.events[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name).toBe(type);
    const types = eventTypesOf(history);
    const closing = types.filter((t) => CLOSING_EVENTS.includes(t));
    expect(closing, 'the history ends as its provenance says').toEqual(
      meta.state === 'open' ? [] : [CLOSING_EVENT[meta.state]],
    );
    if (meta.state !== 'open') expect(types[types.length - 1]).toBe(CLOSING_EVENT[meta.state]);
    expect(sanitisationProblems(history)).toEqual([]);
  });
});

describe('retained histories are committed and never edited or regenerated in place', () => {
  const files = required.flatMap((key) => {
    const [type, name] = key.split('/') as [string, string];
    return [historyPath(type, name), metaPath(type, name)].map((p) => relative(REPO_ROOT, p));
  });
  const tracked = new Set(
    git(['ls-files', '--', relative(REPO_ROOT, HISTORIES_DIR)])
      .split('\n')
      .filter(Boolean),
  );

  it('the checkout has full history, so an edit to a committed history cannot hide behind a shallow clone', () => {
    expect(git(['rev-parse', '--is-shallow-repository']).trim()).toBe('false');
  });

  it('every retained history and its provenance is tracked by git (committed, or staged in this change)', () => {
    expect(files.filter((f) => !tracked.has(f))).toEqual([]);
  });

  it.each(files)('%s is byte-identical to its first commit and was never changed after it', (path) => {
    const commits = git(['log', '--format=%H', '--', path]).split('\n').filter(Boolean);
    if (commits.length === 0) return; // added by this change: frozen from its first commit on
    const first = commits[commits.length - 1]!;
    const committed = execFileSync('git', ['show', `${first}:${path}`], { cwd: REPO_ROOT });
    expect(
      Buffer.compare(committed, readFileSync(join(REPO_ROOT, path))),
      `${path} differs from ${first}`,
    ).toBe(0);
    expect(commits, `${path} was changed after it was first committed: add a new case instead`).toHaveLength(
      1,
    );
  });
});

describe('every retained history replays against the candidate workflow bundle', () => {
  const results = new Map<string, Error | undefined>();
  beforeAll(async () => {
    for (const entry of Object.keys(QUEUE_ENTRIES) as QueueEntry[]) {
      const keys = required.filter((k) => entryOf.get(k.split('/')[0]!)?.queue === entry);
      if (keys.length === 0) continue;
      const workflowBundle = await bundleWorkflowCode({ workflowsPath: queueEntryPath(entry) });
      const histories = keys.map((key) => ({ workflowId: key, history: historyJson(key) }));
      for await (const r of Worker.runReplayHistories(
        { workflowBundle, replayName: `replay-${entry}` },
        histories,
      ))
        results.set(r.workflowId, r.error);
    }
  }, 600_000);

  it('replayed every history it was given', () => {
    expect([...results.keys()].sort()).toEqual(required);
  });

  it.each(required)('%s', (key) => {
    const error = results.get(key);
    expect(error, error?.message).toBeUndefined();
  });
});
