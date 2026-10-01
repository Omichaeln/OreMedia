import { describe, expect, it } from 'vitest';
import { briefFromValues } from './schema-fields';

const schema = {
  properties: {
    objective: { type: 'string', maxLength: 20 },
    channels: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    count: { type: 'integer' },
    startDate: { type: 'string', format: 'date' },
    elements: { type: 'array', items: { type: 'object' } },
    live: { type: 'boolean' },
  },
  required: ['objective', 'channels'],
};

describe('briefFromValues (UX-08 schema form)', () => {
  it('builds the brief the skill schema expects and names each field problem', () => {
    const ok = briefFromValues(schema, {
      objective: 'Spring launch',
      channels: 'x, linkedin\n',
      count: '3',
      startDate: '2026-10-01',
      elements: '[{"id":"e1","type":"text"}]',
      live: 'false',
    });
    expect(ok.errors).toEqual({});
    expect(ok.brief).toEqual({
      objective: 'Spring launch',
      channels: ['x', 'linkedin'],
      count: 3,
      startDate: '2026-10-01',
      elements: [{ id: 'e1', type: 'text' }],
      live: false,
    });
    const bad = briefFromValues(schema, {
      objective: 'x'.repeat(21),
      channels: 'a, b, c',
      count: '1.5',
      elements: '{',
    });
    expect(bad.errors).toEqual({
      objective: 'At most 20 characters.',
      channels: 'At most 2 items.',
      count: 'Enter an integer.',
      elements: 'Not valid JSON.',
    });
    expect(briefFromValues(schema, {}).errors).toEqual({ objective: 'Required.', channels: 'Required.' });
    // Optional fields left empty are omitted, never sent as empty strings.
    expect(briefFromValues(schema, { objective: 'a', channels: 'x' }).brief).toEqual({
      objective: 'a',
      channels: ['x'],
    });
  });
});
