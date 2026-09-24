/**
 * D-03 (decided): Google authenticates through OpenID Connect; Oremedia's policy layer authorises. Configuration
 * names only (values live in Railway sealed variables): AUTH_ISSUER_URL, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET,
 * AUTH_REDIRECT_URI and the optional AUTH_ALLOWED_DOMAINS.
 */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

export interface AuthConfig {
  issuerUrl: URL;
  clientId: string;
  clientSecret: string;
  /** The callback registered with the provider: https://<web domain>/auth/google/callback in production. */
  redirectUri: URL;
  /** Google Workspace `hd` values allowed to sign in (lower case); null = any verified Google account. */
  allowedDomains: string[] | null;
  /** Session, CSRF and flow cookies carry `Secure` (production). */
  secureCookies: boolean;
  /** Plain-http issuer (local test providers only; refused in production). */
  allowInsecureIssuer: boolean;
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

const REQUIRED = ['AUTH_CLIENT_ID', 'AUTH_CLIENT_SECRET', 'AUTH_REDIRECT_URI'] as const;

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new AuthConfigError(`${name} is not a valid URL`);
  }
}

export function parseAllowedDomains(value: string | undefined): string[] | null {
  const domains = (value ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return domains.length ? [...new Set(domains)] : null;
}

/**
 * Production requires the client id, secret and redirect URI and fails at startup naming what is missing (as
 * DATABASE_URL does). Outside production, nothing set means Google sign-in is unavailable (the sign-in screen says
 * so); a partial configuration is an error everywhere.
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length === REQUIRED.length && !production) return null;
  if (missing.length)
    throw new AuthConfigError(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required${production ? ' in production' : ''} (Google sign-in, decision D-03)`,
    );
  const issuerUrl = parseUrl('AUTH_ISSUER_URL', env['AUTH_ISSUER_URL']?.trim() || GOOGLE_ISSUER);
  const redirectUri = parseUrl('AUTH_REDIRECT_URI', (env['AUTH_REDIRECT_URI'] as string).trim());
  if (production && issuerUrl.protocol !== 'https:')
    throw new AuthConfigError('AUTH_ISSUER_URL must be https in production');
  if (production && redirectUri.protocol !== 'https:')
    throw new AuthConfigError('AUTH_REDIRECT_URI must be https in production');
  if (!redirectUri.pathname.endsWith('/auth/google/callback'))
    throw new AuthConfigError('AUTH_REDIRECT_URI must end with /auth/google/callback');
  return {
    issuerUrl,
    clientId: (env['AUTH_CLIENT_ID'] as string).trim(),
    clientSecret: (env['AUTH_CLIENT_SECRET'] as string).trim(),
    redirectUri,
    allowedDomains: parseAllowedDomains(env['AUTH_ALLOWED_DOMAINS']),
    secureCookies: production,
    allowInsecureIssuer: !production && issuerUrl.protocol === 'http:',
  };
}
