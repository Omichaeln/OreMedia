import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaveformV1, StripMapV1, type MediaProbeV1 } from '@oremedia/contracts/media';
import { withTempDir } from '../temp-disk';
import {
  PeakAccumulator,
  buildMediaDerivatives,
  checkProbe,
  decodeCheck,
  firstToolLine,
  fitInside,
  mediaToolsAvailable,
  parseProbe,
  parseRate,
  posterTimeMs,
  probeFile,
  proxyArgs,
  rotationOf,
  runTool,
  stripTimesMs,
  waveformSvg,
  type RawProbe,
} from './video';

/**
 * STU-2a video ingest toolkit. The pure parts (probe parsing, limits, peaks, geometry) always run; the ffmpeg suites
 * generate tiny fixtures with ffmpeg in setup and run the real tools. They skip, saying so, where ffmpeg is absent;
 * CI installs it (.github/workflows/ci.yml) so they run there.
 */
const hasTools = await mediaToolsAvailable();
if (!hasTools)
  console.error('video.test.ts: ffmpeg/ffprobe not found on PATH; the ffmpeg suites are skipped');

const rawVideo = (over: Partial<NonNullable<RawProbe['streams']>[number]> = {}): RawProbe => ({
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.480000',
    bit_rate: '2500000',
    size: '3900000',
  },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
      r_frame_rate: '30000/1001',
      bit_rate: '2300000',
      ...over,
    },
    {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 2,
      sample_rate: '48000',
      bit_rate: '128000',
    },
  ],
});

const probeOf = (raw: RawProbe): MediaProbeV1 => {
  const p = parseProbe(raw, 3_900_000);
  if (!p) throw new Error('no probe');
  return p;
};

describe('ffprobe parsing (pure)', () => {
  it('reads container, duration, codecs, frame rate and audio streams', () => {
    const p = probeOf(rawVideo());
    expect(p).toMatchObject({
      schemaVersion: 1,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationMs: 12_480,
      bitRate: 2_500_000,
      bytes: 3_900_000,
      video: {
        codec: 'h264',
        profile: 'High',
        width: 1920,
        height: 1080,
        rotation: 0,
        fps: 29.97,
        variableFrameRate: false,
      },
      audio: [{ codec: 'aac', channels: 2, sampleRate: 48_000, bitRate: 128_000 }],
    });
  });

  it('swaps width and height for a rotated (portrait phone) stream and normalises the rotation', () => {
    const p = probeOf(rawVideo({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }));
    expect(p.video).toMatchObject({
      codedWidth: 1920,
      codedHeight: 1080,
      width: 1080,
      height: 1920,
      rotation: 90,
    });
    expect(rotationOf({ tags: { rotate: '270' } })).toBe(270);
    expect(rotationOf({ side_data_list: [{ rotation: 180 }] })).toBe(180);
    expect(rotationOf({})).toBe(0);
  });

  it('applies a non-square sample aspect ratio to the displayed width', () => {
    const p = probeOf(rawVideo({ width: 1440, height: 1080, sample_aspect_ratio: '4:3' }));
    expect(p.video).toMatchObject({ codedWidth: 1440, width: 1920, height: 1080 });
  });

  it('marks variable frame rate when the nominal and average rates differ', () => {
    const p = probeOf(rawVideo({ avg_frame_rate: '2397/100', r_frame_rate: '30/1' }));
    expect(p.video).toMatchObject({ fps: 23.97, nominalFps: 30, variableFrameRate: true });
  });

  it('ignores cover art (an attached picture) as a video stream', () => {
    const p = probeOf({
      format: { format_name: 'mp3', duration: '3.1' },
      streams: [
        { codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
      ],
    });
    expect(p.video).toBeNull();
    expect(p.audio).toHaveLength(1);
  });

  it('returns null when nothing has a duration', () => {
    expect(parseProbe({ format: { format_name: 'mp4' }, streams: [] }, 10)).toBeNull();
  });

  it('parses rates and keeps tool output user-safe', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRate('0/0')).toBe(0);
    expect(parseRate(undefined)).toBe(0);
    expect(firstToolLine('[mov,mp4 @ 0x55] moov atom not found\n/tmp/x/source: Invalid data')).toBe(
      'moov atom not found',
    );
  });
});

describe('limits (architecture video v1)', () => {
  const limits = { maxDurationSeconds: 600 };
  it('accepts a 1080p H.264 + AAC clip', () => {
    expect(checkProbe(probeOf(rawVideo()), 'video', limits)).toBeNull();
  });
  it('refuses too long, with the limit in the detail', () => {
    const r = checkProbe({ ...probeOf(rawVideo()), durationMs: 601_000 }, 'video', limits);
    expect(r).toMatchObject({ reason: 'duration_exceeds_cap' });
    expect(r?.detail).toContain('10 minute');
  });
  it('refuses a video without a video stream, and audio without audio', () => {
    const audioOnly: RawProbe = { format: { duration: '4' }, streams: [rawVideo().streams![1]!] };
    expect(checkProbe(probeOf(audioOnly), 'video', limits)?.reason).toBe('media_no_video_stream');
    const silent: RawProbe = { format: { duration: '4' }, streams: [rawVideo().streams![0]!] };
    expect(checkProbe(probeOf(silent), 'audio', limits)?.reason).toBe('media_no_audio_stream');
    expect(checkProbe(probeOf(audioOnly), 'audio', limits)).toBeNull();
  });
  it('refuses an unsupported codec by name', () => {
    const r = checkProbe(probeOf(rawVideo({ codec_name: 'wmv3' })), 'video', limits);
    expect(r).toMatchObject({ reason: 'media_codec_unsupported' });
    expect(r?.detail).toContain('wmv3');
  });
  it('refuses extreme variable frame rate but accepts phone-style VFR', () => {
    expect(
      checkProbe(probeOf(rawVideo({ avg_frame_rate: '5/1', r_frame_rate: '60/1' })), 'video', limits)?.reason,
    ).toBe('media_frame_rate_unsupported');
    expect(
      checkProbe(probeOf(rawVideo({ avg_frame_rate: '2950/100', r_frame_rate: '30/1' })), 'video', limits),
    ).toBeNull();
  });
  it('refuses dimensions outside the supported range', () => {
    expect(checkProbe(probeOf(rawVideo({ width: 15360, height: 8640 })), 'video', limits)?.reason).toBe(
      'media_dimensions_unsupported',
    );
  });
});

describe('geometry and timing (pure)', () => {
  it('fits the proxy inside 1280×720 (or 720×1280), never upscaling, even sides', () => {
    expect(fitInside(1920, 1080, 1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitInside(1080, 1920, 1280, 720)).toEqual({ width: 720, height: 1280 });
    expect(fitInside(640, 360, 1280, 720)).toEqual({ width: 640, height: 360 });
    expect(fitInside(3840, 1600, 1280, 720)).toEqual({ width: 1280, height: 534 });
  });
  it('places the poster at 10% (at most 3 s) and the strip frames at slice centres', () => {
    expect(posterTimeMs(10_000)).toBe(1_000);
    expect(posterTimeMs(600_000)).toBe(3_000);
    expect(posterTimeMs(0)).toBe(0);
    expect(stripTimesMs(10_000)).toEqual([500, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500, 9500]);
  });
  it('builds a capped H.264 faststart proxy command without metadata', () => {
    const args = proxyArgs(
      'in',
      'out.mp4',
      probeOf(rawVideo({ avg_frame_rate: '60/1', r_frame_rate: '60/1' })),
      1000,
    );
    expect(args.join(' ')).toContain('scale=1280:720');
    expect(args.join(' ')).toContain('-r 30');
    expect(args).toEqual(expect.arrayContaining(['libx264', '+faststart', '-map_metadata', '-fs', '1000']));
  });
});

describe('waveform peaks (pure)', () => {
  const pcm = (samples: number[]) => {
    const b = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
    return b;
  };
  it('takes the absolute peak of each window, scaled to 0..1000', () => {
    const acc = new PeakAccumulator(4, 100);
    acc.push(pcm([0, 100, -16384, 5, 32767, 0, 0, 0, -32768, 1]));
    expect(acc.finish()).toEqual([500, 1000, 1000]);
  });
  it('handles a sample split across chunks', () => {
    const whole = pcm([1000, -20000, 300, 400]);
    const acc = new PeakAccumulator(2, 10);
    acc.push(whole.subarray(0, 3));
    acc.push(whole.subarray(3));
    expect(acc.finish()).toEqual([Math.round((20000 / 32768) * 1000), Math.round((400 / 32768) * 1000)]);
  });
  it('is bounded', () => {
    const acc = new PeakAccumulator(1, 3);
    acc.push(pcm([1, 2, 3, 4, 5, 6]));
    expect(acc.finish()).toHaveLength(3);
  });
  it('draws the peaks as SVG bars', () => {
    const svg = waveformSvg([0, 500, 1000], 40, 20);
    expect(svg.match(/<rect x=/g)).toHaveLength(10);
  });
});

describe.skipIf(!hasTools)(
  'ffmpeg: probe, poster, strip, proxy, waveform on real media',
  { timeout: 120_000 },
  () => {
    let dir: string;
    const ff = async (args: string[]) => {
      const r = await runTool('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(r.stderr);
    };
    const file = (name: string) => join(dir, name);
    const size = async (name: string) => (await stat(file(name))).size;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'video-test-'));
      // 3 s 640×360 25 fps H.264 + AAC (moov at the end), a faststart copy, a rotated copy, audio-only and a WAV.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '3',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-shortest',
        file('clip.mp4'),
      ]);
      await ff(['-i', file('clip.mp4'), '-c', 'copy', '-movflags', '+faststart', file('fast.mp4')]);
      await ff(['-display_rotation', '90', '-i', file('clip.mp4'), '-c', 'copy', file('rotated.mp4')]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=44100',
        '-t',
        '2',
        '-c:a',
        'aac',
        file('audio.m4a'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=22050',
        '-t',
        '2',
        '-c:a',
        'pcm_s16le',
        file('audio.wav'),
      ]);
      const whole = await readFile(file('clip.mp4'));
      await writeFile(file('truncated-end.mp4'), whole.subarray(0, Math.floor(whole.length / 2)));
      const fast = await readFile(file('fast.mp4'));
      await writeFile(file('truncated-fast.mp4'), fast.subarray(0, Math.floor(fast.length * 0.6)));
    }, 120_000);
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('probes a clip and a rotated clip', async () => {
      const p = await probeFile(file('clip.mp4'), await size('clip.mp4'));
      expect('ok' in p).toBe(false);
      expect(p).toMatchObject({
        durationMs: expect.any(Number),
        video: { codec: 'h264', width: 640, height: 360, fps: 25 },
      });
      expect((p as MediaProbeV1).durationMs).toBeGreaterThan(2_900);
      expect((p as MediaProbeV1).durationMs).toBeLessThan(3_200);
      const r = (await probeFile(file('rotated.mp4'), await size('rotated.mp4'))) as MediaProbeV1;
      expect(r.video).toMatchObject({ width: 360, height: 640, codedWidth: 640, rotation: 270 });
    });

    it('rejects a truncated MP4 whose index is missing as media_malformed', async () => {
      const r = await probeFile(file('truncated-end.mp4'), await size('truncated-end.mp4'));
      expect(r).toMatchObject({ ok: false, reason: 'media_malformed' });
      expect((r as { detail: string }).detail).not.toContain(dir);
    });

    it('rejects a faststart MP4 cut short while making its proxy', async () => {
      const probe = (await probeFile(
        file('truncated-fast.mp4'),
        await size('truncated-fast.mp4'),
      )) as MediaProbeV1;
      expect(probe.video?.codec).toBe('h264'); // the index survives: only decoding finds the damage
      const r = await withTempDir({ maxBytes: 256 * 1024 * 1024 }, (tmp) =>
        buildMediaDerivatives(tmp, file('truncated-fast.mp4'), probe, 'video', { maxDurationSeconds: 600 }),
      );
      expect(r).toMatchObject({ ok: false, reason: 'media_malformed' });
    });

    it('decodes the first seconds of a good stream', async () => {
      expect(await decodeCheck(file('clip.mp4'), 'video')).toBeNull();
      expect(await decodeCheck(file('audio.wav'), 'audio')).toBeNull();
    });

    it('builds poster, strip, proxy and waveform derivatives for a video', async () => {
      const probe = (await probeFile(file('clip.mp4'), await size('clip.mp4'))) as MediaProbeV1;
      const phases: string[] = [];
      await withTempDir({ maxBytes: 256 * 1024 * 1024 }, async (tmp) => {
        const r = await buildMediaDerivatives(
          tmp,
          file('clip.mp4'),
          probe,
          'video',
          { maxDurationSeconds: 600 },
          {
            onProgress: (phase) => phases.push(phase),
          },
        );
        if (!r.ok) throw new Error(r.detail);
        expect(r.files.map((f) => f.purpose).sort()).toEqual(
          ['poster', 'preview', 'proxy', 'strip', 'strip_map', 'thumbnail', 'waveform'].sort(),
        );
        const poster = r.files.find((f) => f.purpose === 'poster')!;
        expect(await sharp(tmp.file(poster.name)).metadata()).toMatchObject({
          format: 'webp',
          width: 640,
          height: 360,
        });
        const thumb = r.files.find((f) => f.purpose === 'thumbnail')!;
        expect([thumb.width, thumb.height]).toEqual([256, 144]);
        const map = StripMapV1.parse(JSON.parse(await readFile(tmp.file('strip_map.json'), 'utf8')));
        expect(map.frames).toHaveLength(10);
        expect(map.frames[0]?.timeMs).toBe(Math.floor(probe.durationMs / 20));
        expect(await sharp(tmp.file('strip.webp')).metadata()).toMatchObject({ width: map.frameWidth * 10 });
        const proxy = (await probeFile(
          tmp.file('proxy.mp4'),
          (await stat(tmp.file('proxy.mp4'))).size,
        )) as MediaProbeV1;
        expect(proxy.video).toMatchObject({ codec: 'h264', width: 640, height: 360, fps: 25 });
        expect(proxy.audio[0]).toMatchObject({ codec: 'aac', sampleRate: 48_000, channels: 2 });
        // faststart: the moov box comes before mdat
        const head = (await readFile(tmp.file('proxy.mp4'))).subarray(0, 4096).toString('latin1');
        expect(head.indexOf('moov')).toBeGreaterThan(0);
        expect(head.indexOf('moov')).toBeLessThan(
          head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'),
        );
        const wave = WaveformV1.parse(JSON.parse(await readFile(tmp.file('waveform.json'), 'utf8')));
        expect(wave.peaks.length).toBeGreaterThanOrEqual(59);
        expect(wave.peaks.length).toBeLessThanOrEqual(61);
        expect(Math.max(...wave.peaks)).toBeGreaterThan(100);
      });
      expect(phases).toEqual(expect.arrayContaining(['poster', 'strip', 'proxy', 'waveform', 'done']));
    });

    it('builds a 128k AAC proxy, waveform and waveform images for audio (M4A and WAV)', async () => {
      for (const name of ['audio.m4a', 'audio.wav']) {
        const probe = (await probeFile(file(name), await size(name))) as MediaProbeV1;
        expect(probe.video).toBeNull();
        expect(checkProbe(probe, 'audio', { maxDurationSeconds: 600 })).toBeNull();
        await withTempDir({ maxBytes: 64 * 1024 * 1024 }, async (tmp) => {
          const r = await buildMediaDerivatives(tmp, file(name), probe, 'audio', { maxDurationSeconds: 600 });
          if (!r.ok) throw new Error(r.detail);
          expect(r.files.map((f) => f.purpose).sort()).toEqual(['preview', 'proxy', 'thumbnail', 'waveform']);
          const proxy = (await probeFile(
            tmp.file('proxy.m4a'),
            (await stat(tmp.file('proxy.m4a'))).size,
          )) as MediaProbeV1;
          expect(proxy.audio[0]).toMatchObject({ codec: 'aac', sampleRate: 48_000 });
          expect(proxy.video).toBeNull();
          const preview = r.files.find((f) => f.purpose === 'preview')!;
          expect([preview.width, preview.height]).toEqual([1024, 256]);
        });
      }
    });

    it('removes its temp directory even when the work throws', async () => {
      let path = '';
      await expect(
        withTempDir({ maxBytes: 1024 }, async (tmp) => {
          path = tmp.path;
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expect(stat(path)).rejects.toThrow();
    });
  },
);
