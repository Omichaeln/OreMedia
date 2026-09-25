import { createHash } from 'node:crypto';
import {
  GUIDELINES_MAX_BYTES,
  GUIDELINES_MAX_DOCUMENTS,
  type BrandGuidelinesV1,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import { ValidationFailedError } from '@oremedia/contracts/errors';

type Colour = BrandSystemDocumentV1['tokens']['colours'][number];

/** Text files a brand skill carries its guidance in; everything else (images, fonts, SVG logos) is reported. */
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const INSTRUCTIONS = 'SKILL.md';

export interface ParsedGuidelines {
  guidelines: BrandGuidelinesV1;
  /** Paths not imported, with the reason (not text, or over the size cap). */
  skipped: Array<{ path: string; reason: 'not_text' | 'over_size_cap' }>;
}

/**
 * An Agent Skills package (SKILL.md with name/description front matter, references/*) as brand guidelines. The
 * front matter names the source; the documents are the text files, SKILL.md first, then by path. Paths are
 * normalised to be relative to the package root (a leading folder shared by every path is dropped, as a folder
 * upload adds it). The whole import is capped at GUIDELINES_MAX_BYTES so it always fits an agent's context.
 */
export function parseGuidelinesPackage(
  files: ReadonlyArray<{ path: string; content: string }>,
): ParsedGuidelines {
  const normalised = stripSharedRoot(
    files.map((f) => ({ path: f.path.replace(/\\/g, '/'), content: f.content })),
  );
  const skill = normalised.find((f) => f.path === INSTRUCTIONS);
  if (!skill)
    throw new ValidationFailedError(
      [{ path: 'files', issue: 'skill_md_missing' }],
      'A brand skill needs a SKILL.md at its root',
    );
  const front = frontMatter(skill.content);
  if (!front.name)
    throw new ValidationFailedError(
      [{ path: 'files.SKILL.md', issue: 'name_missing' }],
      'SKILL.md needs a name in its front matter',
    );
  const skipped: ParsedGuidelines['skipped'] = [];
  const ordered = [
    skill,
    ...normalised.filter((f) => f !== skill).sort((a, b) => a.path.localeCompare(b.path)),
  ];
  const documents: BrandGuidelinesV1['documents'] = [];
  let bytes = 0;
  for (const f of ordered) {
    const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
    if (!TEXT_EXTENSIONS.has(ext)) {
      skipped.push({ path: f.path, reason: 'not_text' });
      continue;
    }
    const size = Buffer.byteLength(f.content, 'utf8');
    if (bytes + size > GUIDELINES_MAX_BYTES || documents.length >= GUIDELINES_MAX_DOCUMENTS) {
      if (f === skill)
        throw new ValidationFailedError(
          [{ path: 'files.SKILL.md', issue: `exceeds_cap_${GUIDELINES_MAX_BYTES}` }],
          'SKILL.md is larger than the guidelines cap',
        );
      skipped.push({ path: f.path, reason: 'over_size_cap' });
      continue;
    }
    bytes += size;
    documents.push({ path: f.path, content: f.content });
  }
  const packageHash = createHash('sha256')
    .update(
      [...documents]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((d) => `${d.path}\n${d.content}`)
        .join('\n\0\n'),
    )
    .digest('hex');
  return {
    guidelines: {
      source: {
        name: front.name.slice(0, 200),
        description: (front.description ?? '').slice(0, 1000),
        packageHash,
      },
      documents,
    },
    skipped,
  };
}

function stripSharedRoot<T extends { path: string }>(files: T[]): T[] {
  const firsts = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  const [root] = [...firsts];
  const wrapped = firsts.size === 1 && !!root && files.some((f) => f.path === `${root}/SKILL.md`);
  return wrapped ? files.map((f) => ({ ...f, path: f.path.slice(root.length + 1) })) : files;
}

function frontMatter(markdown: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m?.[1]) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1] && kv[2] !== undefined) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: out['name'], description: out['description'] };
}

const HEX_IN_TEXT = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i;
const ROLE_WORDS: Array<[Colour['role'], RegExp]> = [
  ['primary', /\bprimary\b/i],
  ['secondary', /\bsecondary\b/i],
  ['accent', /\baccent|highlight|callout/i],
  ['background', /\bbackground|surface|canvas|page\b/i],
  ['text', /\b(text|body copy|foreground|ink)\b/i],
  ['semantic', /\b(error|success|warning|danger|destructive|info)\b/i],
  ['neutral', /\bneutral|grey|gray|muted|border\b/i],
];

/**
 * The palette a guidelines document states in markdown tables: each table row carrying a hex value becomes a
 * colour, keyed by the row's first text cell (its name), with a role read from the row's words. The first row
 * naming a hex wins; a name already used gets the next free suffix. Colours written only in other notations (OKLCH,
 * RGB) are not read; they stay in the guidelines text for the person to add.
 */
export function extractPalette(documents: ReadonlyArray<{ content: string }>): Colour[] {
  const colours: Colour[] = [];
  const seenHex = new Set<string>();
  const seenKey = new Set<string>();
  for (const d of documents)
    for (const line of d.content.split(/\r?\n/)) {
      if (!line.trim().startsWith('|')) continue;
      const hex = HEX_IN_TEXT.exec(line)?.[0];
      if (!hex) continue;
      const value = normaliseHex(hex);
      if (seenHex.has(value)) continue;
      const cells = line
        .split('|')
        .map((c) => c.replace(/[`*_]/g, '').trim())
        .filter(Boolean);
      const name =
        cells.map((c) => c.replace(HEX_IN_TEXT, '').trim()).find((c) => /[a-z]/i.test(c)) ?? 'colour';
      const base = slug(name) || 'colour';
      let key = base;
      for (let n = 2; seenKey.has(key); n++) key = `${base}-${n}`;
      const role = ROLE_WORDS.find(([, re]) => re.test(line))?.[0] ?? 'accent';
      seenHex.add(value);
      seenKey.add(key);
      colours.push({ key, value, role });
      if (colours.length >= 40) return colours;
    }
  return colours;
}

const normaliseHex = (hex: string) => {
  const h = hex.slice(1).toUpperCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
