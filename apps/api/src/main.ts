import { reportConfiguration, startTelemetry, stopTelemetry } from '@oremedia/observability';
import { configureDatabase, closeDatabase } from '@oremedia/db';
import { configureConnectCallback } from '@oremedia/module-publishing';
import { createServer, revisionFromEnv } from './server';
import { configureRateLimiter } from './trpc';
import { apiCapabilities, composeModules } from './composition';
import { authConfigFromEnv, type AuthConfig } from './auth/config';
import { webOriginFromEnv } from './web-origin';

const log = startTelemetry({ service: 'oremedia-api', version: process.env['OREMEDIA_VERSION'] });
const url = process.env['DATABASE_URL'];
if (!url) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
let auth: AuthConfig | null;
try {
  auth = authConfigFromEnv();
} catch (err) {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'auth configuration invalid');
  process.exit(2);
}
if (!auth) log.warn({}, 'AUTH_CLIENT_ID not set: Google sign-in unavailable (non-production only)');
let webOrigin: string | null;
try {
  webOrigin = webOriginFromEnv();
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'web origin configuration invalid',
  );
  process.exit(2);
}
// One line naming each degraded capability and the settings it lacks (names only); the api keeps serving, and /health
// lists the capability names, unless OREMEDIA_CONFIG_STRICT=1 (docs/runbooks/deploy-railway.md).
const config = reportConfiguration(log, apiCapabilities(process.env));
if (config.refuse) process.exit(2);
configureDatabase({ url, connectionLimit: Number(process.env['DATABASE_POOL'] ?? 10) });
composeModules();
// Spec 14.7: providers return to the one callback registered with them; unset, the client's redirect is used.
configureConnectCallback(webOrigin);
if (!webOrigin)
  log.warn({}, 'WEB_ORIGIN not set: channel connect uses the redirect the browser sends (development only)');

if (process.env['REDIS_URL']) {
  const { default: Redis } = await import('ioredis');
  configureRateLimiter(new Redis(process.env['REDIS_URL'], { maxRetriesPerRequest: 2, lazyConnect: false }));
} else {
  configureRateLimiter();
  log.warn({}, 'REDIS_URL not set: using in-memory rate limiting (single instance only)');
}

const port = Number(process.env['PORT'] ?? 3001);
const app = createServer({
  webOrigin: webOrigin ?? undefined,
  reviewPortalOrigin: process.env['REVIEW_PORTAL_ORIGIN'],
  auth,
  degraded: config.degraded,
  revision: revisionFromEnv(process.env),
});
const server = app.listen(port, () => log.info({ status: port }, 'api listening'));

const shutdown = async () => {
  server.close();
  await closeDatabase();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
