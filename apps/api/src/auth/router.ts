import { randomBytes } from 'node:crypto';
import express, {
  type CookieOptions,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import * as oidc from 'openid-client';
import {
  signInErrorCodeFor,
  type SignInErrorCode,
  type SignInRefusalReason,
} from '@oremedia/contracts/access';
import { PolicyDeniedError, RateLimitedError, toErrorEnvelope } from '@oremedia/contracts/errors';
import { accessService, authenticate, type AuthOrigin } from '@oremedia/module-access';
import {
  cookieNames,
  createContext,
  firstHeader,
  parseCookies,
  requestOrigin,
  sessionCookies,
} from '../context';
import { consumeAuthRateLimit } from '../trpc';
import type { AuthConfig } from './config';
import {
  FLOW_COOKIE,
  FLOW_COOKIE_PATH,
  FLOW_TTL_MS,
  flowKey,
  openFlow,
  safeReturnTo,
  sealFlow,
} from './flow';

const PROVIDER = 'google';

/** Google publishes stable OAuth/OIDC endpoints; using them avoids provider discovery being blocked by Railway egress. */
const GOOGLE_SERVER_METADATA: oidc.ServerMetadata = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://www.googleapis.com/oauth2/v4/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
};

/**
 * Railway's outbound proxy can preserve a JSON response body while rewriting its content type. oauth4webapi
 * correctly rejects that response by default; only normalize responses whose body is demonstrably a JSON object.
 * Non-JSON responses and all status codes are returned unchanged, so protocol and signature validation remain strict.
 */
const googleFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const isGoogleJsonEndpoint =
    url.startsWith('https://www.googleapis.com/oauth2/v4/token') ||
    url.startsWith('https://oauth2.googleapis.com/revoke') ||
    url.startsWith('https://openidconnect.googleapis.com/v1/userinfo') ||
    url.startsWith('https://www.googleapis.com/oauth2/v3/certs');
  if (!isGoogleJsonEndpoint || (response.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
    return response;
  }
  console.warn('Google OAuth endpoint returned a non-JSON content type', {
    url,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
  });
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

async function googleDiscovery(config: AuthConfig): Promise<oidc.Configuration> {
  const client = new oidc.Configuration(GOOGLE_SERVER_METADATA, config.clientId, config.clientSecret);
  client[oidc.customFetch] = googleFetch;
  oidc.enableNonRepudiationChecks(client);
  return client;
}

export interface AuthRouterOptions {
  config: AuthConfig | null;
  onError: (cause: unknown, stage: string) => void;
}

/**
 * Discovery is fetched once per process (and retried after a failure). ID token signatures are verified against
 * the provider's JWKS (enableNonRepudiationChecks): openid-client otherwise relies on TLS alone for tokens from
 * the token endpoint, and D-03 requires the signature check.
 */
function discoveryFor(config: AuthConfig): () => Promise<oidc.Configuration> {
  let pending: Promise<oidc.Configuration> | null = null;
  const isGoogle = config.issuerUrl.hostname === 'accounts.google.com';
  return () => {
    pending ??= (isGoogle
      ? googleDiscovery(config)
      : oidc.discovery(config.issuerUrl, config.clientId, config.clientSecret, undefined, {
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(config.allowInsecureIssuer ? [oidc.allowInsecureRequests] : []),
          ],
        }))
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
    return pending;
  };
}

/**
 * D-03 browser sign-in as plain Express routes (spec 7.1 keeps tRPC for the application API):
 *   GET  /auth/google/start?returnTo=/path  → authorization code + PKCE (S256) + state + nonce → Google
 *   GET  /auth/google/callback              → validate, resolve the user (access module), mint a session
 *   POST /auth/sign-out                     → revoke the session (CSRF double-submit for cookie sessions)
 * These routes run before any tenant is selected: they create or end a session and never read tenant data.
 */
export function createAuthRouter({ config, onError }: AuthRouterOptions): Router {
  const router = express.Router();
  const secure = config?.secureCookies ?? process.env['NODE_ENV'] === 'production';
  const names = cookieNames(secure);
  const key = config ? flowKey(config.clientSecret) : null;
  const discover = config ? discoveryFor(config) : null;

  const base: CookieOptions = { secure, sameSite: 'lax' };
  const flowCookie: CookieOptions = { ...base, httpOnly: true, path: FLOW_COOKIE_PATH };
  const clearFlow = (res: Response) => res.clearCookie(FLOW_COOKIE, flowCookie);
  const clearSession = (res: Response) => {
    res.clearCookie(names.session, { ...base, httpOnly: true, path: '/' });
    res.clearCookie(names.csrf, { ...base, path: '/' });
  };
  const toSignIn = (res: Response, code: SignInErrorCode) =>
    res.redirect(303, `/sign-in?error=${encodeURIComponent(code)}`);
  const originOf = (req: Request): AuthOrigin => requestOrigin(req.headers, req.ip);
  /** An unexpected failure is still an audited sign-in outcome; recording it must not mask the redirect. */
  const recordInternal = (origin: AuthOrigin) =>
    accessService.recordSignInRefusal(PROVIDER, 'internal_error', origin).catch((err: unknown) => {
      onError(err, 'audit');
    });

  /**
   * Per client address (m3): over the limit the request is answered 429 with Retry-After and nothing is written
   * (no auth_events row), so a flood cannot grow the audit table.
   */
  const limited =
    (path: Parameters<typeof consumeAuthRateLimit>[1]) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await consumeAuthRateLimit(originOf(req).ipHash, path);
        next();
      } catch (err) {
        if (err instanceof RateLimitedError) {
          if (err.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
          res.status(429).json(toErrorEnvelope(err, 'unknown'));
          return;
        }
        next(err);
      }
    };

  router.get('/google/start', limited('auth.google.start'), async (req, res) => {
    if (!config || !key || !discover) return toSignIn(res, 'unavailable');
    try {
      const client = await discover();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const params: Record<string, string> = {
        redirect_uri: config.redirectUri.href,
        scope: 'openid email profile',
        response_type: 'code',
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        prompt: 'select_account',
      };
      // A single allowed Workspace domain is also a hint to Google's account chooser; the callback enforces it.
      if (config.allowedDomains?.length === 1) params['hd'] = config.allowedDomains[0] as string;
      const url = oidc.buildAuthorizationUrl(client, params);
      res.cookie(
        FLOW_COOKIE,
        sealFlow(
          {
            state,
            nonce,
            codeVerifier,
            returnTo: safeReturnTo(req.query['returnTo']),
            expiresAt: Date.now() + FLOW_TTL_MS,
          },
          key,
        ),
        { ...flowCookie, maxAge: FLOW_TTL_MS },
      );
      return res.redirect(302, url.href);
    } catch (err) {
      onError(err, 'start');
      await recordInternal(originOf(req));
      return toSignIn(res, 'sign_in_failed');
    }
  });

  router.get('/google/callback', limited('auth.google.callback'), async (req, res) => {
    clearFlow(res); // single use, whatever happens next
    if (!config || !key || !discover) return toSignIn(res, 'unavailable');
    const origin = originOf(req);
    const refuse = async (reason: SignInRefusalReason) => {
      await accessService.recordSignInRefusal(PROVIDER, reason, origin);
      return toSignIn(res, signInErrorCodeFor(reason));
    };
    try {
      const raw = parseCookies(firstHeader(req.headers['cookie']));
      const flow = openFlow(raw[FLOW_COOKIE], key);
      const state = req.query['state'];
      if (!flow || typeof state !== 'string' || state !== flow.state) return await refuse('flow_invalid');
      if (req.query['error'] !== undefined) return await refuse('provider_error');

      // The callback URL as registered, with the provider's query: openid-client re-checks state, exchanges the code
      // with the PKCE verifier and validates the ID token (signature via JWKS, iss, aud, exp, iat, nonce).
      const callbackUrl = new URL(config.redirectUri.href);
      callbackUrl.search = new URL(req.originalUrl, config.redirectUri).search;
      let claims: oidc.IDToken | undefined;
      try {
        const tokens = await oidc.authorizationCodeGrant(await discover(), callbackUrl, {
          pkceCodeVerifier: flow.codeVerifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        });
        claims = tokens.claims();
      } catch (err) {
        onError(err, 'token');
        return await refuse('token_invalid');
      }
      if (!claims?.sub) return await refuse('token_invalid');

      // Rotation: the session this browser already held is ended in the same transaction that creates the new one.
      const prior = await authenticate(sessionCookies(raw).session).catch(() => null);
      const result = await accessService.signInWithExternalIdentity(
        {
          provider: PROVIDER,
          subject: claims.sub,
          email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
          emailVerified: claims['email_verified'] === true,
          hostedDomain: typeof claims['hd'] === 'string' ? claims['hd'] : undefined,
          name: typeof claims['name'] === 'string' ? claims['name'].slice(0, 200) : undefined,
        },
        {
          allowedDomains: config.allowedDomains,
          replaces: prior?.kind === 'user' ? { userId: prior.userId, sessionId: prior.sessionId } : null,
        },
        origin,
      );
      if (!result.ok) return toSignIn(res, signInErrorCodeFor(result.reason));

      const maxAge = Math.max(0, result.expiresAt.getTime() - Date.now());
      res.cookie(names.session, result.token, { ...base, httpOnly: true, path: '/', maxAge });
      res.cookie(names.csrf, randomBytes(32).toString('base64url'), { ...base, path: '/', maxAge });
      return res.redirect(303, flow.returnTo);
    } catch (err) {
      onError(err, 'callback');
      await recordInternal(origin);
      return toSignIn(res, 'sign_in_failed');
    }
  });

  router.post('/sign-out', limited('auth.sign_out'), async (req, res) => {
    try {
      const ctx = await createContext(req.headers, req.ip);
      // Spec 18: a cookie session presents the CSRF double-submit header; bearer callers are exempt.
      if (ctx.cookieSession && (!ctx.csrf.header || ctx.csrf.header !== ctx.csrf.cookie)) {
        res
          .status(403)
          .json(
            toErrorEnvelope(
              new PolicyDeniedError('csrf_invalid', 'CSRF token missing or invalid'),
              ctx.correlationId,
            ),
          );
        return;
      }
      const origin = {
        correlationId: ctx.correlationId,
        ipHash: ctx.ipHash,
        userAgentHash: ctx.userAgentHash,
      };
      if (ctx.principal?.kind === 'user') await accessService.signOut(ctx.principal, origin);
      // Spec 5.7: an operator signing out of a support session closes it (the sup_ bearer stops working).
      if (ctx.principal?.kind === 'platform_operator')
        await accessService.endSupportSession(ctx.principal, origin);
      clearSession(res);
      res.status(204).end();
    } catch (err) {
      onError(err, 'sign-out');
      res.status(500).json(toErrorEnvelope(err, 'unknown'));
    }
  });

  return router;
}
