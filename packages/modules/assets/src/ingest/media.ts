/**
 * ADR-11 generated media, spec 9.1 step 4 for video and audio: a structural check, not a transcode. The container is
 * walked from its first byte to its last, so a truncated or padded file, a box or chunk that runs past the end, or a
 * stream with no playable content is refused; the duration (and a video's dimensions) come from the container. The
 * stored bytes are the provider's, unchanged.
 */
export interface MediaInfo {
  durationSeconds: number;
  width: number | null;
  height: number | null;
}

export type MediaInspection = { ok: true; info: MediaInfo } | { ok: false; detail: string };

const bad = (detail: string): MediaInspection => ({ ok: false, detail });

// ---- ISO base media (MP4, MOV, M4A) ----------------------------------------------------------------------------

interface Box {
  type: string;
  /** Offset of the box's payload (after its header). */
  start: number;
  /** Offset just past the box. */
  end: number;
}

/** The boxes between `from` and `to`, which they must cover exactly. Null when any box is malformed. */
function boxes(buf: Buffer, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at < to) {
    if (to - at < 8) return null;
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (to - at < 16) return null;
      const large = buf.readBigUInt64BE(at + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = to - at; // extends to the end of its parent
    }
    if (size < header || at + size > to) return null;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (buf: Buffer, parent: Box, type: string) =>
  boxes(buf, parent.start, parent.end)?.find((b) => b.type === type) ?? null;

function inspectIsoBmff(buf: Buffer, wantVideo: boolean): MediaInspection {
  const top = boxes(buf, 0, buf.length);
  if (!top) return bad('container boxes do not cover the file');
  if (top[0]?.type !== 'ftyp') return bad('no ftyp box first');
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return bad('no moov box');
  if (!top.some((b) => b.type === 'mdat' && b.end > b.start)) return bad('no media data');
  const moovChildren = boxes(buf, moov.start, moov.end);
  if (!moovChildren) return bad('moov boxes malformed');

  const mvhd = moovChildren.find((b) => b.type === 'mvhd');
  if (!mvhd || mvhd.end - mvhd.start < 32) return bad('no movie header');
  const v1 = buf[mvhd.start] === 1;
  if (v1 && mvhd.end - mvhd.start < 44) return bad('movie header truncated');
  const timescale = buf.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
  const duration = v1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
  if (timescale === 0 || duration === 0) return bad('no duration');

  let width: number | null = null;
  let height: number | null = null;
  let tracks = 0;
  for (const trak of moovChildren.filter((b) => b.type === 'trak')) {
    tracks += 1;
    const tkhd = child(buf, trak, 'tkhd');
    if (!tkhd || tkhd.end - tkhd.start < 84) return bad('track header malformed');
    // Width and height are the last two fields, 16.16 fixed point.
    const w = buf.readUInt32BE(tkhd.end - 8) >>> 16;
    const h = buf.readUInt32BE(tkhd.end - 4) >>> 16;
    if (w > 0 && h > 0 && width === null) {
      width = w;
      height = h;
    }
  }
  if (tracks === 0) return bad('no tracks');
  if (wantVideo && width === null) return bad('no video track');
  return { ok: true, info: { durationSeconds: duration / timescale, width, height } };
}

// ---- WAV -------------------------------------------------------------------------------------------------------

function inspectWav(buf: Buffer): MediaInspection {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE')
    return bad('not a RIFF WAVE file');
  const riffEnd = 8 + buf.readUInt32LE(4);
  // The file ends where RIFF says, allowing the pad byte of an odd-sized body.
  if (riffEnd < 12 || riffEnd > buf.length || buf.length > riffEnd + 1)
    return bad('RIFF size does not match the file');
  let byteRate = 0;
  let dataBytes = -1;
  let at = 12;
  while (at < riffEnd) {
    if (riffEnd - at < 8) return bad('chunk header truncated');
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const end = at + 8 + size;
    if (end > riffEnd) return bad(`chunk ${id.trim()} runs past the end`);
    if (id === 'fmt ') {
      if (size < 16) return bad('fmt chunk truncated');
      byteRate = buf.readUInt32LE(at + 8 + 8);
    } else if (id === 'data') {
      if (byteRate === 0) return bad('data before fmt');
      dataBytes = size;
    }
    at = end + (size % 2); // chunks are word-aligned
  }
  if (byteRate === 0) return bad('no fmt chunk');
  if (dataBytes <= 0) return bad('no audio data');
  return { ok: true, info: { durationSeconds: dataBytes / byteRate, width: null, height: null } };
}

// ---- MP3 (MPEG audio layer III) --------------------------------------------------------------------------------

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};
/** Frames needed before a stream counts as audio rather than a lucky sync word. */
const MIN_FRAMES = 3;

/** One layer III frame header at `at`: its length and duration, or null when there is none. */
function mp3Frame(buf: Buffer, at: number): { length: number; seconds: number } | null {
  if (at + 4 > buf.length) return null;
  const b1 = buf[at + 1] as number;
  const b2 = buf[at + 2] as number;
  if (buf[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x03; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5, 1 reserved
  const layer = (b1 >> 1) & 0x03; // 1 is layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = (version === 3 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIndex] as number;
  const sampleRate = (SAMPLE_RATES[version] as readonly number[])[rateIndex] as number;
  const padding = (b2 >> 1) & 0x01;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  return { length, seconds: samples / sampleRate };
}

function inspectMp3(buf: Buffer): MediaInspection {
  let at = 0;
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    // ID3v2: a 28-bit syncsafe size after a 10-byte header, plus a footer when flagged.
    const syncsafe = (i: number) => buf.readUInt8(i) & 0x7f;
    const size = (syncsafe(6) << 21) | (syncsafe(7) << 14) | (syncsafe(8) << 7) | syncsafe(9);
    at = 10 + size + ((buf.readUInt8(5) & 0x10) !== 0 ? 10 : 0);
    if (at >= buf.length) return bad('ID3 tag runs past the end');
  }
  let frames = 0;
  let seconds = 0;
  for (;;) {
    const frame = mp3Frame(buf, at);
    if (!frame || at + frame.length > buf.length) break;
    frames += 1;
    seconds += frame.seconds;
    at += frame.length;
  }
  if (frames < MIN_FRAMES) return bad('no MPEG audio frames');
  // After the last frame only a trailing tag may follow: ID3v1 (128 bytes) or an APE tag.
  const tail = buf.subarray(at);
  const tagOnly =
    tail.length === 0 ||
    (tail.length === 128 && tail.toString('latin1', 0, 3) === 'TAG') ||
    tail.toString('latin1', 0, 8) === 'APETAGEX';
  if (!tagOnly) return bad('data after the last audio frame');
  return { ok: true, info: { durationSeconds: seconds, width: null, height: null } };
}

// ---- dispatch --------------------------------------------------------------------------------------------------

/** Structural inspection by sniffed mime; null when the mime has no inspector. */
export function inspectMedia(bytes: Buffer, mime: string): MediaInspection | null {
  switch (mime) {
    case 'video/mp4':
    case 'video/quicktime':
      return inspectIsoBmff(bytes, true);
    case 'audio/mp4':
      return inspectIsoBmff(bytes, false);
    case 'audio/wav':
      return inspectWav(bytes);
    case 'audio/mpeg':
      return inspectMp3(bytes);
    default:
      return null;
  }
}
