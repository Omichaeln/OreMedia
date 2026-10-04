import { describe, expect, it } from 'vitest';
import {
  SPECIMEN_LINE_HEIGHT,
  TYPE_ROLES,
  fontStatus,
  formatTracking,
  specRows,
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
  it('lists role, font, weight, true size, the preview line height and tracking', () => {
    expect(specRows({ ...role('display', 48, -0.02), weight: 600 }, staticFace)).toEqual([
      ['role', 'display'],
      ['font', 'Karla'],
      ['weight', '600'],
      ['size', '48 px (minimum)'],
      ['line height', `${SPECIMEN_LINE_HEIGHT} (preview only)`],
      ['tracking', '-0.02 em'],
    ]);
  });
  it('says when tracking is not set and when the font is not one of the brand’s', () => {
    expect(formatTracking(undefined)).toBe('0 em (not set)');
    expect(formatTracking(0)).toBe('0 em');
    expect(specRows(role('body', 16), undefined)[1]).toEqual(['font', 'A font not in this brand']);
    expect(specRows(role('body', 16), { family: null, name: 'Brand.otf' })[1]).toEqual(['font', 'Brand.otf']);
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
