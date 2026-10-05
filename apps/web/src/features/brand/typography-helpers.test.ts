import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINE_HEIGHT,
  TYPE_ROLES,
  fontStatus,
  formatTracking,
  minSizeWarning,
  resolveLineHeight,
  specRows,
  specimenSizePx,
  typeScale,
  weightCoverage,
} from './typography-helpers';

const role = (
  r: 'display' | 'heading' | 'body' | 'label' | 'caption',
  minSizePx: number,
  tracking?: number,
) => ({
  role: r,
  fontAssetId: 'ast_font',
  weight: 400,
  minSizePx,
  ...(tracking !== undefined ? { tracking } : {}),
});

const staticFace = { family: 'Karla', name: 'Karla.ttf', weight: 400, weightRange: null };
const variableFace = {
  family: 'Inter',
  name: 'Inter.woff2',
  weight: 100,
  weightRange: { min: 100, max: 900 },
};

describe('type scale', () => {
  it('orders the configured roles largest first and numbers each step of the scale', () => {
    const scale = typeScale([role('body', 18), role('caption', 12), role('display', 40), role('label', 14)]);
    expect(scale.map((s) => [s.role.role, s.step, s.of])).toEqual([
      ['display', 1, 4],
      ['body', 2, 4],
      ['label', 3, 4],
      ['caption', 4, 4],
    ]);
  });
  it('keeps the contract role order for equal sizes and never adds a role the brand does not define', () => {
    expect(typeScale([role('label', 14), role('heading', 14)]).map((s) => s.role.role)).toEqual([
      'heading',
      'label',
    ]);
    expect(typeScale([])).toEqual([]);
  });
  it('covers every contract role with a sample and an intended use', () => {
    for (const r of TYPE_ROLES) {
      expect(r.sample.length).toBeGreaterThan(0);
      expect(r.use.length).toBeGreaterThan(0);
    }
  });
});

describe('spec label', () => {
  it('lists role, font, weight, the size drawn and the minimum apart, line height and tracking', () => {
    expect(
      specRows({ ...role('display', 40, -0.02), weight: 600, sizePx: 56, lineHeight: 1.05 }, staticFace),
    ).toEqual([
      ['role', 'display'],
      ['font', 'Karla'],
      ['weight', '600'],
      ['specimen size', '56 px'],
      ['minimum size', '40 px'],
      ['line height', '1.05'],
      ['tracking', '-0.02 em'],
    ]);
  });
  it('labels what a stored role does not set: the size is the minimum and the line height the default', () => {
    expect(specRows(role('display', 48), staticFace).slice(3, 6)).toEqual([
      ['specimen size', '48 px (the minimum; no size set)'],
      ['minimum size', '48 px'],
      ['line height', `${DEFAULT_LINE_HEIGHT} (default; not set)`],
    ]);
    // An emptied minimum is stored as 0: no minimum is claimed.
    expect(specRows({ ...role('body', 0), sizePx: 16 }, staticFace)[4]).toEqual(['minimum size', 'not set']);
  });
  it('says when tracking is not set and when the font is not one of the brand’s', () => {
    expect(formatTracking(undefined)).toBe('0 em (not set)');
    expect(formatTracking(0)).toBe('0 em');
    expect(specRows(role('body', 16), undefined)[1]).toEqual(['font', 'A font not in this brand']);
    expect(specRows(role('body', 16), { family: null, name: 'Brand.otf' })[1]).toEqual(['font', 'Brand.otf']);
  });
});

describe('line height and size', () => {
  it('uses the configured line height where the guidance stores one, else the labelled default', () => {
    expect(resolveLineHeight({ lineHeight: 1.5 })).toEqual({ value: 1.5, configured: true });
    expect(resolveLineHeight({})).toEqual({ value: DEFAULT_LINE_HEIGHT, configured: false });
  });
  it('draws a role at its intended size, else at its minimum', () => {
    expect(specimenSizePx({ minSizePx: 16, sizePx: 18 })).toBe(18);
    expect(specimenSizePx({ minSizePx: 16 })).toBe(16);
  });
  it('orders the scale by the size each role is drawn at', () => {
    const scale = typeScale([{ ...role('heading', 28), sizePx: 32 }, { ...role('display', 30) }]);
    expect(scale.map((s) => s.role.role)).toEqual(['heading', 'display']);
  });
  it('warns when a role is set below its own minimum, naming both sizes and what to do', () => {
    const w = minSizeWarning({ minSizePx: 28, sizePx: 24 });
    expect(w?.tone).toBe('warning');
    expect(w?.title).toContain('Set at 24 px, below this role’s 28 px minimum');
    expect(w?.action).toContain('at least 28 px');
  });
  it('is quiet at or above the minimum, without an intended size, or without a minimum', () => {
    expect(minSizeWarning({ minSizePx: 28, sizePx: 28 })).toBeNull();
    expect(minSizeWarning({ minSizePx: 28, sizePx: 40 })).toBeNull();
    expect(minSizeWarning({ minSizePx: 28 })).toBeNull();
    expect(minSizeWarning({ minSizePx: 0, sizePx: 12 })).toBeNull();
  });
});

describe('font status', () => {
  it('reads a weight as covered by a static weight or a variable range', () => {
    expect(weightCoverage(staticFace, 400)).toBe('covered');
    expect(weightCoverage(staticFace, 700)).toBe('uncovered');
    expect(weightCoverage(variableFace, 700)).toBe('covered');
    expect(weightCoverage({ weight: null, weightRange: null }, 700)).toBe('unknown');
  });
  it('is quiet when the specimen shows the face it is labelled with', () => {
    expect(fontStatus({ face: staticFace, weight: 400, load: 'loaded', rendered: 'unchecked' })).toBeNull();
    expect(fontStatus({ face: variableFace, weight: 700, load: 'loaded', rendered: 'unchecked' })).toBeNull();
    // An uploaded variable file is listed as static; the browser drew the weight differently, so it is there.
    expect(fontStatus({ face: staticFace, weight: 600, load: 'loaded', rendered: 'distinct' })).toBeNull();
  });
  it('names the family and weight that failed to load and what to do', () => {
    const s = fontStatus({ face: staticFace, weight: 600, load: 'failed', rendered: 'unchecked' });
    expect(s?.tone).toBe('critical');
    expect(s?.title).toContain('Karla 600 did not load');
    expect(s?.title).toContain('fallback font');
    expect(s?.action).toContain('upload');
  });
  it('warns when the file has no such weight instead of labelling the drawn weight as the configured one', () => {
    const s = fontStatus({ face: staticFace, weight: 700, load: 'loaded', rendered: 'same' });
    expect(s?.tone).toBe('warning');
    expect(s?.title).toContain('Karla has no weight 700');
    expect(s?.action).toContain('weight 700');
  });
  it('flags a role whose font is not one of the brand’s, and says when a font is still loading', () => {
    expect(fontStatus({ face: undefined, weight: 400, load: 'failed', rendered: 'unchecked' })?.tone).toBe(
      'critical',
    );
    expect(fontStatus({ face: staticFace, weight: 400, load: 'loading', rendered: 'unchecked' })).toEqual({
      tone: 'info',
      title: 'Loading Karla…',
      action: '',
    });
  });
});
