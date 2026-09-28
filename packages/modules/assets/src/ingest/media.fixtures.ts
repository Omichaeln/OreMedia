/**
 * Test fixtures for ingest/media.ts: minimal containers built byte by byte, what a generation provider returns
 * stripped to the structure. Imported by tests only.
 */
export const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
export const box = (type: string, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
export const mvhd = (timescale: number, duration: number) =>
  box('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80));
/** tkhd version 0: 84-byte payload whose last two fields are width and height in 16.16 fixed point. */
export const tkhd = (width: number, height: number) =>
  box('tkhd', Buffer.alloc(76), u32(width << 16), u32(height << 16));
export function mp4(opts: { seconds?: number; width?: number; height?: number; brand?: string } = {}) {
  const { seconds = 5, width = 1280, height = 720, brand = 'isom' } = opts;
  return Buffer.concat([
    box('ftyp', Buffer.from(brand, 'latin1'), u32(0), Buffer.from(brand, 'latin1')),
    box('moov', mvhd(1000, seconds * 1000), box('trak', tkhd(width, height))),
    box('mdat', Buffer.alloc(64, 7)),
  ]);
}

export function wav(seconds = 2, byteRate = 8000) {
  const data = Buffer.alloc(seconds * byteRate, 1);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // mono
  fmt.writeUInt32LE(byteRate, 4); // 8-bit mono: sample rate = byte rate
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(1, 12);
  fmt.writeUInt16LE(8, 14);
  const chunk = (id: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', data)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** MPEG-1 layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames of 1152 samples. */
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
export function mp3(frames = 40, opts: { id3?: boolean; tail?: Buffer } = {}) {
  const id3 = opts.id3
    ? Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10)])
    : Buffer.alloc(0);
  return Buffer.concat([id3, ...Array.from({ length: frames }, () => FRAME), opts.tail ?? Buffer.alloc(0)]);
}
