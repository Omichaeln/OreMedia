import { useMemo } from 'react';
import { useBrandContext } from '../brand/brand-context';
import { useBrandFonts } from '../assets/use-assets';
import { useFontFaces } from '../assets/use-font-faces';

/**
 * Spec 11.5: document fonts are asset versions (pinned files), never system fonts. Each ref is loaded as a FontFace
 * under its own id, joined by the other subset files of its face when the brand's fonts list one (an imported face),
 * as the render worker does; the scene falls back and reports missingFont for refs that are not loaded.
 */
export function useDocumentFonts(fontRefs: string[]): (ref: string) => string | null {
  const { brandId } = useBrandContext();
  const faces = useBrandFonts(brandId);
  const files = useMemo(
    () =>
      fontRefs.flatMap((ref) => {
        const face = faces.data?.items.find((f) => f.files.some((x) => x.assetVersionId === ref));
        if (!face || face.files.length <= 1)
          return [{ family: ref, assetVersionId: ref, unicodeRange: null }];
        return face.files.map((x) => ({
          family: ref,
          assetVersionId: x.assetVersionId,
          unicodeRange: x.unicodeRange,
        }));
      }),
    [fontRefs, faces.data],
  );
  const loaded = useFontFaces(files);
  return (ref) => (loaded.has(ref) ? ref : null);
}
