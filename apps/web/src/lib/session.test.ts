import { afterEach, describe, expect, it } from 'vitest';
import { readCsrfCookie } from './session';

const setCookies = (cookie: string) => {
  (globalThis as { document?: { cookie: string } }).document = { cookie };
};

describe('readCsrfCookie (D-03 cookie names)', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('reads the production __Host- cookie, preferring it over an unprefixed one', () => {
    setCookies('oremedia_csrf=planted-by-sibling; __Host-oremedia_csrf=real-value');
    expect(readCsrfCookie()).toBe('real-value');
  });

  it('falls back to the unprefixed cookie over http (development and tests)', () => {
    setCookies('other=1; oremedia_csrf=dev-value');
    expect(readCsrfCookie()).toBe('dev-value');
  });

  it('is null without either', () => {
    setCookies('other=1');
    expect(readCsrfCookie()).toBeNull();
  });
});
