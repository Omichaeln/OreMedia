import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { nodeHttpFetch, type FetchLike } from './http';

/**
 * The startup probe of the acceptance job (docs/runbooks/staging-acceptance.md, "Reading the log"): the same two
 * public paths of the deployment fetched by three clients, the global fetch, the `undici` package's fetch (the
 * hoisted one) and node:http(s), each reporting the status and the sorted response header NAMES it saw. A
 * deployment where the global fetch sees no headers while Node's HTTP client does is then visible from the log,
 * and the job switches its own requests to the node:http(s) client (`chooseFetch`). When no client sees a header
 * the raw start of the response (status line and headers as text, no body) says what answers in front of the
 * origin. Also printed: `process.execArgv` and the NAMES of the NODE_* / OTEL_* / SENTRY_* variables, never a value.
 */
export interface ProbeSample {
  client: 'fetch' | 'undici' | 'https';
  path: string;
  status: number;
  headerNames: string[];
  bodyLength: number;
  error?: string;
}

const PATHS = ['/health', '/deployment-brand/brand.json'] as const;

async function sample(
  client: ProbeSample['client'],
  f: FetchLike,
  url: string,
  path: string,
): Promise<ProbeSample> {
  try {
    const res = await f(url, { redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return {
      client,
      path,
      status: res.status,
      headerNames: [...res.headers.keys()].sort(),
      bodyLength: text.length,
    };
  } catch (err) {
    return {
      client,
      path,
      status: 0,
      headerNames: [],
      bodyLength: 0,
      error: err instanceof Error ? `${err.name}: ${err.message}` : 'failed',
    };
  }
}

/** The `undici` package's fetch when it is installed next to the bundle (the hoisted install); null otherwise. */
async function undiciFetch(): Promise<{ fetch: FetchLike } | null> {
  try {
    const name = 'undici';
    const mod = (await import(name)) as { fetch?: FetchLike };
    return typeof mod.fetch === 'function' ? { fetch: mod.fetch } : null;
  } catch {
    return null;
  }
}

/**
 * The first bytes of the origin's answer to a plain HTTP/1.1 GET on a raw socket (TLS for https): the status line
 * and the header block as text, cut before the body (at the blank line) and at 300 characters.
 */
export function rawResponseHead(origin: string, path: string, limit = 300): Promise<string> {
  const url = new URL(origin);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const request = `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: oremedia-acceptance-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve) => {
    let text = '';
    const done = (note?: string) => {
      socket.destroy();
      const head = text.split('\r\n\r\n')[0] ?? '';
      resolve((note ? `${note}; ` : '') + head.slice(0, limit).replace(/\r\n/g, ' | '));
    };
    const socket =
      url.protocol === 'https:'
        ? tlsConnect({ host: url.hostname, port, servername: url.hostname }, () => socket.write(request))
        : netConnect({ host: url.hostname, port }, () => socket.write(request));
    socket.setTimeout(15_000, () => done('timed out'));
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n') || text.length > limit * 4) done();
    });
    socket.on('end', () => done());
    socket.on('error', (err) => done(`socket error: ${err.message}`));
  });
}

export interface ProbeReport {
  lines: string[];
  /** The global fetch saw no header on any path while node:http(s) did on every path. */
  fetchDropsHeaders: boolean;
}

export async function probeOrigin(
  webOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProbeReport> {
  const lines: string[] = [];
  const names = Object.keys(env)
    .filter((k) => /^(NODE_|OTEL_|SENTRY_)/.test(k))
    .sort();
  lines.push(`ACCEPTANCE_INFO probe execArgv=[${process.execArgv.join(' ')}] env=[${names.join(',')}]`);
  const undici = await undiciFetch();
  lines.push(
    `ACCEPTANCE_INFO probe undici=${undici ? 'installed' : 'absent'} globalFetchIsUndiciFetch=${undici ? String(globalThis.fetch === undici.fetch) : 'n/a'}`,
  );
  const samples: ProbeSample[] = [];
  for (const path of PATHS) {
    const url = `${webOrigin}${path}`;
    samples.push(await sample('fetch', globalThis.fetch, url, path));
    if (undici) samples.push(await sample('undici', undici.fetch, url, path));
    samples.push(await sample('https', nodeHttpFetch, url, path));
  }
  for (const s of samples)
    lines.push(
      `ACCEPTANCE_INFO probe ${s.client} ${s.path} HTTP ${s.status} headers=[${s.headerNames.join(',')}] body=${s.bodyLength}B${s.error ? ` error=${s.error}` : ''}`,
    );
  const byClient = (client: ProbeSample['client']) => samples.filter((s) => s.client === client);
  const fetchDropsHeaders =
    byClient('fetch').every((s) => s.headerNames.length === 0) &&
    byClient('https').length > 0 &&
    byClient('https').every((s) => s.headerNames.length > 0);
  if (samples.every((s) => s.headerNames.length === 0))
    lines.push(`ACCEPTANCE_INFO probe raw /health ${await rawResponseHead(webOrigin, '/health')}`);
  return { lines, fetchDropsHeaders };
}

/**
 * The client the job's own requests use: the global fetch, or node:http(s) when the probe found the global fetch
 * blind to headers or ACCEPTANCE_HTTP_CLIENT=node-https asks for it (`fetch` forces the global one).
 */
export function chooseFetch(
  report: Pick<ProbeReport, 'fetchDropsHeaders'>,
  override: string | undefined,
): { fetch: FetchLike; name: 'fetch' | 'node-https' } {
  const wanted = override?.trim();
  if (wanted === 'node-https' || (wanted !== 'fetch' && report.fetchDropsHeaders))
    return { fetch: nodeHttpFetch, name: 'node-https' };
  return { fetch: globalThis.fetch, name: 'fetch' };
}
