import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ByteRange, StorageProvider } from './storage';

/**
 * STU-2a: scratch disk for media processing (ffprobe/ffmpeg read and write files, not buffers). A TempDir is one
 * private directory with a byte budget: downloads abort as soon as they would exceed it, callers cap tool output
 * (ffmpeg `-fs`) with `remaining()`, and `assertWithinBudget()` checks what the tools wrote. `withTempDir` always
 * removes the directory, whether the work succeeded, threw or was cancelled. Directories a crashed process left
 * behind are removed at worker start by `sweepStaleTempDirs`.
 */
export const TEMP_DIR_PREFIX = 'oremedia-media-';

export class TempDiskBudgetExceededError extends Error {
  constructor(
    readonly usedBytes: number,
    readonly maxBytes: number,
  ) {
    super(`temp disk budget exceeded: ${usedBytes} bytes used of ${maxBytes}`);
    this.name = 'TempDiskBudgetExceededError';
  }
}

export interface TempDirOptions {
  /** Most bytes the directory may hold at once. */
  maxBytes: number;
  /** Parent directory; default MEDIA_TMP_DIR or the OS temp directory. */
  root?: string;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export const tempRoot = (root?: string): string => root ?? process.env['MEDIA_TMP_DIR'] ?? tmpdir();

export class TempDir {
  constructor(
    readonly path: string,
    readonly maxBytes: number,
  ) {}

  /** Absolute path of a file in the directory; names are plain (no separators, no dot-dot). */
  file(name: string): string {
    if (!SAFE_NAME.test(name)) throw new Error(`unsafe temp file name: ${name}`);
    return join(this.path, name);
  }

  /** Bytes currently held by the directory's files. */
  async usage(): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.path, { withFileTypes: true }))
      if (entry.isFile()) total += (await stat(join(this.path, entry.name))).size;
    return total;
  }

  async remaining(): Promise<number> {
    return Math.max(0, this.maxBytes - (await this.usage()));
  }

  async assertWithinBudget(): Promise<void> {
    const used = await this.usage();
    if (used > this.maxBytes) throw new TempDiskBudgetExceededError(used, this.maxBytes);
  }

  /**
   * Streams an object to a file, hashing as it goes; aborts (and removes the partial file) once the budget would be
   * exceeded. Null when the object does not exist.
   */
  async download(
    store: StorageProvider,
    key: string,
    name: string,
    opts: { range?: ByteRange; onProgress?: (bytes: number) => void } = {},
  ): Promise<{ path: string; bytes: number; contentHash: string } | null> {
    const path = this.file(name);
    const source = await store.getObjectStream(key, opts.range);
    if (!source) return null;
    const budget = await this.remaining();
    const hash = createHash('sha256');
    let bytes = 0;
    let reported = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        bytes += chunk.length;
        if (bytes > budget)
          return cb(new TempDiskBudgetExceededError(this.maxBytes - budget + bytes, this.maxBytes));
        hash.update(chunk);
        if (opts.onProgress && bytes - reported >= 8 * 1024 * 1024) {
          reported = bytes;
          opts.onProgress(bytes);
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(path));
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { path, bytes, contentHash: hash.digest('hex') };
  }

  /** Hashes a file of the directory and streams it to the store (multipart when large). */
  async upload(
    store: StorageProvider,
    key: string,
    name: string,
    contentType: string,
  ): Promise<{ bytes: number; contentHash: string }> {
    const path = this.file(name);
    const contentHash = await hashFile(path);
    const { bytes } = await store.putObjectStream(key, createReadStream(path), { contentType });
    return { bytes, contentHash };
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

/** Runs `fn` with a fresh private directory and removes it afterwards, always. */
export async function withTempDir<T>(opts: TempDirOptions, fn: (dir: TempDir) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(tempRoot(opts.root), TEMP_DIR_PREFIX));
  try {
    return await fn(new TempDir(path, opts.maxBytes));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

/** Removes media temp directories older than `olderThanMs` (left by a process that was killed mid-job). */
export async function sweepStaleTempDirs(
  opts: { root?: string; olderThanMs: number; now?: number } = { olderThanMs: 6 * 3_600_000 },
): Promise<number> {
  const root = tempRoot(opts.root);
  const now = opts.now ?? Date.now();
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > opts.olderThanMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
