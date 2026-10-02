/**
 * Reads a zip archive in the browser without a library: the central directory names the entries, each stored (0)
 * or deflated (8) entry is unpacked, and directories are dropped. A `.skill` package exported from Claude is such
 * an archive. Zip64 archives, encrypted entries and other compression methods are refused by name so the caller
 * can say why. CRCs are deliberately not checked: a corrupt deflate stream fails to inflate, and the server
 * re-parses and validates every package before anything is stored. Entry names are read as UTF-8 (what Claude,
 * Python and macOS write); `maxEntryBytes` skips entries whose unpacked size exceeds it so a package carrying large
 * assets is not inflated in full for text the caller will not keep.
 */
export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  /** The entry's unpacked size exceeded the caller's bound, so its bytes were not unpacked. */
  skipped?: boolean;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipReadError extends Error {
  constructor(readonly reason: 'not_an_archive' | 'unsupported_archive' | 'unsupported_entry') {
    super(reason);
    this.name = 'ZipReadError';
  }
}

export const isZipFileName = (name: string): boolean => /\.(skill|zip)$/i.test(name);

const READ_MESSAGE: Record<ZipReadError['reason'], string> = {
  not_an_archive: 'is not a zip archive; a .skill package is one',
  unsupported_archive: 'is an archive format this page cannot open; re-export the skill as a plain zip',
  unsupported_entry:
    'has an entry that is encrypted or compressed in a way this page cannot open; re-export the skill without a password',
};

/** The entries of a picked `.skill` or `.zip` file, or an Error naming the file and why it could not be read. */
export async function unpackPicked(file: File, maxEntryBytes?: number): Promise<ZipEntry[]> {
  try {
    return await readZip(await file.arrayBuffer(), maxEntryBytes);
  } catch (err) {
    throw new Error(
      `${file.name} ${err instanceof ZipReadError ? READ_MESSAGE[err.reason] : 'could not be read'}.`,
    );
  }
}

/**
 * Drops the one folder every entry of a package sits in (an archive made from a folder rather than its contents),
 * so SKILL.md is at the root as the import expects.
 */
export function stripSharedRoot<T extends { path: string }>(files: T[]): T[] {
  const firsts = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  const [root] = firsts;
  const wrapped = firsts.size === 1 && !!root && files.some((f) => f.path === `${root}/SKILL.md`);
  return wrapped ? files.map((f) => ({ ...f, path: f.path.slice(root.length + 1) })) : files;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(data: ArrayBuffer, maxEntryBytes = Infinity): Promise<ZipEntry[]> {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  // The end-of-central-directory record is the last 22 bytes plus an optional comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG && i + 22 + view.getUint16(i + 20, true) === data.byteLength) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError('not_an_archive');
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipReadError('unsupported_archive');
  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.byteLength || view.getUint32(at, true) !== CENTRAL_SIG)
      throw new ZipReadError('not_an_archive');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/')) continue;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff)
      throw new ZipReadError('unsupported_archive');
    if (flags & 0x1) throw new ZipReadError('unsupported_entry'); // encrypted
    if (method !== 0 && method !== 8) throw new ZipReadError('unsupported_entry');
    if (uncompressedSize > maxEntryBytes) {
      entries.push({ path, bytes: new Uint8Array(0), skipped: true });
      continue;
    }
    if (localOffset + 30 > data.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIG)
      throw new ZipReadError('not_an_archive');
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > data.byteLength) throw new ZipReadError('not_an_archive');
    const packed = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.push({ path, bytes: method === 8 ? await inflateRaw(packed) : packed.slice() });
  }
  return entries;
}
