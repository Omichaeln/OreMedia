import { sha256Hex } from './hash';

/**
 * BSC-3 duplicate detection for facts. Two statements are the same fact when they read the same after Unicode
 * compatibility normalisation, case folding and with punctuation and spacing ignored ("Founded in 1998." and
 * "founded in 1998"); currency symbols, % and minus signs are kept, so "$10" and "€10", "10%" and "10" differ; the hash of that form is the stored dedupe key. Statements that are only close (a word added
 * or dropped) are surfaced as possible duplicates for a person to merge, never merged automatically.
 */
export function normaliseFactStatement(statement: string): string {
  return statement
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}\p{Sc}%-]+/gu, ' ')
    .trim();
}

/** char(64): sha256 of the normalised statement. */
export const factDedupeKey = (statement: string): string => sha256Hex(normaliseFactStatement(statement));

const tokens = (statement: string): Set<string> =>
  new Set(normaliseFactStatement(statement).split(' ').filter(Boolean));

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Jaccard similarity of the statements' word sets, 0..1 (1 for the same normalised statement). */
export const factSimilarity = (a: string, b: string): number => jaccard(tokens(a), tokens(b));

/** At or above this similarity two live facts are listed as possible duplicates. */
export const NEAR_DUPLICATE_SIMILARITY = 0.75;

/**
 * For each fact, the other facts whose statement is at least NEAR_DUPLICATE_SIMILARITY alike (the same dedupe key
 * scores 1); facts without a match are absent. Quadratic, so callers bound the input (one
 * brand's live facts).
 */
export function possibleDuplicates(
  facts: ReadonlyArray<{ id: string; statement: string }>,
): Map<string, string[]> {
  const keyed = facts.map((f) => ({ id: f.id, words: tokens(f.statement) }));
  const out = new Map<string, string[]>();
  const add = (from: string, to: string) => out.set(from, [...(out.get(from) ?? []), to]);
  for (const [i, a] of keyed.entries())
    for (const b of keyed.slice(i + 1))
      if (jaccard(a.words, b.words) >= NEAR_DUPLICATE_SIMILARITY) {
        add(a.id, b.id);
        add(b.id, a.id);
      }
  return out;
}
