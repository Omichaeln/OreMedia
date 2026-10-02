import { describe, expect, it } from 'vitest';
import { isZipFileName, readZip, ZipReadError } from './unzip';
import { zip } from '../../e2e/zip-writer';

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

describe('readZip bounds', () => {
  it('reports a zip64 entry as an unsupported archive, not as not-an-archive', async () => {
    const archive = zip([{ path: 'SKILL.md', content: '# x' }]);
    archive.writeUInt32LE(0xffffffff, archive.length - 22 - (46 + 'SKILL.md'.length) + 20); // central compressed size
    await expect(readZip(toArrayBuffer(archive))).rejects.toMatchObject({ reason: 'unsupported_archive' });
  });

  it('skips entries over the caller bound without unpacking them', async () => {
    const archive = zip([
      { path: 'SKILL.md', content: '# small' },
      { path: 'assets/big.svg', content: 'x'.repeat(5_000), deflate: true },
    ]);
    const entries = await readZip(toArrayBuffer(archive), 1_000);
    expect(entries.map((e) => [e.path, e.skipped ?? false, e.bytes.length])).toEqual([
      ['SKILL.md', false, 7],
      ['assets/big.svg', true, 0],
    ]);
  });
});
