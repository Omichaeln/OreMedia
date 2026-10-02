import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeHttpFetch } from './http';
import { chooseFetch, probeOrigin, rawResponseHead } from './probe';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('startup probe', () => {
  it('reports each client with the header names it saw, and chooses the global fetch when it sees headers', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-probe', 'yes');
      res.end(req.url === '/health' ? '{"ok":true}' : '{"name":"Test"}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const report = await probeOrigin(origin, {
      NODE_ENV: 'test',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'secret',
      HOME: '/x',
    });
    expect(report.fetchDropsHeaders).toBe(false);
    expect(report.lines[0]).toMatch(
      /^ACCEPTANCE_INFO probe execArgv=\[.*\] env=\[NODE_ENV,OTEL_EXPORTER_OTLP_ENDPOINT\]$/,
    );
    expect(report.lines.join('\n')).not.toContain('secret');
    expect(report.lines).toContain(
      'ACCEPTANCE_INFO probe fetch /health HTTP 200 headers=[connection,content-length,content-type,date,keep-alive,x-probe] body=11B',
    );
    expect(report.lines).toContain(
      'ACCEPTANCE_INFO probe https /deployment-brand/brand.json HTTP 200 headers=[connection,content-length,content-type,date,keep-alive,x-probe] body=15B',
    );
    expect(report.lines.some((l) => l.includes('probe raw'))).toBe(false);
    expect(chooseFetch(report, undefined).name).toBe('fetch');
    expect(chooseFetch(report, 'node-https')).toMatchObject({ name: 'node-https', fetch: nodeHttpFetch });
    expect(chooseFetch({ fetchDropsHeaders: true }, undefined).name).toBe('node-https');
    expect(chooseFetch({ fetchDropsHeaders: true }, 'fetch').name).toBe('fetch');
    const head = await rawResponseHead(origin, '/health');
    expect(head).toMatch(/^HTTP\/1\.1 200 OK \| /);
    expect(head).toContain('x-probe: yes');
    expect(head).not.toContain('{"ok":true}');
  });
});
