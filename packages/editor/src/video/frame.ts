import type { ClipFrame } from '@oremedia/contracts/video';

/**
 * Where a source lands in the output frame, for both the preview canvas and the compositor's ffmpeg scale, crop and
 * pad (so a framed clip looks the same in the editor and the export):
 *  - `fill` scales the source to cover the frame (times `zoom`) and crops around the focal point;
 *  - `fit` scales it to fit inside (times `zoom`), crops what a zoom pushes outside, and pads with black.
 * Scaled sizes are even (yuv420p), crops are clamped inside the scaled source.
 */
export interface FramePlacement {
  /** The source scaled to this size. */
  scaledWidth: number;
  scaledHeight: number;
  /** Then cropped to this rectangle of the scaled source. */
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  /** Then placed at this offset in the output frame (black around it). */
  padX: number;
  padY: number;
}

/** Up to the next even pixel, so a cover never falls a pixel short of the frame. */
const even = (n: number) => Math.max(2, 2 * Math.ceil(n / 2 - 1e-9));

export function framePlacement(
  source: { width: number; height: number },
  output: { width: number; height: number },
  frame: ClipFrame,
): FramePlacement {
  const sw = Math.max(1, source.width);
  const sh = Math.max(1, source.height);
  const base =
    frame.fit === 'fill'
      ? Math.max(output.width / sw, output.height / sh)
      : Math.min(output.width / sw, output.height / sh);
  const scale = base * frame.zoom;
  const scaledWidth = even(sw * scale);
  const scaledHeight = even(sh * scale);
  const cropWidth = Math.min(output.width, scaledWidth);
  const cropHeight = Math.min(output.height, scaledHeight);
  // Even offsets: yuv420p chroma is subsampled by two, and the preview uses the same numbers.
  const clamp = (v: number, max: number) => 2 * Math.floor(Math.max(0, Math.min(max, v)) / 2);
  const cropX = clamp(frame.focalX * scaledWidth - cropWidth / 2, scaledWidth - cropWidth);
  const cropY = clamp(frame.focalY * scaledHeight - cropHeight / 2, scaledHeight - cropHeight);
  return {
    scaledWidth,
    scaledHeight,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    padX: Math.floor((output.width - cropWidth) / 2),
    padY: Math.floor((output.height - cropHeight) / 2),
  };
}
