import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaProbeV1 } from '@oremedia/contracts/media';
import type { VideoProjectV1 } from '@oremedia/contracts/video';
import { mediaToolsAvailable, probeFile, runTool, withTempDir } from '@oremedia/module-assets';
import { buildComposePlan, demuxerFor, type ComposeSourceFile } from './video-filter-graph';
import { encodeProject } from './video-render';

/**
 * STU-2b compositor against real ffmpeg 6.1 on tiny generated media whose pixels encode their frame number (red =
 * 8·frame for A, green = 8·frame for B), so frame accuracy is read off decoded pixels: clip order and trims at the
 * boundaries, transition timing, overlay and caption windows, a beep's offset (audio sync), aspect fit and fill,
 * exact duration, and determinism (decoded frames hash the same across renders, whatever the bytes).
 */
const hasTools = await mediaToolsAvailable();
if (!hasTools) console.error('video-compose.test.ts: ffmpeg/ffprobe not found; the ffmpeg suite is skipped');

const frame = { fit: 'fill' as const, focalX: 0.5, focalY: 0.5, zoom: 1 };

function project(over: (p: VideoProjectV1) => void = () => undefined): VideoProjectV1 {
  const p: VideoProjectV1 = {
    schemaVersion: 1,
    kind: 'video',
    brandVersionId: 'bv',
    format: { key: 'video_9x16', width: 1080, height: 1920, fps: 30 },
    durationMs: 10_000,
    tracks: [
      {
        id: 'v',
        kind: 'video',
        name: 'Video',
        locked: false,
        muted: false,
        items: [
          {
            id: 'a',
            assetVersionId: 'A',
            sourceInMs: 1_000,
            sourceOutMs: 5_000,
            startMs: 0,
            frame,
            gainDb: 0,
            muted: true,
            locked: false,
          },
          {
            id: 'b',
            assetVersionId: 'B',
            sourceInMs: 0,
            sourceOutMs: 3_000,
            startMs: 4_000,
            frame,
            transitionIn: { kind: 'crossfade', durationMs: 1_000 },
            gainDb: 0,
            muted: false,
            locked: false,
          },
          {
            id: 'c',
            assetVersionId: 'S',
            sourceInMs: 0,
            sourceOutMs: 3_000,
            startMs: 7_000,
            frame,
            gainDb: 0,
            muted: false,
            locked: false,
          },
        ],
      },
      { id: 'o', kind: 'overlay', name: 'Titles', locked: false, items: [] },
      {
        id: 'm',
        kind: 'audio',
        name: 'Sound',
        locked: false,
        muted: false,
        items: [
          {
            id: 'beep',
            assetVersionId: 'BEEP',
            sourceInMs: 500,
            sourceOutMs: 3_500,
            startMs: 2_000,
            gainDb: 0,
            fadeInMs: 0,
            fadeOutMs: 0,
            muted: false,
            locked: false,
          },
        ],
      },
    ],
    scenes: [],
  };
  over(p);
  return p;
}

describe.skipIf(!hasTools)('compositor on real ffmpeg', { timeout: 300_000 }, () => {
  let dir: string;
  let sources: Record<string, ComposeSourceFile>;
  const ff = async (args: string[]) => {
    const r = await runTool('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };
  /** RGB of a 2×2 block at (x, y) of decoded frame n. */
  const pixel = async (file: string, n: number, x: number, y: number): Promise<[number, number, number]> => {
    const r = await runTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-vf',
        `select=eq(n\\,${n}),crop=2:2:${x}:${y}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { timeoutMs: 60_000 },
    );
    return [r.stdout[0] ?? -1, r.stdout[1] ?? -1, r.stdout[2] ?? -1];
  };
  const near = (actual: number, expected: number, tol = 6) =>
    expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);

  async function render(
    p: VideoProjectV1,
    frames: Array<{ path: string; startMs: number; endMs: number; itemId: string }> = [],
  ) {
    const out = join(
      dir,
      `out-${createHash('sha1')
        .update(JSON.stringify(p) + JSON.stringify(frames))
        .digest('hex')
        .slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await mkdir(out);
    return withTempDir({ maxBytes: 2 * 1024 ** 3, root: out }, async (tmp) => {
      const r = await encodeProject({
        project: p,
        sources,
        frames,
        dir: tmp,
        encoder: { preset: 'superfast', crf: 18, threads: 2 },
        timeoutMs: 240_000,
      });
      const keep = join(out, 'output.mp4');
      const poster = join(out, 'poster.webp');
      await copyFile(r.output, keep);
      await copyFile(r.poster, poster);
      return { ...r, output: keep, poster };
    });
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'video-compose-'));
    await ff([
      '-f',
      'lavfi',
      '-i',
      "color=c=black:s=640x360:r=30,format=gbrp,geq=r='mod(N*8,256)':g='0':b='0'",
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv444p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'a.mp4'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      "color=c=black:s=360x640:r=25,format=gbrp,geq=r='0':g='mod(N*8,256)':b='0'",
      '-t',
      '5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv444p',
      join(dir, 'b.mp4'),
    ]);
    await ff(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=1200x800', '-frames:v', '1', join(dir, 'still.png')]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc=exprs='if(between(t,1,1.1),0.8*sin(2*PI*1000*t),0)':s=48000:d=4",
      join(dir, 'beep.wav'),
    ]);
    // Transparent full-frame PNGs as the scene renderer draws them: a magenta title box and a cyan caption box.
    const box = (x: number, y: number, w: number, h: number, r: number, g: number, b: number) =>
      `color=c=black@0.0:s=1080x1920,format=rgba,geq=r='${r}':g='${g}':b='${b}':a='if(between(X,${x},${x + w - 1})*between(Y,${y},${y + h - 1}),255,0)'`;
    await ff([
      '-f',
      'lavfi',
      '-i',
      box(100, 300, 800, 200, 255, 0, 255),
      '-frames:v',
      '1',
      join(dir, 'title.png'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      box(64, 1400, 952, 150, 0, 255, 255),
      '-frames:v',
      '1',
      join(dir, 'caption.png'),
    ]);
    sources = {
      A: {
        path: join(dir, 'a.mp4'),
        kind: 'video',
        mime: 'video/mp4',
        hasAudio: true,
        width: 640,
        height: 360,
      },
      B: {
        path: join(dir, 'b.mp4'),
        kind: 'video',
        mime: 'video/mp4',
        hasAudio: false,
        width: 360,
        height: 640,
      },
      S: {
        path: join(dir, 'still.png'),
        kind: 'image',
        mime: 'image/png',
        hasAudio: false,
        width: 1200,
        height: 800,
      },
      BEEP: {
        path: join(dir, 'beep.wav'),
        kind: 'audio',
        mime: 'audio/wav',
        hasAudio: true,
        width: null,
        height: null,
      },
    };
  }, 300_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  let main: Awaited<ReturnType<typeof render>>;
  it('renders H.264 High + AAC 48 kHz at the exact duration and frame count, with a poster', async () => {
    main = await render(project(), [
      { path: join(dir, 'title.png'), startMs: 500, endMs: 3_500, itemId: 'title' },
      { path: join(dir, 'caption.png'), startMs: 8_000, endMs: 9_500, itemId: 'cap' },
    ]);
    const p = (await probeFile(main.output, 1, { mime: 'video/mp4' })) as MediaProbeV1;
    expect(p.video).toMatchObject({ codec: 'h264', profile: 'High', width: 1080, height: 1920, fps: 30 });
    expect(p.audio[0]).toMatchObject({ codec: 'aac', sampleRate: 48_000, channels: 2 });
    expect(Math.abs(p.durationMs - 10_000)).toBeLessThanOrEqual(34);
    const frames = await runTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'csv=p=0',
        main.output,
      ],
      { timeoutMs: 60_000 },
    );
    expect(frames.stdout.toString().trim()).toBe('300');
    expect(main.totalFrames).toBe(300);
    const poster = await runTool(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', main.poster],
      { timeoutMs: 30_000 },
    );
    expect(poster.stdout.toString().trim()).toBe('webp,1080,1920');
  });

  it('plays clips in order with frame-accurate trims at their boundaries', async () => {
    // A starts at source 1.000 s (its frame 30): output frame n shows A's frame 30 + n.
    for (const n of [0, 1, 50, 104]) near((await pixel(main.output, n, 540, 1000))[0], (8 * (30 + n)) % 256);
    // B (25 fps) after its transition: output frame n shows B at (n - 120) / 30 s.
    for (const n of [150, 180, 209])
      near((await pixel(main.output, n, 540, 1000))[1], (8 * Math.round(((n - 120) / 30) * 25)) % 256, 10);
    // The still from frame 210 to the end; nothing of B leaks into it.
    for (const n of [210, 299])
      expect(await pixel(main.output, n, 540, 1000)).toEqual([
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      ]);
    const [r, g, b] = await pixel(main.output, 210, 540, 1000);
    expect(b).toBeGreaterThan(240);
    expect(r + g).toBeLessThan(12);
  });

  it('times a 1 s crossfade centred on the cut (frames 105 to 135)', async () => {
    const before = await pixel(main.output, 104, 540, 1000);
    near(before[0], (8 * 134) % 256);
    expect(before[1]).toBeLessThan(8);
    const after = await pixel(main.output, 135, 540, 1000);
    expect(after[0]).toBeLessThan(8); // all B
    const mid = await pixel(main.output, 120, 540, 1000);
    // Half A's last frame (frozen, 8·149 mod 256 = 168) and half B's first (green 0).
    near(mid[0], 84, 12);
  });

  it('shows overlays and captions exactly in their windows', async () => {
    const magenta = (p: number[]) => (p[0] ?? 0) > 200 && (p[2] ?? 0) > 200 && (p[1] ?? 255) < 60;
    expect(magenta(await pixel(main.output, 14, 500, 400))).toBe(false);
    expect(magenta(await pixel(main.output, 15, 500, 400))).toBe(true);
    expect(magenta(await pixel(main.output, 104, 500, 400))).toBe(true);
    expect(magenta(await pixel(main.output, 105, 500, 400))).toBe(false);
    const cyan = (p: number[]) => (p[1] ?? 0) > 200 && (p[2] ?? 0) > 200 && (p[0] ?? 255) < 60;
    expect(cyan(await pixel(main.output, 239, 540, 1450))).toBe(false);
    expect(cyan(await pixel(main.output, 240, 540, 1450))).toBe(true);
    expect(cyan(await pixel(main.output, 284, 540, 1450))).toBe(true);
    expect(cyan(await pixel(main.output, 285, 540, 1450))).toBe(false);
  });

  it('fades an overlay in over its enter animation', async () => {
    const p = project((x) => {
      const o = x.tracks[1];
      if (o?.kind !== 'overlay') return;
      o.items.push({
        id: 'title',
        startMs: 1_000,
        endMs: 3_000,
        enter: { kind: 'fade', durationMs: 1_000 },
        locked: false,
        element: {
          id: 'el_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          name: 't',
          type: 'shape',
          shape: 'rect',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          strokeWidth: 0,
          cornerRadius: 0,
          transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
        },
      });
      x.tracks[0]!.items.length = 1;
      x.durationMs = 4_000;
      (x.tracks[2]!.items as unknown[]).length = 0;
    });
    const out = await render(p, [
      { path: join(dir, 'title.png'), startMs: 1_000, endMs: 3_000, itemId: 'title' },
    ]);
    const g = async (n: number) => (await pixel(out.output, n, 500, 400))[1];
    // A has no blue: the magenta title's blue channel reads its opacity.
    const blue = async (n: number) => (await pixel(out.output, n, 500, 400))[2];
    near(await blue(30), 0, 10); // alpha 0 at the window start
    near(await blue(45), 128, 25); // half way through the fade
    expect(await blue(60)).toBeGreaterThan(240); // fully in
    expect(await g(60)).toBeLessThan(40);
  });

  it('keeps sound in sync: a beep 1.0 s into its source, trimmed by 0.5 s and placed at 2.0 s, sounds at 2.5 s', async () => {
    const pcm = await runTool(
      'ffmpeg',
      ['-v', 'error', '-i', main.output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
      { timeoutMs: 60_000, maxStdoutBytes: 64 * 1024 * 1024 },
    );
    const samples = new Int16Array(
      pcm.stdout.buffer,
      pcm.stdout.byteOffset,
      Math.floor(pcm.stdout.length / 2),
    );
    const onset = samples.findIndex((s) => Math.abs(s) > 3_000);
    expect(onset).toBeGreaterThan(0);
    expect(Math.abs(onset / 48 - 2_500)).toBeLessThanOrEqual(10); // ms
    // A is muted: silence before the beep.
    expect(Math.max(...samples.slice(0, 48 * 2_400).map(Math.abs))).toBeLessThan(200);
  });

  it('frames a clip with fit (black bars) or fill (cropped to cover)', async () => {
    const fit = await render(
      project((x) => {
        const v = x.tracks[0];
        if (v?.kind !== 'video') return;
        v.items = [{ ...v.items[0]!, frame: { fit: 'fit', focalX: 0.5, focalY: 0.5, zoom: 1 } }];
        x.durationMs = 2_000;
        (x.tracks[2]!.items as unknown[]).length = 0;
      }),
    );
    // 640×360 fitted into 1080×1920: 1080×608 in the middle, black above and below.
    expect((await pixel(fit.output, 10, 540, 100)).every((c) => c < 12)).toBe(true);
    near((await pixel(fit.output, 10, 540, 960))[0], (8 * 40) % 256);
    expect((await pixel(fit.output, 10, 540, 1900)).every((c) => c < 12)).toBe(true);
    // Fill covers the whole frame.
    near((await pixel(main.output, 10, 540, 100))[0], (8 * 40) % 256);
  });

  it('is deterministic: the same project decodes to the same frames', async () => {
    const again = await render(project(), [
      { path: join(dir, 'title.png'), startMs: 500, endMs: 3_500, itemId: 'title' },
      { path: join(dir, 'caption.png'), startMs: 8_000, endMs: 9_500, itemId: 'cap' },
    ]);
    const md5 = async (file: string) =>
      (
        await runTool(
          'ffmpeg',
          ['-v', 'error', '-i', file, '-vf', "select='not(mod(n,30))'", '-vsync', '0', '-f', 'framemd5', '-'],
          { timeoutMs: 120_000 },
        )
      ).stdout
        .toString()
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(',').at(-1)?.trim());
    const a = await md5(main.output);
    expect(a.length).toBeGreaterThanOrEqual(10);
    expect(await md5(again.output)).toEqual(a);
  });
});

describe('compose plan (pure)', () => {
  const files: Record<string, ComposeSourceFile> = {
    A: { path: '/x/a.mp4', kind: 'video', mime: 'video/mp4', hasAudio: true, width: 640, height: 360 },
    B: { path: '/x/b.webm', kind: 'video', mime: 'video/webm', hasAudio: false, width: 360, height: 640 },
    S: { path: '/x/s.png', kind: 'image', mime: 'image/png', hasAudio: false, width: 1200, height: 800 },
    BEEP: {
      path: '/x/beep.wav',
      kind: 'audio',
      mime: 'audio/wav',
      hasAudio: true,
      width: null,
      height: null,
    },
  };
  const plan = (p: VideoProjectV1) =>
    buildComposePlan({
      project: p,
      sources: files,
      frames: [],
      filterScriptPath: '/x/g.txt',
      outputPath: '/x/o.mp4',
      encoder: { preset: 'veryfast', crf: 20, threads: 2, audioBitrate: '160k', maxBytes: 1e9 },
    });

  it('limits every input to files and pipes with a forced demuxer, and caps threads, duration and size', () => {
    const { args } = plan(project());
    const inputs = args.reduce<number[]>((acc, a, i) => (a === '-i' ? [...acc, i] : acc), []);
    expect(inputs).toHaveLength(4);
    for (const i of inputs) {
      const before = args.slice(Math.max(0, i - 12), i);
      expect(before).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file,pipe', '-f']));
    }
    expect(args).toEqual(
      expect.arrayContaining([
        '-threads',
        '2',
        '-t',
        '10.000000',
        '-fs',
        '1000000000',
        '-movflags',
        '+faststart',
        '-profile:v',
        'high',
      ]),
    );
    expect(demuxerFor('video/webm')).toBe('matroska');
    expect(demuxerFor('application/x-unknown')).toBeNull();
  });
  it('is the same command for the same project, and snaps every boundary to the frame grid', () => {
    expect(plan(project())).toEqual(plan(project()));
    const g = plan(project()).filterGraph;
    expect(g).toContain('trim=end_frame=120'); // A: 0-4 s at 30 fps
    expect(g).toContain('tpad=start=15:start_mode=clone'); // B: half of the 1 s crossfade before its cut
    expect(g).toContain('xfade=transition=fade:duration=1.000000:offset=3.500000');
    expect(g).toContain('adelay=delays=96000S:all=1'); // the beep at 2.0 s, to the sample
    expect(g).not.toContain('[0:a]'); // A is muted
  });
  it('fills gaps with black and an empty video track with black for the whole duration', () => {
    const g = plan(project((x) => void ((x.tracks[0] as { items: unknown[] }).items = []))).filterGraph;
    expect(g).toContain('color=c=black:s=1080x1920:r=30');
    expect(g).toContain('trim=end_frame=300');
  });
});
