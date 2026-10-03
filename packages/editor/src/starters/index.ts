import type { LogoVariant } from '@oremedia/contracts/brand';
import type {
  ContentType,
  CreativeDocumentV1,
  CreativePage,
  Element,
  SemanticRole,
  TemplateSlotKind,
} from '@oremedia/contracts/creative';
import { formatFor } from '../formats';
import { contrastRatio } from '../validate';
import { STARTER_SPECS } from './catalogue';

/**
 * STU-1a built-in starter templates (architecture principle 5): composition structure that ships in code, like
 * built-in skills. A starter is declarative (boxes in page pixels, colour and type ROLES, logo slots); it becomes a
 * CreativeDocumentV1 only when instantiated with a brand's published system: colour tokens by role (text colours
 * picked for contrast against what they sit on), the brand's fonts per type role (never below the role's minimum
 * size) and its logos by variant with their pinned versions. Instantiation is pure, so the gallery preview, the
 * created document and the tests are the same code.
 */

export type Ground = 'light' | 'dark' | 'accent' | 'neutral';
export type TypeRoleKey = 'display' | 'heading' | 'body' | 'label' | 'caption';
/** [x, y, width, height] in page pixels of the starter's format. */
export type Box = readonly [number, number, number, number];

export interface TextSpec {
  kind: 'text';
  name: string;
  text: string;
  role?: SemanticRole;
  typeRole: TypeRoleKey;
  sizePx: number;
  lineHeight?: number;
  tracking?: number;
  align?: 'left' | 'center' | 'right';
  box: Box;
  /** What the text sits on; its colour is the brand colour with the most contrast against it. */
  on: Ground;
  /** Prefer the accent colour when it is legible on `on`. */
  tint?: 'accent';
  /** Slot constraint carried into "save as template". */
  maxLength?: number;
}
export interface ShapeSpec {
  kind: 'shape';
  name: string;
  shape: 'rect' | 'ellipse' | 'line';
  fill: Ground;
  box: Box;
  radius?: number;
  role?: SemanticRole;
}
/** Where a photo goes: a neutral placeholder the person fills from the assets tab ("Fill image area"). */
export interface ImageAreaSpec {
  kind: 'imageArea';
  name: string;
  box: Box;
  radius?: number;
}
export interface LogoSpec {
  kind: 'logo';
  /** Width before the brand's minimum width is applied; height follows the artwork's aspect ratio. */
  width: number;
  /** The corner of the safe area the logo sits in, `inset` px inside it. */
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  inset?: number;
}
export type ElementSpec = TextSpec | ShapeSpec | ImageAreaSpec | LogoSpec;

export interface PageSpec {
  name: string;
  ground: Ground;
  elements: readonly ElementSpec[];
}

export interface StarterSpec {
  key: string;
  name: string;
  /** Intended use, shown in the gallery. */
  description: string;
  contentType: ContentType;
  formatKey: string;
  /** Provider keys the starter is made for (gallery channel filter). */
  channels: readonly string[];
  pages: readonly PageSpec[];
}

/** What a starter needs of the brand: its published system with fonts and logos resolved to asset versions. */
export interface StarterBrand {
  brandVersionId: string;
  colours: ReadonlyArray<{ key: string; value: string; role: string }>;
  typeRoles: ReadonlyArray<{
    role: TypeRoleKey;
    fontAssetVersionId: string;
    weight: number;
    minSizePx: number;
  }>;
  logos: ReadonlyArray<{
    variant: LogoVariant;
    assetVersionId: string;
    /** Artwork width / height. */
    aspect: number;
    minWidthPx: number;
    allowedBackgroundColourKeys: readonly string[];
  }>;
}

export interface StarterSlot {
  key: string;
  elementId: string;
  kind: TemplateSlotKind | 'shape';
  required: boolean;
  maxLength?: number;
}

export interface InstantiatedStarter {
  document: CreativeDocumentV1;
  slots: StarterSlot[];
  /** What could not be placed as designed, in words for the person (e.g. no logo allowed on a dark ground). */
  notes: string[];
}

export const STARTERS: readonly StarterSpec[] = STARTER_SPECS;
export const starterByKey = (key: string): StarterSpec | undefined => STARTERS.find((s) => s.key === key);

// ---- palette -------------------------------------------------------------------------------------------------

const luminanceOrder = (hex: string): number => contrastRatio(hex, '#000000') ?? 0;
const MIN_TEXT_CONTRAST = 4.5;

interface Palette {
  light: string;
  dark: string;
  accent: string;
  neutral: string;
}

function paletteOf(colours: StarterBrand['colours']): Palette | null {
  const valid = colours.filter((c) => contrastRatio(c.value, '#000000') !== null);
  if (valid.length < 2) return null;
  const byLum = [...valid].sort((a, b) => luminanceOrder(b.value) - luminanceOrder(a.value));
  const lightest = byLum[0] as (typeof byLum)[number];
  const darkest = byLum[byLum.length - 1] as (typeof byLum)[number];
  const backgrounds = byLum.filter((c) => c.role === 'background');
  const light = backgrounds[0] ?? lightest;
  if ((contrastRatio(light.value, darkest.value) ?? 0) < MIN_TEXT_CONTRAST) return null;
  const accent =
    valid.find((c) => c.role === 'accent') ??
    valid.find((c) => c.role === 'primary') ??
    valid.find((c) => c.role === 'secondary') ??
    darkest;
  const neutral =
    byLum.find((c) => c.role === 'neutral' && c.key !== light.key) ??
    byLum.find((c) => c.key !== light.key && luminanceOrder(c.value) > luminanceOrder(darkest.value)) ??
    light;
  return { light: light.key, dark: darkest.key, accent: accent.key, neutral: neutral.key };
}

/** Why the brand cannot instantiate starters, or null when it can. */
export function starterBrandIssue(brand: StarterBrand): string | null {
  if (!paletteOf(brand.colours))
    return 'The brand system needs a light and a dark colour with enough contrast between them.';
  if (brand.typeRoles.length === 0) return 'The brand system needs at least one font (type roles).';
  return null;
}

// ---- instantiation -------------------------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const b32 = (n: number, width: number): string => {
  let out = '';
  let v = n;
  for (let i = 0; i < width; i++) {
    out = ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
};
/** Stable element ids per page and position: unique within the document, valid prefixed ULIDs. */
const starterElementId = (page: number, index: number): string =>
  `el_STR${b32(page, 2)}${b32(index, 2)}`.padEnd(29, '0');

const SLOT_KIND: Readonly<Partial<Record<SemanticRole, StarterSlot['kind']>>> = {
  headline: 'text',
  body: 'text',
  cta: 'text',
  price: 'text',
  legal: 'text',
  logo: 'logo',
  background: 'background',
  product: 'shape',
};

export function instantiateStarter(spec: StarterSpec, brand: StarterBrand): InstantiatedStarter {
  const format = formatFor(spec.formatKey);
  if (!format) throw new Error(`starter ${spec.key}: unknown format ${spec.formatKey}`);
  const palette = paletteOf(brand.colours);
  const issue = starterBrandIssue(brand);
  if (!palette || issue) throw new Error(issue ?? 'brand cannot instantiate starters');
  const hex = new Map(brand.colours.map((c) => [c.key, c.value]));
  const token = (g: Ground): string => palette[g];
  const textColour = (on: Ground, tint?: 'accent'): string => {
    const ground = hex.get(token(on)) as string;
    if (
      tint === 'accent' &&
      (contrastRatio(hex.get(palette.accent) as string, ground) ?? 0) >= MIN_TEXT_CONTRAST
    )
      return palette.accent;
    let best = palette.dark;
    let bestRatio = -1;
    for (const c of brand.colours) {
      const r = contrastRatio(c.value, ground) ?? -1;
      if (r > bestRatio) {
        best = c.key;
        bestRatio = r;
      }
    }
    return best;
  };
  const typeRole = (role: TypeRoleKey) =>
    brand.typeRoles.find((t) => t.role === role) ??
    brand.typeRoles.find(
      (t) => t.role === (role === 'display' ? 'heading' : role === 'heading' ? 'display' : 'body'),
    ) ??
    (brand.typeRoles[0] as StarterBrand['typeRoles'][number]);

  const notes: string[] = [];
  const slots: StarterSlot[] = [];
  const slotCounts = new Map<string, number>();
  const addSlot = (role: SemanticRole | undefined, elementId: string, maxLength?: number) => {
    const kind = role ? SLOT_KIND[role] : undefined;
    if (!role || !kind) return;
    const n = (slotCounts.get(role) ?? 0) + 1;
    slotCounts.set(role, n);
    slots.push({
      key: n === 1 ? role : `${role}_${n}`,
      elementId,
      kind,
      required: role === 'headline',
      ...(maxLength !== undefined ? { maxLength } : {}),
    });
  };

  const pages: CreativePage[] = spec.pages.map((pageSpec, p) => {
    const ground = token(pageSpec.ground);
    const elements: Element[] = [];
    const base = (index: number, name: string, box: Box, role?: SemanticRole) => ({
      id: starterElementId(p, index),
      name,
      locked: false,
      visible: true,
      opacity: 1,
      protected: false,
      transform: { x: box[0], y: box[1], width: box[2], height: box[3], rotation: 0 },
      ...(role ? { semanticRole: role } : {}),
    });
    const background: Element = {
      ...base(0, 'Background', [0, 0, format.width, format.height], 'background'),
      type: 'background',
      fillToken: ground,
    };
    elements.push(background);
    addSlot('background', background.id);
    pageSpec.elements.forEach((e, i) => {
      const index = i + 1;
      if (e.kind === 'text') {
        const tr = typeRole(e.typeRole);
        const el: Element = {
          ...base(index, e.name, e.box, e.role),
          type: 'text',
          text: e.text,
          style: {
            typeRole: e.typeRole,
            fontAssetVersionId: tr.fontAssetVersionId,
            weight: tr.weight,
            sizePx: Math.max(e.sizePx, tr.minSizePx),
            lineHeight: e.lineHeight ?? 1.15,
            tracking: e.tracking ?? 0,
            colourToken: textColour(e.on, e.tint),
            align: e.align ?? 'left',
            overflow: 'shrink_to_fit',
          },
          factRefs: [],
        };
        elements.push(el);
        addSlot(e.role, el.id, e.maxLength);
      } else if (e.kind === 'shape') {
        elements.push({
          ...base(index, e.name, e.box, e.role),
          type: 'shape',
          shape: e.shape,
          fillToken: token(e.fill),
          strokeWidth: 0,
          cornerRadius: e.radius ?? 0,
        });
      } else if (e.kind === 'imageArea') {
        const el: Element = {
          ...base(index, e.name, e.box, 'product'),
          type: 'shape',
          shape: 'rect',
          fillToken: palette.neutral,
          strokeWidth: 0,
          cornerRadius: e.radius ?? 0,
        };
        elements.push(el);
        addSlot('product', el.id);
      } else {
        // The first variant (in the brand system's order) allowed on this ground; the brand check blocks any other.
        const logo = brand.logos.find((l) => l.allowedBackgroundColourKeys.includes(ground));
        if (!logo) {
          notes.push(
            brand.logos.length === 0
              ? `${pageSpec.name}: the brand has no usable logo yet, so none was placed.`
              : `${pageSpec.name}: no logo variant is allowed on this background, so none was placed.`,
          );
          return;
        }
        const width = Math.ceil(Math.max(e.width, logo.minWidthPx));
        const height = Math.round((width / logo.aspect) * 100) / 100;
        const inset = e.inset ?? 24;
        const left = format.safeArea.left + inset;
        const right = format.width - format.safeArea.right - inset - width;
        const top = format.safeArea.top + inset;
        const bottom = format.height - format.safeArea.bottom - inset - height;
        const x = e.corner.endsWith('left') ? left : right;
        const y = e.corner.startsWith('top') ? top : bottom;
        const el: Element = {
          ...base(index, `Logo (${logo.variant.replace('_', ' ')})`, [x, y, width, height], 'logo'),
          protected: true,
          type: 'logo',
          assetVersionId: logo.assetVersionId,
          variant: logo.variant,
        };
        elements.push(el);
        addSlot('logo', el.id);
      }
    });
    return {
      id: `page_${p + 1}`,
      name: pageSpec.name,
      formatKey: format.key,
      width: format.width,
      height: format.height,
      elements,
      layoutConstraints: [],
    };
  });
  return {
    document: {
      schemaVersion: 1,
      brandVersionId: brand.brandVersionId,
      contentType: spec.contentType,
      pages,
      variants: [],
    },
    slots,
    notes,
  };
}

/**
 * A blank document for a format (preset or custom key): one page (or `pages` pages) with a background in the brand's
 * light colour when it has one.
 */
export function blankDocument(
  formatKey: string,
  brand: Pick<StarterBrand, 'brandVersionId' | 'colours'>,
  contentType: ContentType,
  pages = 1,
): CreativeDocumentV1 {
  const format = formatFor(formatKey);
  if (!format) throw new Error(`unknown format ${formatKey}`);
  const light = paletteOf(brand.colours)?.light ?? brand.colours[0]?.key;
  return {
    schemaVersion: 1,
    brandVersionId: brand.brandVersionId,
    contentType,
    pages: Array.from({ length: Math.max(1, Math.min(20, pages)) }, (_, p) => ({
      id: `page_${p + 1}`,
      name: `Page ${p + 1}`,
      formatKey: format.key,
      width: format.width,
      height: format.height,
      elements: light
        ? [
            {
              id: starterElementId(p, 0),
              name: 'Background',
              type: 'background' as const,
              locked: false,
              visible: true,
              opacity: 1,
              protected: false,
              semanticRole: 'background' as const,
              transform: { x: 0, y: 0, width: format.width, height: format.height, rotation: 0 },
              fillToken: light,
            },
          ]
        : [],
      layoutConstraints: [],
    })),
    variants: [],
  };
}
