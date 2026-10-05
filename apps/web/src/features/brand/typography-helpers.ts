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
 * The line height a specimen uses for a role the guidance gives none: the design reference's 1.2. It is labelled as
 * the default wherever it is used, never presented as the brand's rule.
 */
export const DEFAULT_LINE_HEIGHT = 1.2;

/** The line height a role is drawn with: the configured one, else the labelled default. */
export const resolveLineHeight = (role: Pick<TypeRole, 'lineHeight'>) =>
  role.lineHeight === undefined
    ? { value: DEFAULT_LINE_HEIGHT, configured: false }
    : { value: role.lineHeight, configured: true };

/** The size a specimen is drawn at: the role's intended size, else its minimum (all a role stored before sizes). */
export const specimenSizePx = (role: Pick<TypeRole, 'sizePx' | 'minSizePx'>) => role.sizePx ?? role.minSizePx;

/** Whether the guidance defines a minimum: the editor stores an emptied minimum as 0. */
const hasMinimum = (role: Pick<TypeRole, 'minSizePx'>) => role.minSizePx > 0;

/**
 * A role whose intended size is below its own minimum: null when it is not (or either is not set); otherwise what is
 * wrong and what to do. Studio checks flag text set below the minimum, so the specimen says so before they do.
 */
export function minSizeWarning(role: Pick<TypeRole, 'sizePx' | 'minSizePx'>): FontStatus | null {
  if (role.sizePx === undefined || !hasMinimum(role) || role.sizePx >= role.minSizePx) return null;
  return {
    tone: 'warning',
    title: `Set at ${role.sizePx} px, below this role’s ${role.minSizePx} px minimum; text at this size is flagged as off brand.`,
    action: `Raise the size to at least ${role.minSizePx} px, or lower the minimum if the guidance allows it.`,
  };
}

export interface ScaleStep {
  role: TypeRole;
  /** 1 is the largest size in the scale. */
  step: number;
  of: number;
}

/**
 * The brand's type scale: its roles largest first (by the size each is drawn at; equal sizes keep the contract's role
 * order).
 */
export function typeScale(roles: readonly TypeRole[]): ScaleStep[] {
  const order = (r: TypeRoleKey) => TYPE_ROLES.findIndex((x) => x.role === r);
  return [...roles]
    .sort((a, b) => specimenSizePx(b) - specimenSizePx(a) || order(a.role) - order(b.role))
    .map((role, i, all) => ({ role, step: i + 1, of: all.length }));
}

/** Tracking (letter spacing) as stored, in em; a role without it renders at 0 and says it is not set. */
export const formatTracking = (tracking: number | undefined) =>
  tracking === undefined ? '0 em (not set)' : `${tracking} em`;

/** A face as a specimen names it: family, else the file name. */
export const faceName = (face: Pick<BrandFontFace, 'family' | 'name'> | undefined) =>
  face ? (face.family ?? face.name) : 'A font not in this brand';

/**
 * The secondary label under a specimen: every value the specimen is drawn with, its true size and, apart from it,
 * the minimum the guidance allows; a value the guidance does not set says so.
 */
export function specRows(role: TypeRole, face: Pick<BrandFontFace, 'family' | 'name'> | undefined) {
  const lineHeight = resolveLineHeight(role);
  return [
    ['role', role.role],
    ['font', faceName(face)],
    ['weight', String(role.weight)],
    [
      'specimen size',
      role.sizePx === undefined ? `${role.minSizePx} px (the minimum; no size set)` : `${role.sizePx} px`,
    ],
    ['minimum size', hasMinimum(role) ? `${role.minSizePx} px` : 'not set'],
    [
      'line height',
      lineHeight.configured ? String(lineHeight.value) : `${lineHeight.value} (default; not set)`,
    ],
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
