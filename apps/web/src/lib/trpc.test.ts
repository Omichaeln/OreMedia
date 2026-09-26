import type { Operation } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import { needsOwnRequest } from './trpc';

const op = (type: Operation['type'], context: Record<string, unknown> = {}) =>
  ({ id: 1, type, path: 'brand.summary', input: undefined, context, signal: null }) as Operation;
const at = (pathname: string) => ({ pathname: () => pathname });

describe('needsOwnRequest (a batch carries one tenant header)', () => {
  it('sends every mutation on its own', () => {
    expect(needsOwnRequest(op('mutation'), at('/c/ten_a/b/brd/home'))).toBe(true);
  });

  it('batches queries bound for the URL tenant, named or not', () => {
    expect(needsOwnRequest(op('query'), at('/c/ten_a/b/brd/home'))).toBe(false);
    expect(needsOwnRequest(op('query', { tenantId: 'ten_a' }), at('/c/ten_a'))).toBe(false);
    expect(needsOwnRequest(op('query'), at('/portfolio'))).toBe(false);
  });

  it('sends a query for another tenant, or a named tenant outside a company, on its own', () => {
    expect(needsOwnRequest(op('query', { tenantId: 'ten_b' }), at('/c/ten_a/b/brd/home'))).toBe(true);
    expect(needsOwnRequest(op('query', { tenantId: 'ten_a' }), at('/portfolio'))).toBe(true);
  });
});
