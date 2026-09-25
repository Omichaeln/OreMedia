import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Each app's main.ts is a configuration gate that dynamically imports the real entry (./worker.js, ./start.js) from
 * dist. That import is invisible to the bundler, so the target must be a tsup entry of its own; the redirector once
 * shipped without it and failed at start with ERR_MODULE_NOT_FOUND. Checked statically for every app.
 */
const appsDir = path.resolve(process.cwd(), 'apps');
const apps = readdirSync(appsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const read = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

describe('every module an app entry imports at run time is built', () => {
  const cases = apps.flatMap((app) => {
    const main = read(path.join(appsDir, app, 'src/main.ts'));
    if (!main) return [];
    const targets = [...main.matchAll(/import\(new URL\('\.\/([\w-]+)\.js'/g)].map((m) => m[1]!);
    return targets.map((target) => ({ app, target }));
  });

  it('finds the gated apps', () => {
    expect(cases.map((c) => c.app).sort()).toEqual(
      expect.arrayContaining(['redirector', 'worker-core', 'worker-ingest', 'worker-render']),
    );
  });

  it.each(cases)('$app imports $target, which is a tsup entry', ({ app, target }) => {
    const config = read(path.join(appsDir, app, 'tsup.config.ts')) ?? '';
    const entry = config.match(/entry:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(entry, `${app}/tsup.config.ts entry lacks ${target}`).toMatch(
      new RegExp(`(['"]?)${target}\\1\\s*:\\s*['"]src/${target}\\.ts['"]`),
    );
  });
});
