import { useMemo } from 'react';
import type { LogoVariant } from '@oremedia/contracts/brand';
import { starterBrandIssue, type StarterBrand } from '@oremedia/editor';
import { useAssetSearch, useBrandFonts } from '../../assets/use-assets';
import { useBrandVersion } from '../../brand/use-brand';

const TYPE_ROLES = ['display', 'heading', 'body', 'label', 'caption'] as const;

/**
 * STU-1a: the brand's published system in the shape starters are instantiated with: colour tokens, each type role's
 * font resolved to the version of the brand font it names, and each logo rule's usable logo (its pinned version, else
 * the asset's current eligible version) with the artwork's aspect ratio.
 */
export function useStarterBrand(brandId: string, versionId: string | null) {
  const version = useBrandVersion(brandId, versionId);
  const fonts = useBrandFonts(brandId);
  const logos = useAssetSearch(brandId, 'logo');
  const brand = useMemo((): StarterBrand | null => {
    const doc = version.data?.document;
    if (!doc || !versionId) return null;
    const faces = fonts.data?.items ?? [];
    const typeRoles = TYPE_ROLES.flatMap((role) => {
      const t = doc.tokens.typeRoles.find((r) => r.role === role);
      const face = t ? faces.find((f) => f.assetId === t.fontAssetId) : undefined;
      return t && face
        ? [{ role, fontAssetVersionId: face.assetVersionId, weight: t.weight, minSizePx: t.minSizePx }]
        : [];
    });
    const starterLogos = doc.logoRules.flatMap((rule) => {
      const asset = logos.items.find((a) =>
        rule.assetVersionId ? a.assetVersionId === rule.assetVersionId : a.assetId === rule.assetId,
      );
      if (!asset) return [];
      return [
        {
          variant: rule.variant as LogoVariant,
          assetVersionId: asset.assetVersionId,
          aspect: asset.width && asset.height ? asset.width / asset.height : 3,
          minWidthPx: rule.minWidthPx,
          allowedBackgroundColourKeys: rule.allowedBackgroundColourKeys,
        },
      ];
    });
    return { brandVersionId: versionId, colours: doc.tokens.colours, typeRoles, logos: starterLogos };
  }, [version.data, versionId, fonts.data, logos.items]);
  return {
    brand,
    issue: brand ? starterBrandIssue(brand) : null,
    isPending: version.isPending || fonts.isPending || logos.isPending,
    isError: version.isError || fonts.isError,
    error: version.error ?? fonts.error,
    refetch: () => {
      void version.refetch();
      void fonts.refetch();
    },
  };
}
