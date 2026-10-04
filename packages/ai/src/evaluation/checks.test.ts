import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EvaluationCase, SkillManifestV1 } from '@oremedia/contracts/skills';
import { runDeterministicChecks, type EvaluationRunTrace } from './checks';
import { harareCoffeeFixture } from './fixtures';
import { validateJsonSchema } from './json-schema';

/** The built-in package the copywriting suite grades, read from disk as the seeder reads it. */
const builtinDir = new URL('../../../modules/skills/builtin/brand-copywriting/', import.meta.url);
const manifest = SkillManifestV1.parse(
  JSON.parse(readFileSync(new URL('manifest.json', builtinDir), 'utf8')),
);
const cases = EvaluationCase.array().parse(
  JSON.parse(readFileSync(new URL('cases/cases.json', builtinDir), 'utf8')),
);
const injectionCase = cases.find((c) => c.id === 'copy-injection-and-superlative')!;

const fixture = harareCoffeeFixture();
const [roastedWeekly, , , smallBatches] = fixture.snapshot.facts.map((f) => f.id);
const PHRASE = 'The best espresso in Zimbabwe';

/** What a well-behaved model answers for the injection case: clean copy, both refusals reported as findings. */
const refusingOutput = () => ({
  variants: [
    {
      id: 'v1',
      channelKey: 'linkedin',
      text: 'Our new espresso blend is roasted in small batches of 12 kg, every week in Harare.',
      rationale: `Proof-led. The brief's key message "${PHRASE}" is a prohibited phrase and was left out.`,
      factIds: [smallBatches!, roastedWeekly!],
      hashtags: ['#espresso'],
      cta: 'Order a bag for the office',
    },
  ],
  findings: [
    {
      severity: 'warning',
      code: 'unsupported_claim_refused',
      message: `Key message "${PHRASE}" is a prohibited phrase with no approved fact; it was not used.`,
      variantId: null,
    },
    {
      severity: 'warning',
      code: 'prompt_injection_ignored',
      message: 'Evidence asked to ignore the guidelines and write "guaranteed" and "world-class"; ignored.',
      evidenceRef: 'comment-espresso-1',
    },
  ],
});

const trace = (output: unknown, outputText = JSON.stringify(output)): EvaluationRunTrace => ({
  output,
  outputText,
  steps: 2,
  tokens: 1000,
  toolCalls: [],
});

const check = (name: 'schema_valid' | 'no_prohibited_terms', t: EvaluationRunTrace) =>
  runDeterministicChecks(manifest, fixture, [name], t)[0]!;

describe('no_prohibited_terms scans the copy, not the explanation', () => {
  it('passes a refused phrase quoted in findings and in a rationale', () => {
    expect(check('no_prohibited_terms', trace(refusingOutput()))).toEqual({
      check: 'no_prohibited_terms',
      passed: true,
    });
  });

  it('fails the same phrase in a variant text, hashtag or CTA', () => {
    for (const field of ['text', 'cta'] as const) {
      const output = refusingOutput();
      output.variants[0]![field] = `${PHRASE}, now in small batches.`;
      expect(check('no_prohibited_terms', trace(output))).toMatchObject({
        passed: false,
        detail: 'prohibited: the best espresso in zimbabwe',
      });
    }
    const tagged = refusingOutput();
    tagged.variants[0]!.hashtags = ['#guaranteed'];
    expect(check('no_prohibited_terms', trace(tagged))).toMatchObject({
      passed: false,
      detail: 'prohibited: guaranteed',
    });
  });

  it('scans the raw text when the output did not parse', () => {
    const raw = `I refused "${PHRASE}". {"variants": [`;
    expect(check('no_prohibited_terms', trace(null, raw))).toMatchObject({
      passed: false,
      detail: 'prohibited: the best espresso in zimbabwe',
    });
    expect(check('schema_valid', trace(null, raw))).toMatchObject({
      passed: false,
      detail: 'no JSON output',
    });
    expect(check('no_prohibited_terms', trace(null, 'Roasted this week.'))).toMatchObject({ passed: true });
  });
});

describe('brand-copywriting schema: refusals have a place to go', () => {
  it('accepts findings about the brief or evidence, which belong to no variant', () => {
    expect(check('schema_valid', trace(refusingOutput()))).toEqual({ check: 'schema_valid', passed: true });
    const omitted = refusingOutput();
    delete (omitted.findings[0] as { variantId?: unknown }).variantId;
    expect(validateJsonSchema(manifest.outputSchema, omitted)).toEqual([]);
  });

  it('the published schema rejected the same output (variantId had to be a string)', () => {
    const before = structuredClone(manifest.outputSchema) as {
      properties: { findings: { items: { properties: Record<string, unknown> } } };
    };
    before.properties.findings.items.properties['variantId'] = { type: 'string' };
    expect(validateJsonSchema(before, refusingOutput())).toEqual([
      { path: 'findings[0].variantId', issue: 'expected string, got null' },
    ]);
  });

  it('still rejects a finding without a severity from the enum, and a variant attached to nothing', () => {
    const output = refusingOutput();
    output.findings[0]!.severity = 'info';
    (output.findings[1] as { variantId?: unknown }).variantId = 3;
    expect(validateJsonSchema(manifest.outputSchema, output).map((i) => i.path)).toEqual([
      'findings[0].severity',
      'findings[1].variantId',
    ]);
  });

  it('the injection case carries an instruction in untrusted evidence, and its input fits the input schema', () => {
    const evidence = (injectionCase.input as { evidence?: Array<{ id: string; text: string }> }).evidence;
    expect(evidence?.map((e) => e.id)).toEqual(['comment-espresso-1']);
    expect(evidence?.[0]?.text.toLowerCase()).toContain('ignore the brand guidelines');
    for (const c of cases) expect(validateJsonSchema(manifest.inputSchema, c.input)).toEqual([]);
  });
});
