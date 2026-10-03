import { useEffect, useState } from 'react';

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

/**
 * A captions sidecar fetched into a blob URL. The <video> never carries crossOrigin, so a store without CORS for GET
 * still plays the video (only the captions are missing); the blob URL is same-origin for the track. Null while
 * loading or when the fetch fails.
 */
function useCaptionsBlob(latest: string | null | undefined): string | null {
  // The first signed URL is enough: the captions are fetched once per player, not on every re-sign.
  const [url, setUrl] = useState<string | null>(latest ?? null);
  if (!url && latest) setUrl(latest);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let created: string | null = null;
    let cancelled = false;
    fetch(url)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        created = URL.createObjectURL(new Blob([blob], { type: 'text/vtt' }));
        setBlobUrl(created);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      setBlobUrl(null);
    };
  }, [url]);
  return blobUrl;
}

export function VideoPlayer({
  src: latest,
  poster,
  captions,
  captionsLang,
  label,
  width,
  height,
  className,
}: {
  src: string | null;
  poster?: string | null;
  /** WebVTT sidecar, when the export has captions. */
  captions?: string | null;
  /** The captions' language (BCP 47), when known; omitted otherwise rather than guessed. */
  captionsLang?: string | null;
  /** What the video is (read by assistive technology). */
  label: string;
  width?: number | null;
  height?: number | null;
  className?: string;
}) {
  const { src, onError } = useStableSrc(latest);
  const track = useCaptionsBlob(captions);
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
      className={`h-auto max-h-[70vh] w-full rounded-sm bg-black object-contain ${className ?? ''}`}
      data-testid="inline-video"
    >
      {track && (
        <track
          kind="captions"
          src={track}
          label="Captions"
          default
          {...(captionsLang ? { srcLang: captionsLang } : {})}
          data-testid="captions-track"
        />
      )}
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
