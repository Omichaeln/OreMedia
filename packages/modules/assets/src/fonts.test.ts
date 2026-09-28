import { describe, expect, it } from 'vitest';
import type { Provenance } from '@oremedia/contracts/assets';
import {
  groupFontFaces,
  renderFontFaces,
  styleFromSubfamily,
  weightFromSubfamily,
  type FontFileRow,
} from './fonts';

const imported = (
  subset: string | null,
  weight = 400,
  style: 'normal' | 'italic' = 'normal',
): Provenance => ({
  kind: 'imported',
  source: 'google_fonts',
  externalRef: `https://fonts.gstatic.com/s/inter/v1/${subset}-${weight}.woff2`,
  font: {
    family: 'Inter',
    weight,
    style,
    subset,
    unicodeRange: subset === 'latin' ? 'U+0000-00FF' : subset === 'latin-ext' ? 'U+0100-02AF' : null,
  },
  licence: 'per fonts.google.com',
});
const uploaded: Provenance = {
  kind: 'upload',
  uploadedByUserId: 'usr_1',
  originalFilename: 'Brand-SemiBoldItalic.otf',
  fontMetadata: {
    family: 'Brand Sans',
    subfamily: 'SemiBold Italic',
    postscriptName: null,
    copyright: null,
    licence: 'Commercial',
    licenceUrl: null,
    fontVersion: null,
    glyphs: 10,
  },
};
const row = (assetId: string, provenance: Provenance, extra: Partial<FontFileRow> = {}): FontFileRow => ({
  assetId,
  assetName: `${assetId}.woff2`,
  assetState: 'approved',
  assetVersionId: `av_${assetId}`,
  mime: 'font/woff2',
  bytes: 100,
  provenance,
  ...extra,
});

describe('brand font faces', () => {
  it('reads weight and style from a subfamily name', () => {
    expect(weightFromSubfamily('SemiBold Italic')).toBe(600);
    expect(weightFromSubfamily('ExtraLight')).toBe(200);
    expect(weightFromSubfamily('Extra Bold')).toBe(800);
    expect(weightFromSubfamily('Bold')).toBe(700);
    expect(weightFromSubfamily('Italic')).toBe(400);
    expect(weightFromSubfamily('Condensed')).toBeNull();
    expect(weightFromSubfamily(null)).toBeNull();
    expect(styleFromSubfamily('Bold Oblique')).toBe('italic');
    expect(styleFromSubfamily('Regular')).toBe('normal');
  });

  it('groups the subset files of an imported face; an upload is a face of its own', () => {
    const faces = groupFontFaces([
      row('ast_ext', imported('latin-ext')),
      row('ast_lat', imported('latin')),
      row('ast_bold', imported('latin', 700)),
      row('ast_up', uploaded, { mime: 'font/otf', assetState: 'pending_review' }),
    ]);
    expect(faces.map((f) => [f.family, f.weight, f.style, f.assetId, f.files.length])).toEqual([
      ['Brand Sans', 600, 'italic', 'ast_up', 1],
      ['Inter', 400, 'normal', 'ast_lat', 2],
      ['Inter', 700, 'normal', 'ast_bold', 1],
    ]);
    const regular = faces[1];
    expect(regular?.files.map((f) => [f.subset, f.unicodeRange])).toEqual([
      ['latin', 'U+0000-00FF'],
      ['latin-ext', 'U+0100-02AF'],
    ]);
    expect(regular).toMatchObject({
      source: 'google_fonts',
      licence: 'per fonts.google.com',
      format: 'woff2',
    });
    expect(faces[0]).toMatchObject({
      source: 'upload',
      state: 'pending_review',
      licence: 'Commercial',
      format: 'otf',
    });
  });

  it('keys an imported face by the source release and weight range: a re-import after an update is a new face', () => {
    const v2 = (subset: string): Provenance => {
      const p = imported(subset);
      return p.kind === 'imported' ? { ...p, externalRef: p.externalRef.replace('/v1/', '/v2/') } : p;
    };
    const variable = (subset: string): Provenance => {
      const p = imported(subset, 100);
      return p.kind === 'imported' && p.font
        ? { ...p, font: { ...p.font, weightRange: { min: 100, max: 900 } } }
        : p;
    };
    const faces = groupFontFaces([
      row('ast_lat1', imported('latin')),
      row('ast_ext1', imported('latin-ext')),
      row('ast_lat2', v2('latin')),
      row('ast_var', variable('latin')),
    ]);
    expect(faces.map((f) => [f.key, f.files.length, f.weightRange])).toEqual([
      ['google_fonts:inter:v1:100-900:normal', 1, { min: 100, max: 900 }],
      ['google_fonts:inter:v1:400:normal', 2, null],
      ['google_fonts:inter:v2:400:normal', 1, null],
    ]);
  });

  it('registers every pinned file of a face under the referenced version, with its range', () => {
    const pinned = [
      { assetVersionId: 'av_lat', assetId: 'ast_lat', provenance: imported('latin') },
      { assetVersionId: 'av_ext', assetId: 'ast_ext', provenance: imported('latin-ext') },
      { assetVersionId: 'av_up', assetId: 'ast_up', provenance: uploaded },
    ];
    expect(renderFontFaces(['av_lat', 'av_up', 'av_lat'], pinned)).toEqual([
      { family: 'av_lat', assetVersionId: 'av_lat', unicodeRange: 'U+0000-00FF' },
      { family: 'av_lat', assetVersionId: 'av_ext', unicodeRange: 'U+0100-02AF' },
      { family: 'av_up', assetVersionId: 'av_up', unicodeRange: null },
    ]);
    // A job resolved before faces were expanded pins only the referenced file: registered whole, as before.
    expect(renderFontFaces(['av_lat'], pinned.slice(0, 1))).toEqual([
      { family: 'av_lat', assetVersionId: 'av_lat', unicodeRange: null },
    ]);
  });
});
