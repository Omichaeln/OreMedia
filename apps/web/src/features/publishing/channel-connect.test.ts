import { describe, expect, it } from 'vitest';
import {
  callbackError,
  callbackParams,
  connectRedirectUri,
  providerLabel,
  recallConnect,
  rememberConnect,
  returnQuery,
  unavailableReason,
} from './channel-connect';

describe('unavailableReason (spec 14.6)', () => {
  it('explains an uncertified or unknown provider and ignores other refusals', () => {
    expect(unavailableReason([{ path: 'providerKey', issue: 'provider_not_certified:x' }])).toContain(
      'Not certified',
    );
    expect(unavailableReason([{ path: 'providerKey', issue: 'unknown_provider:y' }])).toContain(
      'not registered',
    );
    expect(unavailableReason([{ path: 'brandId', issue: 'other' }])).toBeNull();
  });
});

describe('callback parsing (spec 14.7)', () => {
  it('needs both state and code', () => {
    expect(callbackParams('?state=s1&code=c1')).toEqual({ state: 's1', code: 'c1' });
    expect(callbackParams('state=s1')).toBeNull();
    expect(callbackParams('')).toBeNull();
  });
  it('reads the provider error redirect as text', () => {
    expect(callbackError('error=access_denied&error_description=User+said+no')).toBe(
      'access_denied: User said no',
    );
    expect(callbackError('error=access_denied')).toBe('access_denied');
    expect(callbackError('state=s')).toBeNull();
  });
  it('builds the one registered callback and labels providers', () => {
    expect(connectRedirectUri('https://app.example')).toBe('https://app.example/connect/callback');
    expect(providerLabel('linkedin_page')).toBe('LinkedIn Page');
    expect(providerLabel('other')).toBe('other');
  });
});

describe('the shared callback finds its brand (spec 14.7)', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
      size: () => m.size,
      has: (k: string) => m.has(k),
    };
  };
  const pending = { companyId: 'ten_1', brandId: 'brd_1', expiresAt: '2026-09-28T12:10:00.000Z' };

  it('recalls the brand once, by state, until it expires', () => {
    const store = memory();
    rememberConnect('st_1', pending, store, Date.parse('2026-09-28T12:00:00Z'));
    expect(recallConnect('st_other', store, Date.parse('2026-09-28T12:00:00Z'))).toBeNull();
    expect(recallConnect('st_1', store, Date.parse('2026-09-28T12:00:00Z'))).toEqual(pending);
    expect(recallConnect('st_1', store, Date.parse('2026-09-28T12:00:00Z'))).toBeNull(); // used up
    rememberConnect('st_2', pending, store, Date.parse('2026-09-28T12:00:00Z'));
    expect(recallConnect('st_2', store, Date.parse('2026-09-28T12:11:00Z'))).toBeNull(); // expired
    expect(store.size()).toBe(0);
  });

  it('a new flow drops entries of flows abandoned at the provider, and keeps live ones', () => {
    const store = memory();
    store.setItem('other.key', 'kept');
    rememberConnect(
      'st_old',
      { ...pending, expiresAt: '2026-09-28T11:00:00.000Z' },
      store,
      Date.parse('2026-09-28T10:59:00Z'),
    );
    rememberConnect('st_live', pending, store, Date.parse('2026-09-28T10:59:00Z'));
    rememberConnect('st_new', pending, store, Date.parse('2026-09-28T12:00:00Z'));
    expect(store.has('oremedia.connect.st_old')).toBe(false);
    expect(store.has('oremedia.connect.st_live')).toBe(true);
    expect(store.has('other.key')).toBe(true);
  });

  it('tolerates blocked storage and malformed entries', () => {
    expect(() => rememberConnect('st', pending, null)).not.toThrow();
    expect(recallConnect('st', null)).toBeNull();
    const store = memory();
    store.setItem('oremedia.connect.st_bad', '{"companyId":1}');
    expect(recallConnect('st_bad', store)).toBeNull();
  });

  it('carries only the provider answer on to the settings page', () => {
    expect(returnQuery('?state=s&code=c&extra=x')).toBe('state=s&code=c');
    expect(returnQuery('state=s&error=access_denied&error_description=No')).toBe(
      'state=s&error=access_denied&error_description=No',
    );
  });
});
