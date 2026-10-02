import { describe, expect, it } from 'vitest';
import type { ProviderIO } from './io';
import { MediaFetchError, fetchBytes } from './shared';

/** A ProviderIO whose one answer is given: status, headers and a body streamed in chunks. */
const ioWith = (status: number, headers: Record<string, string>, chunks: Uint8Array[]): ProviderIO => ({
  request: async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return { res: new Response(status === 204 ? null : body, { status, headers }) } as Awaited<
      ReturnType<ProviderIO['request']>
    >;
  },
});
const bytes = (n: number) => new Uint8Array(n).fill(7);
const URL_ = 'https://releases.example/releases/t/b/av/original/x.png';

describe('fetchBytes (spec 9.3 release URLs; RA-08 bounds)', () => {
  it('reads the body whole without options, as the channel adapters always did', async () => {
    const out = await fetchBytes(ioWith(200, { 'content-type': 'video/mp4' }, [bytes(10), bytes(5)]), URL_);
    expect(out.byteLength).toBe(15);
    await expect(fetchBytes(ioWith(404, {}, []), URL_)).rejects.toMatchObject({
      reason: 'status',
      status: 404,
    });
  });

  it('refuses a Content-Length over the cap before reading, and a body that grows past it while streaming', async () => {
    await expect(
      fetchBytes(ioWith(200, { 'content-type': 'image/png', 'content-length': '101' }, [bytes(1)]), URL_, {
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
    // No Content-Length (chunked): the cap is enforced on the bytes as they arrive.
    await expect(
      fetchBytes(ioWith(200, { 'content-type': 'image/png' }, [bytes(60), bytes(60)]), URL_, {
        maxBytes: 100,
      }),
    ).rejects.toBeInstanceOf(MediaFetchError);
    const ok = await fetchBytes(ioWith(200, { 'content-type': 'image/png' }, [bytes(60), bytes(40)]), URL_, {
      maxBytes: 100,
    });
    expect(ok.byteLength).toBe(100);
  });

  it('refuses an answer whose Content-Type is not the expected kind, without reading it', async () => {
    await expect(
      fetchBytes(ioWith(200, { 'content-type': 'text/html; charset=utf-8' }, [bytes(3)]), URL_, {
        expectType: 'image/',
      }),
    ).rejects.toMatchObject({ reason: 'unexpected_type' });
    await expect(
      fetchBytes(ioWith(200, {}, [bytes(3)]), URL_, { expectType: 'image/' }),
    ).rejects.toMatchObject({
      reason: 'unexpected_type',
    });
    expect(
      (
        await fetchBytes(ioWith(200, { 'content-type': 'IMAGE/JPEG' }, [bytes(3)]), URL_, {
          expectType: 'image/',
        })
      ).byteLength,
    ).toBe(3);
  });
});
