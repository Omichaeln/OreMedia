import { describe, expect, it } from 'vitest';
import { briefFromValues } from './schema-fields';

const schema = {
  properties: {
    objective: { type: 'string', maxLength: 20 },
    channels: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    count: { type: 'integer', minimum: 1, maximum: 6 },
    startDate: { type: 'string', format: 'date' },
    evidence: { type: 'array', items: { type: 'object' } },
    live: { type: 'boolean' },
  },
  required: ['objective', 'channels'],
};

/** The brand copywriting and channel adaptation manifests' shapes: a nested object and an array of objects. */
const nested = {
  properties: {
    brief: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        keyMessages: { type: 'array', items: { type: 'string' } },
      },
      required: ['objective', 'keyMessages'],
    },
    channels: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        properties: {
          channelKey: { type: 'string' },
          capabilities: {
            type: 'object',
            properties: { maxTextLength: { type: 'integer' }, supportsLinks: { type: 'boolean' } },
          },
        },
        required: ['channelKey', 'capabilities'],
      },
    },
    tone: { type: 'string', maxLength: 200 },
  },
  required: ['brief', 'channels'],
};

describe('briefFromValues (UX-08 schema form)', () => {
  it('builds the brief the skill schema expects and names each field problem', () => {
    const ok = briefFromValues(schema, {
      objective: 'Spring launch',
      channels: 'x, linkedin\n',
      count: '3',
      startDate: '2026-10-01',
      live: 'false',
    });
    expect(ok.errors).toEqual({});
    expect(ok.brief).toEqual({
      objective: 'Spring launch',
      channels: ['x', 'linkedin'],
      count: 3,
      startDate: '2026-10-01',
      live: false,
    });
    const bad = briefFromValues(schema, {
      objective: 'x'.repeat(21),
      channels: 'a, b, c',
      count: '1.5',
    });
    expect(bad.errors).toEqual({
      objective: 'At most 20 characters.',
      channels: 'At most 2 items.',
      count: 'Enter an integer.',
    });
    expect(briefFromValues(schema, { count: '9' }).errors['count']).toBe('At most 6.');
    expect(briefFromValues(schema, {}).errors).toEqual({ objective: 'Required.', channels: 'Required.' });
    // Optional fields left empty are omitted, never sent as empty strings.
    expect(briefFromValues(schema, { objective: 'a', channels: 'x' }).brief).toEqual({
      objective: 'a',
      channels: ['x'],
    });
  });

  it('builds nested objects and rows of objects from fields, naming problems by dotted path (RA-07: never JSON)', () => {
    const ok = briefFromValues(nested, {
      brief: { objective: 'Sell the autumn offer', keyMessages: 'Free delivery\nTwo for one' },
      channels: [
        { channelKey: 'linkedin', capabilities: { maxTextLength: '3000', supportsLinks: 'true' } },
        { channelKey: 'x', capabilities: {} },
      ],
    });
    expect(ok.errors).toEqual({});
    expect(ok.brief).toEqual({
      brief: { objective: 'Sell the autumn offer', keyMessages: ['Free delivery', 'Two for one'] },
      channels: [
        { channelKey: 'linkedin', capabilities: { maxTextLength: 3000, supportsLinks: true } },
        { channelKey: 'x', capabilities: {} },
      ],
    });
    const bad = briefFromValues(nested, {
      brief: { objective: '' },
      channels: [{ channelKey: '', capabilities: { maxTextLength: 'many' } }],
    });
    expect(bad.errors).toEqual({
      'brief.objective': 'Required.',
      'brief.keyMessages': 'Required.',
      'channels.0.channelKey': 'Required.',
      'channels.0.capabilities.maxTextLength': 'Enter an integer.',
    });
    expect(briefFromValues(nested, {}).errors).toEqual({
      'brief.objective': 'Required.',
      'brief.keyMessages': 'Required.',
      channels: 'Required.',
    });
    // Three rows against maxItems 2 is named on the list itself.
    expect(
      briefFromValues(nested, {
        brief: { objective: 'a', keyMessages: 'b' },
        channels: [{ channelKey: 'a' }, { channelKey: 'b' }, { channelKey: 'c' }],
      }).errors['channels'],
    ).toBe('At most 2 items.');
  });
});
