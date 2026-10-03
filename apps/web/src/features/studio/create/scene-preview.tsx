import { useLayoutEffect, useMemo, useRef } from 'react';
import Konva from 'konva';
import type { CreativeDocumentV1, CreativePage } from '@oremedia/contracts/creative';
import { formatForPage } from '@oremedia/editor';
import { buildScene } from '@oremedia/editor/renderer/scene';
import { cn } from '@oremedia/ui';
import { useAssetUrls } from '../../assets/use-assets';
import { assetVersionIdsOf, fontRefsOf, logoVersionIdsOf } from '../document-helpers';
import { useDocumentFonts } from '../use-document-fonts';

/** What the previews of a gallery need to draw brand documents: asset URLs, loaded fonts and colour values. */
export interface PreviewResolvers {
  resolveAssetUrl: (assetVersionId: string) => string | null;
  fontFamilyFor: (ref: string) => string | null;
  colourFor: (token: string) => string | null;
  /** Changes when any answer changes, so previews redraw (URLs arrive, fonts load). */
  version: string;
}

/** One set of resolvers for every document a gallery previews (they share the brand's fonts, logos and tokens). */
export function usePreviewResolvers(
  documents: readonly CreativeDocumentV1[],
  colours: ReadonlyArray<{ key: string; value: string }>,
): PreviewResolvers {
  const all = useMemo(
    (): CreativeDocumentV1 => ({
      schemaVersion: 1,
      brandVersionId: '',
      pages: documents.flatMap((d) => d.pages),
      variants: [],
    }),
    [documents],
  );
  const logoIds = useMemo(() => logoVersionIdsOf(all), [all]);
  const imageIds = useMemo(
    () => assetVersionIdsOf(all).filter((id) => !logoIds.includes(id)),
    [all, logoIds],
  );
  const fontRefs = useMemo(() => fontRefsOf(all), [all]);
  const logoUrls = useAssetUrls(logoIds, 'original');
  const imageUrls = useAssetUrls(imageIds);
  const fontFamilyFor = useDocumentFonts(fontRefs);
  const urls = new Map([...imageUrls, ...logoUrls]);
  const colourMap = new Map(colours.map((c) => [c.key, c.value]));
  return {
    resolveAssetUrl: (id) => urls.get(id) ?? null,
    fontFamilyFor,
    colourFor: (token) => colourMap.get(token) ?? null,
    version: `${[...urls.values()].join(',').length}|${fontRefs.map(fontFamilyFor).join(',')}|${colours.length}`,
  };
}

/**
 * A page drawn by the same scene code as the studio canvas and the render worker (packages/editor/src/renderer),
 * scaled to `width` CSS pixels; read-only and not focusable. The label says what it shows for screen readers.
 */
export function ScenePreview({
  page,
  width,
  resolvers,
  label,
  className,
}: {
  page: CreativePage;
  width: number;
  resolvers: PreviewResolvers;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(resolvers);
  latest.current = resolvers;
  const scale = width / page.width;
  const height = Math.round(page.height * scale);
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const stage = new Konva.Stage({
      container: container as HTMLDivElement,
      width,
      height,
      listening: false,
    });
    stage.scale({ x: scale, y: scale });
    const layer = new Konva.Layer({ listening: false });
    stage.add(layer);
    const scene = buildScene(layer, page, {
      format: formatForPage(page),
      resolveAssetUrl: (id) => latest.current.resolveAssetUrl(id),
      fontFamilyFor: (r) => latest.current.fontFamilyFor(r),
      colourFor: (t) => latest.current.colourFor(t),
    });
    layer.batchDraw();
    let alive = true;
    void scene.ready().then(() => {
      if (alive) layer.batchDraw();
    });
    return () => {
      alive = false;
      scene.destroy();
      stage.destroy();
    };
  }, [page, width, height, scale, resolvers.version]);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      style={{ width, height }}
      className={cn('overflow-hidden rounded-sm border border-border bg-muted', className)}
      data-testid="scene-preview"
    />
  );
}
