import { describe, expect, it } from 'vitest';
import { BrandSystemDocumentV1, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import {
  SuggestionPathError,
  applyChange,
  changedSectionLabels,
  describeValue,
  diffBrandDocuments,
  parsePath,
  pathLabel,
  sameValue,
  suggestionFingerprint,
  valueAt,
} from './brand-suggestions';

const base = (): BrandSystemDocumentV1 =>
  BrandSystemDocumentV1.parse({
    ...emptyBrandSystemDocument(),
    voice: {
      ...emptyBrandSystemDocument().voice,
      summary: 'Warm.',
      principles: [
        { statement: 'Say what it does', rationale: 'Fast readers.', provenance: { origin: 'user' } },
      ],
    },
    vocabulary: [{ term: 'Roast', usage: 'preferred', alternatives: [] }],
  });

describe('suggestion paths (BSC-4)', () => {
  it('names scalar fields and keyed items; keys compare without case or spacing; unknown paths are null', () => {
    expect(parsePath('voice.summary')?.target.kind).toBe('scalar');
    expect(parsePath('vocabulary#roast')).toMatchObject({
      key: 'roast',
      target: { collection: 'vocabulary' },
    });
    expect(parsePath('voice.secrets')).toBeNull();
    expect(parsePath('vocabulary#  ')).toBeNull();
    expect(valueAt(base(), 'vocabulary#  ROAST ')).toMatchObject({ term: 'Roast' });
    expect(valueAt(base(), 'messaging.positioning')).toBeUndefined();
    expect(pathLabel('vocabulary#roast')).toBe('Term "roast"');
  });

  it('adds, replaces and removes with provenance, creating containers as needed; the result is a valid document', () => {
    let doc = applyChange(base(), {
      path: 'messaging.positioning',
      op: 'add',
      value: 'The roastery that names its farms.',
    });
    expect(doc.messaging).toEqual({
      positioning: 'The roastery that names its farms.',
      valueProposition: '',
      pillars: [],
      keyMessages: [],
    });
    doc = applyChange(doc, {
      path: 'vocabulary#roast',
      op: 'replace',
      value: { term: 'Roast', usage: 'preferred', alternatives: ['batch'] },
      provenance: { origin: 'imported', suggestionId: 'bsug_1' },
    });
    expect(doc.vocabulary).toEqual([
      {
        term: 'Roast',
        usage: 'preferred',
        alternatives: ['batch'],
        provenance: { origin: 'imported', suggestionId: 'bsug_1' },
      },
    ]);
    doc = applyChange(doc, {
      path: 'writingPatterns.headline',
      op: 'add',
      value: { guidance: 'Benefit first.', dos: [], donts: [], examples: [] },
    });
    expect(doc.writingPatterns?.headline?.guidance).toBe('Benefit first.');
    doc = applyChange(doc, { path: 'vocabulary#ROAST', op: 'remove', value: null });
    expect(doc.vocabulary).toEqual([]);
    doc = applyChange(doc, { path: 'writingPatterns.headline', op: 'remove', value: null });
    expect(doc.writingPatterns).toEqual({});
  });

  it('refuses unknown paths, invalid values and facts (which never enter the document)', () => {
    expect(() => applyChange(base(), { path: 'x.y', op: 'add', value: 1 })).toThrow(SuggestionPathError);
    expect(() =>
      applyChange(base(), {
        path: 'vocabulary#a',
        op: 'add',
        value: { term: 'a', usage: 'sometimes', alternatives: [] },
      }),
    ).toThrow(/invalid_value/);
    expect(() =>
      applyChange(base(), {
        path: 'facts#Founded 2014',
        op: 'add',
        value: { statement: 'Founded 2014', category: 'company' },
      }),
    ).toThrow(/not_part_of_the_document/);
  });

  it('fingerprints fold case, spacing and provenance, so a rejected suggestion is recognised again', () => {
    const a = suggestionFingerprint({
      section: 'vocabulary',
      path: 'vocabulary#Roast',
      op: 'add',
      value: { term: 'Roast', usage: 'avoid', alternatives: [] },
    });
    const b = suggestionFingerprint({
      section: 'vocabulary',
      path: 'vocabulary#roast ',
      op: 'add',
      value: { term: ' roast', usage: 'avoid', alternatives: [], provenance: { origin: 'suggested' } },
    });
    const c = suggestionFingerprint({
      section: 'vocabulary',
      path: 'vocabulary#roast',
      op: 'add',
      value: { term: 'roast', usage: 'preferred', alternatives: [] },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(sameValue({ term: 'A', provenance: { origin: 'user' } }, { term: 'a' })).toBe(true);
  });

  it('describes values for people: no ids, no JSON', () => {
    expect(
      describeValue({
        key: 'p1',
        title: 'Traceable',
        statement: 'Every bag names its farm.',
        proofFactIds: ['fact_1'],
      }),
    ).toBe('key: p1 · title: Traceable · statement: Every bag names its farm.');
    expect(describeValue(['warm', 'direct'])).toBe('warm; direct');
  });
});

describe('document comparison (BSC-5 history)', () => {
  it('reports per section what was added, removed and changed; provenance alone is no change', () => {
    const before = base();
    const after = BrandSystemDocumentV1.parse({
      ...before,
      voice: {
        ...before.voice,
        summary: 'Warm and plain.',
        principles: [
          { statement: 'Say what it does', rationale: 'Fast readers.', provenance: { origin: 'suggested' } },
        ],
      },
      vocabulary: [{ term: 'blend', usage: 'avoid', alternatives: ['roast'] }],
      tokens: { ...before.tokens, colours: [{ key: 'ore-red', value: '#C0392B', role: 'primary' }] },
    });
    const diff = diffBrandDocuments(before, after);
    expect(diff.map((s) => s.label)).toEqual(['Colour', 'Voice & personality', 'Vocabulary']);
    expect(diff[1]!.changes).toEqual([
      { change: 'changed', item: 'Voice summary', before: 'Warm.', after: 'Warm and plain.' },
    ]);
    expect(diff[2]!.changes.map((c) => [c.change, c.item])).toEqual([
      ['removed', 'Term "Roast"'],
      ['added', 'Term "blend"'],
    ]);
    expect(changedSectionLabels(before, before)).toEqual([]);
  });
});
