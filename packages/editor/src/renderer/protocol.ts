import type { CreativePage, FormatDefinition } from '@oremedia/contracts/creative';
import type { SceneMetrics } from './metrics';

/**
 * The contract between the render worker and window.__oremediaRender in the render-only bundle (entry.ts).
 * Everything is already resolved: fonts and assets are data: URLs, colours are the brand's token values, so the
 * page fetches nothing (spec 11.5 render isolation). Kept free of DOM types for the Node side.
 */
export interface RenderInput {
  page: CreativePage;
  format: FormatDefinition;
  /**
   * Every file is registered under `family`; a face served as several files (one per unicode subset) lists each file
   * with its `unicodeRange`, so the browser picks the file that covers each character.
   */
  fonts: Array<{ family: string; url: string; unicodeRange?: string }>;
  assets: Record<string, string>;
  colours: Record<string, string>;
}

export interface RenderOutput {
  dataUrl: string;
  metrics: SceneMetrics;
  rendererVersion: string;
}
