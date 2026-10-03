import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { MemoryStorageProvider, S3StorageProvider, chunkStream, hashStoredObject } from './storage';
import { TempDiskBudgetExceededError, sweepStaleTempDirs, withTempDir } from './temp-disk';

/** STU-2a streaming object-store I/O: chunking, multipart uploads, ranged streams and the temp-disk budget. */
const A = 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAA';
const B = 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAB';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: 'usr_1' },
  brandIds: 'all',
  correlationId: 'corr_stream',
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251));

/** A fake S3 client: records every command and keeps uploaded parts; `failPart` makes that part number fail. */
function fakeS3(opts: { failPart?: number; object?: Buffer } = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const parts = new Map<number, Buffer>();
  let completed: Buffer | null = null;
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      switch (name) {
        case 'CreateMultipartUploadCommand':
          return { UploadId: 'up_1' };
        case 'UploadPartCommand': {
          const n = cmd.input['PartNumber'] as number;
          if (n === opts.failPart) throw new Error('network reset');
          parts.set(n, cmd.input['Body'] as Buffer);
          return { ETag: `"etag-${n}"` };
        }
        case 'CompleteMultipartUploadCommand':
          completed = Buffer.concat([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
          return {};
        case 'PutObjectCommand':
          completed = cmd.input['Body'] as Buffer;
          return {};
        case 'GetObjectCommand': {
          const range = cmd.input['Range'] as string | undefined;
          const all = opts.object ?? Buffer.alloc(0);
          const m = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
          const body = m ? all.subarray(Number(m[1]), Number(m[2]) + 1) : all;
          return { Body: Readable.from(chunkStream([body], 1000)) };
        }
        default:
          return {};
      }
    },
  };
  return { client: client as unknown as S3Client, calls, completed: () => completed };
}

const provider = (client: S3Client, partBytes = 4096) =>
  new S3StorageProvider(
    { region: 'auto', buckets: { assets: 'assets-bucket', releases: 'releases-bucket' }, partBytes },
    client,
  );

describe('chunkStream', () => {
  it('re-chunks into equal parts with a shorter last part', async () => {
    const source = [bytes(10), bytes(3), bytes(25)];
    const out: Buffer[] = [];
    for await (const part of chunkStream(source, 8)) out.push(part);
    expect(out.map((p) => p.length)).toEqual([8, 8, 8, 8, 6]);
    expect(Buffer.concat(out)).toEqual(Buffer.concat(source));
  });
  it('yields nothing for an empty stream', async () => {
    const out: Buffer[] = [];
    for await (const part of chunkStream([], 8)) out.push(part);
    expect(out).toEqual([]);
  });
});

describe('S3StorageProvider.putObjectStream (multipart)', () => {
  it('uploads a large stream in equal parts and completes with every ETag in order', async () => {
    const s3 = fakeS3();
    const body = bytes(4096 * 3 + 100);
    const r = await runInTenant(ctx(A), () =>
      provider(s3.client).putObjectStream(`quarantine/${A}/ui_1/derivative-proxy`, Readable.from([body]), {
        contentType: 'video/mp4',
      }),
    );
    expect(r).toEqual({ bytes: body.length });
    expect(s3.calls.map((c) => c.name)).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);
    const sizes = s3.calls
      .filter((c) => c.name === 'UploadPartCommand')
      .map((c) => (c.input['Body'] as Buffer).length);
    expect(sizes).toEqual([4096, 4096, 4096, 100]);
    const complete = s3.calls.at(-1)?.input['MultipartUpload'] as { Parts: Array<{ PartNumber: number }> };
    expect(complete.Parts.map((p) => p.PartNumber)).toEqual([1, 2, 3, 4]);
    expect(s3.calls[0]?.input).toMatchObject({ Bucket: 'assets-bucket', ContentType: 'video/mp4' });
    expect(sha(s3.completed() as Buffer)).toBe(sha(body));
  });

  it('uses a plain PUT for a body of one part or less', async () => {
    const s3 = fakeS3();
    const body = bytes(4096);
    await runInTenant(ctx(A), () =>
      provider(s3.client).putObjectStream(`quarantine/${A}/ui_1/x`, Readable.from([body]), {
        contentType: 'application/json',
      }),
    );
    expect(s3.calls.map((c) => c.name)).toEqual(['PutObjectCommand']);
  });

  it('aborts the multipart upload when a part fails, and rethrows', async () => {
    const s3 = fakeS3({ failPart: 2 });
    await expect(
      runInTenant(ctx(A), () =>
        provider(s3.client).putObjectStream(`quarantine/${A}/ui_1/y`, Readable.from([bytes(4096 * 3)]), {
          contentType: 'video/mp4',
        }),
      ),
    ).rejects.toThrow('network reset');
    expect(s3.calls.map((c) => c.name)).toContain('AbortMultipartUploadCommand');
    expect(s3.calls.map((c) => c.name)).not.toContain('CompleteMultipartUploadCommand');
  });

  it('refuses another tenant’s key before any request', async () => {
    const s3 = fakeS3();
    await expect(
      runInTenant(ctx(A), () =>
        provider(s3.client).putObjectStream(`quarantine/${B}/ui_1`, Readable.from([bytes(10)]), {
          contentType: 'video/mp4',
        }),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(s3.calls).toEqual([]);
  });

  it('streams ranged reads with an HTTP Range header', async () => {
    const object = bytes(5000);
    const s3 = fakeS3({ object });
    const stream = await runInTenant(ctx(A), () =>
      provider(s3.client).getObjectStream(`assets/${A}/brd/ast/av/original`, { start: 100, end: 1099 }),
    );
    const got: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) got.push(c);
    expect(Buffer.concat(got)).toEqual(object.subarray(100, 1100));
    expect(s3.calls[0]?.input['Range']).toBe('bytes=100-1099');
  });
});

describe('MemoryStorageProvider streams', () => {
  it('round-trips a stream, serves ranges as streams and hashes without loading whole', async () => {
    const s = new MemoryStorageProvider();
    const body = bytes(200_000);
    await runInTenant(ctx(A), async () => {
      const key = `assets/${A}/brd/ast/av/original`;
      expect(
        await s.putObjectStream(key, Readable.from(chunkStream([body], 7_000)), { contentType: 'video/mp4' }),
      ).toEqual({
        bytes: body.length,
      });
      const ranged: Buffer[] = [];
      for await (const c of (await s.getObjectStream(key, { start: 10, end: 19 })) as AsyncIterable<Buffer>)
        ranged.push(c);
      expect(Buffer.concat(ranged)).toEqual(body.subarray(10, 20));
      const progress: number[] = [];
      expect(await hashStoredObject(s, key, (b) => progress.push(b))).toEqual({
        contentHash: sha(body),
        bytes: body.length,
      });
      expect(await s.getObjectStream(`assets/${A}/brd/ast/av/missing`)).toBeNull();
      await expect(s.getObjectStream(`assets/${B}/brd/ast/av/original`)).rejects.toBeInstanceOf(
        PolicyDeniedError,
      );
    });
  });
});

describe('TempDir (byte caps and guaranteed cleanup)', () => {
  it('downloads an object to disk with its hash, and removes the directory afterwards', async () => {
    const s = new MemoryStorageProvider();
    const body = bytes(50_000);
    let path = '';
    await runInTenant(ctx(A), async () => {
      const key = `quarantine/${A}/ui_9`;
      await s.putObject(key, body, { contentType: 'video/mp4' });
      await withTempDir({ maxBytes: 100_000 }, async (dir) => {
        path = dir.path;
        const got = await dir.download(s, key, 'source');
        expect(got).toMatchObject({ bytes: body.length, contentHash: sha(body) });
        expect(await readFile(got!.path)).toEqual(body);
        expect(await dir.usage()).toBe(body.length);
        const up = await dir.upload(s, `quarantine/${A}/ui_9/copy`, 'source', 'video/mp4');
        expect(up).toEqual({ bytes: body.length, contentHash: sha(body) });
      });
    });
    await expect(stat(path)).rejects.toThrow();
  });

  it('aborts a download that would exceed the budget and leaves no partial file', async () => {
    const s = new MemoryStorageProvider();
    await runInTenant(ctx(A), async () => {
      const key = `quarantine/${A}/ui_10`;
      await s.putObject(key, bytes(300_000), { contentType: 'video/mp4' });
      await withTempDir({ maxBytes: 100_000 }, async (dir) => {
        await expect(dir.download(s, key, 'source')).rejects.toBeInstanceOf(TempDiskBudgetExceededError);
        expect(await dir.usage()).toBe(0);
      });
    });
  });

  it('refuses unsafe file names', async () => {
    await withTempDir({ maxBytes: 10 }, async (dir) => {
      expect(() => dir.file('../escape')).toThrow(/unsafe/);
      expect(() => dir.file('a/b')).toThrow(/unsafe/);
    });
  });

  it('sweeps stale media temp directories only (in its own root, so parallel suites are untouched)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sweep-root-'));
    const other = await mkdtemp(join(root, 'not-media-'));
    let kept = '';
    await withTempDir({ maxBytes: 10, root }, async (dir) => {
      kept = dir.path;
      expect(await sweepStaleTempDirs({ root, olderThanMs: 60_000 })).toBe(0);
      await expect(stat(kept)).resolves.toBeTruthy();
      expect(await sweepStaleTempDirs({ root, olderThanMs: 1, now: Date.now() + 10_000 })).toBe(1);
      await expect(stat(kept)).rejects.toThrow();
    });
    await expect(stat(other)).resolves.toBeTruthy();
    await rm(root, { recursive: true, force: true });
  });
});
