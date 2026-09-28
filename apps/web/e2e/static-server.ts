import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import type { BrowserContext } from 'playwright';
import { productionSecurityHeaders } from './caddy-headers';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export interface StaticServerOptions {
  dist: string;
  /** In-process tRPC handler for `/trpc/*` (UI-only smoke) ... */
  trpcHandler?: RequestListener;
  /** ... or an API origin to proxy `/trpc/*` to (real API smoke). */
  apiOrigin?: string;
  /** In-process handler for `/auth/*` next to `trpcHandler` (the mock password routes); without it only sign-out answers. */
  authHandler?: RequestListener;
  /** The pack served at /deployment-brand/ (OREMEDIA_DEPLOYMENT_BRAND in production); default the neutral one. */
  deploymentBrand?: string;
  /**
   * The web container's variables the Caddyfile's header blocks read (OBJECT_STORE_PUBLIC_ORIGIN): every page, pack
   * file and legal page carries the production security headers (CSP included) resolved against these, as Caddy
   * does. Default: none set, which is what an unconfigured production deploy serves.
   */
  webEnv?: Record<string, string | undefined>;
}

const PACKS = fileURLToPath(new URL('../deployment-brands', import.meta.url));

/**
 * Serves the built app (SPA fallback to index.html) with the production security headers and routes /trpc (and /auth)
 * to the mock or the real API.
 */
export async function startStaticServer(
  opts: StaticServerOptions,
): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  // Read from infra/railway/web/Caddyfile, so these are the production headers and cannot drift from them.
  const headers = productionSecurityHeaders(opts.webEnv ?? {});
  const setHeaders = (res: ServerResponse, set: Record<string, string>) => {
    for (const [name, value] of Object.entries(set)) res.setHeader(name, value);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Stands in for the object store (the mock's signed URLs point here unless a test names another store).
    if (serveObjectStore(req, res, url)) return;
    if (url.pathname.startsWith('/trpc/')) {
      if (opts.trpcHandler) return opts.trpcHandler(req, res);
      if (opts.apiOrigin) return proxy(req, res, opts.apiOrigin);
      res.statusCode = 502;
      res.end('no API configured');
      return;
    }
    // As in the Caddyfile, the platform health check is the API's (proxied when a real API is configured).
    if (url.pathname === '/health' && opts.apiOrigin) return proxy(req, res, opts.apiOrigin);
    // Mirrors the production web container (infra/railway/web/Caddyfile): /auth/* is the API's, same origin.
    if (url.pathname.startsWith('/auth/')) {
      if (opts.apiOrigin) return proxy(req, res, opts.apiOrigin);
      if (opts.authHandler) return opts.authHandler(req, res);
      res.statusCode = url.pathname === '/auth/sign-out' && req.method === 'POST' ? 204 : 404;
      res.end();
      return;
    }
    // Mirrors the Caddyfile's /deployment-brand/* route: the chosen pack's files, 404 for anything it lacks.
    if (url.pathname.startsWith('/deployment-brand/')) {
      setHeaders(res, headers.deploymentBrand);
      return servePackFile(res, opts, url.pathname.slice('/deployment-brand/'.length));
    }
    // Mirrors its /legal/* route: the pack's legal pages with clean URLs (/legal/privacy is legal/privacy.html).
    if (url.pathname.startsWith('/legal/')) {
      const page = url.pathname.slice('/legal/'.length);
      setHeaders(res, headers.legal);
      return servePackFile(res, opts, join('legal', page.endsWith('.html') ? page : `${page}.html`));
    }
    let file = join(opts.dist, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!existsSync(file) || statSync(file).isDirectory())
      file = join(opts.dist, url.pathname.startsWith('/review-portal') ? 'review-portal.html' : 'index.html');
    // Mirrors its catch-all route: the app's files and index.html with the production security headers.
    setHeaders(res, headers.app);
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A real OFL font (tooling/test-fixtures) served as every stored font file, so previews load a genuine FontFace. */
const FONT_FILE = fileURLToPath(
  new URL('../../../tooling/test-fixtures/fonts/karla/Karla[wght].ttf', import.meta.url),
);

/**
 * The object store's side of the mock's signed URLs: a presigned PUT to /e2e-upload/<intent> is accepted and
 * discarded (its path recorded in `puts`); a signed GET of /e2e-object/<assetVersion> answers the fixture font (its
 * path recorded in `gets`). With
 * `corsOrigin` (a store on its own origin) it answers CORS as a bucket configured for the web origin does: the
 * preflight for PUT with a content-type, and Access-Control-Allow-Origin on every answer. False: not a store path.
 */
function serveObjectStore(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store?: { corsOrigin: string; puts: string[]; gets: string[] },
): boolean {
  const isStorePath = url.pathname.startsWith('/e2e-upload/') || url.pathname.startsWith('/e2e-object/');
  if (!isStorePath) return false;
  if (store?.corsOrigin && req.headers.origin === store.corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', store.corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  if (store && req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (req.method === 'PUT' && url.pathname.startsWith('/e2e-upload/')) {
    req.resume();
    req.on('end', () => {
      store?.puts.push(url.pathname);
      res.statusCode = 200;
      res.end();
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/e2e-object/')) {
    store?.gets.push(url.pathname);
    res.setHeader('content-type', 'font/ttf');
    createReadStream(FONT_FILE).pipe(res);
    return true;
  }
  res.statusCode = 405;
  res.end();
  return true;
}

/**
 * A fake object store on its own origin (a second local server) whose CORS admits one web origin, set with `allow`
 * once the web server listens: the production shape, where signed URLs point at the store and the browser needs both
 * the web CSP and the bucket's CORS to reach it.
 */
export async function startFakeObjectStore(): Promise<{
  origin: string;
  puts: string[];
  /** Paths of the signed GETs it answered (font files). */
  gets: string[];
  allow: (webOrigin: string) => void;
  close: () => Promise<void>;
}> {
  const store = { corsOrigin: '', puts: [] as string[], gets: [] as string[] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!serveObjectStore(req, res, url, store)) {
      res.statusCode = 404;
      res.end();
    }
  });
  // Another port is another origin: 'self' does not cover it.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    puts: store.puts,
    gets: store.gets,
    allow: (webOrigin) => {
      store.corsOrigin = webOrigin;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A file of the chosen pack (the neutral one by default), or 404 when the pack lacks it. */
function servePackFile(res: ServerResponse, opts: StaticServerOptions, path: string): void {
  const name = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const packFile = join(PACKS, opts.deploymentBrand ?? 'oremedia', name);
  if (!existsSync(packFile) || statSync(packFile).isDirectory()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', MIME[extname(packFile)] ?? 'application/octet-stream');
  createReadStream(packFile).pipe(res);
}

function proxy(req: IncomingMessage, res: ServerResponse, apiOrigin: string): void {
  const target = new URL(req.url ?? '/', apiOrigin);
  const upstream = httpRequest(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    res.statusCode = 502;
    res.end(String(err));
  });
  req.pipe(upstream);
}

export interface CspViolation {
  directive: string;
  blockedUri: string;
  documentUri: string;
}

/**
 * Records every Content-Security-Policy violation in a browser context (the `securitypolicyviolation` event of each
 * page, reported to the test as it happens, so navigations lose nothing). A screen served with the production headers
 * must leave this empty: a violation is a feature production blocks.
 */
export async function watchCspViolations(context: BrowserContext): Promise<CspViolation[]> {
  const violations: CspViolation[] = [];
  await context.exposeBinding('__oremediaCspViolation', (_source, v: CspViolation) => {
    violations.push(v);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const report = (window as unknown as { __oremediaCspViolation?: (v: unknown) => void })
        .__oremediaCspViolation;
      report?.({ directive: e.effectiveDirective, blockedUri: e.blockedURI, documentUri: e.documentURI });
    });
  });
  return violations;
}
