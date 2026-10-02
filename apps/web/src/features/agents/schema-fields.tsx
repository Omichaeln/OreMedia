import { Button, Field, Input, Textarea } from '@oremedia/ui';
import { Select } from '../../components/select';

/**
 * The subset of JSON Schema a skill's inputSchema uses (spec 10.1 manifests): objects of scalars, arrays of
 * scalars, nested objects and arrays of objects. Every shape renders as fields; nothing is typed as JSON.
 */
export interface SchemaProperty {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}
export interface ObjectSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

/** Typed form state: scalars and arrays of scalars as text, nested objects as objects, arrays of objects as rows. */
export type BriefValue = string | BriefObject | BriefObject[];
export interface BriefObject {
  [key: string]: BriefValue;
}
export type BriefValues = BriefObject;

const typeOf = (p: SchemaProperty): string =>
  Array.isArray(p.type) ? (p.type[0] ?? 'string') : (p.type ?? 'string');
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const singular = (name: string) => (name.endsWith('s') ? name.slice(0, -1) : name);
const isObject = (v: unknown): v is BriefObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const asText = (v: BriefValue | undefined): string => (typeof v === 'string' ? v : '');
const asObject = (v: BriefValue | undefined): BriefObject => (isObject(v) ? v : {});
const asRows = (v: BriefValue | undefined): BriefObject[] => (Array.isArray(v) ? v : []);

/** A nested object schema with named fields; an object without them has nothing a person can fill in. */
const hasFields = (
  p: SchemaProperty | undefined,
): p is SchemaProperty & { properties: Record<string, SchemaProperty> } =>
  p !== undefined && typeOf(p) === 'object' && p.properties !== undefined;
const isRowArray = (p: SchemaProperty) => typeOf(p) === 'array' && hasFields(p.items);
const isScalarArray = (p: SchemaProperty) =>
  typeOf(p) === 'array' && !hasFields(p.items) && typeOf(p.items ?? {}) !== 'object';

function scalar(p: SchemaProperty, raw: string, path: string, errors: Record<string, string>): unknown {
  const t = typeOf(p);
  if (t === 'number' || t === 'integer') {
    const n = Number(raw);
    if (Number.isNaN(n) || (t === 'integer' && !Number.isInteger(n))) {
      errors[path] = `Enter a${t === 'integer' ? 'n integer' : ' number'}.`;
      return undefined;
    }
    if (p.minimum !== undefined && n < p.minimum) errors[path] = `At least ${p.minimum}.`;
    else if (p.maximum !== undefined && n > p.maximum) errors[path] = `At most ${p.maximum}.`;
    return n;
  }
  if (t === 'boolean') return raw === 'true';
  if (p.maxLength !== undefined && raw.length > p.maxLength) {
    errors[path] = `At most ${p.maxLength} characters.`;
    return undefined;
  }
  return raw;
}

/**
 * Turns the typed values back into the object the skill's schema expects: numbers parsed, booleans read, arrays of
 * scalars split on newlines or commas, nested objects and rows built recursively. Returns the problems keyed by
 * dotted path (`brief.objective`, `channels.0.channelKey`) instead of throwing so the form shows each beside its
 * field. Optional shapes left empty are omitted, never sent as empty strings or objects.
 */
export function briefFromValues(
  schema: ObjectSchema,
  values: BriefValues,
  prefix = '',
): { brief: Record<string, unknown>; errors: Record<string, string> } {
  const brief: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, p] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${key}`;
    const value = values[key];
    if (hasFields(p)) {
      const built = briefFromValues(p, asObject(value), `${path}.`);
      Object.assign(errors, built.errors);
      if (Object.keys(built.brief).length > 0 || required.has(key)) brief[key] = built.brief;
      continue;
    }
    if (isRowArray(p)) {
      const rows = asRows(value);
      if (rows.length === 0) {
        if (required.has(key) || (p.minItems ?? 0) > 0) errors[path] = 'Required.';
        continue;
      }
      if (p.minItems !== undefined && rows.length < p.minItems)
        errors[path] = `At least ${p.minItems} item${p.minItems === 1 ? '' : 's'}.`;
      else if (p.maxItems !== undefined && rows.length > p.maxItems)
        errors[path] = `At most ${p.maxItems} items.`;
      brief[key] = rows.map((row, i) => {
        const built = briefFromValues(p.items as ObjectSchema, row, `${path}.${i}.`);
        Object.assign(errors, built.errors);
        return built.brief;
      });
      continue;
    }
    if (typeOf(p) === 'object' || (typeOf(p) === 'array' && !isScalarArray(p))) continue; // nothing to fill in
    const raw = asText(value).trim();
    if (raw === '') {
      if (required.has(key)) errors[path] = 'Required.';
      continue;
    }
    if (isScalarArray(p)) {
      const items = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (p.minItems !== undefined && items.length < p.minItems)
        errors[path] = `At least ${p.minItems} item${p.minItems === 1 ? '' : 's'}.`;
      else if (p.maxItems !== undefined && items.length > p.maxItems)
        errors[path] = `At most ${p.maxItems} items.`;
      else {
        const parsed = items.map((s) => scalar(p.items ?? {}, s, path, errors));
        if (!errors[path]) brief[key] = parsed;
      }
      continue;
    }
    const v = scalar(p, raw, path, errors);
    if (v !== undefined && !errors[path]) brief[key] = v;
  }
  return { brief, errors };
}

export interface SchemaFieldsProps {
  schema: ObjectSchema;
  values: BriefValues;
  /** Problems keyed by dotted path, as briefFromValues names them. */
  errors: Record<string, string>;
  onChange: (key: string, value: BriefValue) => void;
  idPrefix: string;
  /** The dotted path of this object inside the brief ('' at the top). */
  path?: string;
}

/**
 * One control per schema property, in schema order; required ones are marked and validated by briefFromValues.
 * A nested object is a group of fields, an array of objects a list of groups the person adds to and removes from.
 */
export function SchemaFields({ schema, values, errors, onChange, idPrefix, path = '' }: SchemaFieldsProps) {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0)
    return <p className="text-xs text-muted-foreground">This skill takes no brief fields.</p>;
  return (
    <>
      {entries.map(([key, p]) => {
        const id = `${idPrefix}-${key}`;
        const fieldPath = `${path}${key}`;
        const t = typeOf(p);
        const name = `${label(key)}${required.has(key) ? '' : ' (optional)'}`;
        const error = errors[fieldPath];
        if (hasFields(p)) {
          const sub = asObject(values[key]);
          return (
            <fieldset key={key} className="flex flex-col gap-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-medium text-muted-foreground">{name}</legend>
              {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
              <SchemaFields
                schema={p}
                values={sub}
                errors={errors}
                onChange={(k, v) => onChange(key, { ...sub, [k]: v })}
                idPrefix={id}
                path={`${fieldPath}.`}
              />
            </fieldset>
          );
        }
        if (isRowArray(p)) {
          const rows = asRows(values[key]);
          const rowSchema = p.items as ObjectSchema;
          const atMost = p.maxItems !== undefined && rows.length >= p.maxItems;
          return (
            <fieldset key={key} className="flex flex-col gap-3 rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-medium text-muted-foreground">{name}</legend>
              {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
              {rows.length === 0 && <p className="text-xs text-muted-foreground">None yet; add one below.</p>}
              {rows.map((row, i) => (
                <fieldset key={i} className="flex flex-col gap-3 rounded-md bg-muted p-3">
                  <legend className="px-1 text-xs font-medium">
                    {singular(label(key))} {i + 1}
                  </legend>
                  <SchemaFields
                    schema={rowSchema}
                    values={row}
                    errors={errors}
                    onChange={(k, v) =>
                      onChange(
                        key,
                        rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)),
                      )
                    }
                    idPrefix={`${id}-${i}`}
                    path={`${fieldPath}.${i}.`}
                  />
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        onChange(
                          key,
                          rows.filter((_, j) => j !== i),
                        )
                      }
                    >
                      Remove {singular(label(key)).toLowerCase()} {i + 1}
                    </Button>
                  </div>
                </fieldset>
              ))}
              {error && (
                <p id={`${id}-error`} role="alert" className="text-xs text-status-critical">
                  <span aria-hidden="true">! </span>
                  {error}
                </p>
              )}
              <div>
                <Button
                  type="button"
                  size="sm"
                  disabled={atMost}
                  disabledReason={atMost ? `At most ${p.maxItems} items` : undefined}
                  onClick={() => onChange(key, [...rows, {}])}
                >
                  Add {singular(label(key)).toLowerCase()}
                </Button>
              </div>
            </fieldset>
          );
        }
        if (t === 'object' || (t === 'array' && !isScalarArray(p)))
          return (
            <p key={key} className="text-xs text-muted-foreground">
              {label(key)} is filled in by the system, not here.
            </p>
          );
        const value = asText(values[key]);
        const set = (v: string) => onChange(key, v);
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
        if (t === 'array')
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
        if (t === 'number' || t === 'integer')
          return (
            <Field key={key} label={name} htmlFor={id} hint={p.description} error={error}>
              <Input
                id={id}
                type="number"
                min={p.minimum}
                max={p.maximum}
                step={t === 'integer' ? 1 : 'any'}
                value={value}
                onChange={(e) => set(e.target.value)}
              />
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
            <Input
              id={id}
              type={p.format === 'uri' ? 'url' : 'text'}
              value={value}
              onChange={(e) => set(e.target.value)}
            />
          </Field>
        );
      })}
    </>
  );
}
