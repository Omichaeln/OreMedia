import { reportConfiguration, startTelemetry, stopTelemetry } from '@oremedia/observability';
import { configureDatabase, closeDatabase } from '@oremedia/db';
import { ensureObjectStoreCors, objectStoreCorsOrigins } from '@oremedia/module-assets';
import { configureDestinationConnectStateStore } from '@oremedia/module-destinations';
import {
  RedisConnectStateStore,
  configureConnectCallback,
  configureConnectStateStore,
} from '@oremedia/module-publishing';
import { createServer, revisionFromEnv } from './server';
import { configureRateLimiter, rateLimitRedisUrlFromEnv } from './trpc';
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
try {
  objectStoreCorsOrigins(process.env);
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'object store CORS configuration invalid',
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

let redisUrl: string | null;
try {
  redisUrl = rateLimitRedisUrlFromEnv();
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'rate limit configuration invalid',
  );
  process.exit(2);
}
if (redisUrl) {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  configureRateLimiter(redis);
  // OAuth connect state is shared too, so a callback that reaches another instance still completes.
  configureConnectStateStore(new RedisConnectStateStore(redis, 'connect:channel:'));
  configureDestinationConnectStateStore(new RedisConnectStateStore(redis, 'connect:destination:'));
} else {
  configureRateLimiter();
  log.warn({}, 'REDIS_URL not set: using in-memory rate limiting and connect state (single instance only)');
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

// Opt-in (OBJECT_STORE_CORS_ORIGINS): the buckets' CORS rules for browser uploads and reads, applied and read back on
// every start, so nobody handles the store's credentials to set them. Unset, nothing is sent. A failure is logged and
// the api keeps serving (uploads from the browser stay blocked until it succeeds; the acceptance smoke names it).
void ensureObjectStoreCors(process.env).then(
  (applied) => {
    if (applied)
      log.info(
        { count: applied.buckets.length },
        `object store CORS applied: GET, HEAD and PUT from ${applied.origins.join(', ')}`,
      );
  },
  (err: unknown) =>
    log.error(
      {
        errorName: (err as Error | undefined)?.name ?? 'unknown',
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      'object store CORS not applied',
    ),
);

const shutdown = async () => {
  server.close();
  await closeDatabase();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
