import { fileURLToPath } from 'node:url';
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
