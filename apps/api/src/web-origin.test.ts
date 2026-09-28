import { describe, expect, it } from 'vitest';
import { WebOriginConfigError, webOriginFromEnv } from './web-origin';

describe('WEB_ORIGIN (CORS and the channel-connect callback, spec 14.7)', () => {
  it('is a bare origin; unset is null', () => {
    expect(webOriginFromEnv({ WEB_ORIGIN: 'https://app.example.com' })).toBe('https://app.example.com');
    expect(webOriginFromEnv({ WEB_ORIGIN: ' http://localhost:5173 ' })).toBe('http://localhost:5173');
    expect(webOriginFromEnv({})).toBeNull();
    expect(webOriginFromEnv({ WEB_ORIGIN: '  ' })).toBeNull();
  });

  it('refuses a value that is not an origin, and plain http in production', () => {
    for (const WEB_ORIGIN of ['app.example.com', 'https://app.example.com/', 'https://app.example.com/app'])
      expect(() => webOriginFromEnv({ WEB_ORIGIN })).toThrow(WebOriginConfigError);
    expect(() => webOriginFromEnv({ WEB_ORIGIN: 'http://app.example.com', NODE_ENV: 'production' })).toThrow(
      /https in production/,
    );
  });
});
