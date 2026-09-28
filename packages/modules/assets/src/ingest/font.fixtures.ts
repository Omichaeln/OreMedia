import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, deflateSync } from 'node:zlib';

/**
 * Test fixtures for font ingest: the pinned OFL fixture fonts (tooling/test-fixtures/fonts) and minimal WOFF and
 * WOFF2 wrappers of them built byte by byte (WOFF2 with null-transformed glyf/loca, which the format allows), so
 * tests exercise every accepted font format without binary fixtures. Imported by tests only.
 */
const FONTS = new URL('../../../../../tooling/test-fixtures/fonts/', import.meta.url);
export const karlaTtf = (): Buffer => readFileSync(fileURLToPath(new URL('karla/Karla[wght].ttf', FONTS)));
export const notoNaskhTtf = (): Buffer =>
  readFileSync(fileURLToPath(new URL('noto-naskh-arabic/NotoNaskhArabic[wght].ttf', FONTS)));

interface SfntTable {
  tag: string;
  data: Buffer;
  checksum: number;
}

function sfntTables(sfnt: Buffer): { flavor: number; tables: SfntTable[] } {
  const numTables = sfnt.readUInt16BE(4);
  const tables: SfntTable[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 12 + 16 * i;
    const offset = sfnt.readUInt32BE(at + 8);
    const length = sfnt.readUInt32BE(at + 12);
    tables.push({
      tag: sfnt.toString('latin1', at, at + 4),
      checksum: sfnt.readUInt32BE(at + 4),
      data: sfnt.subarray(offset, offset + length),
    });
  }
  return { flavor: sfnt.readUInt32BE(0), tables };
}

const pad4 = (n: number) => (n + 3) & ~3;
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const padded = (b: Buffer) => Buffer.concat([b, Buffer.alloc(pad4(b.length) - b.length)]);

/** WOFF 1.0: header, directory, zlib-compressed tables on 4-byte boundaries. */
export function toWoff(sfnt: Buffer): Buffer {
  const { flavor, tables } = sfntTables(sfnt);
  const dirEnd = 44 + 20 * tables.length;
  const entries: Buffer[] = [];
  const blobs: Buffer[] = [];
  let offset = dirEnd;
  for (const t of tables) {
    const z = deflateSync(t.data);
    const stored = z.length < t.data.length ? z : t.data;
    entries.push(
      Buffer.concat([
        Buffer.from(t.tag, 'latin1'),
        u32(offset),
        u32(stored.length),
        u32(t.data.length),
        u32(t.checksum),
      ]),
    );
    blobs.push(padded(stored));
    offset += pad4(stored.length);
  }
  const totalSfntSize = 12 + 16 * tables.length + tables.reduce((n, t) => n + pad4(t.data.length), 0);
  const header = Buffer.concat([
    Buffer.from('wOFF', 'latin1'),
    u32(flavor),
    u32(offset),
    u16(tables.length),
    u16(0),
    u32(totalSfntSize),
    u16(1),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  ]);
  return Buffer.concat([header, ...entries, ...blobs]);
}

/** WOFF2 known-table index (W3C WOFF2 5.1); anything else is written with its own four-byte tag (index 63). */
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

function base128(n: number): Buffer {
  const bytes = [n & 0x7f];
  for (let v = n >>> 7; v > 0; v >>>= 7) bytes.unshift((v & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

/**
 * WOFF2 with every table untransformed (glyf/loca transform version 3) in one Brotli stream. A different Brotli
 * quality gives different bytes for the same font (tests that need distinct files of one font).
 */
export function toWoff2(sfnt: Buffer, quality = 4): Buffer {
  const { flavor, tables } = sfntTables(sfnt);
  const directory = Buffer.concat(
    tables.map((t) => {
      const known = KNOWN_TAGS.indexOf(t.tag);
      const nullTransform = t.tag === 'glyf' || t.tag === 'loca' ? 0xc0 : 0;
      const flags = (known === -1 ? 0x3f : known) | nullTransform;
      return Buffer.concat([
        Buffer.from([flags]),
        known === -1 ? Buffer.from(t.tag, 'latin1') : Buffer.alloc(0),
        base128(t.data.length),
      ]);
    }),
  );
  const compressed = brotliCompressSync(Buffer.concat(tables.map((t) => t.data)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: quality },
  });
  const totalSfntSize = 12 + 16 * tables.length + tables.reduce((n, t) => n + pad4(t.data.length), 0);
  const length = pad4(48 + directory.length + compressed.length);
  const header = Buffer.concat([
    Buffer.from('wOF2', 'latin1'),
    u32(flavor),
    u32(length),
    u16(tables.length),
    u16(0),
    u32(totalSfntSize),
    u32(compressed.length),
    u16(1),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  ]);
  return padded(Buffer.concat([header, directory, compressed]));
}

/**
 * A WOFF2 decompression bomb: a valid header and directory declaring one table of `declaredBytes`, whose Brotli
 * stream is that many zero bytes (a few kilobytes on disk). Ingest must refuse it without decompressing.
 */
export function woff2Bomb(declaredBytes: number): Buffer {
  const compressed = brotliCompressSync(Buffer.alloc(declaredBytes), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 1 },
  });
  const directory = Buffer.concat([Buffer.from([KNOWN_TAGS.indexOf('glyf') | 0xc0]), base128(declaredBytes)]);
  const length = pad4(48 + directory.length + compressed.length);
  const header = Buffer.concat([
    Buffer.from('wOF2', 'latin1'),
    u32(0x00010000),
    u32(length),
    u16(1),
    u16(0),
    u32(12 + 16 + pad4(declaredBytes)),
    u32(compressed.length),
    u16(1),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  ]);
  return padded(Buffer.concat([header, directory, compressed]));
}
