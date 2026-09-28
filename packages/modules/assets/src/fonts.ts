import {
  GOOGLE_FONTS_SOURCE,
  type AssetState,
  type BrandFontFace,
  type FontStyle,
  type Provenance,
} from '@oremedia/contracts/assets';

/**
 * Brand font faces from font asset versions. A face is what a type role chooses and what the renderer registers
 * under one family name: an uploaded file is a face of its own; the files of one imported face (same source, family,
 * weight and style, one file per unicode subset) are one face. Everything here reads the recorded provenance of
 * immutable asset versions, so the same versions always make the same faces.
 */
export interface FontFileRow {
  assetId: string;
  assetName: string;
  assetState: AssetState;
  assetVersionId: string;
  mime: string;
  bytes: number;
  provenance: Provenance;
}

/** Where a file belongs: its face key, and the unicode range it covers (null: every character it has). */
export interface FontFileIdentity {
  key: string;
  subset: string | null;
  unicodeRange: string | null;
}

/** The subset a face's representative file is chosen from first (a type role names that file). */
const PRIMARY_SUBSET = 'latin';

const WEIGHT_NAMES: ReadonlyArray<[RegExp, number]> = [
  [/\b(?:thin|hairline)\b/, 100],
  [/\b(?:extra|ultra)[\s-]?light\b/, 200],
  [/\b(?:semi|demi)[\s-]?bold\b/, 600],
  [/\b(?:extra|ultra)[\s-]?bold\b/, 800],
  [/\b(?:black|heavy)\b/, 900],
  [/\blight\b/, 300],
  [/\bmedium\b/, 500],
  [/\bbold\b/, 700],
  [/\b(?:regular|normal|book|roman|italic|oblique)\b/, 400],
];

/** The weight a font's subfamily name states ("SemiBold Italic" → 600); null when it names none. */
export function weightFromSubfamily(subfamily: string | null | undefined): number | null {
  if (!subfamily) return null;
  const s = subfamily.toLowerCase();
  for (const [re, w] of WEIGHT_NAMES) if (re.test(s)) return w;
  return null;
}

export const styleFromSubfamily = (subfamily: string | null | undefined): FontStyle =>
  subfamily && /\b(?:italic|oblique)\b/i.test(subfamily) ? 'italic' : 'normal';

const FORMATS: Readonly<Record<string, string>> = {
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
};
export const fontFormat = (mime: string): string => FORMATS[mime] ?? mime.replace(/^.*\//, '');

/** True for one file of a multi-file face (an imported face); any other font file is a face of its own. */
export const isFaceFile = (provenance: Provenance): boolean =>
  provenance.kind === 'imported' && provenance.font !== undefined;

/** The release a font service serves a file from (fonts.gstatic.com/s/<family>/v31/…): part of the face's identity. */
export function sourceVersion(externalRef: string): string {
  return /\/s\/[^/]+\/(v\d+)\//.exec(externalRef)?.[1] ?? '-';
}

/**
 * Only an imported face groups files; any other file is a face of its own, keyed by its asset. An imported face is
 * its source, family, the source's release of it (a re-import after the family is updated is a new face, never mixed
 * with the old files), its weight or weight range, and its style.
 */
export function fontFileIdentity(assetId: string, provenance: Provenance): FontFileIdentity {
  if (provenance.kind === 'imported' && provenance.font) {
    const { weight, weightRange } = provenance.font;
    return {
      key: [
        provenance.source,
        provenance.font.family.toLowerCase(),
        sourceVersion(provenance.externalRef),
        weightRange ? `${weightRange.min}-${weightRange.max}` : weight,
        provenance.font.style,
      ].join(':'),
      subset: provenance.font.subset,
      unicodeRange: provenance.font.unicodeRange,
    };
  }
  return { key: `asset:${assetId}`, subset: null, unicodeRange: null };
}

/** The brand's font faces, one per key, files ordered with the representative (latin) file first. */
export function groupFontFaces(rows: readonly FontFileRow[]): BrandFontFace[] {
  const byKey = new Map<string, FontFileRow[]>();
  for (const r of rows) {
    const { key } = fontFileIdentity(r.assetId, r.provenance);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const faces: BrandFontFace[] = [];
  for (const [key, files] of byKey) {
    const ordered = [...files].sort((a, b) => rank(a) - rank(b) || a.assetId.localeCompare(b.assetId));
    const first = ordered[0] as FontFileRow;
    const p = first.provenance;
    const meta = p.kind === 'upload' || p.kind === 'imported' ? p.fontMetadata : undefined;
    const imported = p.kind === 'imported' ? p.font : undefined;
    faces.push({
      key,
      assetId: first.assetId,
      assetVersionId: first.assetVersionId,
      name: first.assetName,
      // A face is as usable as its least approved file.
      state: ordered.some((f) => f.assetState !== 'approved') ? 'pending_review' : 'approved',
      family: imported?.family ?? meta?.family ?? null,
      subfamily: meta?.subfamily ?? null,
      weight: imported?.weight ?? weightFromSubfamily(meta?.subfamily),
      weightRange: imported?.weightRange ?? null,
      style: imported?.style ?? styleFromSubfamily(meta?.subfamily),
      format: fontFormat(first.mime),
      source:
        p.kind === 'upload'
          ? 'upload'
          : p.kind === 'imported' && p.source === GOOGLE_FONTS_SOURCE
            ? 'google_fonts'
            : 'other',
      licence: (p.kind === 'imported' ? p.licence : undefined) ?? meta?.licence ?? null,
      files: ordered.map((f) => {
        const id = fontFileIdentity(f.assetId, f.provenance);
        return {
          assetId: f.assetId,
          assetVersionId: f.assetVersionId,
          mime: f.mime,
          bytes: f.bytes,
          subset: id.subset,
          unicodeRange: id.unicodeRange,
        };
      }),
    });
  }
  return faces.sort(
    (a, b) =>
      (a.family ?? a.name).localeCompare(b.family ?? b.name) ||
      (a.weight ?? 400) - (b.weight ?? 400) ||
      a.style.localeCompare(b.style),
  );
}

function rank(r: FontFileRow): number {
  const { subset } = fontFileIdentity(r.assetId, r.provenance);
  return subset === PRIMARY_SUBSET ? 0 : subset === null ? 1 : 2;
}

/** One file to register for a render: under `family`, limited to `unicodeRange` when the face has several files. */
export interface RenderFontFace {
  family: string;
  assetVersionId: string;
  unicodeRange: string | null;
}

/**
 * Which pinned files to register under which family for a render. Each document font ref (an asset version id) is a
 * family; its face's other pinned files join it, each limited to its unicode range. A ref whose face has one pinned
 * file is registered as before (whole file, no range). Files are matched on recorded provenance only.
 */
export function renderFontFaces(
  refs: readonly string[],
  pinned: ReadonlyArray<{ assetVersionId: string; assetId: string; provenance: Provenance }>,
): RenderFontFace[] {
  const identity = new Map(pinned.map((p) => [p.assetVersionId, fontFileIdentity(p.assetId, p.provenance)]));
  const out: RenderFontFace[] = [];
  for (const ref of new Set(refs)) {
    const own = identity.get(ref);
    if (!own) continue;
    const members = pinned.filter((p) => identity.get(p.assetVersionId)?.key === own.key);
    if (members.length <= 1) {
      out.push({ family: ref, assetVersionId: ref, unicodeRange: null });
      continue;
    }
    for (const m of members)
      out.push({
        family: ref,
        assetVersionId: m.assetVersionId,
        unicodeRange: identity.get(m.assetVersionId)?.unicodeRange ?? null,
      });
  }
  return out;
}
