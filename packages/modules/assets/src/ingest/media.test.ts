import { describe, expect, it } from 'vitest';
import { inspectMedia } from './media';
import { box, mp3, mp4, mvhd, tkhd, u32, wav } from './media.fixtures';

describe('inspectMedia: MP4 and MOV (ADR-11 generated video)', () => {
  it('reads the duration from the movie header and the size from the video track', () => {
    expect(inspectMedia(mp4({ seconds: 8, width: 1280, height: 720 }), 'video/mp4')).toEqual({
      ok: true,
      info: { durationSeconds: 8, width: 1280, height: 720 },
    });
    expect(inspectMedia(mp4({ brand: 'qt  ' }), 'video/quicktime')).toMatchObject({ ok: true });
  });

  it('refuses a file cut short, one with bytes after the last box, and one with no media data', () => {
    const whole = mp4();
    expect(inspectMedia(whole.subarray(0, whole.length - 10), 'video/mp4')).toMatchObject({ ok: false });
    expect(inspectMedia(Buffer.concat([whole, Buffer.from('junk')]), 'video/mp4')).toMatchObject({
      ok: false,
    });
    const noMdat = Buffer.concat([
      box('ftyp', Buffer.from('isom'), u32(0)),
      box('moov', mvhd(1000, 5000), box('trak', tkhd(640, 360))),
    ]);
    expect(inspectMedia(noMdat, 'video/mp4')).toEqual({ ok: false, detail: 'no media data' });
  });

  it('refuses a video with no picture, a zero duration, and a file whose first box is not ftyp', () => {
    expect(inspectMedia(mp4({ width: 0, height: 0 }), 'video/mp4')).toEqual({
      ok: false,
      detail: 'no video track',
    });
    expect(inspectMedia(mp4({ seconds: 0 }), 'video/mp4')).toEqual({ ok: false, detail: 'no duration' });
    expect(inspectMedia(Buffer.concat([box('free'), mp4()]), 'video/mp4')).toEqual({
      ok: false,
      detail: 'no ftyp box first',
    });
  });

  it('M4A audio has no picture and needs none', () => {
    expect(inspectMedia(mp4({ width: 0, height: 0, brand: 'M4A ' }), 'audio/mp4')).toEqual({
      ok: true,
      info: { durationSeconds: 5, width: null, height: null },
    });
  });
});

describe('inspectMedia: WAV and MP3 (ADR-11 generated audio)', () => {
  it('WAV: the duration is the data size over the byte rate', () => {
    expect(inspectMedia(wav(3), 'audio/wav')).toEqual({
      ok: true,
      info: { durationSeconds: 3, width: null, height: null },
    });
  });

  it('WAV: a RIFF size that disagrees with the file, or a chunk past the end, is refused', () => {
    const whole = wav(1);
    expect(inspectMedia(whole.subarray(0, whole.length - 100), 'audio/wav')).toMatchObject({ ok: false });
    expect(inspectMedia(Buffer.concat([whole, Buffer.alloc(40)]), 'audio/wav')).toMatchObject({ ok: false });
    const lying = Buffer.from(whole);
    lying.writeUInt32LE(whole.length, 40); // the data chunk claims more than the file holds
    expect(inspectMedia(lying, 'audio/wav')).toMatchObject({ ok: false });
  });

  it('MP3: the duration is the sum of its frames, with or without an ID3v2 tag or an ID3v1 trailer', () => {
    const r = inspectMedia(mp3(100), 'audio/mpeg');
    expect(r?.ok && r.info.durationSeconds).toBeCloseTo((100 * 1152) / 44100, 6);
    expect(inspectMedia(mp3(10, { id3: true }), 'audio/mpeg')).toMatchObject({ ok: true });
    const v1 = Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)]);
    expect(inspectMedia(mp3(10, { tail: v1 }), 'audio/mpeg')).toMatchObject({ ok: true });
  });

  it('MP3: stray bytes after the frames, a truncated last frame, or too few frames are refused', () => {
    expect(inspectMedia(mp3(10, { tail: Buffer.from('not audio') }), 'audio/mpeg')).toEqual({
      ok: false,
      detail: 'data after the last audio frame',
    });
    const whole = mp3(10);
    expect(inspectMedia(whole.subarray(0, whole.length - 5), 'audio/mpeg')).toMatchObject({ ok: false });
    expect(inspectMedia(mp3(2), 'audio/mpeg')).toEqual({ ok: false, detail: 'no MPEG audio frames' });
  });

  it('a mime with no inspector is left to the caller', () => {
    expect(inspectMedia(Buffer.alloc(10), 'video/webm')).toBeNull();
  });
});
