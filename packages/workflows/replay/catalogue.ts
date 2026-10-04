import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';

/**
 * Spec 19.4 replay gate: where the retained workflow histories live, what the workers register, and the manifest
 * of required histories. Shared by the recorder (record.ts) and the replay suite (*.replay.test.ts). Lives outside
 * src/ because workflow sources may not import Node built-ins (eslint no-restricted-imports).
 */
const here = dirname(fileURLToPath(import.meta.url));
export const WORKFLOWS_SRC = join(here, '..', 'src');
export const REPO_ROOT = join(here, '..', '..', '..');
/** Spec 19.4: histories are committed under tooling/test-fixtures/histories/<workflowType>/<case>.json. */
export const HISTORIES_DIR = join(REPO_ROOT, 'tooling', 'test-fixtures', 'histories');
export const MANIFEST_PATH = join(HISTORIES_DIR, 'manifest.json');

/**
 * Each workflow queue entry (packages/workflows/src/queues/<entry>.ts), the worker app that bundles it
 * (tsup.config.ts QUEUES → dist/workflows.<entry>.js) and the task queues it is served on in production.
 */
export const QUEUE_ENTRIES = {
  core: { worker: 'worker-core', taskQueues: ['core'] },
  agents: { worker: 'worker-core', taskQueues: ['agents'] },
  ingest: { worker: 'worker-ingest', taskQueues: ['ingest-metrics', 'ingest-comments'] },
  media: { worker: 'worker-render', taskQueues: ['media'] },
  render: { worker: 'worker-render', taskQueues: ['render'] },
  video: { worker: 'worker-render', taskQueues: ['video'] },
} as const;
export type QueueEntry = keyof typeof QUEUE_ENTRIES;
export const queueEntryPath = (entry: QueueEntry): string => join(WORKFLOWS_SRC, 'queues', `${entry}.ts`);

/** The queue entries each worker app pre-bundles, read from its tsup.config.ts (`const QUEUES = [...]`). */
export function bundledQueueEntries(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const apps = join(REPO_ROOT, 'apps');
  for (const app of readdirSync(apps)) {
    const config = join(apps, app, 'tsup.config.ts');
    if (!existsSync(config)) continue;
    const match = /const QUEUES = \[([^\]]*)\]/.exec(readFileSync(config, 'utf8'));
    if (!match) continue;
    out.set(
      app,
      [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''),
    );
  }
  return out;
}

/** Workflow types a queue entry registers: its exported functions whose name ends in V<N> (as the workers see them). */
export async function registeredWorkflowTypes(entry: QueueEntry): Promise<string[]> {
  const mod = (await import(pathToFileURL(queueEntryPath(entry)).href)) as Record<string, unknown>;
  return Object.entries(mod)
    .filter(([name, v]) => typeof v === 'function' && /V\d+$/.test(name))
    .map(([name]) => name)
    .sort();
}

export interface ManifestEntry {
  workflowType: string;
  queue: QueueEntry;
  /** `supported`: registered by a worker, so open executions of it may exist in production and must replay. */
  status: 'supported';
  /** The case names whose <case>.json history must be retained for this type. */
  histories: string[];
}
/**
 * A retirement, kept as the audit trail: a whole workflow type no longer registered (`histories: 'all'`, after its
 * last execution closed), or single cases of a still-registered type that were recorded wrongly and replaced.
 */
export interface RetiredEntry {
  workflowType: string;
  histories: string[] | 'all';
  reason: string;
  retiredOn: string;
}
export interface Manifest {
  workflows: ManifestEntry[];
  retired: RetiredEntry[];
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

/** Provenance recorded beside each history (<case>.meta.json); written once by the recorder, never edited. */
export interface HistoryMeta {
  workflowType: string;
  case: string;
  description: string;
  queue: QueueEntry;
  /** How the recorded execution ended, or `open` when the history was taken while it was still running. */
  state: 'completed' | 'failed' | 'canceled' | 'continued_as_new' | 'open';
  /** The commit whose packages/workflows/src the history was generated from (the tree was clean there). */
  generatedFromCommit: string;
  generatedAt: string;
  generator: string;
  temporalSdk: string;
  /** sha256 of the <case>.json bytes: a retained history is never regenerated or edited in place. */
  historySha256: string;
}

export const historyPath = (workflowType: string, name: string): string =>
  join(HISTORIES_DIR, workflowType, `${name}.json`);
export const metaPath = (workflowType: string, name: string): string =>
  join(HISTORIES_DIR, workflowType, `${name}.meta.json`);

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Every history file on disk, as `<workflowType>/<case>` (meta files excluded). */
export function historiesOnDisk(): string[] {
  if (!existsSync(HISTORIES_DIR)) return [];
  const out: string[] = [];
  for (const type of readdirSync(HISTORIES_DIR, { withFileTypes: true })) {
    if (!type.isDirectory()) continue;
    for (const f of readdirSync(join(HISTORIES_DIR, type.name)))
      if (f.endsWith('.json') && !f.endsWith('.meta.json')) out.push(`${type.name}/${f.slice(0, -5)}`);
  }
  return out.sort();
}

/** Event types of a history (a fetched proto or history JSON), as TIMER_STARTED, WORKFLOW_TASK_FAILED, … */
export function eventTypesOf(history: unknown): string[] {
  const json = (
    typeof (history as { toJSON?: unknown }).toJSON === 'function' || !('events' in (history as object))
      ? JSON.parse(historyToJSON(history as never))
      : history
  ) as { events?: Array<{ eventType?: string }> };
  return (json.events ?? []).map((e) =>
    String(e.eventType ?? '')
      .replace(/^EVENT_TYPE_/, '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toUpperCase(),
  );
}
