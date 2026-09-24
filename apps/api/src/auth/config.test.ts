import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GOOGLE_ISSUER, authConfigFromEnv, parseAllowedDomains } from './config';

const full = {
  AUTH_CLIENT_ID: 'client-id.apps.example',
  AUTH_CLIENT_SECRET: 'not-a-real-secret',
  AUTH_REDIRECT_URI: 'https://app.example.test/auth/google/callback',
};

describe('authConfigFromEnv (D-03 configuration)', () => {
  it('production fails naming every missing required variable', () => {
    expect(() => authConfigFromEnv({ NODE_ENV: 'production' })).toThrow(
      'AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, AUTH_REDIRECT_URI are required in production',
    );
    expect(() => authConfigFromEnv({ NODE_ENV: 'production', ...full, AUTH_CLIENT_SECRET: ' ' })).toThrow(
      'AUTH_CLIENT_SECRET is required in production',
    );
  });

  it('production refuses plain-http issuer or redirect and sets Secure cookies', () => {
    expect(() =>
      authConfigFromEnv({ NODE_ENV: 'production', ...full, AUTH_ISSUER_URL: 'http://127.0.0.1:9' }),
    ).toThrow('AUTH_ISSUER_URL must be https in production');
    expect(() =>
      authConfigFromEnv({
        NODE_ENV: 'production',
        ...full,
        AUTH_REDIRECT_URI: 'http://app.example.test/auth/google/callback',
      }),
    ).toThrow('AUTH_REDIRECT_URI must be https in production');
    const cfg = authConfigFromEnv({ NODE_ENV: 'production', ...full });
    expect(cfg).toMatchObject({ secureCookies: true, allowInsecureIssuer: false, allowedDomains: null });
    expect(cfg?.issuerUrl.href).toBe(`${GOOGLE_ISSUER}/`);
  });

  it('outside production: nothing set = unavailable; a partial configuration is still an error', () => {
    expect(authConfigFromEnv({ NODE_ENV: 'development' })).toBeNull();
    expect(() => authConfigFromEnv({ NODE_ENV: 'test', AUTH_CLIENT_ID: 'x' })).toThrow(
      'AUTH_CLIENT_SECRET, AUTH_REDIRECT_URI are required',
    );
    const local = authConfigFromEnv({
      NODE_ENV: 'test',
      ...full,
      AUTH_ISSUER_URL: 'http://127.0.0.1:4000',
      AUTH_REDIRECT_URI: 'http://localhost:5173/auth/google/callback',
    });
    expect(local).toMatchObject({ secureCookies: false, allowInsecureIssuer: true });
  });

  it('the redirect URI must be the callback route', () => {
    expect(() =>
      authConfigFromEnv({ ...full, AUTH_REDIRECT_URI: 'https://app.example.test/elsewhere' }),
    ).toThrow('AUTH_REDIRECT_URI must end with /auth/google/callback');
  });

  it('AUTH_ALLOWED_DOMAINS is a trimmed, lower-cased, de-duplicated list; empty means unrestricted', () => {
    expect(parseAllowedDomains(' Acme.com, example.org ,acme.com,, ')).toEqual(['acme.com', 'example.org']);
    expect(parseAllowedDomains('')).toBeNull();
    expect(parseAllowedDomains(undefined)).toBeNull();
  });

  it('the API process exits at startup (code 2) naming the missing variable in production', () => {
    const main = fileURLToPath(new URL('../main.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', main], {
      env: {
        PATH: process.env['PATH'],
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://nobody@127.0.0.1:1/none',
        AUTH_CLIENT_ID: 'client-id.apps.example',
        AUTH_REDIRECT_URI: 'https://app.example.test/auth/google/callback',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(res.status).toBe(2);
    expect(`${res.stdout}${res.stderr}`).toContain('AUTH_CLIENT_SECRET is required in production');
  }, 60_000);
});
