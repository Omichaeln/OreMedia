import { useEffect, useMemo, useRef, useState } from 'react';
import { fontFaceDescriptors } from '@oremedia/editor';
import type { FontLoadState } from '../brand/typography-helpers';
import { useAssetUrlState } from './use-assets';

/** One pinned font file to register: under `family`, limited to `unicodeRange` when its face has several files. */
export interface FontFaceFile {
  family: string;
  assetVersionId: string;
  unicodeRange: string | null;
}

/**
 * Spec 11.5: fonts are asset versions (pinned files), never system fonts. Each file is loaded from a short-lived
 * signed URL as a FontFace under its family, with the same descriptors as the render worker (fontFaceDescriptors),
 * so the studio and the brand kit preview draw what the export will. Returns the families whose files all loaded.
 * Signed URLs are renewed every few minutes: the faces this hook added are replaced by the new set once it has
 * loaded (never left to accumulate in document.fonts), and removed when the component unmounts.
 */
export function useFontFaces(files: FontFaceFile[]): ReadonlySet<string> {
  const status = useFontFaceStatus(files);
  return useMemo(
    () => new Set([...status].filter(([, s]) => s === 'loaded').map(([family]) => family)),
    [status],
  );
}

/**
 * As useFontFaces, per family: loading, loaded, or failed (a file did not load, or its signed URL could not be
 * issued), so a preview can say its font is missing instead of drawing a fallback under the font's name.
 */
export function useFontFaceStatus(files: FontFaceFile[]): ReadonlyMap<string, FontLoadState> {
  const { urls, failed: unsigned } = useAssetUrlState(
    [...new Set(files.map((f) => f.assetVersionId))],
    'original',
  );
  const [settled, setSettled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const entries = files
    .map((f) => [f.family, f.unicodeRange ?? '', urls.get(f.assetVersionId) ?? ''].join('\u0000'))
    .filter((e) => !e.endsWith('\u0000'))
    .join('\n');
  const added = useRef<FontFace[]>([]);
  useEffect(
    () => () => {
      for (const face of added.current) document.fonts?.delete(face);
      added.current = [];
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || entries.length === 0) return;
    void Promise.all(
      entries.split('\n').map(async (line) => {
        const [family, range, url] = line.split('\u0000');
        if (!family || !url) return null;
        try {
          const face = new FontFace(family, `url(${url})`, fontFaceDescriptors(range || null));
          await face.load();
          return { family, ok: true, face };
        } catch {
          return { family, ok: false, face: null };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const next = results.flatMap((r) => (r?.face ? [r.face] : []));
      for (const face of next) fonts.add(face);
      for (const face of added.current) fonts.delete(face);
      added.current = next;
      const ok = new Map<string, boolean>();
      for (const r of results) if (r) ok.set(r.family, (ok.get(r.family) ?? true) && r.ok);
      setSettled(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);
  const unsignedFamilies = files
    .filter((f) => unsigned.has(f.assetVersionId))
    .map((f) => f.family)
    .join('\n');
  const families = [...new Set(files.map((f) => f.family))].join('\n');
  return useMemo(() => {
    const failedFamilies = new Set(unsignedFamilies.split('\n'));
    const status = new Map<string, FontLoadState>();
    for (const family of families ? families.split('\n') : []) {
      const done = settled.get(family);
      status.set(
        family,
        failedFamilies.has(family) || done === false ? 'failed' : done ? 'loaded' : 'loading',
      );
    }
    return status;
  }, [families, unsignedFamilies, settled]);
}
