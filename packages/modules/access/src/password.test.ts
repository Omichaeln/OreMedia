import { describe, expect, it } from 'vitest';
import { passwordPolicyIssue } from '@oremedia/contracts/access';
import {
  CURRENT_SCRYPT_PARAMS,
  PasswordHashingBusyError,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  verifyPassword,
} from './password';

/** Cheap parameters for the round trips; one test covers the production parameters end to end. */
const FAST = { logN: 10, r: 8, p: 1 };

describe('password hashing (scrypt)', () => {
  it('encodes the parameters, a 16-byte salt and a 32-byte key; the production parameters verify', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const parsed = parsePasswordHash(stored);
    expect(parsed?.params).toEqual(CURRENT_SCRYPT_PARAMS);
    expect(parsed?.salt.length).toBe(16);
    expect(parsed?.key.length).toBe(32);
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
    await expect(verifyPassword('correct horse battery stapler', stored)).resolves.toBe(false);
  }, 30_000);

  it('salts every hash: the same password never hashes to the same string', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password here', FAST),
      hashPassword('same password here', FAST),
    ]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same password here', a)).resolves.toBe(true);
    await expect(verifyPassword('same password here', b)).resolves.toBe(true);
  });

  it('normalises to NFC: a composed and a decomposed é are the same password', async () => {
    const composed = 'café au lait please';
    const decomposed = 'café au lait please';
    const stored = await hashPassword(composed, FAST);
    await expect(verifyPassword(decomposed, stored)).resolves.toBe(true);
  });

  it('reads the parameters from the stored string (a hash made with other parameters still verifies)', async () => {
    const stored = await hashPassword('older parameters', { logN: 11, r: 4, p: 2 });
    expect(parsePasswordHash(stored)?.params).toEqual({ logN: 11, r: 4, p: 2 });
    await expect(verifyPassword('older parameters', stored)).resolves.toBe(true);
  });

  it('needsRehash: weaker parameters than the current ones, or an unreadable value', async () => {
    expect(needsRehash(await hashPassword('x'.repeat(12), FAST))).toBe(true);
    expect(needsRehash(await hashPassword('x'.repeat(12), FAST), FAST)).toBe(false);
    expect(needsRehash('not-a-hash')).toBe(true);
  });

  it('no stored hash, or a malformed one, never verifies (and still runs a check)', async () => {
    await expect(verifyPassword('anything at all', null)).resolves.toBe(false);
    await expect(verifyPassword('anything at all', 'scrypt$17$8$1$AAAA$BBBB')).resolves.toBe(false);
    await expect(verifyPassword('anything at all', 'bcrypt$2b$10$abc')).resolves.toBe(false);
  }, 30_000);

  it('refuses parameters outside the bounds a stored string may carry', () => {
    const salt = Buffer.alloc(16).toString('base64');
    const key = Buffer.alloc(32).toString('base64');
    expect(parsePasswordHash(`scrypt$30$8$1$${salt}$${key}`)).toBeNull(); // N = 2^30: memory exhaustion
    expect(parsePasswordHash(`scrypt$19$8$1$${salt}$${key}`)).toBeNull(); // above 2^18
    expect(parsePasswordHash(`scrypt$17$17$1$${salt}$${key}`)).toBeNull(); // r above 16
    expect(parsePasswordHash(`scrypt$18$16$1$${salt}$${key}`)?.params).toEqual({ logN: 18, r: 16, p: 1 });
    expect(parsePasswordHash(`scrypt$4$8$1$${salt}$${key}`)).toBeNull(); // trivially cheap
    expect(parsePasswordHash(`scrypt$17$0$1$${salt}$${key}`)).toBeNull();
    expect(parsePasswordHash(`scrypt$17$8$1$${Buffer.alloc(4).toString('base64')}$${key}`)).toBeNull();
    expect(parsePasswordHash(`scrypt$17$8$1$${salt}$${key}`)?.params).toEqual({ logN: 17, r: 8, p: 1 });
  });
});

describe('password policy', () => {
  const email = 'amara.okafor@acme.test';
  it('12 to 128 characters, counted as code points after NFC', () => {
    expect(passwordPolicyIssue('a'.repeat(11), email)).toBe('too_short');
    expect(passwordPolicyIssue('a'.repeat(12), email)).toBeNull();
    expect(passwordPolicyIssue('a'.repeat(128), email)).toBeNull();
    expect(passwordPolicyIssue('a'.repeat(129), email)).toBe('too_long');
    // Twelve emoji are 24 UTF-16 units but twelve characters.
    expect(passwordPolicyIssue('\u{1F511}'.repeat(12), email)).toBeNull();
    expect(passwordPolicyIssue('\u{1F511}'.repeat(11), email)).toBe('too_short');
    // Eleven decomposed é (22 code points) are eleven characters once composed.
    expect(passwordPolicyIssue('é'.repeat(11), email)).toBe('too_short');
  });

  it('no composition rules: a long passphrase of lower-case words is fine', () => {
    expect(passwordPolicyIssue('purple river quietly hums', email)).toBeNull();
  });

  it('must not be or contain the local part of the email address (case-insensitive)', () => {
    expect(passwordPolicyIssue('amara.okafor', email)).toBe('contains_email'); // twelve characters, the local part
    expect(passwordPolicyIssue('Amara.Okafor2026!', email)).toBe('contains_email');
    expect(passwordPolicyIssue('xxamara.okaforxx', email)).toBe('contains_email');
    expect(passwordPolicyIssue('amara okafor 2026', email)).toBeNull();
    // A short local part is only refused as the whole password, never as a substring.
    expect(passwordPolicyIssue('the jolly jo went home', 'jo@acme.test')).toBeNull();
    expect(passwordPolicyIssue('abcdefghijkl', 'abcdefghijkl@acme.test')).toBe('contains_email');
    expect(passwordPolicyIssue('a long enough password', null)).toBeNull();
  });
});

describe('hashing concurrency', () => {
  it('a burst beyond the running and waiting slots is refused as busy, and every accepted hash completes', async () => {
    const burst = Array.from({ length: 4 + 64 + 12 }, (_, i) =>
      hashPassword(`burst password ${i}`, FAST).then(
        () => 'ok' as const,
        (err: unknown) => (err instanceof PasswordHashingBusyError ? ('busy' as const) : ('error' as const)),
      ),
    );
    const results = await Promise.all(burst);
    expect(results.filter((r) => r === 'error')).toEqual([]);
    expect(results.filter((r) => r === 'busy')).toHaveLength(12);
    // The slots were all released: a later hash runs.
    await expect(hashPassword('after the burst', FAST)).resolves.toMatch(/^scrypt\$/);
  }, 60_000);
});
