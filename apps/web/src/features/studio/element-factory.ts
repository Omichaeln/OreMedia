import type { CreativePage, Element } from '@oremedia/contracts/creative';
import { contrastRatio, type StarterBrand } from '@oremedia/editor';
import { newElementId } from '../../lib/ids';

/** STU-1a: the brand pieces new elements are made of (the published system's tokens and resolved fonts). */
export interface BrandKit {
  colours: StarterBrand['colours'];
  typeRoles: StarterBrand['typeRoles'];
}

const base = (name: string, box: { x: number; y: number; width: number; height: number }) => ({
  id: newElementId(),
  name,
  locked: false,
  visible: true,
  opacity: 1,
  protected: false,
  transform: { ...box, rotation: 0 },
});

const centred = (page: CreativePage, width: number, height: number) => ({
  x: Math.round((page.width - width) / 2),
  y: Math.round((page.height - height) / 2),
  width: Math.round(width),
  height: Math.round(height),
});

/** The page background's colour value, when it is a token fill. */
function groundValue(page: CreativePage, kit: BrandKit): string | null {
  const bg = page.elements.find((e) => e.type === 'background');
  const token = bg?.type === 'background' ? bg.fillToken : undefined;
  return kit.colours.find((c) => c.key === token)?.value ?? null;
}

/** The brand colour with the most contrast against the page background (text tokens first when tied). */
export function textColourFor(page: CreativePage, kit: BrandKit): string | undefined {
  const ground = groundValue(page, kit) ?? '#FFFFFF';
  let best: { key: string; ratio: number } | null = null;
  for (const c of kit.colours) {
    const ratio = contrastRatio(c.value, ground) ?? -1;
    if (!best || ratio > best.ratio || (ratio === best.ratio && c.role === 'text'))
      best = { key: c.key, ratio };
  }
  return best?.key;
}

/** A fill for new shapes: the accent, else the primary, else the first colour. */
export const shapeFillFor = (kit: BrandKit): string | undefined =>
  (
    kit.colours.find((c) => c.role === 'accent') ??
    kit.colours.find((c) => c.role === 'primary') ??
    kit.colours[0]
  )?.key;

export type TextKind = 'heading' | 'body';

/** A text layer in the brand's font for the role, at a size proportional to the page, never below the role minimum. */
export function newTextElement(page: CreativePage, kit: BrandKit, kind: TextKind): Element | null {
  const role =
    kit.typeRoles.find((t) => t.role === kind) ??
    kit.typeRoles.find((t) => t.role === (kind === 'heading' ? 'display' : 'label')) ??
    kit.typeRoles[0];
  if (!role) return null;
  const short = Math.min(page.width, page.height);
  const sizePx = Math.max(role.minSizePx, Math.round(short * (kind === 'heading' ? 0.07 : 0.032)));
  const box = centred(page, page.width * 0.7, sizePx * 1.25 * (kind === 'heading' ? 2 : 3));
  const colourToken = textColourFor(page, kit);
  return {
    ...base(kind === 'heading' ? 'Heading' : 'Text', box),
    ...(kind === 'heading' ? { semanticRole: 'headline' as const } : { semanticRole: 'body' as const }),
    type: 'text',
    text: kind === 'heading' ? 'Your heading' : 'Your text',
    style: {
      typeRole: role.role,
      fontAssetVersionId: role.fontAssetVersionId,
      weight: role.weight,
      sizePx,
      lineHeight: kind === 'heading' ? 1.15 : 1.35,
      tracking: 0,
      ...(colourToken ? { colourToken } : {}),
      align: 'left',
      overflow: 'shrink_to_fit',
    },
    factRefs: [],
  };
}

export function newShapeElement(
  page: CreativePage,
  kit: BrandKit,
  shape: 'rect' | 'ellipse' | 'line',
): Element {
  const short = Math.min(page.width, page.height);
  const size = Math.round(short * 0.3);
  const box = shape === 'line' ? centred(page, page.width * 0.5, 6) : centred(page, size, size);
  const fillToken = shapeFillFor(kit);
  return {
    ...base(shape === 'rect' ? 'Rectangle' : shape === 'ellipse' ? 'Ellipse' : 'Line', box),
    type: 'shape',
    shape,
    ...(fillToken ? { fillToken } : {}),
    strokeWidth: 0,
    cornerRadius: 0,
  };
}

/** A full-page background in the brand's background colour; inserted at the back. */
export function newBackgroundElement(page: CreativePage, kit: BrandKit): Element {
  const fillToken = (kit.colours.find((c) => c.role === 'background') ?? kit.colours[0])?.key;
  return {
    ...base('Background', { x: 0, y: 0, width: page.width, height: page.height }),
    semanticRole: 'background',
    type: 'background',
    ...(fillToken ? { fillToken } : {}),
  };
}

/** An image area of a starter (a placeholder shape with the product role): the person fills it from the assets tab. */
export const isImageArea = (el: Element | null | undefined): boolean =>
  el?.type === 'shape' && el.semanticRole === 'product';

/** The image that fills an image area: same box, place in the layer order and corner radius as a mask. */
export function imageForArea(area: Element, assetVersionId: string, name: string): Element {
  const radius = area.type === 'shape' ? area.cornerRadius : 0;
  return {
    id: newElementId(),
    name,
    locked: false,
    visible: true,
    opacity: area.opacity,
    protected: false,
    semanticRole: 'product',
    transform: { ...area.transform },
    type: 'image',
    assetVersionId,
    fit: 'cover',
    ...(radius > 0 ? { mask: { kind: 'rounded' as const, radius } } : {}),
  };
}

/** A complete old → new id map for duplicatePage (groups' children included). */
export function freshIdMap(page: CreativePage): Record<string, string> {
  const map: Record<string, string> = {};
  const walk = (els: Element[]) => {
    for (const e of els) {
      map[e.id] = newElementId();
      if (e.type === 'group') walk(e.children);
    }
  };
  walk(page.elements);
  return map;
}
