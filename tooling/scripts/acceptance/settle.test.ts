import { describe, expect, it } from 'vitest';
import {
  waitForSettled,
  type HealthObservation,
  type MigrationObservation,
  type SettleProbes,
} from './settle';

const SHA = 'f3ba12f0c0ffee00000000000000000000000001';
const OLD = 'a1b2c3d4c0ffee00000000000000000000000002';
const applied: MigrationObservation = {
  expectedTag: '0025_studio_generation',
  expectedAt: 1791055662066,
  appliedAt: 1791055662066,
  upToDate: true,
};
const pending: MigrationObservation = { ...applied, appliedAt: 1791050815610, upToDate: false };

/** A fake clock the injected sleep advances, and probes answering from a script (the last answer repeats). */
function harness(health: HealthObservation[], migrations: MigrationObservation[]) {
  let t = 0;
  let calls = 0;
  const lines: string[] = [];
  const at = <T>(xs: T[], i: number): T => xs[Math.min(i, xs.length - 1)]!;
  const probes: SettleProbes = {
    health: async () => at(health, calls),
    migrations: async () => at(migrations, calls++),
  };
  return {
    probes,
    lines,
    opts: {
      timeoutMs: 60_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      print: (line: string) => lines.push(line),
    },
    elapsed: () => t,
    calls: () => calls,
  };
}

describe('waitForSettled', () => {
  it('settles after three consecutive settled probes, restarting the count when the api restarts', async () => {
    const h = harness(
      [
        { status: 502, revision: null },
        { status: 200, revision: SHA },
        { status: 0, revision: null, error: 'TypeError: fetch failed' },
        { status: 200, revision: SHA },
      ],
      [pending, applied],
    );
    const result = await waitForSettled(h.probes, { ...h.opts, revision: SHA });
    expect(result.outcome).toBe('pass');
    expect(result.name).toBe('settle');
    expect(result.detail).toContain(SHA);
    expect(h.calls()).toBe(6);
    expect(h.elapsed()).toBe(50_000);
    expect(h.lines.every((l) => l.startsWith('ACCEPTANCE_INFO settle '))).toBe(true);
    expect(h.lines).toContain(
      'ACCEPTANCE_INFO settle probe 1: api /health HTTP 502, expected 200; migrations pending: latest applied created_at 1791050815610, expected 1791055662066 (0025_studio_generation) (0/3 settled)',
    );
    expect(h.lines.at(-1)).toMatch(/probe 6: .* \(3\/3 settled\)$/);
  });

  it('times out on a revision mismatch, naming the observed and the expected commit', async () => {
    const h = harness([{ status: 200, revision: OLD }], [applied]);
    const result = await waitForSettled(h.probes, { ...h.opts, revision: SHA });
    expect(result).toEqual({
      name: 'settle',
      outcome: 'fail',
      detail: `not settled within 60 s: api revision ${OLD}, expected ${SHA}`,
    });
    expect(h.elapsed()).toBeLessThanOrEqual(60_000);
    expect(h.calls()).toBe(7);
  });

  it('times out on pending migrations, naming the applied and the expected migration time', async () => {
    const h = harness([{ status: 200, revision: SHA }], [pending]);
    const result = await waitForSettled(h.probes, { ...h.opts, revision: SHA });
    expect(result.outcome).toBe('fail');
    expect(result.detail).toBe(
      'not settled within 60 s: migrations pending: latest applied created_at 1791050815610, expected 1791055662066 (0025_studio_generation)',
    );
  });

  it('reports an unreadable migration state as the failing condition', async () => {
    const h = harness([{ status: 200, revision: SHA }], [applied]);
    h.probes.migrations = async () => {
      throw new Error("Table 'oremedia.policy_versions' doesn't exist");
    };
    const result = await waitForSettled(h.probes, { ...h.opts, revision: SHA, timeoutMs: 15_000 });
    expect(result.outcome).toBe('fail');
    expect(result.detail).toContain('migration state unreadable (Error: Table');
  });

  it('skips the revision check when the job does not know its commit, and says so once', async () => {
    const h = harness([{ status: 200, revision: OLD }], [applied]);
    const result = await waitForSettled(h.probes, { ...h.opts, revision: null });
    expect(result.outcome).toBe('pass');
    expect(result.detail).toContain('an unchecked revision');
    expect(
      h.lines.filter((l) => l.includes('revision check skipped: RAILWAY_GIT_COMMIT_SHA is not set')),
    ).toHaveLength(1);
  });

  it("skips the revision check when the api reports none, but still waits for /health's 200", async () => {
    const h = harness(
      [
        { status: 503, revision: null },
        { status: 200, revision: null },
      ],
      [applied],
    );
    const result = await waitForSettled(h.probes, { ...h.opts, revision: SHA });
    expect(result.outcome).toBe('pass');
    expect(h.calls()).toBe(4);
    expect(h.lines).toContain(
      "ACCEPTANCE_INFO settle revision check skipped: the api's /health reports no revision",
    );
  });
});
