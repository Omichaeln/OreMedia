import type { CapabilityCheck } from '@oremedia/observability';

/**
 * WEB_ORIGIN: the web app's public origin. It admits cross-origin callers (CORS) and fixes the channel-connect callback
 * (spec 14.7): every provider returns to `${WEB_ORIGIN}/connect/callback`, the one redirect URI registered with Meta
 * and LinkedIn. It must be a bare origin (`https://host[:port]`, no path or trailing slash, which a browser's Origin
 * header never carries), https in production.
 */
export class WebOriginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebOriginConfigError';
  }
}

/**
 * The configured origin, or null when unset outside production (the API then takes the browser's redirect and the
 * password routes compare Origin with the request's host: development only). Production (NODE_ENV=production, the
 * condition that makes cookies Secure) requires it: the login-CSRF check and the password setup links depend on it.
 */
export function webOriginFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env['WEB_ORIGIN']?.trim();
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  if (!value && production)
    throw new WebOriginConfigError(
      'WEB_ORIGIN is required in production (https://<web domain>): password sign-in checks Origin against it and setup links point at it',
    );
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebOriginConfigError('WEB_ORIGIN is not a valid URL (expected https://<web domain>)');
  }
  if (url.origin !== value)
    throw new WebOriginConfigError(
      `WEB_ORIGIN must be a bare origin such as ${url.origin} (no path, query or trailing slash)`,
    );
  if ((env['NODE_ENV'] ?? 'development') === 'production' && url.protocol !== 'https:')
    throw new WebOriginConfigError('WEB_ORIGIN must be https in production');
  return url.origin;
}

/** Configuration report capability `web_origin`: the name webOriginFromEnv reads (validation stays there). */
export const webOriginCapability: CapabilityCheck = {
  capability: 'web_origin',
  missing: (env) => (env['WEB_ORIGIN']?.trim() ? [] : ['WEB_ORIGIN']),
};
