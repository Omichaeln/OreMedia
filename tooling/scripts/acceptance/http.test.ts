import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeHttpFetch } from './http';

/** The node:http(s) client builds a standard Response: status, every header (repeated Set-Cookie too), the body. */
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('nodeHttpFetch', () => {
  it('returns status, headers (Set-Cookie repeated) and the body of a GET', async () => {
    const origin = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', [
        '__Host-oremedia_session=abc; Path=/; HttpOnly',
        'oremedia_csrf=x; Path=/',
      ]);
      res.setHeader('content-security-policy', "default-src 'self'");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    const res = await nodeHttpFetch(`${origin}/health?x=1`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(res.headers.getSetCookie()).toEqual([
      '__Host-oremedia_session=abc; Path=/; HttpOnly',
      'oremedia_csrf=x; Path=/',
    ]);
    expect(await res.json()).toEqual({ ok: true, path: '/health?x=1' });
  });

  it('sends the method, headers and body of a POST, and handles bodiless statuses', async () => {
    const origin = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/empty') {
          res.statusCode = 204;
          res.end();
          return;
        }
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            method: req.method,
            origin: req.headers['origin'],
            type: req.headers['content-type'],
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
    });
    const res = await nodeHttpFetch(`${origin}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://web.example' },
      body: JSON.stringify({ a: 1 }),
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      method: 'POST',
      origin: 'https://web.example',
      type: 'application/json',
      body: '{"a":1}',
    });
    const bytes = await nodeHttpFetch(`${origin}/auth`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    expect(((await bytes.json()) as { body: string }).body).toBe('\u0001\u0002\u0003');
    const empty = await nodeHttpFetch(`${origin}/empty`, { method: 'POST' });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
  });
});
