import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Demo workspace (architecture §4.1, §4.4): two composition hooks must be wired by every process that can reach
 * them, because unwired they refuse in production (every company, not only demos):
 *  - configureEgressGuard, by every app whose workspace dependencies (transitively) include @oremedia/providers
 *    (createProviderIO);
 *  - configureTenantKindResolver, by every app that runs the outbox dispatcher (dispatchBatch).
 * The apps are discovered from apps/* and their package.json, so a new worker that forgets the wiring fails here.
 */
const root = process.cwd();
const read = (file: string): string => readFileSync(file, 'utf8');

/** Every workspace package's name → its directory (apps, packages, modules, tooling). */
const packageDirs = new Map<string, string>();
for (const parent of ['apps', 'packages', 'packages/modules', 'tooling']) {
  const dir = path.join(root, parent);
  for (const name of readdirSync(dir)) {
    const pkg = path.join(dir, name, 'package.json');
    if (existsSync(pkg))
      packageDirs.set((JSON.parse(read(pkg)) as { name: string }).name, path.join(dir, name));
  }
}

const workspaceDeps = (dir: string): string[] => {
  const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {}).filter((d) => packageDirs.has(d));
};

function closure(dir: string): Set<string> {
  const seen = new Set<string>();
  const queue = workspaceDeps(dir);
  while (queue.length) {
    const next = queue.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...workspaceDeps(packageDirs.get(next) as string));
  }
  return seen;
}

/** The app's production source (no tests), concatenated. */
function source(dir: string): string {
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((name) => {
      const file = path.join(d, name);
      if (statSync(file).isDirectory()) return files(file);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
    });
  return files(path.join(dir, 'src')).map(read).join('\n');
}

/** The web app is a browser bundle: its edge to the api is type-only (eslint boundaries), so no provider I/O runs. */
const BROWSER_APPS = new Set(['web']);

const apps = readdirSync(path.join(root, 'apps')).filter(
  (name) => existsSync(path.join(root, 'apps', name, 'package.json')) && !BROWSER_APPS.has(name),
);
const appInfo = apps.map((name) => {
  const dir = path.join(root, 'apps', name);
  const src = source(dir);
  return {
    name,
    reachesProviderIO: closure(dir).has('@oremedia/providers'),
    runsDispatcher: /\bdispatchBatch\(/.test(src),
    src,
  };
});

describe('demo workspace composition hooks are wired by every process that can reach them', () => {
  it('discovers the apps that reach provider I/O and the one that runs the outbox dispatcher', () => {
    expect(appInfo.filter((a) => a.reachesProviderIO).map((a) => a.name)).toEqual(
      expect.arrayContaining(['api', 'worker-core', 'worker-ingest', 'worker-render']),
    );
    expect(appInfo.filter((a) => a.runsDispatcher).map((a) => a.name)).toEqual(['worker-core']);
  });

  it.each(appInfo.filter((a) => a.reachesProviderIO))('$name wires configureEgressGuard', ({ src }) => {
    expect(src).toMatch(
      /\bconfigureEgressGuard\(\s*\(tenantId\)\s*=>\s*assertEgressAllowed\(tenantId\)\s*\)/,
    );
  });

  it.each(appInfo.filter((a) => a.runsDispatcher))('$name wires configureTenantKindResolver', ({ src }) => {
    expect(src).toMatch(/\bconfigureTenantKindResolver\(/);
  });

  it.each(appInfo.filter((a) => a.reachesProviderIO || a.runsDispatcher))(
    '$name calls its composition root from its process entry',
    ({ name }) => {
      const dir = path.join(root, 'apps', name, 'src');
      const entry = ['worker.ts', 'main.ts', 'start.ts']
        .map((f) => path.join(dir, f))
        .filter(existsSync)
        .map(read)
        .join('\n');
      expect(entry).toMatch(/\bcomposeModules\(/);
    },
  );
});
