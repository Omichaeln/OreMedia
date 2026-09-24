import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authentication (spec 3.1, 18). D-03 is decided: Google (OpenID Connect) authenticates, through the protocol
 * adapter in apps/api/src/auth. This module owns the provider-independent parts: opaque bearer/session tokens,
 * hashing at rest, constant-time comparison, session lifetimes, and (service.ts) resolving a verified identity to a
 * user. Nothing in the policy layer depends on the provider.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function newOpaqueToken(prefix: string): { token: string; hash: string; prefixForLookup: string } {
  const raw = randomBytes(32).toString('base64url');
  const token = `${prefix}_${raw}`;
  return { token, hash: hashToken(token), prefixForLookup: token.slice(0, 12) };
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export const hashForAudit = (value: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${value}`).digest('hex');

/**
 * Browser session lifetime (spec 18; no earlier convention existed): a session ends after 12 hours without use or
 * 7 days after sign-in, whichever comes first. Use is recorded at most once a minute per session.
 */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_MS = 60 * 1000;
