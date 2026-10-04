import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { LogoVariant } from '@oremedia/contracts/brand';
import { starterBrandIssue, type StarterBrand } from '@oremedia/editor';
import { useTRPC } from '../../../lib/trpc';
import { useBrandFonts } from '../../assets/use-assets';
import { useBrandVersion } from '../../brand/use-brand';
import { LOGO_LABEL } from '../../brand/logo-rules';

const TYPE_ROLES = ['display', 'heading', 'body', 'label', 'caption'] as const;

/**
 * STU-1a: the brand's published system in the shape starters are instantiated with: colour tokens, each type role's
 * font resolved to the version of the brand font it names, and each logo rule's logo by the version the rule pins
 * (else the asset's current version), read from the asset itself (one read per rule, not a search page). Only the
 * current version of a logo can be used in new work (BSC-2), so a pin to a superseded version, or a logo that cannot
 * be loaded, leaves that variant out with a note saying why.
 */
export function useStarterBrand(brandId: string, versionId: string | null) {
  const trpc = useTRPC();
  const version = useBrandVersion(brandId, versionId);
  const fonts = useBrandFonts(brandId);
  const rules = version.data?.document.logoRules ?? [];
  const assets = useQueries({
    queries: rules.map((rule) => ({
      ...trpc.assets.get.queryOptions({ assetId: rule.assetId }),
      retry: false,
    })),
  });
  // useQueries returns new objects every render: the reads are reduced to plain data (stable through JSON).
  const logoJson = JSON.stringify(
    assets.map((a) => ({
      pending: a.isPending,
      failed: a.isError,
      current: a.data?.currentVersion
        ? {
            id: a.data.currentVersion.id,
            width: a.data.currentVersion.width,
            height: a.data.currentVersion.height,
          }
        : null,
    })),
  );
  const logoReads = useMemo(
    () =>
      JSON.parse(logoJson) as Array<{
        pending: boolean;
        failed: boolean;
        current: { id: string; width: number | null; height: number | null } | null;
      }>,
    [logoJson],
  );
  const resolved = useMemo(() => {
    const doc = version.data?.document;
    if (!doc || !versionId) return { brand: null as StarterBrand | null, notes: [] as string[] };
    const faces = fonts.data?.items ?? [];
    const typeRoles = TYPE_ROLES.flatMap((role) => {
      const t = doc.tokens.typeRoles.find((r) => r.role === role);
      const face = t ? faces.find((f) => f.assetId === t.fontAssetId) : undefined;
      return t && face
        ? [{ role, fontAssetVersionId: face.assetVersionId, weight: t.weight, minSizePx: t.minSizePx }]
        : [];
    });
    const notes: string[] = [];
    const logos = doc.logoRules.flatMap((rule, i) => {
      const label = LOGO_LABEL[rule.variant] ?? rule.variant;
      const read = logoReads[i];
      if (!read || read.pending) return [];
      const current = read.current;
      if (read.failed || !current) {
        notes.push(`The ${label.toLowerCase()} logo could not be loaded, so starters are made without it.`);
        return [];
      }
      if (rule.assetVersionId && rule.assetVersionId !== current.id) {
        notes.push(
          `The brand system pins an earlier version of the ${label.toLowerCase()} logo; update it in the brand system (logos) to use it in starters.`,
        );
        return [];
      }
      return [
        {
          variant: rule.variant as LogoVariant,
          assetVersionId: current.id,
          aspect: current.width && current.height ? current.width / current.height : 3,
          minWidthPx: rule.minWidthPx,
          allowedBackgroundColourKeys: rule.allowedBackgroundColourKeys,
        },
      ];
    });
    return { brand: { brandVersionId: versionId, colours: doc.tokens.colours, typeRoles, logos }, notes };
  }, [version.data, versionId, fonts.data, logoReads]);
  return {
    brand: resolved.brand,
    notes: resolved.notes,
    issue: resolved.brand ? starterBrandIssue(resolved.brand) : null,
    isPending: version.isPending || fonts.isPending || assets.some((a) => a.isPending),
    isError: version.isError || fonts.isError,
    error: version.error ?? fonts.error,
    refetch: () => {
      void version.refetch();
      void fonts.refetch();
    },
  };
}
