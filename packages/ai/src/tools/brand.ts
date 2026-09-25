import { z } from 'zod';
import { BrandSnapshotV1, BrandVoiceProposal, FactKind } from '@oremedia/contracts/brand';
import type { ToolDefinition } from '../tool-registry';

const FactRef = z.object({
  id: z.string(),
  kind: FactKind,
  statement: z.string(),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
});

const GetSnapshotInput = z.object({}).strict();
const FactsListInput = z.object({ kind: FactKind.optional() }).strict();

/** brand.getSnapshot: read, brand.read. The pinned snapshot of the run (the same bundle the resolver hashed). */
export const brandGetSnapshot: ToolDefinition<
  z.infer<typeof GetSnapshotInput>,
  z.infer<typeof BrandSnapshotV1>
> = {
  name: 'brand.getSnapshot',
  description:
    'Returns the approved brand system for this run: voice, tokens, logo rules, approved facts, objectives and policy.',
  input: GetSnapshotInput,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  output: BrandSnapshotV1,
  action: 'brand.read',
  effect: 'read',
  async run(_input, ctx) {
    if (ctx.snapshot) return ctx.snapshot.brand;
    return ctx.services.brand.resolveBrandSnapshot(ctx.actor, { brandId: ctx.run.brandId }, ctx.tx);
  },
};

/** facts.list: read, brand.read. Approved facts effective now, optionally by kind; claims must cite these ids. */
export const factsList: ToolDefinition<
  z.infer<typeof FactsListInput>,
  { facts: z.infer<typeof FactRef>[] }
> = {
  name: 'facts.list',
  description:
    'Lists the approved facts (products, claims, offers, prices, legal) the copy may state, by id.',
  input: FactsListInput,
  inputSchema: {
    type: 'object',
    properties: { kind: { type: 'string', enum: FactKind.options } },
    additionalProperties: false,
  },
  output: z.object({ facts: z.array(FactRef) }),
  action: 'brand.read',
  effect: 'read',
  async run(input, ctx) {
    const brand =
      ctx.snapshot?.brand ??
      (await ctx.services.brand.resolveBrandSnapshot(ctx.actor, { brandId: ctx.run.brandId }, ctx.tx));
    return { facts: brand.facts.filter((f) => !input.kind || f.kind === input.kind) };
  },
};

const str = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength });
const ProposeVoiceOutput = z.object({ versionId: z.string(), state: z.literal('proposed') });

/**
 * brand.proposeVoice: draft, brand.edit_standards. An onboarding run's proposal of the voice and vocabulary read
 * from the guidelines, written to the draft its run was started for (the brand module reads the target from the
 * run's brief, never from the model). A person reviews, edits and publishes; agents never publish (propose_only).
 */
export const brandProposeVoice: ToolDefinition<BrandVoiceProposal, z.infer<typeof ProposeVoiceOutput>> = {
  name: 'brand.proposeVoice',
  description:
    "Proposes the brand voice and vocabulary (summary, tone, audiences, preferred and avoided terms, prohibited phrases, locales, on/off-brand examples) into the draft this onboarding run was started for. Replaces the draft's voice once; a person reviews and publishes.",
  input: BrandVoiceProposal,
  inputSchema: {
    type: 'object',
    properties: {
      summary: str(2000),
      tone: { type: 'array', maxItems: 12, items: str(60, 1) },
      audiences: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: { key: str(60, 1), description: str(500) },
          required: ['key', 'description'],
          additionalProperties: false,
        },
      },
      preferredTerms: {
        type: 'array',
        maxItems: 60,
        items: {
          type: 'object',
          properties: { use: str(120, 1), avoid: { type: 'array', maxItems: 10, items: str(120, 1) } },
          required: ['use', 'avoid'],
          additionalProperties: false,
        },
      },
      prohibitedPhrases: { type: 'array', maxItems: 60, items: str(200, 1) },
      locales: { type: 'array', maxItems: 12, items: str(20, 2) },
      examples: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            text: str(1000, 1),
            verdict: { type: 'string', enum: ['on_brand', 'off_brand'] },
            note: str(500),
          },
          required: ['text', 'verdict', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'tone', 'audiences', 'preferredTerms', 'prohibitedPhrases', 'locales', 'examples'],
    additionalProperties: false,
  },
  output: ProposeVoiceOutput,
  action: 'brand.edit_standards',
  effect: 'draft',
  async run(input, ctx) {
    const written = await ctx.services.brand.proposeVoice(
      ctx.actor,
      { brandId: ctx.run.brandId, runId: ctx.run.runId, voice: input },
      ctx.tx,
      { autonomyMode: ctx.run.policy.autonomyMode },
    );
    return { versionId: written.versionId, state: 'proposed' as const };
  },
};
