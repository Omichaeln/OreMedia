import { describe, expect, it } from 'vitest';
import { ModelElementEdit } from '@oremedia/contracts/generation';
import { generationTool } from './generation-prompt';

interface ObjectSchema {
  properties: Record<string, ObjectSchema & { items?: ObjectSchema }>;
  required?: string[];
  items?: ObjectSchema;
}

describe('studio fill tool schema', () => {
  it('the edit JSON schema the model sees and the zod ModelElementEdit the server parses accept the same keys', () => {
    const input = generationTool(1).inputSchema as unknown as ObjectSchema;
    const edit = input.properties['variations']!.items!.properties['edits']!.items!;
    const shape = ModelElementEdit.shape;
    expect(Object.keys(edit.properties).sort()).toEqual(Object.keys(shape).sort());
    const requiredInZod = Object.entries(shape)
      .filter(([, field]) => !field.isOptional())
      .map(([key]) => key)
      .sort();
    expect([...(edit.required ?? [])].sort()).toEqual(requiredInZod);
  });
});
