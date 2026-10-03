import { useState } from 'react';

/**
 * STU-2a inline players for video and audio (the asset inspector and the review screens). Signed URLs are re-signed
 * every few minutes by their queries; a player keeps the URL it started with (changing `src` restarts playback) and
 * takes the newest one only when the old one fails (expired), so an open review never loses its place silently.
 */
function useStableSrc(latest: string | null): { src: string | null; onError: () => void } {
  const [held, setHeld] = useState<string | null>(latest);
  const src = held ?? latest;
  return {
    src,
    onError: () => {
      if (latest && latest !== held) setHeld(latest);
    },
  };
}

export function VideoPlayer({
  src: latest,
  poster,
  captions,
  label,
  width,
  height,
  className,
}: {
  src: string | null;
  poster?: string | null;
  /** WebVTT sidecar, when the export has captions. */
  captions?: string | null;
  /** What the video is (read by assistive technology). */
  label: string;
  width?: number | null;
  height?: number | null;
  className?: string;
}) {
  const { src, onError } = useStableSrc(latest);
  if (!src) return null;
  return (
    <video
      controls
      preload="metadata"
      playsInline
      src={src}
      poster={poster ?? undefined}
      width={width ?? undefined}
      height={height ?? undefined}
      aria-label={label}
      onError={onError}
      crossOrigin={captions ? 'anonymous' : undefined}
      className={`h-auto max-h-[70vh] w-full rounded-sm bg-black object-contain ${className ?? ''}`}
      data-testid="inline-video"
    >
      {captions && <track kind="captions" src={captions} srcLang="en" label="Captions" default />}
      Your browser cannot play this video.{' '}
      <a href={src} target="_blank" rel="noreferrer">
        Open the file
      </a>
      .
    </video>
  );
}

export function AudioPlayer({ src: latest, label }: { src: string | null; label: string }) {
  const { src, onError } = useStableSrc(latest);
  if (!src) return null;
  return (
    <audio
      controls
      preload="metadata"
      src={src}
      aria-label={label}
      onError={onError}
      className="w-full"
      data-testid="inline-audio"
    >
      Your browser cannot play this audio.
    </audio>
  );
}
