import { Field, Input, Textarea } from '@oremedia/ui';
import { Select } from '../../components/select';

/** The subset of JSON Schema a skill's inputSchema uses (spec 10.1 manifests): objects of scalars, arrays of strings. */
export interface SchemaProperty {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  items?: { type?: string };
}
export interface ObjectSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export type BriefValues = Record<string, string>;

const typeOf = (p: SchemaProperty): string =>
  Array.isArray(p.type) ? (p.type[0] ?? 'string') : (p.type ?? 'string');
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Turns the typed values back into the object the skill's schema expects: numbers parsed, booleans read, arrays of
 * strings split on newlines or commas, nested shapes taken as typed JSON. Returns the field-level problems instead
 * of throwing so the form can show them beside the field.
 */
export function briefFromValues(
  schema: ObjectSchema,
  values: BriefValues,
): { brief: Record<string, unknown>; errors: Record<string, string> } {
  const brief: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, p] of Object.entries(schema.properties ?? {})) {
    const raw = (values[key] ?? '').trim();
    if (raw === '') {
      if (required.has(key)) errors[key] = 'Required.';
      continue;
    }
    const t = typeOf(p);
    if (t === 'number' || t === 'integer') {
      const n = Number(raw);
      if (Number.isNaN(n) || (t === 'integer' && !Number.isInteger(n)))
        errors[key] = `Enter a${t === 'integer' ? 'n integer' : ' number'}.`;
      else brief[key] = n;
    } else if (t === 'boolean') brief[key] = raw === 'true';
    else if (t === 'array' && (p.items?.type ?? 'string') === 'string') {
      const items = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (p.minItems !== undefined && items.length < p.minItems)
        errors[key] = `At least ${p.minItems} item${p.minItems === 1 ? '' : 's'}.`;
      else if (p.maxItems !== undefined && items.length > p.maxItems)
        errors[key] = `At most ${p.maxItems} items.`;
      else brief[key] = items;
    } else if (t === 'array' || t === 'object') {
      try {
        brief[key] = JSON.parse(raw);
      } catch {
        errors[key] = 'Not valid JSON.';
      }
    } else {
      if (p.maxLength !== undefined && raw.length > p.maxLength)
        errors[key] = `At most ${p.maxLength} characters.`;
      else brief[key] = raw;
    }
  }
  return { brief, errors };
}

/** One control per schema property, in schema order; required ones are marked and validated by briefFromValues. */
export function SchemaFields({
  schema,
  values,
  errors,
  onChange,
  idPrefix,
}: {
  schema: ObjectSchema;
  values: BriefValues;
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
  idPrefix: string;
}) {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0)
    return <p className="text-xs text-muted-foreground">This skill takes no brief fields.</p>;
  return (
    <>
      {entries.map(([key, p]) => {
        const id = `${idPrefix}-${key}`;
        const t = typeOf(p);
        const name = `${label(key)}${required.has(key) ? '' : ' (optional)'}`;
        const value = values[key] ?? '';
        const set = (v: string) => onChange(key, v);
        const error = errors[key];
        if (p.enum)
          return (
            <Field key={key} label={name} htmlFor={id} hint={p.description} error={error}>
              <Select
                id={id}
                value={value}
                onValueChange={set}
                placeholder="Choose"
                options={p.enum.map((v) => ({ value: String(v), label: String(v) }))}
              />
            </Field>
          );
        if (t === 'boolean')
          return (
            <Field key={key} label={name} htmlFor={id} hint={p.description} error={error}>
              <Select
                id={id}
                value={value}
                onValueChange={set}
                placeholder="Choose"
                options={[
                  { value: 'true', label: 'Yes' },
                  { value: 'false', label: 'No' },
                ]}
              />
            </Field>
          );
        if (t === 'array' && (p.items?.type ?? 'string') === 'string')
          return (
            <Field
              key={key}
              label={name}
              htmlFor={id}
              hint={p.description ?? 'One per line (or comma separated).'}
              error={error}
            >
              <Textarea id={id} value={value} onChange={(e) => set(e.target.value)} rows={3} />
            </Field>
          );
        if (t === 'array' || t === 'object')
          return (
            <Field key={key} label={name} htmlFor={id} hint={p.description ?? 'JSON.'} error={error}>
              <Textarea
                id={id}
                value={value}
                onChange={(e) => set(e.target.value)}
                rows={4}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
          );
        if (t === 'number' || t === 'integer')
          return (
            <Field key={key} label={name} htmlFor={id} hint={p.description} error={error}>
              <Input id={id} type="number" value={value} onChange={(e) => set(e.target.value)} />
            </Field>
          );
        if (p.format === 'date' || p.format === 'date-time')
          return (
            <Field key={key} label={name} htmlFor={id} hint={p.description} error={error}>
              <Input
                id={id}
                type={p.format === 'date' ? 'date' : 'datetime-local'}
                value={value}
                onChange={(e) => set(e.target.value)}
              />
            </Field>
          );
        if ((p.maxLength ?? 0) > 200)
          return (
            <Field key={key} label={name} htmlFor={id} hint={p.description} error={error}>
              <Textarea id={id} value={value} onChange={(e) => set(e.target.value)} rows={3} />
            </Field>
          );
        return (
          <Field key={key} label={name} htmlFor={id} hint={p.description} error={error}>
            <Input id={id} value={value} onChange={(e) => set(e.target.value)} />
          </Field>
        );
      })}
    </>
  );
}
