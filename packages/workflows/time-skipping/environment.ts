import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';

/**
 * Spec 19.4 time-skipping tests. In CI the SDK downloads Temporal's time-skipping test server, so a three-day wait
 * takes no wall time. Where that download is blocked, TEMPORAL_CLI_PATH points at a Temporal CLI binary and the
 * same tests run against its dev server in real time with durations scaled by TEMPORAL_TIME_SCALE (a day becomes
 * `86_400_000 * scale` ms), which checks the mechanics but not the long waits.
 */
export interface TestEnvironment {
  env: TestWorkflowEnvironment;
  /** Milliseconds for one day in this environment. */
  day: number;
  now(): Promise<number>;
}

export async function createTestEnvironment(): Promise<TestEnvironment> {
  const cli = process.env['TEMPORAL_CLI_PATH'];
  if (!cli) {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    return { env, day: 86_400_000, now: () => env.currentTimeMs() };
  }
  const env = await TestWorkflowEnvironment.createLocal({
    server: { executable: { type: 'existing-path', path: cli } },
  });
  const scale = Number(process.env['TEMPORAL_TIME_SCALE'] ?? 1 / 43_200); // a day ≈ 2 s
  return { env, day: 86_400_000 * scale, now: async () => Date.now() };
}

/** The workflow entry the core worker bundles (publication workflows live on task queue `core`). */
export const CORE_WORKFLOWS = fileURLToPath(new URL('../src/queues/core.ts', import.meta.url));

/** The workflow entry worker-render bundles for task queue `video` (STU-2a video and audio ingest, STU-2b renders). */
export const VIDEO_WORKFLOWS = fileURLToPath(new URL('../src/queues/video.ts', import.meta.url));

/** The workflow entry the agents worker bundles (agent runs, STU-1b generation and STU-3 video AI jobs: queue `agents`). */
export const AGENTS_WORKFLOWS = fileURLToPath(new URL('../src/queues/agents.ts', import.meta.url));

/** An activity implementation as the worker calls it, with the workflow's input. */
export type FakeActivity = (input: never) => Promise<unknown>;

/** The options a worker app passes to Worker.create, as far as the smoke tests read them. */
interface CreatedWorker {
  taskQueue: string;
  activities?: object;
}

/**
 * Worker smoke tests (G26): the app's own start function creates its workers against this environment; for each
 * task queue, the activities `fakes(taskQueue)` names replace the registered ones of the same name (the rest stay
 * registered, so the registration is the production one), and every task queue a worker was created for is
 * recorded with the activity names the app itself registered on it (before any fake replaced one), so a test can
 * prove a production registration that a fake would otherwise stand in for. `worker` is the app's `Worker` (its own
 * @temporalio/worker instance); `restore()` puts create back.
 */
export function fakeActivitiesOnWorkers(
  worker: { create(options: never): Promise<unknown> },
  fakes: (taskQueue: string) => Record<string, FakeActivity> | undefined,
): { queues: string[]; registered: Map<string, string[]>; restore(): void } {
  const queues: string[] = [];
  const registered = new Map<string, string[]>();
  const target = worker as unknown as { create(options: CreatedWorker): Promise<unknown> };
  const create = target.create.bind(target);
  const spy = vi.spyOn(target, 'create').mockImplementation(async (options: CreatedWorker) => {
    queues.push(options.taskQueue);
    registered.set(options.taskQueue, Object.keys(options.activities ?? {}));
    return create({ ...options, activities: { ...options.activities, ...fakes(options.taskQueue) } });
  });
  return { queues, registered, restore: () => spy.mockRestore() };
}

/** A tenant context the fake activities ignore (workflows pass their input through unchanged). */
export const SMOKE_CONTEXT = {
  tenantId: 'tnt_smoke',
  actor: { kind: 'user' as const, id: 'usr_smoke' },
  correlationId: 'smoke',
};
