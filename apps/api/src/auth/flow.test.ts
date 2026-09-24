import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_TO, flowKey, openFlow, safeReturnTo, sealFlow, type FlowState } from './flow';

const flow = (over: Partial<FlowState> = {}): FlowState => ({
  state: 'state-value',
  nonce: 'nonce-value',
  codeVerifier: 'verifier-value',
  returnTo: '/c/ten_1/b/brd_1/home',
  expiresAt: Date.now() + 60_000,
  ...over,
});

describe('sealed flow cookie', () => {
  const key = flowKey('client-secret-one');

  it('round-trips and is opaque to the browser', () => {
    const sealed = sealFlow(flow(), key);
    expect(sealed).not.toContain('state-value');
    expect(sealed).not.toContain('verifier-value');
    expect(openFlow(sealed, key)).toMatchObject({ state: 'state-value', codeVerifier: 'verifier-value' });
  });

  it('refuses a tampered, truncated, foreign-key or expired cookie', () => {
    const sealed = sealFlow(flow(), key);
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
    expect(openFlow(flipped, key)).toBeNull();
    expect(openFlow(sealed.slice(0, 30), key)).toBeNull();
    expect(openFlow(sealed, flowKey('client-secret-two'))).toBeNull();
    expect(openFlow(sealFlow(flow({ expiresAt: Date.now() - 1 }), key), key)).toBeNull();
    expect(openFlow(undefined, key)).toBeNull();
    expect(openFlow('not base64 at all %%', key)).toBeNull();
  });

  it('refuses a bit-flipped cookie even when the altered plaintext would still parse (authentication tag)', () => {
    const sealed = sealFlow(flow(), key);
    const raw = Buffer.from(sealed, 'base64url');
    const plaintext = JSON.stringify({ v: 1, ...flow() });
    const at = 28 + plaintext.indexOf('"state-value"') + 1; // AES-GCM is a stream: flip 's' into 'r' in place
    raw[at] = (raw[at] as number) ^ 1;
    expect(openFlow(raw.toString('base64url'), key)).toBeNull();
  });

  it('re-sanitises returnTo on the way out', () => {
    expect(openFlow(sealFlow(flow({ returnTo: '//evil.example' }), key), key)?.returnTo).toBe(
      DEFAULT_RETURN_TO,
    );
  });
});

describe('safeReturnTo (open-redirect guard)', () => {
  const KEPT: Array<[string, string]> = [
    ['/portfolio', '/portfolio'],
    ['/c/ten_1/b/brd_1/studio/doc_1?x=1#el', '/c/ten_1/b/brd_1/studio/doc_1?x=1#el'],
    ['/%2F%2Fevil.example', '/%2F%2Fevil.example'], // stays a path on this origin
    ['/c/./ten_1/../ten_2/home', '/c/ten_2/home'], // normalised, still local
  ];
  const REFUSED: unknown[] = [
    'https://evil.example/',
    'http:/evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\r\nLocation: https://evil.example',
    'javascript:alert(1)',
    'portfolio',
    '',
    '/auth/google/callback?code=x',
    `/${'a'.repeat(600)}`,
    // Dot segments that normalise into a protocol-relative URL (review finding m1).
    '/.//evil.com',
    '/a/..//evil.com',
    '/%2e//evil.com',
    '/%2e%2e//evil.com',
    '/./\\evil.com',
    undefined,
    ['/portfolio'],
    42,
  ];

  it.each(KEPT)('keeps the same-origin path %j', (input, out) => {
    expect(safeReturnTo(input)).toBe(out);
  });

  it.each(REFUSED.map((v) => [v]))('falls back to the default for %j', (input) => {
    expect(safeReturnTo(input)).toBe(DEFAULT_RETURN_TO);
  });

  it.each([...KEPT.map(([i]) => i), ...REFUSED].map((v) => [v]))(
    'is idempotent and never yields a protocol-relative or off-origin value: %j',
    (input) => {
      const once = safeReturnTo(input);
      expect(safeReturnTo(once)).toBe(once);
      expect(once.startsWith('/')).toBe(true);
      expect(once.startsWith('//') || once.startsWith('/\\')).toBe(false);
      expect(new URL(once, 'https://app.example').origin).toBe('https://app.example');
    },
  );
});
