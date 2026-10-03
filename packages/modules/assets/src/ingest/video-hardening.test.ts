import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaProbeV1 } from '@oremedia/contracts/media';
import { withTempDir } from '../temp-disk';
import {
  buildMediaDerivatives,
  decodeCheck,
  demuxerFor,
  inspectFile,
  mediaToolsAvailable,
  probeFile,
  runTool,
  stripMetadata,
  withToolContext,
} from './video';

/**
 * STU-2a review hardening, against the real ffmpeg 6.1: crafted inputs never reach the network (protocol whitelist,
 * forced demuxer, external data references), a header cannot understate the duration, a WebM without a recorded
 * duration is measured, personal metadata is stripped while rotation is kept, oversized frames are refused, and a
 * cancelled activity kills its tool. Skips, saying so, without ffmpeg (CI installs it).
 */
const hasTools = await mediaToolsAvailable();
if (!hasTools) console.error('video-hardening.test.ts: ffmpeg/ffprobe not found; the suite is skipped');

/** Inserts `url` into the first self-contained `url ` data reference of an MP4 (moov after mdat, so no offsets move). */
function withExternalDataReference(mp4: Buffer, url: string): Buffer {
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf']);
  const path: number[] = [];
  const find = (from: number, to: number): number | null => {
    for (let at = from; at + 8 <= to;) {
      const size = mp4.readUInt32BE(at);
      const type = mp4.toString('latin1', at + 4, at + 8);
      if (size < 8) return null;
      if (type === 'url ') return at;
      const childStart = type === 'dref' ? at + 16 : containers.has(type) ? at + 8 : null;
      if (childStart !== null) {
        path.push(at);
        const hit = find(childStart, at + size);
        if (hit !== null) return hit;
        path.pop();
      }
      at += size;
    }
    return null;
  };
  const urlBox = find(0, mp4.length);
  if (urlBox === null) throw new Error('no url box');
  const payload = Buffer.from(`${url}\0`, 'latin1');
  const box = Buffer.alloc(12 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write('url ', 4, 'latin1');
  box.writeUInt32BE(0, 8); // flags 0: the media data is NOT in this file
  payload.copy(box, 12);
  const out = Buffer.concat([mp4.subarray(0, urlBox), box, mp4.subarray(urlBox + 12)]);
  for (const at of path) out.writeUInt32BE(out.readUInt32BE(at) + payload.length, at);
  return out;
}

describe.skipIf(!hasTools)('media toolkit hardening (real ffmpeg)', { timeout: 120_000 }, () => {
  let dir: string;
  let server: Server;
  let origin = '';
  const fetched: string[] = [];
  const file = (name: string) => join(dir, name);
  const size = async (name: string) => (await stat(file(name))).size;
  const ff = async (args: string[]) => {
    const r = await runTool('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'video-hardening-'));
    server = createServer((req, res) => {
      fetched.push(req.url ?? '');
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      file('plain.mp4'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=10',
      '-t',
      '6',
      '-c:v',
      'libvpx',
      '-b:v',
      '50k',
      file('six.webm'),
    ]);
    await ff([
      '-display_rotation',
      '90',
      '-i',
      file('plain.mp4'),
      '-c',
      'copy',
      '-metadata',
      'location=+48.8577+002.2950/',
      '-metadata',
      'com.apple.quicktime.make=Phone',
      file('located.mp4'),
    ]);
    await writeFile(
      file('hls.mp4'),
      `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${origin}/segment.ts\n#EXT-X-ENDLIST\n`,
    );
    await writeFile(file('concat.mp4'), `ffconcat version 1.0\nfile '${origin}/remote.mp4'\n`);
    await writeFile(
      file('dref.mp4'),
      withExternalDataReference(await readFile(file('plain.mp4')), `${origin}/data.mov`),
    );
    // A WebM without its Duration element (MediaRecorder output), and one whose Duration says 1 s for 6 s of video.
    const webm = await readFile(file('six.webm'));
    const at = webm.indexOf(Buffer.from([0x44, 0x89, 0x88]));
    const noDuration = Buffer.from(webm);
    Buffer.concat([Buffer.from([0xec, 0x89]), Buffer.alloc(9)]).copy(noDuration, at);
    await writeFile(file('no-duration.webm'), noDuration);
    const lying = Buffer.from(webm);
    lying.writeDoubleBE(1000, at + 3);
    await writeFile(file('lying.webm'), lying);
  }, 120_000);
  afterAll(async () => {
    server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('control: ffprobe allowed http does fetch the playlist segment (so the next tests are meaningful)', async () => {
    const before = fetched.length;
    await runTool(
      'ffprobe',
      ['-v', 'error', '-protocol_whitelist', 'file,http,tcp', '-f', 'hls', file('hls.mp4')],
      { timeoutMs: 30_000 },
    );
    expect(fetched.length).toBeGreaterThan(before);
  });

  it('HLS and concat playlists named .mp4 are refused and never reach the network', async () => {
    const before = fetched.length;
    for (const name of ['hls.mp4', 'concat.mp4']) {
      expect(await probeFile(file(name), await size(name), { mime: 'video/mp4' })).toMatchObject({
        ok: false,
        reason: 'media_malformed',
      });
      expect(await decodeCheck(file(name), 'video', 'video/mp4')).toMatchObject({ ok: false });
    }
    expect(fetched.length).toBe(before);
  });

  it('an MP4 whose data reference points at a URL is processed from the file alone: nothing is fetched', async () => {
    const before = fetched.length;
    const r = await probeFile(file('dref.mp4'), await size('dref.mp4'), { mime: 'video/mp4' });
    if (!('ok' in r))
      await withTempDir({ maxBytes: 64 * 1024 * 1024 }, (tmp) =>
        buildMediaDerivatives(
          tmp,
          file('dref.mp4'),
          r,
          'video',
          { maxDurationSeconds: 600 },
          { mime: 'video/mp4' },
        ),
      );
    await decodeCheck(file('dref.mp4'), 'video', 'video/mp4');
    expect(fetched.length).toBe(before);
  });

  it('the sniffed type decides the demuxer; content of another container is refused', async () => {
    expect(demuxerFor('video/webm')).toBe('matroska');
    expect(demuxerFor('audio/mpeg')).toBe('mp3');
    expect(demuxerFor('application/x-mpegurl')).toBeNull();
    expect(await probeFile(file('six.webm'), await size('six.webm'), { mime: 'video/mp4' })).toMatchObject({
      ok: false,
    });
    expect(
      await probeFile(file('plain.mp4'), await size('plain.mp4'), { mime: 'audio/x-mpegurl' }),
    ).toMatchObject({
      ok: false,
      reason: 'format_unsupported',
    });
  });

  it('a WebM without a recorded duration is measured instead of refused', async () => {
    const r = (await probeFile(file('no-duration.webm'), await size('no-duration.webm'), {
      mime: 'video/webm',
    })) as MediaProbeV1;
    expect(r.durationMs).toBeGreaterThan(5_800);
    expect(r.durationMs).toBeLessThan(6_300);
  });

  it('a header that understates the duration is caught while the proxy plays the real length', async () => {
    const probe = (await probeFile(file('lying.webm'), await size('lying.webm'), {
      mime: 'video/webm',
    })) as MediaProbeV1;
    expect(probe.durationMs).toBe(1_000); // what the header claims
    const r = await withTempDir({ maxBytes: 64 * 1024 * 1024 }, (tmp) =>
      buildMediaDerivatives(
        tmp,
        file('lying.webm'),
        probe,
        'video',
        { maxDurationSeconds: 600 },
        { mime: 'video/webm' },
      ),
    );
    expect(r).toMatchObject({ ok: false, reason: 'media_malformed' });
    expect((r as { detail: string }).detail).toMatch(/says it lasts 1 s but plays for [56](\.\d)? s/);
    // An honest file reports what it played (recorded on the version).
    const honest = (await probeFile(file('six.webm'), await size('six.webm'), {
      mime: 'video/webm',
    })) as MediaProbeV1;
    const ok = await withTempDir({ maxBytes: 64 * 1024 * 1024 }, (tmp) =>
      buildMediaDerivatives(
        tmp,
        file('six.webm'),
        honest,
        'video',
        { maxDurationSeconds: 600 },
        { mime: 'video/webm' },
      ),
    );
    expect(ok).toMatchObject({ ok: true });
    expect((ok as { playedMs: number }).playedMs).toBeGreaterThan(5_500); // up to the last frame's timestamp
  });

  it('personal metadata is found and stripped into a faststart copy that keeps the rotation', async () => {
    const before = await inspectFile(file('located.mp4'), await size('located.mp4'), { mime: 'video/mp4' });
    if ('ok' in before) throw new Error(before.detail);
    expect(before.personalTags).toEqual(expect.arrayContaining(['location']));
    await withTempDir({ maxBytes: 64 * 1024 * 1024 }, async (tmp) => {
      const clean = await stripMetadata(tmp, file('located.mp4'), 'video/mp4', 'clean');
      if ('ok' in clean) throw new Error(clean.detail);
      const after = await inspectFile(clean.path, (await stat(clean.path)).size, { mime: 'video/mp4' });
      if ('ok' in after) throw new Error(after.detail);
      expect(after.personalTags).toEqual([]);
      expect(after.probe.video).toMatchObject({
        rotation: before.probe.video?.rotation,
        width: 240,
        height: 320,
      });
      expect(Math.abs(after.probe.durationMs - before.probe.durationMs)).toBeLessThan(50);
      const raw = (await readFile(clean.path)).toString('latin1');
      expect(raw).not.toContain('48.8577');
      expect(raw.indexOf('moov')).toBeLessThan(raw.indexOf('mdat'));
    });
    // A plain encoder tag counts as personal (device and software user data) too.
    const plain = await inspectFile(file('plain.mp4'), await size('plain.mp4'), { mime: 'video/mp4' });
    expect('ok' in plain ? [] : plain.personalTags).toContain('encoder');
  });

  it('a frame larger than 8K is refused as oversized at decode', async () => {
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=7700x4400:rate=1',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      file('huge.mov'),
    ]);
    expect(await decodeCheck(file('huge.mov'), 'video', 'video/quicktime')).toMatchObject({
      reason: 'media_dimensions_unsupported',
    });
  });

  it('a cancelled activity kills its tool; a long tool ticks the heartbeat', async () => {
    const controller = new AbortController();
    const ticks: number[] = [];
    const started = Date.now();
    const run = withToolContext({ signal: controller.signal, tick: () => ticks.push(Date.now()) }, () =>
      runTool('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2', '-f', 'null', '-'], {
        timeoutMs: 60_000,
        tickMs: 100,
      }),
    );
    setTimeout(() => controller.abort(), 600);
    await expect(run).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    await expect(
      withToolContext({ signal: controller.signal }, () =>
        runTool('ffmpeg', ['-version'], { timeoutMs: 5_000 }),
      ),
    ).rejects.toThrow(/cancelled/);
  });
});
