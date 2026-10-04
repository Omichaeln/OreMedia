import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { StripMapV1, WaveformV1 } from '@oremedia/contracts/media';
import type { VideoMediaInfo, VideoProjectV1 } from '@oremedia/contracts/video';
import { useTRPC } from '../../../lib/trpc';

/**
 * Where the editor reads each source from: the editing proxy (video and audio; never the original, which can be a
 * gigabyte), the poster strip and its map (clip thumbnails on the timeline), the waveform peaks (audio lanes), and
 * the web derivative of stills. Signed URLs are re-signed every few minutes like the graphic studio's.
 */
export interface SourceUrls {
  proxy?: string;
  strip?: string;
  stripMap?: StripMapV1;
  waveform?: WaveformV1;
  /** Still images: the web derivative. */
  image?: string;
}

type Derivative = 'proxy' | 'strip' | 'strip_map' | 'waveform' | 'web';

/** Every timed source and still a project uses, and every overlay image or logo. */
export function sourceIdsOf(project: VideoProjectV1): string[] {
  const ids = new Set<string>();
  for (const t of project.tracks) {
    if (t.kind === 'video' || t.kind === 'audio') for (const i of t.items) ids.add(i.assetVersionId);
    if (t.kind === 'overlay')
      for (const o of t.items)
        if (o.element.type === 'image' || o.element.type === 'logo') ids.add(o.element.assetVersionId);
  }
  return [...ids].sort();
}

export function useVideoSourceUrls(
  ids: string[],
  media: Record<string, VideoMediaInfo>,
): Map<string, SourceUrls> {
  const trpc = useTRPC();
  const wanted = useMemo(
    () =>
      ids.flatMap((id) => {
        const m = media[id];
        const derivatives: Derivative[] = !m
          ? ['web']
          : m.kind === 'image'
            ? ['web']
            : (['proxy', 'strip', 'strip_map', 'waveform'] as const).filter((d) => m.derivatives.includes(d));
        return derivatives.map((derivative) => ({ id, derivative }));
      }),
    [ids, media],
  );
  const signed = useQueries({
    queries: wanted.map(({ id, derivative }) => ({
      ...trpc.assets.media.signedUrl.queryOptions({ assetVersionId: id, derivative }),
      staleTime: 4 * 60_000,
      refetchInterval: 4 * 60_000,
      retry: false,
    })),
  });
  // The JSON derivatives are fetched once per source (their bytes never change: versions are immutable).
  const jsonWanted = wanted
    .map((w, i) => ({ ...w, url: signed[i]?.data?.url }))
    .filter((w) => (w.derivative === 'strip_map' || w.derivative === 'waveform') && w.url);
  const json = useQueries({
    queries: jsonWanted.map((w) => ({
      queryKey: ['video-derivative-json', w.id, w.derivative],
      queryFn: async () => {
        const res = await fetch(w.url as string);
        if (!res.ok) throw new Error(`derivative ${w.derivative} ${res.status}`);
        const body: unknown = await res.json();
        return w.derivative === 'waveform' ? WaveformV1.parse(body) : StripMapV1.parse(body);
      },
      staleTime: Infinity,
      retry: false,
    })),
  });
  const out = new Map<string, SourceUrls>();
  wanted.forEach((w, i) => {
    const url = signed[i]?.data?.url;
    if (!url) return;
    const entry = out.get(w.id) ?? {};
    if (w.derivative === 'proxy') entry.proxy = url;
    if (w.derivative === 'strip') entry.strip = url;
    if (w.derivative === 'web') entry.image = url;
    out.set(w.id, entry);
  });
  jsonWanted.forEach((w, i) => {
    const data = json[i]?.data;
    if (!data) return;
    const entry = out.get(w.id) ?? {};
    if (w.derivative === 'waveform') entry.waveform = data as WaveformV1;
    else entry.stripMap = data as StripMapV1;
    out.set(w.id, entry);
  });
  return out;
}
