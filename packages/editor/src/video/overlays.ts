import type { CreativePage, Element, FormatDefinition } from '@oremedia/contracts/creative';
import {
  videoFormatFor,
  type CaptionItem,
  type CaptionTrack,
  type OverlayAnimation,
  type OverlayItem,
  type VideoProjectV1,
} from '@oremedia/contracts/video';

/**
 * Overlays and captions draw through the graphic scene renderer (packages/editor/src/renderer/scene.ts) so the
 * editor preview and the exported video use the same fonts, colours and text layout. These helpers turn timeline
 * items into single-purpose pages at the project's size (transparent: no background element), and state the enter
 * and exit animation maths the preview applies per frame and the compositor writes as ffmpeg expressions.
 */

/** The project's output frame as a format definition (safe areas from the preset). */
export function videoFormatOf(project: VideoProjectV1): FormatDefinition {
  const preset = videoFormatFor(project.format.key);
  return {
    key: project.format.key,
    label: preset?.label ?? project.format.key,
    width: project.format.width,
    height: project.format.height,
    safeArea: preset?.safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 },
    providerKeys: preset?.providerKeys ?? [],
  };
}

/** A transparent page holding the given elements at the project's size. */
export function framePage(project: VideoProjectV1, id: string, elements: Element[]): CreativePage {
  return {
    id,
    name: id,
    formatKey: project.format.key,
    width: project.format.width,
    height: project.format.height,
    elements,
    layoutConstraints: [],
  };
}

export const overlayPage = (project: VideoProjectV1, overlay: OverlayItem): CreativePage =>
  framePage(project, `overlay_${overlay.id}`, [overlay.element]);

/** Lines a caption is laid out for before the renderer shrinks it to fit (shrink_to_fit). */
export const CAPTION_MAX_LINES = 3;

/**
 * A caption as elements: an optional box (the style's box colour at its opacity) behind a centred text block, at
 * the top, middle or bottom of the safe area. Long captions shrink to fit the block (the renderer's
 * shrink_to_fit), so a caption never overflows the frame.
 */
export function captionElements(
  project: VideoProjectV1,
  track: CaptionTrack,
  caption: CaptionItem,
): Element[] {
  const format = videoFormatOf(project);
  const style = track.style;
  const position = caption.position ?? style.position;
  const pad = Math.round(style.sizePx * 0.4);
  const width = format.width - format.safeArea.left - format.safeArea.right;
  const approxCharsPerLine = Math.max(1, Math.floor((width - 2 * pad) / (0.55 * style.sizePx)));
  const lines = Math.min(
    CAPTION_MAX_LINES,
    Math.max(1, Math.ceil([...caption.text].length / approxCharsPerLine)),
  );
  const textHeight = Math.ceil(lines * style.sizePx * 1.25);
  const height = textHeight + 2 * pad;
  const x = format.safeArea.left;
  const y =
    position === 'top'
      ? format.safeArea.top
      : position === 'middle'
        ? Math.round((format.height - height) / 2)
        : format.height - format.safeArea.bottom - height;
  const base = { locked: true, visible: true, protected: false, opacity: 1 };
  const out: Element[] = [];
  if (style.boxToken)
    out.push({
      ...base,
      id: `cap_${caption.id}_box`,
      name: 'Caption box',
      type: 'shape',
      shape: 'rect',
      fillToken: style.boxToken,
      strokeWidth: 0,
      cornerRadius: Math.round(pad / 2),
      opacity: style.boxOpacity,
      transform: { x, y, width, height, rotation: 0 },
    });
  out.push({
    ...base,
    id: `cap_${caption.id}_text`,
    name: 'Caption',
    type: 'text',
    text: caption.text,
    factRefs: [],
    semanticRole: 'body',
    transform: { x: x + pad, y: y + pad, width: width - 2 * pad, height: textHeight, rotation: 0 },
    style: {
      typeRole: 'caption',
      fontAssetVersionId: style.fontAssetVersionId,
      weight: style.weight,
      sizePx: style.sizePx,
      lineHeight: 1.25,
      tracking: 0,
      ...(style.colourToken ? { colourToken: style.colourToken } : {}),
      ...(style.colourValue ? { colourValue: style.colourValue } : {}),
      align: 'center',
      overflow: 'shrink_to_fit',
    },
  });
  return out;
}

export const captionPage = (
  project: VideoProjectV1,
  track: CaptionTrack,
  caption: CaptionItem,
): CreativePage => framePage(project, `caption_${caption.id}`, captionElements(project, track, caption));

/** Fraction of the frame height a slide-up enter (or slide-down exit) travels. */
export const SLIDE_FRACTION = 0.08;

const active = (a: OverlayAnimation | undefined): a is OverlayAnimation =>
  a !== undefined && a.kind !== 'none' && a.durationMs > 0;

/**
 * How an overlay looks at timeline time `ms` (inside its window): opacity 0..1 and a vertical offset in pixels.
 * Linear ramps: a fade enter goes 0 → 1 over its duration, a slide_up enter starts SLIDE_FRACTION of the height
 * lower and rises; exits mirror them. The compositor uses the same formulas (filter-graph.ts).
 */
export function overlayAnimationAt(
  overlay: Pick<OverlayItem, 'startMs' | 'endMs' | 'enter' | 'exit'>,
  ms: number,
  frameHeight: number,
): { opacity: number; dy: number } {
  let opacity = 1;
  let dy = 0;
  const { enter, exit } = overlay;
  if (active(enter) && ms < overlay.startMs + enter.durationMs) {
    const p = Math.max(0, (ms - overlay.startMs) / enter.durationMs);
    if (enter.kind === 'fade') opacity = Math.min(opacity, p);
    if (enter.kind === 'slide_up') dy += (1 - p) * SLIDE_FRACTION * frameHeight;
  }
  if (active(exit) && ms > overlay.endMs - exit.durationMs) {
    const p = Math.max(0, (overlay.endMs - ms) / exit.durationMs);
    if (exit.kind === 'fade') opacity = Math.min(opacity, p);
    if (exit.kind === 'slide_up') dy -= (1 - p) * SLIDE_FRACTION * frameHeight;
  }
  return { opacity, dy };
}

/** WebVTT for the project's captions (every caption track, by start time); the export's captions sidecar. */
export function captionsVtt(project: VideoProjectV1): string | null {
  const cues = project.tracks
    .flatMap((t) => (t.kind === 'caption' ? t.items : []))
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  if (!cues.length) return null;
  const stamp = (ms: number) => {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const f = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
  };
  // A cue's text may not contain "-->" or blank lines (WebVTT); both are neutralised.
  const clean = (text: string) =>
    text
      .replace(/-->/g, '->')
      .replace(/\n\s*\n/g, '\n')
      .trim();
  return `WEBVTT\n\n${cues
    .map(
      (c, i) =>
        `${i + 1}\n${stamp(c.startMs)} --> ${stamp(Math.min(c.endMs, project.durationMs))}\n${clean(c.text)}`,
    )
    .join('\n\n')}\n`;
}
