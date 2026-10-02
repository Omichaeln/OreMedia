import { describe, expect, it } from 'vitest';
import { acceptanceConfigFromEnv } from './config';

const base = {
  DATABASE_URL: 'mysql://app:pw@db.internal:3306/oremedia',
  WEB_ORIGIN: 'https://staging.example.test',
};

describe('acceptanceConfigFromEnv', () => {
  it('reads the required origin and database, with every optional part off by default', () => {
    const cfg = acceptanceConfigFromEnv(base, '/src');
    expect(cfg.webOrigin).toBe('https://staging.example.test');
    expect(cfg.apiBaseUrl).toBe('https://staging.example.test');
    expect(cfg.emailDomain).toBe('acceptance.invalid');
    expect(cfg.repoDir).toBe('/src');
    expect(cfg.e2e.enabled).toBe(true);
    expect(cfg.load).toEqual({ enabled: false, expectedPeak: 50, peakMultiplier: 2 });
    expect(cfg.modelEval).toEqual({
      enabled: false,
      taskKinds: ['copywriting'],
      timeoutMs: 600_000,
      budgetMicros: 250_000,
    });
    expect(cfg.disabledChannels.size).toBe(0);
    expect(cfg.expectStoreOrigin).toBeUndefined();
  });

  it('names the missing or malformed variable, never a value', () => {
    expect(() => acceptanceConfigFromEnv({ WEB_ORIGIN: base.WEB_ORIGIN }, '/src')).toThrow(/^DATABASE_URL/);
    expect(() => acceptanceConfigFromEnv({ DATABASE_URL: base.DATABASE_URL }, '/src')).toThrow(/^WEB_ORIGIN/);
    expect(() => acceptanceConfigFromEnv({ ...base, WEB_ORIGIN: 'https://a.test/' }, '/src')).toThrow(
      'WEB_ORIGIN must be a bare origin such as https://a.test',
    );
    expect(() => acceptanceConfigFromEnv({ ...base, EXPECTED_PEAK: '-1' }, '/src')).toThrow(/^EXPECTED_PEAK/);
    expect(() =>
      acceptanceConfigFromEnv({ ...base, ACCEPTANCE_EMAIL_DOMAIN: 'not a domain' }, '/src'),
    ).toThrow(/^ACCEPTANCE_EMAIL_DOMAIN/);
  });

  it('the synthetic users take an allowed domain: the first AUTH_ALLOWED_DOMAINS entry, or the one named if allowed', () => {
    expect(
      acceptanceConfigFromEnv({ ...base, AUTH_ALLOWED_DOMAINS: 'Pilot.Example, other.example' }, '/src')
        .emailDomain,
    ).toBe('pilot.example');
    expect(
      acceptanceConfigFromEnv(
        {
          ...base,
          AUTH_ALLOWED_DOMAINS: 'pilot.example,other.example',
          ACCEPTANCE_EMAIL_DOMAIN: 'other.example',
        },
        '/src',
      ).emailDomain,
    ).toBe('other.example');
    expect(() =>
      acceptanceConfigFromEnv(
        { ...base, AUTH_ALLOWED_DOMAINS: 'pilot.example', ACCEPTANCE_EMAIL_DOMAIN: 'elsewhere.example' },
        '/src',
      ),
    ).toThrow(/AUTH_ALLOWED_DOMAINS/);
  });

  it('switches on the load test and the model evaluation only with their flags, carrying their settings', () => {
    const cfg = acceptanceConfigFromEnv(
      {
        ...base,
        LOAD_ENABLED: '1',
        EXPECTED_PEAK: '80',
        PEAK_MULTIPLIER: '3',
        DISPATCH_WINDOW_S: '90',
        LOAD_TARGET_AT: '2026-10-02T10:00:00Z',
        MODEL_EVAL_ENABLED: '1',
        MODEL_EVAL_TASK_KINDS: 'copywriting, layout',
        MODEL_EVAL_TIMEOUT_MS: '120000',
        MODEL_EVAL_BUDGET_MICROS: '50000',
        ACCEPTANCE_E2E: '0',
        ACCEPTANCE_API_BASE_URL: 'http://api.railway.internal:3001',
        OREMEDIA_DISABLED_CHANNELS: 'X, instagram_business',
        SMOKE_EXPECT_STORE_ORIGIN: 'https://store.example.test',
        SMOKE_INGEST_TIMEOUT_MS: '30000',
        ACCEPTANCE_REPO_DIR: '/checkout',
      },
      '/src',
    );
    expect(cfg.load).toEqual({
      enabled: true,
      expectedPeak: 80,
      peakMultiplier: 3,
      dispatchWindowS: 90,
      targetAt: '2026-10-02T10:00:00Z',
    });
    expect(cfg.modelEval).toEqual({
      enabled: true,
      taskKinds: ['copywriting', 'layout'],
      timeoutMs: 120_000,
      budgetMicros: 50_000,
    });
    expect(cfg.e2e.enabled).toBe(false);
    expect(cfg.apiBaseUrl).toBe('http://api.railway.internal:3001');
    expect([...cfg.disabledChannels]).toEqual(['x', 'instagram_business']);
    expect(cfg.expectStoreOrigin).toBe('https://store.example.test');
    expect(cfg.ingestTimeoutMs).toBe(30_000);
    expect(cfg.repoDir).toBe('/checkout');
  });
});
