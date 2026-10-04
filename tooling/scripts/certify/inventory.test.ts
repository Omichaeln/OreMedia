import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmsRegistry, providerRegistry, sourceRegistry } from '@oremedia/providers';

/**
 * PR-06: docs/release/connection-inventory.md is derived from the registries; this keeps the two in step, so a
 * capability recorded as certified in code without the inventory (or the reverse) fails the unit suite.
 */
const INVENTORY = path.resolve(import.meta.dirname, '../../../docs/release/connection-inventory.md');
const LABEL = { certified: 'certified', uncertified: 'uncertified', not_supported: 'not supported' } as const;

const fromCode = () =>
  [providerRegistry, sourceRegistry, cmsRegistry].flatMap((registry) =>
    registry
      .list()
      .flatMap((p) =>
        registry.certifications(p.key).map((s) => `${p.key} ${s.capability} ${LABEL[s.state]}`),
      ),
  );

describe('connection inventory (PR-06)', () => {
  const doc = readFileSync(INVENTORY, 'utf8');

  it('lists every provider × capability with the state the registries report, nothing more', () => {
    const rows = [
      ...doc.matchAll(/^\| `(\w+)`\s*\| `(\w+)`\s*\| (certified|uncertified|not supported)\s*\|/gm),
    ].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
    expect(rows.sort()).toEqual(fromCode().sort());
  });

  it('the summary counts match the table', () => {
    const count = (label: string) => fromCode().filter((r) => r.endsWith(` ${label}`)).length;
    for (const label of Object.values(LABEL)) {
      const m = new RegExp(`^\\| ${label}\\s*\\| (\\d+)\\s*\\|$`, 'm').exec(doc);
      expect(Number(m?.[1]), label).toBe(count(label));
    }
    expect(Number(/^\| total\s*\| (\d+)\s*\|$/m.exec(doc)?.[1])).toBe(fromCode().length);
  });

  it('a certified row names its evidence; nothing is certified without a recorded run', () => {
    const certified = [...doc.matchAll(/^\| `\w+`\s*\| `\w+`\s*\| certified\s*\| ([^|]*)\|/gm)];
    for (const m of certified) expect(m[1]!.trim()).not.toMatch(/^none/i);
  });
});
