import { describe, expect, it } from 'vitest';
import { BrandSystemDocumentV1, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import { factDedupeKey } from '@oremedia/domain/facts';
import { suggestionFingerprint } from '@oremedia/domain/brand-suggestions';
import {
  foldForMatch,
  parseSectionOutput,
  suggestionsFromOutput,
  supportsStatement,
  verifyEvidence,
  type ConvertContext,
  type SuggestionSource,
  shapeIssues,
} from './assist-suggestions';

const SRC: SuggestionSource = {
  id: 'bsrc_1',
  title: 'About us',
  url: 'https://ore.example/about',
  text: 'We roast single‑origin coffee. “Every bag names its farm.” Founded in 2014.',
};
const meta = (excerpts: string[], basis: 'stated' | 'inferred' | 'suggested' = 'stated') => ({
  rationale: 'Because.',
  basis,
  confidence: 'high' as const,
  evidence: excerpts.map((excerpt) => ({ sourceId: 'bsrc_1', excerpt })),
});
const doc = (): BrandSystemDocumentV1 =>
  BrandSystemDocumentV1.parse({
    ...emptyBrandSystemDocument(),
    voice: {
      ...emptyBrandSystemDocument().voice,
      principles: [
        { statement: 'Say what it does', rationale: 'People decide fast.', provenance: { origin: 'user' } },
        { statement: 'Be brief', rationale: 'Short.', provenance: { origin: 'suggested' } },
      ],
    },
    vocabulary: [{ term: 'roast', usage: 'preferred', alternatives: [] }],
  });
const ctx = (over: Partial<ConvertContext> = {}): ConvertContext => ({
  section: 'voice',
  current: doc(),
  sources: new Map([[SRC.id, SRC]]),
  preserve: new Set(),
  knownChannels: new Set(['linkedin_page']),
  liveFactKeys: new Set(),
  blocked: new Set(),
  ...over,
});
const voice = (over: Record<string, unknown>) =>
  parseSectionOutput('voice', {
    personality: [],
    principles: [],
    styleRules: [],
    claimRules: [],
    remove: [],
    questions: [],
    ...over,
  });

describe('evidence (BSC-4)', () => {
  it('a passage counts only when it is in the cited source, up to case, quotes, dashes and spacing', () => {
    expect(
      verifyEvidence(
        meta(['"every bag names its  farm."', 'single-origin coffee', 'grown on the moon']).evidence,
        new Map([[SRC.id, SRC]]),
      ),
    ).toEqual([
      { sourceId: 'bsrc_1', excerpt: '"every bag names its  farm."', verified: true },
      { sourceId: 'bsrc_1', excerpt: 'single-origin coffee', verified: true },
      { sourceId: 'bsrc_1', excerpt: 'grown on the moon', verified: false },
    ]);
    expect(
      verifyEvidence([{ sourceId: 'bsrc_other', excerpt: 'Founded in 2014.' }], new Map([[SRC.id, SRC]])),
    ).toEqual([]);
    expect(foldForMatch('A—B …')).toBe('a-b ...');
  });
});

describe('merge rules (BSC-4)', () => {
  it('stated with a verified passage is imported; without one it becomes a suggestion that says so', () => {
    const out = suggestionsFromOutput(
      voice({
        summary: { value: 'We roast single-origin coffee.', ...meta(['We roast single-origin coffee.']) },
        personality: [{ value: { trait: 'Bold' }, ...meta(['made-up passage']) }],
      }),
      ctx(),
    );
    expect(out.map((s) => [s.path, s.op, s.provenance.origin])).toEqual([
      ['voice.summary', 'add', 'imported'],
      ['voice.personality#Bold', 'add', 'suggested'],
    ]);
    expect(out[0]!.provenance.evidence).toEqual([
      { kind: 'url', ref: 'https://ore.example/about', note: 'We roast single-origin coffee.' },
    ]);
    expect(out[1]!.uncertainty).toBe('The passage it cites was not found in the sources.');
  });

  it('an inferred pattern from fewer than two passages is low confidence and says why', () => {
    const [one] = suggestionsFromOutput(
      voice({
        styleRules: [
          { value: { topic: 'numbers', rule: 'Use digits.' }, ...meta(['Founded in 2014.'], 'inferred') },
        ],
      }),
      ctx(),
    );
    expect(one!.provenance).toMatchObject({ origin: 'inferred', confidence: 'low' });
    const [two] = suggestionsFromOutput(
      voice({
        styleRules: [
          {
            value: { topic: 'numbers', rule: 'Use digits.' },
            ...meta(['Founded in 2014.', 'single-origin coffee'], 'inferred'),
          },
        ],
      }),
      ctx(),
    );
    expect(two!.provenance).toMatchObject({ origin: 'inferred', confidence: 'high' });
  });

  it('a person’s item is suggested against (flagged), never changed silently; the same value is no suggestion', () => {
    const out = suggestionsFromOutput(
      voice({
        principles: [
          { value: { statement: 'say what it does', rationale: 'Rewritten.' }, ...meta([], 'suggested') },
          { value: { statement: 'Be brief', rationale: 'Short.' }, ...meta([], 'suggested') },
        ],
      }),
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'voice.principles#say what it does',
      op: 'replace',
      againstUserItem: true,
    });
    expect(out[0]!.conflicts.at(-1)!.note).toContain('A person wrote');
  });

  it('preserved items are neither changed nor removed; removals name an existing item of the section', () => {
    const out = suggestionsFromOutput(
      voice({
        principles: [{ value: { statement: 'Be brief', rationale: 'Shorter.' }, ...meta([], 'suggested') }],
        remove: [
          { collection: 'voice.principles', key: 'Say what it does', ...meta([], 'suggested') },
          { collection: 'voice.principles', key: 'Not there', ...meta([], 'suggested') },
          { collection: 'vocabulary', key: 'roast', ...meta([], 'suggested') },
        ],
      }),
      ctx({ preserve: new Set(['voice.principles#be brief']) }),
    );
    expect(out.map((s) => [s.path, s.op])).toEqual([['voice.principles#Say what it does', 'remove']]);
  });

  it('rejected (blocked) fingerprints are not suggested again', () => {
    const value = { trait: 'Bold' };
    const fp = suggestionFingerprint({ section: 'voice', path: 'voice.personality#bold', op: 'add', value });
    expect(
      suggestionsFromOutput(
        voice({ personality: [{ value, ...meta([], 'suggested') }] }),
        ctx({ blocked: new Set([fp]) }),
      ),
    ).toEqual([]);
  });

  it('unknown channels are dropped, new channel entries get their required defaults, template channels are filtered', () => {
    const channels = parseSectionOutput('channels', {
      baseline: [],
      channels: [
        { providerKey: 'linkedin_page', value: { captionStyle: 'Plural.' }, ...meta([], 'suggested') },
        { providerKey: 'myspace', value: { captionStyle: 'Retro.' }, ...meta([], 'suggested') },
      ],
      questions: [],
    });
    const out = suggestionsFromOutput(channels, ctx({ section: 'channels' }));
    expect(out.map((s) => s.value)).toEqual([
      { providerKey: 'linkedin_page', captionStyle: 'Plural.', preferredFormats: [], ctaConventions: '' },
    ]);
  });

  it('facts the brand already holds are not suggested; an unsourced fact is a suggestion only', () => {
    const facts = parseSectionOutput('facts', {
      facts: [
        { statement: 'Founded in 2014.', category: 'company', ...meta(['Founded in 2014.']) },
        { statement: 'Best coffee in Leeds.', category: 'claim', ...meta([], 'suggested') },
      ],
      questions: [],
    });
    const out = suggestionsFromOutput(
      facts,
      ctx({ section: 'facts', liveFactKeys: new Set([factDedupeKey('founded in 2014')]) }),
    );
    expect(out.map((s) => [s.path, s.provenance.origin])).toEqual([
      ['facts#Best coffee in Leeds.', 'suggested'],
    ]);
  });

  it('a fact counts as stated only when its passage says it: long enough, figures and names verbatim, most words', () => {
    expect(supportsStatement('Founded in 2014.', 'We were founded in 2014 by two baristas.')).toBe(true);
    expect(supportsStatement('Founded in 2014.', 'Founded in 2014.')).toBe(false); // too short to carry it alone
    expect(supportsStatement('Founded in 2015.', 'We were founded in 2014 by two baristas.')).toBe(false);
    expect(
      supportsStatement('A bag costs £4.50.', 'Every bag of our house roast costs £4.95 in the shop.'),
    ).toBe(false);
    expect(
      supportsStatement('Roasted in Leeds by Ore.', 'Roasted in York by a small team of roasters.'),
    ).toBe(false);
    expect(
      supportsStatement(
        'Every bag names its farm and roast date.',
        'Our coffee is good and we like it a lot here.',
      ),
    ).toBe(false);
    expect(
      supportsStatement('Every bag names its farm.', 'It is true that every single bag names its farm.'),
    ).toBe(true);
  });

  it('a stated fact whose found passage does not state it is downgraded to a suggestion, and says why', () => {
    const source: SuggestionSource = {
      ...SRC,
      text: 'We roast single-origin coffee in small batches every Tuesday in our Leeds roastery.',
    };
    const facts = parseSectionOutput('facts', {
      facts: [
        {
          statement: 'Founded in 2014.',
          category: 'company',
          ...meta(['We roast single-origin coffee in small batches every Tuesday']),
        },
        {
          statement: 'Roasts coffee in small batches every Tuesday.',
          category: 'company',
          ...meta(['We roast single-origin coffee in small batches every Tuesday']),
        },
      ],
      questions: [],
    });
    const out = suggestionsFromOutput(
      facts,
      ctx({ section: 'facts', sources: new Map([[source.id, source]]) }),
    );
    expect(out.map((s) => [s.path, s.provenance.origin, s.uncertainty])).toEqual([
      ['facts#Founded in 2014.', 'suggested', 'The cited passage does not state this fact.'],
      ['facts#Roasts coffee in small batches every Tuesday.', 'imported', null],
    ]);
  });

  it('the strict schema refuses anything else (extra fields, wrong enums) rather than repairing it', () => {
    expect(() =>
      parseSectionOutput('vocabulary', { terms: [], remove: [], questions: [], note: 'hi' }),
    ).toThrow();
    expect(() =>
      parseSectionOutput('vocabulary', {
        terms: [{ value: { term: 'x', usage: 'sometimes', alternatives: [] }, ...meta([]) }],
        remove: [],
        questions: [],
      }),
    ).toThrow();
  });
});

describe('shapeIssues', () => {
  it('names where an answer left the schema (paths and codes only, never the model’s text); the schema stays strict', () => {
    // What a model wrote for spelling when the voice example did not show the field: a bare string value.
    const answer = {
      personality: [],
      principles: [],
      spelling: { value: 'en-GB', rationale: 'r', basis: 'stated', confidence: 'high', evidence: [] },
      styleRules: [],
      claimRules: [],
      remove: [],
      questions: [],
      uncertainty: 'SECRET-ish model prose',
    };
    let caught: unknown;
    try {
      parseSectionOutput('voice', answer);
    } catch (err) {
      caught = err;
    }
    const issues = shapeIssues(caught);
    expect(issues).toEqual(
      expect.arrayContaining(['spelling.value: invalid_type', '(answer): unrecognized_keys']),
    );
    expect(issues.join(' ')).not.toContain('SECRET');
    expect(shapeIssues(new Error('invalid_json'))).toEqual(['invalid_json']);
  });
});
