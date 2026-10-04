import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FeatureFlagKey } from '@oremedia/contracts/operations';
import { FLAG_DEFINITIONS } from './feature-flags';

/**
 * G05: a flag nobody reads cannot gate anything, yet looks like a control an operator could turn on. Every defined
 * flag must be evaluated (featureFlag.isEnabled or a tool's services.flags.isEnabled) by production code outside its
 * own definitions; a flag whose reader is removed must be removed with it.
 */
const root = process.cwd();
const DEFINITIONS = new Set([
  path.join(root, 'packages/modules/operations/src/feature-flags.ts'),
  path.join(root, 'packages/contracts/src/operations.ts'),
]);

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'dist', 'e2e', 'time-skipping'].includes(entry.name) ? [] : sources(file);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || DEFINITIONS.has(file)) return [];
    return [file];
  });

describe('feature flag definitions', () => {
  const files = [...sources(path.join(root, 'apps')), ...sources(path.join(root, 'packages'))].map(
    (file) => ({
      file: path.relative(root, file),
      text: readFileSync(file, 'utf8'),
    }),
  );

  it('defines exactly the contract keys', () => {
    expect(FLAG_DEFINITIONS.map((d) => d.key).sort()).toEqual([...FeatureFlagKey.options].sort());
  });

  it.each(FLAG_DEFINITIONS.map((d) => ({ key: d.key })))(
    '$key is evaluated by production code',
    ({ key }) => {
      const readers = files
        .filter(({ text }) => text.includes(`'${key}'`) && text.includes('isEnabled('))
        .map(({ file }) => file);
      expect(readers, `${key} is defined but never read: wire it or remove it`).not.toEqual([]);
    },
  );
});
