import { describe, expect, it } from 'vitest';
import { GUIDELINES_MAX_BYTES } from '@oremedia/contracts/brand';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import { extractPalette, parseGuidelinesPackage } from './guidelines';

const SKILL = `---
name: harbour-brand
description: Harbour & Co brand system. Use for anything carrying the Harbour name.
---

# Harbour & Co Brand System

| Token | Value | Use |
|---|---|---|
| Primary | Deep Navy \`#1a2a4d\` | Headings, CTAs |
| Secondary | Teal \`#2A9D8F\` | Accents, active states |
| Background (light) | Sea Mist \`oklch(0.98 0.01 200)\` | Page background |
`;
const COLOURS = `# Colours

| Name | Hex | Role |
|---|---|---|
| Deep Navy | \`#1a2a4d\` | Authority, primary brand colour |
| Champagne Gold | \`#d4af37\` | Premium callouts |
| Sea Sand | \`#f4f1de\` | Warm neutral surface |
| Ink | #123 | Body text |
`;

describe('parseGuidelinesPackage (brand skill → guidelines)', () => {
  it('reads the front matter, keeps SKILL.md first and the references by path, and skips non-text files', () => {
    const { guidelines, skipped } = parseGuidelinesPackage([
      { path: 'references/tone.md', content: '# Tone' },
      { path: 'assets/logo.svg', content: '<svg/>' },
      { path: 'SKILL.md', content: SKILL },
      { path: 'references/colours.md', content: COLOURS },
    ]);
    expect(guidelines.source).toMatchObject({
      name: 'harbour-brand',
      description: 'Harbour & Co brand system. Use for anything carrying the Harbour name.',
    });
    expect(guidelines.source.packageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(guidelines.documents.map((d) => d.path)).toEqual([
      'SKILL.md',
      'references/colours.md',
      'references/tone.md',
    ]);
    expect(skipped).toEqual([{ path: 'assets/logo.svg', reason: 'not_text' }]);
  });

  it('drops the folder a directory upload adds, and hashes the same package the same whatever the file order', () => {
    const a = parseGuidelinesPackage([
      { path: 'harbour-brand/SKILL.md', content: SKILL },
      { path: 'harbour-brand/references/colours.md', content: COLOURS },
    ]);
    const b = parseGuidelinesPackage([
      { path: 'references/colours.md', content: COLOURS },
      { path: 'SKILL.md', content: SKILL },
    ]);
    expect(a.guidelines.documents.map((d) => d.path)).toEqual(['SKILL.md', 'references/colours.md']);
    expect(a.guidelines.source.packageHash).toBe(b.guidelines.source.packageHash);
  });

  it('refuses a package without SKILL.md or without a name, and skips references past the size cap', () => {
    const issue = (files: Array<{ path: string; content: string }>) => {
      try {
        parseGuidelinesPackage(files);
        return null;
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationFailedError);
        return (e as ValidationFailedError).details?.[0]?.issue;
      }
    };
    expect(issue([{ path: 'README.md', content: '# x' }])).toBe('skill_md_missing');
    expect(issue([{ path: 'SKILL.md', content: '# no front matter' }])).toBe('name_missing');
    const big = 'x'.repeat(GUIDELINES_MAX_BYTES - Buffer.byteLength(SKILL) + 1);
    const { guidelines, skipped } = parseGuidelinesPackage([
      { path: 'SKILL.md', content: SKILL },
      { path: 'references/big.md', content: big },
    ]);
    expect(guidelines.documents.map((d) => d.path)).toEqual(['SKILL.md']);
    expect(skipped).toEqual([{ path: 'references/big.md', reason: 'over_size_cap' }]);
  });
});

describe('extractPalette (colours stated in markdown tables)', () => {
  it('reads each hex once, names it from its row, infers its role and leaves other notations in the text', () => {
    expect(extractPalette([{ content: SKILL }, { content: COLOURS }])).toEqual([
      { key: 'primary', value: '#1A2A4D', role: 'primary' },
      { key: 'secondary', value: '#2A9D8F', role: 'secondary' },
      { key: 'champagne-gold', value: '#D4AF37', role: 'accent' },
      { key: 'sea-sand', value: '#F4F1DE', role: 'background' },
      { key: 'ink', value: '#112233', role: 'text' },
    ]);
  });

  it('gives repeated names distinct keys and ignores hex values outside tables', () => {
    const doc = `The accent is #ff0000 in prose.

| Name | Hex |
|---|---|
| Red | #ff0000 |
| Red | #cc0000 |`;
    expect(extractPalette([{ content: doc }]).map((c) => [c.key, c.value])).toEqual([
      ['red', '#FF0000'],
      ['red-2', '#CC0000'],
    ]);
  });
});
