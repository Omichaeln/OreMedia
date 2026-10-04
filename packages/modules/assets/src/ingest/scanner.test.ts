import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import {
  ClamAvScanner,
  FailClosedScanner,
  FakeScanner,
  ScannerUnavailableError,
  createScannerFromEnv,
} from './scanner';

const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

/** A clamd stand-in speaking INSTREAM: reads the length-prefixed chunks and answers OK or FOUND. */
function fakeClamd(
  opts: { silent?: boolean; limit?: number } = {},
): Promise<{ server: Server; port: number }> {
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let answered = false;
    socket.on('error', () => undefined); // the client may still be writing when a limit answer closes the socket
    socket.on('data', (d: Buffer) => {
      if (answered) return;
      buffer = Buffer.concat([buffer, d]);
      if (!buffer.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let offset = 10;
      const parts: Buffer[] = [];
      while (offset + 4 <= buffer.length) {
        const len = buffer.readUInt32BE(offset);
        if (len === 0) {
          if (opts.silent) return;
          const body = Buffer.concat(parts).toString('latin1');
          answered = true;
          socket.end(body.includes(EICAR_MARKER) ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
          return;
        }
        if (offset + 4 + len > buffer.length) return;
        parts.push(buffer.subarray(offset + 4, offset + 4 + len));
        offset += 4 + len;
        if (opts.limit !== undefined && parts.reduce((n, p) => n + p.length, 0) > opts.limit) {
          answered = true;
          socket.end('INSTREAM size limit exceeded. ERROR\0');
          return;
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    ),
  );
}

describe('ClamAvScanner (clamd INSTREAM over TCP)', () => {
  let clamd: { server: Server; port: number };
  let silent: { server: Server; port: number };
  let limited: { server: Server; port: number };
  beforeAll(async () => {
    clamd = await fakeClamd();
    silent = await fakeClamd({ silent: true });
    limited = await fakeClamd({ limit: 100_000 });
  });
  afterAll(() => {
    clamd.server.close();
    silent.server.close();
    limited.server.close();
  });

  it('returns a clean verdict and a signature on a hit, chunking the stream', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, chunkBytes: 7 });
    expect(await scanner.scan(Buffer.from('hello world, this is a harmless file'))).toEqual({
      clean: true,
      engine: 'clamav',
    });
    const eicar = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', `${EICAR_MARKER}!$H+H*`].join(''));
    expect(await scanner.scan(eicar)).toEqual({
      clean: false,
      engine: 'clamav',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });
  it('times out into ScannerUnavailableError instead of a verdict', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: silent.port, timeoutMs: 200 });
    await expect(scanner.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
  it('STU-2a: scans a stream chunk by chunk without collecting it, reporting progress', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: clamd.port });
    async function* source() {
      for (let i = 0; i < 40; i++) yield Buffer.alloc(50_000, i);
      yield Buffer.from(`tail ${EICAR_MARKER}`);
    }
    const progress: number[] = [];
    expect(await scanner.scanStream(source(), (b) => progress.push(b))).toMatchObject({ clean: false });
    expect(progress.at(-1)).toBe(40 * 50_000 + `tail ${EICAR_MARKER}`.length);
    expect(await scanner.scanStream([Buffer.from('harmless')])).toEqual({ clean: true, engine: 'clamav' });
  });
  it('STU-2a: clamd refusing a stream above StreamMaxLength is no verdict, with an actionable message', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: limited.port, timeoutMs: 5000 });
    async function* big() {
      for (let i = 0; i < 20; i++) yield Buffer.alloc(64 * 1024, 1);
    }
    await expect(scanner.scanStream(big())).rejects.toThrow(/StreamMaxLength|no verdict|EPIPE|ECONNRESET/);
    await expect(scanner.scanStream(big())).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
  it('STU-2a: the fake scanner streams too', async () => {
    const fake = new FakeScanner();
    expect(await fake.scanStream([Buffer.from(EICAR_MARKER), Buffer.alloc(10_000)])).toMatchObject({
      clean: false,
    });
    expect(await fake.scanStream([Buffer.alloc(10_000), Buffer.from(EICAR_MARKER)])).toMatchObject({
      clean: true,
    });
  });
  it('a refused connection is ScannerUnavailableError', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    await expect(scanner.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});

describe('scanner selection (fail closed in production)', () => {
  it('production without SCANNER_CLAMD_ADDRESS never yields a verdict', async () => {
    const s = createScannerFromEnv({ NODE_ENV: 'production' });
    expect(s).toBeInstanceOf(FailClosedScanner);
    await expect(s.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
  it('an address selects ClamAV; non-production without one uses the fake', () => {
    expect(
      createScannerFromEnv({ NODE_ENV: 'production', SCANNER_CLAMD_ADDRESS: 'clamd:3310' }),
    ).toBeInstanceOf(ClamAvScanner);
    expect(createScannerFromEnv({ NODE_ENV: 'test' })).toBeInstanceOf(FakeScanner);
    expect(() => createScannerFromEnv({ SCANNER_CLAMD_ADDRESS: ':abc' })).toThrow(/host:port/);
  });
});
