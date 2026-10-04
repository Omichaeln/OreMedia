import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import type { Element } from '@oremedia/contracts/creative';
import type { VideoClipItem, VideoMediaInfo, VideoProjectV1 } from '@oremedia/contracts/video';
import {
  activeCaptions,
  activeOverlays,
  captionElements,
  framePage,
  framePlacement,
  frameMs,
  gainAt,
  lengthOf,
  overlayAnimationAt,
  pictureLayersAt,
  scheduleGain,
  soundWindows,
  videoFormatOf,
  type SoundWindow,
} from '@oremedia/editor';
import { buildScene } from '@oremedia/editor/renderer/scene';
import { Button } from '@oremedia/ui';
import type { SourceUrls } from './use-video-media';
import { timecode } from './timecode';

export interface PreviewPlayerProps {
  project: VideoProjectV1;
  media: Record<string, VideoMediaInfo>;
  urls: Map<string, SourceUrls>;
  fontFamilyFor: (ref: string) => string | null;
  colourFor: (token: string) => string | null;
  /** Changes when fonts load or colours resolve, so the overlay scene redraws. */
  resolverVersion: string;
  playheadMs: number;
  onSeek: (ms: number) => void;
}

/** How often the studio's playhead (timeline, readouts) follows a playing preview. */
const PLAYHEAD_SYNC_MS = 100;
/** A media element this far from where the timeline says it should be is re-seeked. */
const DRIFT_S = 0.25;

/**
 * The editor preview (architecture: "browser plays proxies with an overlay canvas using the same scene renderer"):
 * the clips under the playhead play from their editing proxies, framed with the compositor's numbers
 * (framePlacement) and blended through transitions with its timing (pictureLayersAt); audio items play from their
 * proxies; overlays and captions are drawn by the shared Konva scene with the enter/exit maths the export uses.
 * Sound goes through Web Audio: each sounding element feeds its own gain node, scheduled with the export's envelope
 * (soundWindows and gainAt, through scheduleGain), so gain above 0 dB, fades, transition fades and mute sound as
 * they will in the render, and every play, pause, seek or edit reschedules from the playhead. The export, not this
 * preview, is the reference: proxies are 720p and browsers seek to the nearest decoded frame.
 */
export function PreviewPlayer(props: PreviewPlayerProps) {
  const { project, media, urls, playheadMs, onSeek } = props;
  const W = project.format.width;
  const H = project.format.height;
  const frame = frameMs(project.format.fps);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(playheadMs);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const outerRef = useRef<HTMLDivElement>(null);
  const clock = useRef({ startWall: 0, startT: 0, lastSync: 0 });
  // Created on the first Play (a user gesture, so the browser lets it start); null where Web Audio is missing.
  const [audio, setAudio] = useState<AudioContext | null>(null);
  // Changes when playback (re)starts from another point: the gains reschedule from the playhead.
  const [epoch, setEpoch] = useState(0);
  useEffect(
    () => () => {
      void audio?.close().catch(() => undefined);
    },
    [audio],
  );

  // Follow the studio's playhead while paused (timeline clicks, keyboard steps).
  useEffect(() => {
    if (!playing) setT(playheadMs);
  }, [playheadMs, playing]);

  // Fit the frame inside the available box, keeping the project's aspect ratio.
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const fit = () => {
      const maxW = el.clientWidth;
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.45, 520));
      const scale = Math.min(maxW / W, maxH / H);
      setBox({ width: Math.floor(W * scale), height: Math.floor(H * scale) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);
  const scale = box.width / W || 0;

  const stop = useCallback(
    (at: number) => {
      setPlaying(false);
      setT(at);
      onSeek(at);
    },
    [onSeek],
  );

  // The playback clock: wall time drives the timeline; media elements follow it.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    clock.current = { startWall: performance.now(), startT: t, lastSync: 0 };
    const tick = (now: number) => {
      const next = clock.current.startT + (now - clock.current.startWall);
      if (next >= project.durationMs) {
        stop(project.durationMs - frame);
        return;
      }
      setT(next);
      if (now - clock.current.lastSync > PLAYHEAD_SYNC_MS) {
        clock.current.lastSync = now;
        onSeek(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The clock restarts only when play starts; `t` (read at that moment) is its starting point.
  }, [playing]);

  const layers = useMemo(() => pictureLayersAt(project, t), [project, t]);
  // What sounds, with the export's windows, gains and fades (muted items stay, silent, so unmuting is immediate).
  const sounds = useMemo(
    () =>
      new Map(
        soundWindows(project, (id) => {
          const m = media[id];
          return !!m && m.kind !== 'image' && m.hasAudio;
        }).map((w) => [w.itemId, w]),
      ),
    [project, media],
  );
  const audioItems = [...sounds.values()].filter((w) => w.kind === 'audio' && w.startMs <= t && t < w.endMs);

  const startAudio = () => {
    if (audio) {
      if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
      return;
    }
    if (typeof AudioContext === 'undefined') return;
    try {
      setAudio(new AudioContext({ latencyHint: 'interactive' }));
    } catch {
      // No Web Audio: the elements play at their (clamped) volume instead.
    }
  };
  const toggle = () => {
    if (playing) stop(t);
    else {
      startAudio();
      if (t >= project.durationMs - frame) setT(0);
      setPlaying(true);
    }
  };
  const seek = (ms: number) => {
    const at = Math.max(0, Math.min(project.durationMs - frame, ms));
    setT(at);
    onSeek(at);
    if (playing) {
      // Playback continues from the new point: the clock and the scheduled gains restart there.
      clock.current = { ...clock.current, startWall: performance.now(), startT: at };
      setEpoch((e) => e + 1);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 1000 : frame;
      seek(t + (e.key === 'ArrowLeft' ? -step : step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      seek(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      seek(project.durationMs);
    }
  };

  const spoken = useSettled(playing ? '' : `Playhead at ${timecode(t)}`);

  return (
    <section aria-label="Preview" className="flex flex-col gap-2" data-testid="video-preview">
      <div ref={outerRef} className="flex w-full justify-center">
        <div
          className="relative overflow-hidden rounded-sm bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ width: box.width, height: box.height }}
          tabIndex={0}
          role="img"
          aria-label={`Video preview at ${timecode(t)} of ${timecode(project.durationMs)}. Space plays or pauses; arrow keys step a frame, Shift+arrow one second.`}
          onKeyDown={onKeyDown}
          data-testid="preview-stage"
        >
          {layers.map((layer) => (
            <ClipLayer
              key={layer.clip.id}
              clip={layer.clip}
              info={media[layer.clip.assetVersionId]}
              url={urls.get(layer.clip.assetVersionId)}
              sourceMs={layer.sourceMs}
              opacity={layer.opacity}
              offsetX={layer.offsetX}
              scale={scale}
              output={{ width: W, height: H }}
              playing={playing}
              frozen={t < layer.clip.startMs || t >= layer.clip.startMs + lengthOf(layer.clip)}
              sound={{ audio, envelope: sounds.get(layer.clip.id) ?? null, t, epoch }}
            />
          ))}
          {audioItems.map((a) => (
            <AudioLayer
              key={a.itemId}
              url={urls.get(a.assetVersionId)?.proxy}
              sourceMs={a.sourceInMs + (t - a.startMs)}
              playing={playing}
              sound={{ audio, envelope: a, t, epoch }}
            />
          ))}
          <OverlayCanvas {...props} t={t} width={box.width} height={box.height} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Playback">
        <Button size="sm" onClick={() => seek(0)} aria-label="Go to start">
          <span aria-hidden="true">⏮</span>
        </Button>
        <Button size="sm" onClick={() => seek(t - frame)} aria-label="Back one frame">
          <span aria-hidden="true">◀︎</span>
        </Button>
        <Button size="sm" variant="primary" onClick={toggle} data-testid="play-toggle" aria-pressed={playing}>
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" onClick={() => seek(t + frame)} aria-label="Forward one frame">
          <span aria-hidden="true">▶︎</span>
        </Button>
        <input
          type="range"
          min={0}
          max={project.durationMs}
          step={frame}
          value={Math.round(t)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Scrub"
          aria-valuetext={timecode(t)}
          className="min-w-[8rem] flex-1 accent-primary"
          data-testid="scrubber"
        />
        <span className="font-mono text-sm tabular-nums" data-testid="time-readout">
          {timecode(t)} / {timecode(project.durationMs)}
        </span>
        {/* Announced while paused, once the playhead settles (scrubbing with the keyboard on the preview, the
            timeline or the list editor), so neither playback nor a held arrow key floods assistive technology. */}
        <span className="sr-only" aria-live="polite" data-testid="time-live">
          {spoken}
        </span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="preview-note">
        The preview plays 720p editing copies; the rendered video is made from the originals at full quality.
      </p>
    </section>
  );
}

function ClipLayer({
  clip,
  info,
  url,
  sourceMs,
  opacity,
  offsetX,
  scale,
  output,
  playing,
  frozen,
  sound,
}: {
  clip: VideoClipItem;
  info: VideoMediaInfo | undefined;
  url: SourceUrls | undefined;
  sourceMs: number;
  opacity: number;
  offsetX: number;
  scale: number;
  output: { width: number; height: number };
  playing: boolean;
  /** The playhead is in the transition beyond this clip's cut: its edge frame is held (and its sound is over). */
  frozen: boolean;
  sound: SoundProps;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const isImage = info?.kind === 'image';
  const p = framePlacement(
    { width: info?.width ?? output.width, height: info?.height ?? output.height },
    output,
    clip.frame,
  );
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const want = sourceMs / 1000;
    const run = playing && !frozen;
    if (Math.abs(v.currentTime - want) > (run ? DRIFT_S : 0.02)) v.currentTime = want;
    if (run && v.paused) void v.play().catch(() => undefined);
    if (!run && !v.paused) v.pause();
  }, [sourceMs, playing, frozen]);
  const src = isImage ? url?.image : url?.proxy;
  useSoundGain(ref, sound, playing, src);
  return (
    <div
      className="absolute overflow-hidden"
      style={{
        left: (p.padX + offsetX * output.width) * scale,
        top: p.padY * scale,
        width: p.cropWidth * scale,
        height: p.cropHeight * scale,
        opacity,
      }}
      data-testid="preview-clip"
      data-clip-id={clip.id}
    >
      {src ? (
        isImage ? (
          <img
            src={src}
            alt=""
            className="absolute max-w-none"
            style={{
              left: -p.cropX * scale,
              top: -p.cropY * scale,
              width: p.scaledWidth * scale,
              height: p.scaledHeight * scale,
            }}
          />
        ) : (
          <video
            ref={ref}
            src={src}
            muted
            playsInline
            data-item-id={clip.id}
            preload="auto"
            crossOrigin="anonymous"
            className="absolute max-w-none"
            style={{
              left: -p.cropX * scale,
              top: -p.cropY * scale,
              width: p.scaledWidth * scale,
              height: p.scaledHeight * scale,
            }}
          />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted text-xs text-muted-foreground">
          {clip.name ?? 'Loading clip…'}
        </div>
      )}
    </div>
  );
}

function AudioLayer({
  url,
  sourceMs,
  playing,
  sound,
}: {
  url: string | undefined;
  sourceMs: number;
  playing: boolean;
  sound: SoundProps;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const want = sourceMs / 1000;
    if (Math.abs(a.currentTime - want) > (playing ? DRIFT_S : 0.05)) a.currentTime = want;
    if (playing && a.paused) void a.play().catch(() => undefined);
    if (!playing && !a.paused) a.pause();
  }, [sourceMs, playing]);
  useSoundGain(ref, sound, playing, url);
  if (!url) return null;
  return (
    <audio
      ref={ref}
      src={url}
      muted
      preload="auto"
      crossOrigin="anonymous"
      data-item-id={sound.envelope?.itemId}
    />
  );
}

interface SoundProps {
  audio: AudioContext | null;
  /** The element's sound (null: its source has none). */
  envelope: SoundWindow | null;
  /** Playhead (ms). */
  t: number;
  /** Bumped when playback restarts from another point. */
  epoch: number;
}

/** Each element's Web Audio source, made once per element (a second createMediaElementSource throws). */
const sources = new WeakMap<HTMLMediaElement, { context: AudioContext; node: MediaElementAudioSourceNode }>();

/**
 * Plays a media element's sound through its own gain node with the export's envelope: scheduled from the playhead
 * when playback starts, restarts from a seek, or the item's sound changes (gain, fades, mute, trim, move), and set to
 * the playhead's value while paused. Without Web Audio the element's volume follows gainAt (clamped to 1).
 */
function useSoundGain(
  ref: React.RefObject<HTMLMediaElement | null>,
  { audio, envelope: sound, t, epoch }: SoundProps,
  playing: boolean,
  src: string | undefined,
): void {
  const [gain, setGain] = useState<GainNode | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const routed = !!sound;
  useEffect(() => {
    const el = ref.current;
    if (!el || !audio || !routed) return;
    let source = sources.get(el);
    if (source && source.context !== audio) return;
    if (!source) {
      try {
        source = { context: audio, node: audio.createMediaElementSource(el) };
      } catch {
        return;
      }
      sources.set(el, source);
    }
    const node = audio.createGain();
    source.node.connect(node);
    node.connect(audio.destination);
    el.volume = 1;
    el.muted = false;
    setGain(node);
    return () => {
      el.muted = true;
      source.node.disconnect();
      node.disconnect();
      setGain(null);
    };
  }, [audio, routed, src]);
  const key = sound ? JSON.stringify(sound) : '';
  useEffect(() => {
    if (!gain || !audio) return;
    scheduleGain(gain.gain, sound, { atMs: tRef.current, now: audio.currentTime, playing });
    // Playing, the schedule runs ahead on its own (the playhead is read when it is made); paused, it follows `t`.
  }, [gain, key, playing, epoch, playing ? 0 : t]);
  useEffect(() => {
    const el = ref.current;
    if (!el || gain) return;
    const g = sound ? gainAt(sound, t) : 0;
    el.volume = Math.min(1, g);
    el.muted = g === 0;
  }, [gain, key, t, src]);
}

/** Overlays and captions active at `t`, drawn by the shared scene renderer at the preview's scale. */
function OverlayCanvas({
  project,
  urls,
  fontFamilyFor,
  colourFor,
  resolverVersion,
  t,
  width,
  height,
}: PreviewPlayerProps & { t: number; width: number; height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const latest = useRef({ urls, fontFamilyFor, colourFor });
  latest.current = { urls, fontFamilyFor, colourFor };
  const elements = useMemo((): Element[] => {
    const out: Element[] = [];
    for (const o of activeOverlays(project, t)) {
      const anim = overlayAnimationAt(o, t, project.format.height);
      const el = structuredClone(o.element);
      el.opacity = el.opacity * anim.opacity;
      el.transform = { ...el.transform, y: el.transform.y + anim.dy };
      out.push(el);
    }
    for (const { track, caption } of activeCaptions(project, t))
      out.push(...captionElements(project, track, caption));
    return out;
  }, [project, t]);
  const key = JSON.stringify(elements);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || width === 0) return;
    const stage = new Konva.Stage({ container, width, height, listening: false });
    stageRef.current = stage;
    return () => {
      stage.destroy();
      stageRef.current = null;
    };
  }, [width, height]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.destroyChildren();
    const layer = new Konva.Layer({ listening: false });
    stage.add(layer);
    const s = width / project.format.width;
    layer.scale({ x: s, y: s });
    const handle = buildScene(layer, framePage(project, 'preview', elements), {
      format: videoFormatOf(project),
      resolveAssetUrl: (id) => latest.current.urls.get(id)?.image ?? null,
      fontFamilyFor: (ref) => latest.current.fontFamilyFor(ref),
      colourFor: (token) => latest.current.colourFor(token),
    });
    let live = true;
    void handle.ready().then(() => {
      if (live) layer.draw();
    });
    layer.draw();
    return () => {
      live = false;
      handle.destroy();
    };
    // `key` stands for the elements' content; `resolverVersion` for fonts, colours and URLs arriving.
  }, [key, resolverVersion, width]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-testid="overlay-canvas"
    />
  );
}

/** `text` once it has stopped changing for `delayMs` (a live region then speaks the settled value, not every step). */
function useSettled(text: string, delayMs = 250): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(text), delayMs);
    return () => window.clearTimeout(id);
  }, [text, delayMs]);
  return settled;
}
