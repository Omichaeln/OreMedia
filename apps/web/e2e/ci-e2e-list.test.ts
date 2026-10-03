import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every browser suite is opt-in (`describe.skipIf(!OREMEDIA_E2E)`), so a suite that CI does not name is reported as
 * skipped and never fails. CI names them one by one in the integration job of .github/workflows/ci.yml; this guard
 * fails when a suite in apps/web/e2e is missing from that step, when the step names a suite that does not exist, or
 * when the step stops setting OREMEDIA_E2E=1.
 */
const E2E_DIR = fileURLToPath(new URL('.', import.meta.url));
const CI_PATH = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));

/** Runs only in the staging acceptance job, against the deployed API (OREMEDIA_E2E_BASE_URL), never in CI. */
const NOT_IN_CI = new Set(['deployed.e2e.test.ts']);

const SUITE = /apps\/web\/e2e\/([\w.-]+\.e2e\.test\.ts)/g;

interface E2eStep {
  suites: string[];
  env: string[];
}

/** The `- run: ... vitest run ... apps/web/e2e/*.e2e.test.ts` steps of ci.yml, with the env lines that follow each. */
function e2eSteps(ciYaml: string): E2eStep[] {
  const lines = ciYaml.split('\n');
  const steps: E2eStep[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*- run: .*vitest run .*apps\/web\/e2e\//.test(line)) return;
    const env: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      if (/^\s*- /.test(next) || /^\S/.test(next) || /^ {2}\S/.test(next)) break;
      env.push(next.trim());
    }
    steps.push({ suites: [...line.matchAll(SUITE)].map((m) => m[1] as string), env });
  });
  return steps;
}

describe('CI runs every browser suite (.github/workflows/ci.yml)', () => {
  const onDisk = readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.e2e.test.ts'))
    .sort();
  const steps = e2eSteps(readFileSync(CI_PATH, 'utf8'));
  const listed = steps.flatMap((s) => s.suites);

  it('finds the e2e step and the suites on disk', () => {
    expect(steps.length).toBeGreaterThan(0);
    expect(onDisk.length).toBeGreaterThan(NOT_IN_CI.size);
  });

  it('lists every apps/web/e2e/*.e2e.test.ts except the deliberate exclusions', () => {
    const missing = onDisk.filter((f) => !NOT_IN_CI.has(f) && !listed.includes(f));
    expect(missing, 'add these to the e2e step in .github/workflows/ci.yml').toEqual([]);
  });

  it('lists no suite that does not exist, none twice, and none that is deliberately excluded', () => {
    expect(listed.filter((f) => !onDisk.includes(f))).toEqual([]);
    expect(listed.filter((f, i) => listed.indexOf(f) !== i)).toEqual([]);
    expect(listed.filter((f) => NOT_IN_CI.has(f))).toEqual([]);
    for (const f of NOT_IN_CI) expect(onDisk).toContain(f);
  });

  it('runs the listed suites with OREMEDIA_E2E=1, so they are not skipped', () => {
    for (const step of steps) expect(step.env).toContain("OREMEDIA_E2E: '1'");
  });
});
