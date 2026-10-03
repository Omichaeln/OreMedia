import { z } from 'zod';
import {
  BrandSystemDocumentV1,
  ChannelBaseline,
  CopyTemplate,
  FactCategory,
  KeyMessage,
  MessagingPillar,
  VocabularyTerm,
  VoiceClaimRule,
  VoicePersonalityTrait,
  VoicePrinciple,
  VoiceSpelling,
  VoiceStyleRule,
  WRITING_PARTS,
  WritingPattern,
  type GuidanceProvenance,
} from '@oremedia/contracts/brand';
import type {
  AssistSection,
  DocumentChangeV1,
  DocumentSectionDiffV1,
  SuggestionOp,
} from '@oremedia/contracts/brand-assist';
import { hashCanonical } from './hash';
import { normaliseFactStatement } from './facts';

/**
 * BSC-4 / BSC-5: where a suggestion lands in the brand system document and how it is applied, compared and undone.
 * A path is a scalar field (`voice.summary`, `writingPatterns.headline`, `channelBaseline.cta`) or an item of a keyed
 * list (`vocabulary#roast`: the collection, `#`, the item's key as written). Keys compare case- and space-insensitively.
 * `facts#<statement>` is virtual: a fact suggestion becomes a proposed fact, never part of the document. Pure: no I/O.
 */

type Doc = BrandSystemDocumentV1;
type Voice = Doc['voice'];
const docShape = BrandSystemDocumentV1.shape;
const AudienceItem = docShape.voice.shape.audiences.element.omit({ provenance: true });
const ExampleItem = docShape.voice.shape.examples.element.omit({ provenance: true });
const ChannelEntry = docShape.channelGuidance.element.omit({ provenance: true });
export const FactSuggestionValue = z
  .object({
    statement: z.string().min(1).max(1000),
    category: FactCategory,
    scope: z.string().max(200).optional(),
  })
  .strict();
export type FactSuggestionValue = z.infer<typeof FactSuggestionValue>;

const noProvenance = <T extends z.AnyZodObject>(s: T) => s.omit({ provenance: true });

interface TargetBase {
  section: AssistSection;
  /** What the item is, in words, for people. */
  label: string;
  schema: z.ZodTypeAny;
}
export interface ScalarTarget extends TargetBase {
  kind: 'scalar';
  path: string;
  get(doc: Doc): unknown;
  /** Writes the value (undefined removes it). */
  set(doc: Doc, value: unknown): Doc;
}
export interface KeyedTarget extends TargetBase {
  kind: 'keyed';
  collection: string;
  keyOf(item: Record<string, unknown>): string;
  list(doc: Doc): Array<Record<string, unknown>>;
  setList(doc: Doc, items: Array<Record<string, unknown>>): Doc;
  /** Items carry provenance (every guidance list item does; facts do not live in the document). */
  virtual?: boolean;
}
export type SuggestionTarget = ScalarTarget | KeyedTarget;

const emptyMessaging = (): NonNullable<Doc['messaging']> => ({
  positioning: '',
  valueProposition: '',
  pillars: [],
  keyMessages: [],
});
const voiceList =
  <K extends keyof Voice>(key: K) =>
  (doc: Doc) =>
    ((doc.voice[key] as unknown as Array<Record<string, unknown>> | undefined) ?? []).slice();
const setVoice = (doc: Doc, patch: Partial<Voice>): Doc => ({ ...doc, voice: { ...doc.voice, ...patch } });
const setMessaging = (doc: Doc, patch: Partial<NonNullable<Doc['messaging']>>): Doc => ({
  ...doc,
  messaging: { ...(doc.messaging ?? emptyMessaging()), ...patch },
});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const keyed = (t: Omit<KeyedTarget, 'kind'>): KeyedTarget => ({ kind: 'keyed', ...t });
const scalar = (t: Omit<ScalarTarget, 'kind'>): ScalarTarget => ({ kind: 'scalar', ...t });

const KEYED: KeyedTarget[] = [
  keyed({
    section: 'voice',
    collection: 'voice.personality',
    label: 'Personality trait',
    schema: noProvenance(VoicePersonalityTrait),
    keyOf: (i) => str(i['trait']),
    list: voiceList('personality'),
    setList: (d, items) => setVoice(d, { personality: items as Voice['personality'] }),
  }),
  keyed({
    section: 'voice',
    collection: 'voice.principles',
    label: 'Principle',
    schema: noProvenance(VoicePrinciple),
    keyOf: (i) => str(i['statement']),
    list: voiceList('principles'),
    setList: (d, items) => setVoice(d, { principles: items as Voice['principles'] }),
  }),
  keyed({
    section: 'voice',
    collection: 'voice.styleRules',
    label: 'Style rule',
    schema: noProvenance(VoiceStyleRule),
    keyOf: (i) => str(i['rule']),
    list: voiceList('styleRules'),
    setList: (d, items) => setVoice(d, { styleRules: items as Voice['styleRules'] }),
  }),
  keyed({
    section: 'voice',
    collection: 'voice.claimRules',
    label: 'Claim rule',
    schema: noProvenance(VoiceClaimRule),
    keyOf: (i) => str(i['rule']),
    list: voiceList('claimRules'),
    setList: (d, items) => setVoice(d, { claimRules: items as Voice['claimRules'] }),
  }),
  keyed({
    section: 'messaging',
    collection: 'voice.audiences',
    label: 'Audience',
    schema: AudienceItem,
    keyOf: (i) => str(i['key']),
    list: voiceList('audiences'),
    setList: (d, items) => setVoice(d, { audiences: items as Voice['audiences'] }),
  }),
  keyed({
    section: 'messaging',
    collection: 'messaging.pillars',
    label: 'Messaging pillar',
    schema: noProvenance(MessagingPillar),
    keyOf: (i) => str(i['key']),
    list: (d) => (d.messaging?.pillars ?? []).slice() as Array<Record<string, unknown>>,
    setList: (d, items) => setMessaging(d, { pillars: items as NonNullable<Doc['messaging']>['pillars'] }),
  }),
  keyed({
    section: 'messaging',
    collection: 'messaging.keyMessages',
    label: 'Key message',
    schema: noProvenance(KeyMessage),
    keyOf: (i) => str(i['text']),
    list: (d) => (d.messaging?.keyMessages ?? []).slice() as Array<Record<string, unknown>>,
    setList: (d, items) =>
      setMessaging(d, { keyMessages: items as NonNullable<Doc['messaging']>['keyMessages'] }),
  }),
  keyed({
    section: 'vocabulary',
    collection: 'vocabulary',
    label: 'Term',
    schema: noProvenance(VocabularyTerm),
    keyOf: (i) => str(i['term']),
    list: (d) => (d.vocabulary ?? []).slice() as Array<Record<string, unknown>>,
    setList: (d, items) => ({ ...d, vocabulary: items as Doc['vocabulary'] }),
  }),
  keyed({
    section: 'examples',
    collection: 'voice.examples',
    label: 'Example',
    schema: ExampleItem,
    keyOf: (i) => str(i['text']),
    list: voiceList('examples'),
    setList: (d, items) => setVoice(d, { examples: items as Voice['examples'] }),
  }),
  keyed({
    section: 'templates',
    collection: 'copyTemplates',
    label: 'Copy template',
    schema: noProvenance(CopyTemplate),
    keyOf: (i) => str(i['key']),
    list: (d) => (d.copyTemplates ?? []).slice() as Array<Record<string, unknown>>,
    setList: (d, items) => ({ ...d, copyTemplates: items as Doc['copyTemplates'] }),
  }),
  keyed({
    section: 'channels',
    collection: 'channelGuidance',
    label: 'Channel guidance',
    schema: ChannelEntry,
    keyOf: (i) => str(i['providerKey']),
    list: (d) => d.channelGuidance.slice() as Array<Record<string, unknown>>,
    setList: (d, items) => ({ ...d, channelGuidance: items as Doc['channelGuidance'] }),
  }),
  keyed({
    section: 'facts',
    collection: 'facts',
    label: 'Fact',
    schema: FactSuggestionValue,
    keyOf: (i) => str(i['statement']),
    list: () => [],
    setList: (d) => d,
    virtual: true,
  }),
];

const SCALARS: ScalarTarget[] = [
  scalar({
    section: 'voice',
    path: 'voice.summary',
    label: 'Voice summary',
    schema: z.string().max(2000),
    get: (d) => d.voice.summary || undefined,
    set: (d, v) => setVoice(d, { summary: (v as string | undefined) ?? '' }),
  }),
  scalar({
    section: 'voice',
    path: 'voice.tone',
    label: 'Tone',
    schema: z.array(z.string().min(1).max(60)).max(12),
    get: (d) => (d.voice.tone.length ? d.voice.tone : undefined),
    set: (d, v) => setVoice(d, { tone: (v as string[] | undefined) ?? [] }),
  }),
  scalar({
    section: 'voice',
    path: 'voice.spelling',
    label: 'Spelling',
    schema: VoiceSpelling,
    get: (d) => d.voice.spelling,
    set: (d, v) => {
      const { spelling: _drop, ...voice } = d.voice;
      return { ...d, voice: v === undefined ? voice : { ...voice, spelling: v as Voice['spelling'] } };
    },
  }),
  scalar({
    section: 'messaging',
    path: 'messaging.positioning',
    label: 'Positioning',
    schema: z.string().max(2000),
    get: (d) => d.messaging?.positioning || undefined,
    set: (d, v) => setMessaging(d, { positioning: (v as string | undefined) ?? '' }),
  }),
  scalar({
    section: 'messaging',
    path: 'messaging.valueProposition',
    label: 'Value proposition',
    schema: z.string().max(2000),
    get: (d) => d.messaging?.valueProposition || undefined,
    set: (d, v) => setMessaging(d, { valueProposition: (v as string | undefined) ?? '' }),
  }),
  ...WRITING_PARTS.map((part) =>
    scalar({
      section: 'writing',
      path: `writingPatterns.${part}`,
      label: `Writing pattern: ${part.replace('_', ' ')}`,
      schema: noProvenance(WritingPattern),
      get: (d) => d.writingPatterns?.[part],
      set: (d, v) => {
        const { [part]: _drop, ...rest } = d.writingPatterns ?? {};
        return { ...d, writingPatterns: v === undefined ? rest : { ...rest, [part]: v as WritingPattern } };
      },
    }),
  ),
  ...(Object.keys(ChannelBaseline.shape) as Array<keyof ChannelBaseline>).map((field) =>
    scalar({
      section: 'channels',
      path: `channelBaseline.${field}`,
      label: `Channel default: ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}`,
      schema: z.string().max(1000),
      get: (d) => d.channelBaseline?.[field] || undefined,
      set: (d, v) => {
        const { [field]: _drop, ...rest } = d.channelBaseline ?? {};
        return { ...d, channelBaseline: v === undefined ? rest : { ...rest, [field]: v as string } };
      },
    }),
  ),
];

export const SUGGESTION_TARGETS: readonly SuggestionTarget[] = [...SCALARS, ...KEYED];
const scalarByPath = new Map(SCALARS.map((t) => [t.path, t]));
const keyedByCollection = new Map(KEYED.map((t) => [t.collection, t]));

/** The collections a section's model output may remove items from. */
export const removableCollections = (section: AssistSection): string[] =>
  KEYED.filter((t) => t.section === section && !t.virtual).map((t) => t.collection);

/** A key as it compares: Unicode-folded, case-insensitive, spacing collapsed (a fact: its normalised statement). */
export const normaliseKey = (key: string): string =>
  key.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

export interface ParsedPath {
  target: SuggestionTarget;
  key: string | null;
}

export const itemPath = (collection: string, key: string): string => `${collection}#${key}`;

/** The target a path names, or null for a path no target knows (refused wherever a path arrives). */
export function parsePath(path: string): ParsedPath | null {
  const hash = path.indexOf('#');
  if (hash < 0) {
    const t = scalarByPath.get(path);
    return t ? { target: t, key: null } : null;
  }
  const t = keyedByCollection.get(path.slice(0, hash));
  const key = path.slice(hash + 1);
  return t && key.trim() ? { target: t, key } : null;
}

const matches = (t: KeyedTarget, key: string) => {
  const k = t.collection === 'facts' ? normaliseFactStatement(key) : normaliseKey(key);
  return (item: Record<string, unknown>) =>
    (t.collection === 'facts' ? normaliseFactStatement(t.keyOf(item)) : normaliseKey(t.keyOf(item))) === k;
};

/** The value at a path (an item without its provenance, a scalar), or undefined when there is none. */
export function valueAt(doc: Doc, path: string): unknown {
  const p = parsePath(path);
  if (!p) return undefined;
  if (p.target.kind === 'scalar') return p.target.get(doc);
  const item = p.target.list(doc).find(matches(p.target, p.key as string));
  return item;
}

/** The provenance of the item or field at a path, when it has one. */
export function provenanceAt(doc: Doc, path: string): GuidanceProvenance | undefined {
  const v = valueAt(doc, path);
  return v && typeof v === 'object' && 'provenance' in v
    ? ((v as { provenance?: GuidanceProvenance }).provenance ?? undefined)
    : undefined;
}

export const stripProvenance = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { provenance: _p, ...rest } = value as Record<string, unknown>;
  return rest;
};

export class SuggestionPathError extends Error {
  constructor(
    readonly path: string,
    readonly issue: string,
  ) {
    super(`${issue}: ${path}`);
    this.name = 'SuggestionPathError';
  }
}

/**
 * Applies one change to a document: `add`/`replace` write the value (an item takes `provenance`; a scalar object such
 * as a writing pattern does too), `remove` drops it. Writing `undefined` restores "absent" (undo of an add). The value
 * is checked against the target's schema; the result is parsed as a document, so a bad value never escapes.
 */
export function applyChange(
  doc: Doc,
  change: { path: string; op: SuggestionOp; value: unknown; provenance?: GuidanceProvenance },
): Doc {
  const p = parsePath(change.path);
  if (!p) throw new SuggestionPathError(change.path, 'unknown_path');
  if (p.target.kind === 'keyed' && p.target.virtual)
    throw new SuggestionPathError(change.path, 'not_part_of_the_document');
  const removing = change.op === 'remove' || change.value === undefined || change.value === null;
  let value: unknown;
  if (!removing) {
    const parsed = p.target.schema.safeParse(stripProvenance(change.value));
    if (!parsed.success) throw new SuggestionPathError(change.path, 'invalid_value');
    value = parsed.data;
    if (change.provenance && value && typeof value === 'object' && !Array.isArray(value))
      value = { ...(value as object), provenance: change.provenance };
  }
  let next: Doc;
  if (p.target.kind === 'scalar') next = p.target.set(doc, removing ? undefined : value);
  else {
    const t = p.target;
    const items = t.list(doc);
    const at = items.findIndex(matches(t, p.key as string));
    if (removing) {
      if (at >= 0) items.splice(at, 1);
    } else if (at >= 0) items[at] = value as Record<string, unknown>;
    else items.push(value as Record<string, unknown>);
    next = t.setList(doc, items);
  }
  const parsed = BrandSystemDocumentV1.safeParse(next);
  if (!parsed.success) throw new SuggestionPathError(change.path, 'document_limit');
  return parsed.data;
}

/** Strings folded for comparison: Unicode, case, spacing; provenance dropped; object keys sorted by hashCanonical. */
function folded(value: unknown): unknown {
  if (typeof value === 'string') return normaliseKey(value);
  if (Array.isArray(value)) return value.map(folded);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k, v]) => k !== 'provenance' && v !== undefined)
        .map(([k, v]) => [k, folded(v)]),
    );
  return value;
}

/** Whether two values say the same thing (same text up to case and spacing, provenance aside). */
export const sameValue = (a: unknown, b: unknown): boolean =>
  hashCanonical(folded(a) ?? null) === hashCanonical(folded(b) ?? null);

/**
 * The identity of a suggestion: section, path, op and value, folded. A rejected fingerprint is never suggested again;
 * the same suggestion from a later import or regeneration has the same fingerprint.
 */
export function suggestionFingerprint(s: {
  section: AssistSection;
  path: string;
  op: SuggestionOp;
  value: unknown;
}): string {
  const p = parsePath(s.path);
  const path =
    p?.target.kind === 'keyed'
      ? `${p.target.collection}#${p.target.collection === 'facts' ? normaliseFactStatement(p.key ?? '') : normaliseKey(p.key ?? '')}`
      : s.path;
  return hashCanonical({
    section: s.section,
    path,
    op: s.op,
    value: folded(s.op === 'remove' ? null : s.value) ?? null,
  });
}

// ---- readable text (diffs, history, the suggestion list): no ids, no JSON ----

const HIDDEN_FIELDS = new Set([
  'provenance',
  'assetId',
  'assetVersionId',
  'fontAssetId',
  'exampleAssetIds',
  'templateVersionIds',
  'proofFactIds',
]);
const words = (key: string) =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .toLowerCase();

/** A value as one line of text for people: strings as they are, lists joined, objects as "field: value" pairs. */
export function describeValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(describeValue).filter(Boolean).join('; ');
  if (typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .filter(
        ([k, v]) => !HIDDEN_FIELDS.has(k) && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length),
      )
      .map(([k, v]) => {
        const text = describeValue(v);
        return Array.isArray(v) && v.some((x) => x && typeof x === 'object')
          ? `${words(k)}: [${text}]`
          : `${words(k)}: ${text}`;
      })
      .join(' · ');
  return '';
}

/** What a path's item is, in words, with its key ("Term \"roast\""). */
export function pathLabel(path: string): string {
  const p = parsePath(path);
  if (!p) return path;
  if (p.target.kind === 'scalar') return p.target.label;
  const key = (p.key ?? '').length > 60 ? `${(p.key ?? '').slice(0, 57)}…` : p.key;
  return `${p.target.label} "${key}"`;
}

// ---- document comparison (history compare, what changed per applied version) ----

interface DiffSection {
  section: string;
  label: string;
  scalars: Array<{ item: string; get: (d: Doc) => unknown }>;
  lists: Array<{
    item: string;
    get: (d: Doc) => ReadonlyArray<Record<string, unknown>>;
    keyOf: (i: Record<string, unknown>) => string;
  }>;
}

const list =
  <T>(get: (d: Doc) => readonly T[] | undefined) =>
  (d: Doc) =>
    (get(d) ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;

/** The sections a comparison reports, in the Brand System's order, with the labels the screen uses. */
const DIFF_SECTIONS: DiffSection[] = [
  {
    section: 'logo',
    label: 'Logo',
    scalars: [],
    lists: [{ item: 'Logo', get: list((d) => d.logoRules), keyOf: (i) => str(i['variant']) }],
  },
  {
    section: 'colour',
    label: 'Colour',
    scalars: [{ item: 'Contrast target', get: (d) => d.tokens.contrastTarget }],
    lists: [{ item: 'Colour', get: list((d) => d.tokens.colours), keyOf: (i) => str(i['key']) }],
  },
  {
    section: 'typography',
    label: 'Typography & layout',
    scalars: [
      { item: 'Spacing scale', get: (d) => d.tokens.spacingScale.join(', ') },
      { item: 'Radii', get: (d) => d.tokens.radii.join(', ') },
    ],
    lists: [{ item: 'Type role', get: list((d) => d.tokens.typeRoles), keyOf: (i) => str(i['role']) }],
  },
  {
    section: 'voice',
    label: 'Voice & personality',
    scalars: [
      { item: 'Voice summary', get: (d) => d.voice.summary },
      { item: 'Tone', get: (d) => d.voice.tone },
      { item: 'Spelling', get: (d) => d.voice.spelling },
      { item: 'Locales', get: (d) => d.voice.locales },
      { item: 'Never write', get: (d) => d.voice.prohibitedPhrases },
    ],
    lists: [
      { item: 'Personality trait', get: list((d) => d.voice.personality), keyOf: (i) => str(i['trait']) },
      { item: 'Principle', get: list((d) => d.voice.principles), keyOf: (i) => str(i['statement']) },
      { item: 'Style rule', get: list((d) => d.voice.styleRules), keyOf: (i) => str(i['rule']) },
      { item: 'Claim rule', get: list((d) => d.voice.claimRules), keyOf: (i) => str(i['rule']) },
      { item: 'Preferred term', get: list((d) => d.voice.preferredTerms), keyOf: (i) => str(i['use']) },
    ],
  },
  {
    section: 'messaging',
    label: 'Messaging',
    scalars: [
      { item: 'Positioning', get: (d) => d.messaging?.positioning },
      { item: 'Value proposition', get: (d) => d.messaging?.valueProposition },
    ],
    lists: [
      { item: 'Pillar', get: list((d) => d.messaging?.pillars), keyOf: (i) => str(i['key']) },
      { item: 'Key message', get: list((d) => d.messaging?.keyMessages), keyOf: (i) => str(i['text']) },
      { item: 'Audience', get: list((d) => d.voice.audiences), keyOf: (i) => str(i['key']) },
    ],
  },
  {
    section: 'vocabulary',
    label: 'Vocabulary',
    scalars: [],
    lists: [{ item: 'Term', get: list((d) => d.vocabulary), keyOf: (i) => str(i['term']) }],
  },
  {
    section: 'writing',
    label: 'Writing patterns',
    scalars: WRITING_PARTS.map((part) => ({
      item: `Writing pattern: ${part.replace('_', ' ')}`,
      get: (d: Doc) => d.writingPatterns?.[part],
    })),
    lists: [],
  },
  {
    section: 'examples',
    label: 'Examples',
    scalars: [],
    lists: [{ item: 'Example', get: list((d) => d.voice.examples), keyOf: (i) => str(i['text']) }],
  },
  {
    section: 'templates',
    label: 'Templates',
    scalars: [],
    lists: [{ item: 'Copy template', get: list((d) => d.copyTemplates), keyOf: (i) => str(i['key']) }],
  },
  {
    section: 'patterns',
    label: 'Imagery & visual patterns',
    scalars: [],
    lists: [{ item: 'Pattern', get: list((d) => d.patterns), keyOf: (i) => str(i['key']) }],
  },
  {
    section: 'channels',
    label: 'Channel guidance',
    scalars: (Object.keys(ChannelBaseline.shape) as Array<keyof ChannelBaseline>).map((f) => ({
      item: `Channel default: ${words(f)}`,
      get: (d: Doc) => d.channelBaseline?.[f],
    })),
    lists: [{ item: 'Channel', get: list((d) => d.channelGuidance), keyOf: (i) => str(i['providerKey']) }],
  },
  {
    section: 'guidelines',
    label: 'Guidelines',
    scalars: [
      {
        item: 'Brand guidelines',
        get: (d) =>
          d.guidelines
            ? `${d.guidelines.source.name} (${d.guidelines.documents.length} documents, ${d.guidelines.source.packageHash.slice(0, 8)})`
            : undefined,
      },
    ],
    lists: [],
  },
];

const present = (v: unknown) =>
  !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));

/**
 * What changed from `before` to `after`, per section in the Brand System's order, as readable lines: items added,
 * removed or changed (by key) and fields changed. Provenance alone is not a change. Sections without changes are left
 * out; identical documents give an empty list.
 */
export function diffBrandDocuments(before: Doc, after: Doc): DocumentSectionDiffV1[] {
  const out: DocumentSectionDiffV1[] = [];
  for (const s of DIFF_SECTIONS) {
    const changes: DocumentChangeV1[] = [];
    for (const f of s.scalars) {
      const [a, b] = [f.get(before), f.get(after)];
      if (!present(a) && !present(b)) continue;
      if (present(a) && present(b) && sameValue(a, b)) continue;
      changes.push({
        change: !present(a) ? 'added' : !present(b) ? 'removed' : 'changed',
        item: f.item,
        before: present(a) ? describeValue(a) : null,
        after: present(b) ? describeValue(b) : null,
      });
    }
    for (const l of s.lists) {
      const a = new Map(l.get(before).map((i) => [normaliseKey(l.keyOf(i)), i]));
      const b = new Map(l.get(after).map((i) => [normaliseKey(l.keyOf(i)), i]));
      for (const [k, item] of a) {
        const next = b.get(k);
        const name = `${l.item} "${l.keyOf(item)}"`;
        if (!next) changes.push({ change: 'removed', item: name, before: describeValue(item), after: null });
        else if (!sameValue(item, next))
          changes.push({
            change: 'changed',
            item: name,
            before: describeValue(item),
            after: describeValue(next),
          });
      }
      for (const [k, item] of b)
        if (!a.has(k))
          changes.push({
            change: 'added',
            item: `${l.item} "${l.keyOf(item)}"`,
            before: null,
            after: describeValue(item),
          });
    }
    if (changes.length) out.push({ section: s.section, label: s.label, changes });
  }
  return out;
}

/** The labels of the sections that differ between two documents (the history's "what changed"). */
export const changedSectionLabels = (before: Doc, after: Doc): string[] =>
  diffBrandDocuments(before, after).map((s) => s.label);
