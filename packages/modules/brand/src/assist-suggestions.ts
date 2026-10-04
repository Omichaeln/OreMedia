import { ZodError } from 'zod';
import type {
  BrandSystemDocumentV1,
  EvidenceRef,
  GuidanceOrigin,
  GuidanceProvenance,
} from '@oremedia/contracts/brand';
import {
  MODEL_SECTION_OUTPUT,
  type AssistSection,
  type ModelBasis,
  type ModelSectionOutput,
  type SuggestionConflict,
  type SuggestionEvidence,
  type SuggestionOp,
} from '@oremedia/contracts/brand-assist';
import {
  itemPath,
  normaliseKey,
  parsePath,
  provenanceAt,
  removableCollections,
  sameValue,
  stripProvenance,
  suggestionFingerprint,
  valueAt,
} from '@oremedia/domain/brand-suggestions';
import { factDedupeKey } from '@oremedia/domain/facts';

/**
 * BSC-4: a section's model output turned into suggestions against the brand system as it is now (the pending
 * proposal, else the applied document). The rules, in order:
 * - evidence counts only when its passage is found in the cited source's captured text (`verified`); an item said to
 *   be stated by the sources without a verified passage becomes `suggested`, with the uncertainty saying so;
 * - an inferred pattern needs passages from at least two places, else it is low confidence and says why;
 * - a fact is never invented: without a verified passage it is a `suggested` fact (a question for a person), and a
 *   fact the brand already holds (same normalised statement) is not suggested;
 * - an item the same as the current one is no suggestion; an item a person wrote (`user`) is never changed by itself:
 *   the suggestion is made against it and marked so; items named in `preserve` are not changed or removed at all;
 * - channels the platform does not know are not suggested (accepting them could never be saved);
 * - a fingerprint the brand rejected (or already accepted) is not suggested again, nor one already pending.
 */
export interface SuggestionSource {
  id: string;
  title: string;
  url: string | null;
  text: string;
}

export interface ConvertContext {
  section: AssistSection;
  current: BrandSystemDocumentV1;
  sources: ReadonlyMap<string, SuggestionSource>;
  preserve: ReadonlySet<string>;
  knownChannels: ReadonlySet<string>;
  liveFactKeys: ReadonlySet<string>;
  /** Fingerprints that must not be suggested (rejected, accepted, or already pending). */
  blocked: ReadonlySet<string>;
}

export interface DraftSuggestion {
  section: AssistSection;
  path: string;
  op: SuggestionOp;
  value: unknown;
  provenance: GuidanceProvenance;
  rationale: string;
  uncertainty: string | null;
  conflicts: SuggestionConflict[];
  evidence: SuggestionEvidence[];
  fingerprint: string;
  againstUserItem: boolean;
}

export const SECTION_SUGGESTIONS_MAX = 80;

type ModelMeta = {
  rationale: string;
  basis: ModelBasis;
  confidence: 'high' | 'medium' | 'low';
  evidence: Array<{ sourceId: string; excerpt: string }>;
  uncertainty?: string | undefined;
  conflicts?: Array<{ note: string; sourceIds: string[] }> | undefined;
};

/** Text folded for passage matching: Unicode, case, quotes, dashes and spacing. */
export const foldForMatch = (text: string): string =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[\u2018\u2019\u201a\u201b'`]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f"]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();

/** The model's passages checked against the sources: unknown sources dropped, each marked verified or not. */
export function verifyEvidence(
  evidence: ModelMeta['evidence'],
  sources: ReadonlyMap<string, SuggestionSource>,
  folded = new Map<string, string>(),
): SuggestionEvidence[] {
  const out: SuggestionEvidence[] = [];
  for (const e of evidence) {
    const source = sources.get(e.sourceId.split('#')[0] as string);
    if (!source) continue;
    let text = folded.get(source.id);
    if (text === undefined) {
      text = foldForMatch(source.text);
      folded.set(source.id, text);
    }
    const passage = foldForMatch(e.excerpt)
      .replace(/^\.\.\.|\.\.\.$/g, '')
      .trim();
    out.push({
      sourceId: source.id,
      excerpt: e.excerpt.slice(0, 1000),
      verified: passage.length >= 8 && text.includes(passage),
    });
  }
  return out;
}

const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' ') || null;

/** Passages shorter than this cannot carry a fact on their own (a heading, a fragment). */
export const FACT_EXCERPT_MIN_CHARS = 30;
/** Share of the statement's content words the passage must contain. */
export const FACT_WORD_OVERLAP_MIN = 0.6;
const STOPWORDS = new Set(
  (
    'the and for are but not you all any can had her was one our out has his how its may new now old see two who ' +
    'did get let put say she too use that with have this will your from they been more when were what than then ' +
    'them into only over such also each just most some very which their there these those about after before ' +
    'being would could should other where while every since until because'
  ).split(' '),
);
const words = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Figures (years, prices, percentages) as written, e.g. 2014, £4.50, 30%. */
const figures = (folded: string): string[] =>
  (folded.match(/[£$€¥]?\d[\d,.]*%?/g) ?? []).map((f) => f.replace(/[.,]+$/, ''));
/** Names: capitalised words after the first word of the statement. */
const names = (statement: string): string[] =>
  (statement.normalize('NFKC').match(/\p{Lu}[\p{L}\p{N}'-]*/gu) ?? [])
    .filter((_, i, all) => !(i === 0 && statement.trimStart().startsWith(all[0] as string)))
    .map((n) => foldForMatch(n));

/**
 * Whether a passage actually states a fact (MAJOR: a found passage is not enough; it must say this): long enough to
 * carry it, every figure and name of the statement verbatim, and most of its content words.
 */
export function supportsStatement(statement: string, excerpt: string): boolean {
  const passage = foldForMatch(excerpt);
  if (passage.length < FACT_EXCERPT_MIN_CHARS) return false;
  const said = foldForMatch(statement);
  const passageWords = new Set(words(passage));
  for (const f of figures(said)) if (!passage.includes(f)) return false;
  for (const n of names(statement)) if (!words(n).every((w) => passageWords.has(w))) return false;
  const content = [...new Set(words(said).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
  if (content.length === 0) return true;
  const found = content.filter((w) => passageWords.has(w)).length;
  return found / content.length >= FACT_WORD_OVERLAP_MIN;
}

/** Provenance, confidence and uncertainty from the model's basis and what its evidence turned out to be. */
export function judge(
  meta: ModelMeta,
  evidence: SuggestionEvidence[],
  sources: ReadonlyMap<string, SuggestionSource>,
  /** A fact's statement: only passages that state it count as its evidence. */
  statement?: string,
): { provenance: GuidanceProvenance; uncertainty: string | null } {
  const found = evidence.filter((e) => e.verified);
  const verified =
    statement === undefined ? found : found.filter((e) => supportsStatement(statement, e.excerpt));
  let origin: GuidanceOrigin;
  let confidence = meta.confidence;
  let uncertainty = meta.uncertainty?.trim() || null;
  if (statement !== undefined && found.length > verified.length && verified.length === 0)
    uncertainty = join(uncertainty, 'The cited passage does not state this fact.');
  if (meta.basis === 'stated' && verified.length > 0) origin = 'imported';
  else if (meta.basis === 'inferred') {
    origin = 'inferred';
    const places = new Set(verified.map((e) => foldForMatch(e.excerpt)));
    if (places.size < 2) {
      confidence = 'low';
      uncertainty = join(uncertainty, 'Drawn from fewer than two examples, so it may not be a pattern.');
    }
  } else {
    origin = 'suggested';
    if (meta.basis === 'stated' && found.length === 0)
      uncertainty = join(uncertainty, 'The passage it cites was not found in the sources.');
  }
  const refs: EvidenceRef[] = verified.slice(0, 10).map((e) => {
    const s = sources.get(e.sourceId);
    return {
      kind: s?.url ? 'url' : 'document',
      ref: (s?.url ?? s?.title ?? e.sourceId).slice(0, 1000),
      note: e.excerpt.slice(0, 500),
    };
  });
  return {
    provenance: { origin, confidence, ...(refs.length ? { evidence: refs } : {}) },
    uncertainty: uncertainty ? uncertainty.slice(0, 500) : null,
  };
}

interface Candidate {
  path: string;
  op: SuggestionOp;
  value: unknown;
  meta: ModelMeta;
}

/** Candidates in model order, before the rules: one per output item. */
function candidatesOf(section: AssistSection, out: ModelSectionOutput): Candidate[] {
  const c: Candidate[] = [];
  const scalar = (path: string, item?: { value: unknown } & ModelMeta) => {
    if (item) c.push({ path, op: 'replace', value: item.value, meta: item });
  };
  const keyed = <V>(collection: string, items: Array<{ value: V } & ModelMeta>, keyOf: (v: V) => string) => {
    for (const i of items)
      c.push({ path: itemPath(collection, keyOf(i.value)), op: 'replace', value: i.value, meta: i });
  };
  switch (section) {
    case 'voice': {
      const o = out as ModelSectionOutput<'voice'>;
      scalar('voice.summary', o.summary);
      scalar('voice.tone', o.tone);
      scalar('voice.spelling', o.spelling);
      keyed('voice.personality', o.personality, (v) => v.trait);
      keyed('voice.principles', o.principles, (v) => v.statement);
      keyed('voice.styleRules', o.styleRules, (v) => v.rule);
      keyed('voice.claimRules', o.claimRules, (v) => v.rule);
      break;
    }
    case 'messaging': {
      const o = out as ModelSectionOutput<'messaging'>;
      scalar('messaging.positioning', o.positioning);
      scalar('messaging.valueProposition', o.valueProposition);
      keyed('messaging.pillars', o.pillars, (v) => v.key);
      keyed('messaging.keyMessages', o.keyMessages, (v) => v.text);
      keyed('voice.audiences', o.audiences, (v) => v.key);
      break;
    }
    case 'vocabulary':
      keyed('vocabulary', (out as ModelSectionOutput<'vocabulary'>).terms, (v) => v.term);
      break;
    case 'writing':
      for (const p of (out as ModelSectionOutput<'writing'>).patterns)
        c.push({ path: `writingPatterns.${p.part}`, op: 'replace', value: p.value, meta: p });
      break;
    case 'examples':
      keyed('voice.examples', (out as ModelSectionOutput<'examples'>).examples, (v) => v.text);
      break;
    case 'templates':
      keyed('copyTemplates', (out as ModelSectionOutput<'templates'>).templates, (v) => v.key);
      break;
    case 'channels': {
      const o = out as ModelSectionOutput<'channels'>;
      for (const b of o.baseline)
        c.push({ path: `channelBaseline.${b.field}`, op: 'replace', value: b.value, meta: b });
      for (const ch of o.channels)
        c.push({
          path: itemPath('channelGuidance', ch.providerKey),
          op: 'replace',
          value: { providerKey: ch.providerKey, ...ch.value },
          meta: ch,
        });
      break;
    }
    case 'facts':
      for (const f of (out as ModelSectionOutput<'facts'>).facts)
        c.push({
          path: itemPath('facts', f.statement),
          op: 'add',
          value: { statement: f.statement, category: f.category, ...(f.scope ? { scope: f.scope } : {}) },
          meta: f,
        });
      break;
  }
  if ('remove' in out && Array.isArray(out.remove)) {
    const allowed = new Set(removableCollections(section));
    for (const r of out.remove)
      if (allowed.has(r.collection))
        c.push({ path: itemPath(r.collection, r.key), op: 'remove', value: null, meta: r });
  }
  return c;
}

/** Per-target clean-up before comparison: unknown channels dropped, a new pillar cites no facts, required defaults. */
function shapeValue(path: string, value: unknown, existing: unknown, ctx: ConvertContext): unknown | null {
  const p = parsePath(path);
  if (!p) return null;
  if (p.target.kind === 'scalar') {
    if (p.target.path === 'voice.tone' && Array.isArray(value)) return value.slice(0, 12);
    return value;
  }
  const v = { ...(value as Record<string, unknown>) };
  const old = existing ? (stripProvenance(existing) as Record<string, unknown>) : null;
  switch (p.target.collection) {
    case 'channelGuidance': {
      const key = String(v['providerKey'] ?? '');
      if (!ctx.knownChannels.has(key) && !old) return null;
      return {
        captionStyle: '',
        preferredFormats: [],
        ctaConventions: '',
        ...(old ?? {}),
        ...v,
        ...(old?.['examples'] ? { examples: old['examples'] } : {}),
      };
    }
    case 'copyTemplates':
      return {
        ...(old ?? {}),
        ...v,
        channelKeys: ((v['channelKeys'] as string[] | undefined) ?? []).filter((k) =>
          ctx.knownChannels.has(k),
        ),
      };
    case 'voice.examples': {
      const merged: Record<string, unknown> = { ...(old ?? {}), ...v };
      if (typeof merged['channelKey'] === 'string' && !ctx.knownChannels.has(merged['channelKey']))
        delete merged['channelKey'];
      return merged;
    }
    case 'messaging.pillars':
      return { ...(old ?? {}), ...v, proofFactIds: (old?.['proofFactIds'] as string[] | undefined) ?? [] };
    case 'messaging.keyMessages': {
      const pillars = new Set(
        ((ctx.current.messaging?.pillars ?? []) as Array<{ key: string }>).map((x) => x.key),
      );
      const merged: Record<string, unknown> = { ...(old ?? {}), ...v };
      if (typeof merged['pillarKey'] === 'string' && !pillars.has(merged['pillarKey']))
        delete merged['pillarKey'];
      return merged;
    }
    case 'facts':
      return v;
    default:
      return { ...(old ?? {}), ...v };
  }
}

/**
 * Validates the raw output against the section's strict schema (anything else is refused, never repaired) and
 * converts it. Throws the zod error when the output does not match.
 */
export function parseSectionOutput(section: AssistSection, raw: unknown): ModelSectionOutput {
  return MODEL_SECTION_OUTPUT[section].parse(raw) as ModelSectionOutput;
}

const MAX_SHAPE_ISSUES = 5;
/**
 * Where an answer left the section's schema, as `path: code` (e.g. `spelling.value.notes: invalid_type`), or the
 * JSON parse error: the schema's own words only, never the model's text, so a failed attempt says what to fix.
 */
export function shapeIssues(err: unknown): string[] {
  if (err instanceof ZodError)
    return err.issues.slice(0, MAX_SHAPE_ISSUES).map((i) => `${i.path.join('.') || '(answer)'}: ${i.code}`);
  return err instanceof Error ? [err.message] : [];
}

export function suggestionsFromOutput(output: ModelSectionOutput, ctx: ConvertContext): DraftSuggestion[] {
  const out: DraftSuggestion[] = [];
  const folded = new Map<string, string>();
  const seenPaths = new Set<string>();
  const preserved = new Set([...ctx.preserve].map((p) => normalisedPath(p)));
  for (const cand of candidatesOf(ctx.section, output)) {
    if (out.length >= SECTION_SUGGESTIONS_MAX) break;
    const parsed = parsePath(cand.path);
    if (!parsed) continue;
    const pathKey = normalisedPath(cand.path);
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    const existing =
      parsed.target.kind === 'keyed' && parsed.target.virtual ? undefined : valueAt(ctx.current, cand.path);
    const isUser = provenanceAt(ctx.current, cand.path)?.origin === 'user';
    const evidence = verifyEvidence(cand.meta.evidence, ctx.sources, folded);
    const statement =
      ctx.section === 'facts' && cand.value && typeof cand.value === 'object' && 'statement' in cand.value
        ? String((cand.value as { statement: unknown }).statement)
        : undefined;
    const { provenance, uncertainty } = judge(cand.meta, evidence, ctx.sources, statement);
    let op = cand.op;
    let value: unknown = null;
    if (op === 'remove') {
      if (existing === undefined || preserved.has(pathKey)) continue;
    } else {
      if (parsed.target.kind === 'keyed' && parsed.target.collection === 'facts') {
        const statement = String((cand.value as { statement: string }).statement);
        if (ctx.liveFactKeys.has(factDedupeKey(statement))) continue;
      }
      if (existing !== undefined && preserved.has(pathKey)) continue;
      const shaped = shapeValue(cand.path, cand.value, existing, ctx);
      if (shaped === null) continue;
      const checked = parsed.target.schema.safeParse(shaped);
      if (!checked.success) continue;
      value = checked.data;
      if (existing !== undefined && sameValue(stripProvenance(existing), value)) continue;
      op = existing === undefined ? 'add' : 'replace';
    }
    const conflicts: SuggestionConflict[] = (cand.meta.conflicts ?? []).map((c) => ({
      note: c.note.slice(0, 500),
      sourceIds: c.sourceIds.filter((id) => ctx.sources.has(id)).slice(0, 5),
    }));
    if (isUser && op !== 'add')
      conflicts.push({
        note: 'A person wrote the current wording; accepting this replaces it.',
        sourceIds: [],
      });
    const fingerprint = suggestionFingerprint({ section: ctx.section, path: cand.path, op, value });
    if (ctx.blocked.has(fingerprint)) continue;
    out.push({
      section: ctx.section,
      path: cand.path,
      op,
      value: op === 'remove' ? null : value,
      provenance,
      rationale: cand.meta.rationale.slice(0, 1000),
      uncertainty,
      conflicts: conflicts.slice(0, 5),
      evidence,
      fingerprint,
      againstUserItem: isUser && op !== 'add',
    });
  }
  return out;
}

/** A path as it compares: its collection and folded key (`vocabulary#roast` and `vocabulary#Roast` are one). */
export function normalisedPath(path: string): string {
  const p = parsePath(path);
  if (!p || p.target.kind === 'scalar') return path;
  return `${p.target.collection}#${normaliseKey(p.key ?? '')}`;
}
