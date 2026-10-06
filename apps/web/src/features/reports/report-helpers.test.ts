import { describe, expect, it } from 'vitest';
import { emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import {
  FALLBACK_KIT,
  contrastOf,
  kitOf,
  legible,
  monthOptions,
  pageOrder,
  shiftMonth,
} from './report-helpers';

describe('report helpers', () => {
  it('kit colours read on their surfaces: a pale neutral is darkened, a teal accent lightened on the dark cover', () => {
    const doc = {
      ...emptyBrandSystemDocument(),
      tokens: {
        ...emptyBrandSystemDocument().tokens,
        colours: [
          { key: 'ink', value: '#172120', role: 'text' as const },
          { key: 'paper', value: '#F4F6F3', role: 'background' as const },
          { key: 'teal', value: '#0f6e63', role: 'accent' as const },
          { key: 'mist', value: '#d3dad5', role: 'neutral' as const },
        ],
      },
    };
    const kit = kitOf(doc);
    expect(kit.ink).toBe('#172120');
    expect(kit.light).toBe('#F4F6F3');
    expect(kit.dark).toBe('#172120');
    expect(contrastOf(kit.muted, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(kit.muted).not.toBe(FALLBACK_KIT.muted); // the brand's hue, darkened, not the fallback
    expect(contrastOf(kit.accentInk, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(kit.accentOnDark, kit.dark)).toBeGreaterThanOrEqual(4.5);
    expect(kit.accent).toBe('#0f6e63'); // marks keep the brand's colour
  });
  it('falls back where nothing is published or a colour cannot be read', () => {
    expect(kitOf(null)).toBe(FALLBACK_KIT);
    expect(legible('oklch(0.5 0.1 150)', '#ffffff', '#111111')).toBe('#111111');
    expect(legible(null, '#ffffff', '#111111')).toBe('#111111');
    expect(legible('#000000', '#ffffff', '#111111')).toBe('#000000');
  });
  it('months and pages', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthOptions('2026-10')).toHaveLength(12);
    expect(monthOptions('2026-10')[11]).toBe('2025-11');
    expect(pageOrder(['posts', 'cover'])).toEqual(['cover', 'posts']);
  });
});
