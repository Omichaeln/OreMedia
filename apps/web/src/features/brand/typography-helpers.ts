import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { BrandFontFace } from '@oremedia/contracts/assets';

type TypeRole = BrandSystemDocumentV1['tokens']['typeRoles'][number];
export type TypeRoleKey = TypeRole['role'];

/**
 * The type roles the brand system defines (spec 8.1), in the contract's order: the label people read, the size a new
 * role starts at in the editor, the sample a specimen shows for it and what the role is for.
 */
export const TYPE_ROLES: Array<{
  role: TypeRoleKey;
  label: string;
  minSizePx: number;
  sample: string;
  use: string;
}> = [
  {
    role: 'display',
    label: 'Display',
    minSizePx: 40,
    sample: 'Built to last',
    use: 'Campaign headlines and covers: a few words, set large.',
  },
  {
    role: 'heading',
    label: 'Heading',
    minSizePx: 28,
    sample: 'The quick brown fox',
    use: 'Section and post titles.',
  },
  {
    role: 'body',
    label: 'Body',
    minSizePx: 16,
    sample: 'The quick brown fox jumps over the lazy dog.',
    use: 'Paragraphs and captions people read in full.',
  },
  {
    role: 'label',
    label: 'Label',
    minSizePx: 14,
    sample: 'Shop the range',
    use: 'Buttons, tags and short calls to action.',
  },
  {
    role: 'caption',
    label: 'Caption',
    minSizePx: 12,
    sample: 'Photographed on site, 2026',
    use: 'Credits, footnotes and small supporting detail.',
  },
];

/**
 * Line height is not part of the brand system (type roles carry a face, weight, minimum size and tracking), so every
 * specimen is set at the design reference's 1.2 and says so; it is never presented as a brand rule.
 */
export const SPECIMEN_LINE_HEIGHT = 1.2;

export interface ScaleStep {
  role: TypeRole;
  /** 1 is the largest size in the scale. */
  step: number;
  of: number;
}

/** The brand's type scale: its roles largest first (by minimum size; equal sizes keep the contract's role order). */
export function typeScale(roles: readonly TypeRole[]): ScaleStep[] {
  const order = (r: TypeRoleKey) => TYPE_ROLES.findIndex((x) => x.role === r);
  return [...roles]
    .sort((a, b) => b.minSizePx - a.minSizePx || order(a.role) - order(b.role))
    .map((role, i, all) => ({ role, step: i + 1, of: all.length }));
}

/** Tracking (letter spacing) as stored, in em; a role without it renders at 0 and says it is not set. */
export const formatTracking = (tracking: number | undefined) =>
  tracking === undefined ? '0 em (not set)' : `${tracking} em`;

/** A face as a specimen names it: family, else the file name. */
export const faceName = (face: Pick<BrandFontFace, 'family' | 'name'> | undefined) =>
  face ? (face.family ?? face.name) : 'A font not in this brand';

/** The secondary label under a specimen: every value the specimen is drawn with, true size included. */
export function specRows(role: TypeRole, face: Pick<BrandFontFace, 'family' | 'name'> | undefined) {
  return [
    ['role', role.role],
    ['font', faceName(face)],
    ['weight', String(role.weight)],
    ['size', `${role.minSizePx} px (minimum)`],
    ['line height', `${SPECIMEN_LINE_HEIGHT} (preview only)`],
    ['tracking', formatTracking(role.tracking)],
  ] as const;
}

/** Whether a face's files declare the weight: one static weight, or a variable range; unknown when neither is read. */
export function weightCoverage(
  face: Pick<BrandFontFace, 'weight' | 'weightRange'>,
  weight: number,
): 'covered' | 'uncovered' | 'unknown' {
  if (face.weightRange)
    return weight >= face.weightRange.min && weight <= face.weightRange.max ? 'covered' : 'uncovered';
  if (face.weight === null) return 'unknown';
  return face.weight === weight ? 'covered' : 'uncovered';
}

export type FontLoadState = 'loading' | 'loaded' | 'failed';

export interface FontStatusInput {
  /** The role's face, or undefined when the role names a font that is not one of the brand's. */
  face: Pick<BrandFontFace, 'family' | 'name' | 'weight' | 'weightRange'> | undefined;
  weight: number;
  load: FontLoadState;
  /**
   * For a weight the face does not declare: whether the browser drew it differently from the face's own weight
   * (a variable file read as static), the same (the file has no such weight), or has not checked yet.
   */
  rendered: 'distinct' | 'same' | 'unchecked';
}

export interface FontStatus {
  tone: 'info' | 'warning' | 'critical';
  title: string;
  action: string;
}

/**
 * Whether a specimen shows the face it is labelled with. Null when it does; otherwise what is wrong and what to do,
 * so a fallback is never shown as the brand's font.
 */
export function fontStatus({ face, weight, load, rendered }: FontStatusInput): FontStatus | null {
  if (!face)
    return {
      tone: 'critical',
      title: 'This role names a font that is not one of the brand’s fonts; it is shown in a fallback font.',
      action: 'Edit Typography and choose one of the brand’s fonts for this role.',
    };
  const name = faceName(face);
  if (load === 'failed')
    return {
      tone: 'critical',
      title: `${name} ${weight} did not load; this specimen is shown in a fallback font.`,
      action: `Re-import ${name} from Google Fonts or upload its file again, then reload this page.`,
    };
  if (load === 'loading') return { tone: 'info', title: `Loading ${name}…`, action: '' };
  if (weightCoverage(face, weight) !== 'uncovered' || rendered !== 'same') return null;
  const has = face.weightRange ? `${face.weightRange.min}–${face.weightRange.max}` : String(face.weight);
  return {
    tone: 'warning',
    title: `${name} has no weight ${weight} (its file is weight ${has}); this specimen shows weight ${has}, as exports would.`,
    action: `Import or upload ${name} at weight ${weight} and choose that file for this role, or set the weight to ${has}.`,
  };
}
