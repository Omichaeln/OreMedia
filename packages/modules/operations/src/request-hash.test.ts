import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@oremedia/domain/hash';
import { hashRequest } from './request-hash';

describe('idempotency request hash (spec 7.1)', () => {
  it('is the canonical hash of the path and input, unchanged for an input without credential fields', () => {
    const input = {
      brandId: 'brd_1',
      siteUrl: 'https://example.test',
      nested: { secret: 'kept: not top level' },
    };
    expect(hashRequest('destinations.list', input)).toBe(hashCanonical({ path: 'destinations.list', input }));
    expect(hashRequest('access.me', undefined)).toBe(hashCanonical({ path: 'access.me', input: null }));
    expect(hashRequest('x', ['a'])).toBe(hashCanonical({ path: 'x', input: ['a'] }));
  });

  it('leaves credential fields out, so the stored hash cannot be brute-forced for them', () => {
    const base = { brandId: 'brd_1', kind: 'cms_site', siteUrl: 'https://example.test', username: 'editor' };
    const path = 'destinations.connect.withSecret';
    expect(hashRequest(path, { ...base, secret: 'abcd efgh ijkl' })).toBe(
      hashCanonical({ path, input: base }),
    );
    expect(hashRequest(path, { ...base, secret: 'abcd efgh ijkl' })).toBe(
      hashRequest(path, { ...base, secret: 'another one entirely' }),
    );
    const complete = 'publishing.channels.connect.complete';
    expect(hashRequest(complete, { state: 's1', code: 'oauth-code' })).toBe(
      hashCanonical({ path: complete, input: { state: 's1' } }),
    );
    // The other fields still decide whether a reused key is the same request.
    expect(hashRequest(path, { ...base, secret: 'x' })).not.toBe(
      hashRequest(path, { ...base, username: 'someone else', secret: 'x' }),
    );
  });
});
