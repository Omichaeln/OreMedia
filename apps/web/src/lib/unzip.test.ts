import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { isZipFileName, readZip, ZipReadError } from './unzip';

/** A minimal zip writer for the tests: stored or deflated entries with a correct central directory. */
function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
export function zip(files: Array<{ path: string; content: string; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const raw = Buffer.from(f.content, 'utf8');
    const data = f.deflate ? deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([head, name, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const text = (e: { bytes: Uint8Array }) => new TextDecoder().decode(e.bytes);

describe('readZip (a .skill package is a zip archive)', () => {
  it('unpacks stored and deflated entries and drops directory entries', async () => {
    const archive = zip([
      { path: 'references/', content: '' },
      { path: 'SKILL.md', content: '---\nname: harbour\n---\n# Harbour', deflate: true },
      { path: 'references/tokens.md', content: '| Primary | `#1a2a4d` |' },
      { path: 'assets/logo.svg', content: '<svg/>', deflate: true },
    ]);
    const entries = await readZip(toArrayBuffer(archive));
    expect(entries.map((e) => e.path)).toEqual(['SKILL.md', 'references/tokens.md', 'assets/logo.svg']);
    expect(text(entries[0]!)).toBe('---\nname: harbour\n---\n# Harbour');
    expect(text(entries[1]!)).toBe('| Primary | `#1a2a4d` |');
    expect(text(entries[2]!)).toBe('<svg/>');
  });

  it('refuses a file that is not an archive by reason', async () => {
    await expect(readZip(toArrayBuffer(Buffer.from('# Not a zip\n')))).rejects.toMatchObject({
      name: 'ZipReadError',
      reason: 'not_an_archive',
    });
    await expect(readZip(new ArrayBuffer(0))).rejects.toBeInstanceOf(ZipReadError);
  });

  it('refuses an encrypted entry', async () => {
    const archive = zip([{ path: 'SKILL.md', content: '# x' }]);
    archive.writeUInt16LE(1, archive.length - 22 - (46 + 'SKILL.md'.length) + 8); // central flags: encrypted
    await expect(readZip(toArrayBuffer(archive))).rejects.toMatchObject({ reason: 'unsupported_entry' });
  });

  it('recognises .skill and .zip names regardless of case', () => {
    expect(isZipFileName('kinsley-estate-brand.skill')).toBe(true);
    expect(isZipFileName('Brand.ZIP')).toBe(true);
    expect(isZipFileName('SKILL.md')).toBe(false);
  });
});
