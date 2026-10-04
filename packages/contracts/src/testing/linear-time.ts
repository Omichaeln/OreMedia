/**
 * Test-only: how a parser's running time grows when its hostile input grows. A single absolute bound on wall-clock
 * time fails on a busy machine even for linear code, so tests time the same input at `size` and `factor × size` and
 * compare: linear code grows by about `factor`, quadratic code by `factor²`, catastrophic backtracking by far more.
 *
 * Time is this process's CPU time (vitest runs each test file in its own forked process), so waiting for a core on a
 * loaded machine does not count. A first run of each size warms the JIT, and a run that is already over
 * `LINEAR_SAFETY_MS` is returned without repeating (the larger size unrun, as Infinity, when the smaller one is).
 * Otherwise each sample runs the input enough times for the smaller size to take about `SAMPLE_MS`, so timer noise
 * does not decide the ratio; the sizes are sampled alternately `reps` times and the fastest sample of each counts.
 */
export interface Growth {
  /** CPU time of one run at `size`. */
  smallMs: number;
  /** CPU time of one run at `factor × size`. */
  largeMs: number;
  /** largeMs / smallMs. */
  ratio: number;
}

/** The most an 8× input may multiply the time: linear code gives about 8, quadratic about 64. */
export const LINEAR_RATIO_MAX = 24;
/** Generous for a loaded CI runner at the larger size, still far below what a quadratic parser takes there. */
export const LINEAR_SAFETY_MS = 2_000;
const SAMPLE_MS = 2;

/** CPU time of one run of `run(input)`, averaged over `times` runs. */
function cpuMs<T>(run: (input: T) => unknown, input: T, times = 1): number {
  const started = process.cpuUsage();
  for (let i = 0; i < times; i++) run(input);
  const { user, system } = process.cpuUsage(started);
  return (user + system) / 1000 / times;
}

export function timeGrowth<T>(
  input: (size: number) => T,
  run: (input: T) => unknown,
  { size, factor = 8, reps = 5 }: { size: number; factor?: number; reps?: number },
): Growth {
  const small = input(size);
  const large = input(size * factor);
  const smallOnce = cpuMs(run, small);
  if (smallOnce > LINEAR_SAFETY_MS) return { smallMs: smallOnce, largeMs: Infinity, ratio: Infinity };
  const largeOnce = cpuMs(run, large);
  if (largeOnce > LINEAR_SAFETY_MS)
    return { smallMs: smallOnce, largeMs: largeOnce, ratio: largeOnce / smallOnce };
  const times = Math.max(1, Math.ceil(SAMPLE_MS / Math.max(cpuMs(run, small), 0.001)));
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let i = 0; i < reps; i++) {
    smallMs = Math.min(smallMs, cpuMs(run, small, times));
    largeMs = Math.min(largeMs, cpuMs(run, large, times));
  }
  return { smallMs, largeMs, ratio: largeMs / smallMs };
}
