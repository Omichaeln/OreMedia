import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSourceAvailability,
  sourceAvailabilityFromEnv,
  sourceAvailable,
  sourceCapabilities,
} from './hooks';

const env = (over: Record<string, string>): NodeJS.ProcessEnv => ({ ...over });
const GA4 = {
  PROVIDER_GA4_PROPERTY_CLIENT_ID_REF: 'id',
  PROVIDER_GA4_PROPERTY_SECRET_REF: 'secret',
};

describe('source availability and the configuration report (ledger R2-1)', () => {
  afterEach(() => configureSourceAvailability(null));

  it('a source is available with both app credentials set and not listed in OREMEDIA_DISABLED_SOURCES', () => {
    const available = sourceAvailabilityFromEnv(env(GA4));
    expect(available('ga4_property')).toBe(true);
    expect(available('search_console_site')).toBe(false);
    expect(
      sourceAvailabilityFromEnv(env({ ...GA4, OREMEDIA_DISABLED_SOURCES: ' GA4_Property ,x' }))(
        'ga4_property',
      ),
    ).toBe(false);
    expect(
      sourceAvailabilityFromEnv(env({ PROVIDER_GA4_PROPERTY_CLIENT_ID_REF: 'id' }))('ga4_property'),
    ).toBe(false);
  });

  it('every source is available until the composition root says otherwise', () => {
    expect(sourceAvailable('ga4_property')).toBe(true);
    configureSourceAvailability((kind) => kind === 'search_console_site');
    expect(sourceAvailable('ga4_property')).toBe(false);
    expect(sourceAvailable('search_console_site')).toBe(true);
  });

  it('source:<kind> capabilities name the missing settings of each registered source, unless disabled', () => {
    const checks = sourceCapabilities(env({}));
    expect(checks.map((c) => c.capability).sort()).toEqual([
      'source:ga4_property',
      'source:search_console_site',
    ]);
    expect(checks.find((c) => c.capability === 'source:ga4_property')!.missing(env(GA4))).toEqual([]);
    expect(checks.find((c) => c.capability === 'source:search_console_site')!.missing(env(GA4))).toEqual([
      'PROVIDER_SEARCH_CONSOLE_SITE_CLIENT_ID_REF',
      'PROVIDER_SEARCH_CONSOLE_SITE_SECRET_REF',
    ]);
    expect(
      sourceCapabilities(env({ OREMEDIA_DISABLED_SOURCES: 'search_console_site' })).map((c) => c.capability),
    ).toEqual(['source:ga4_property']);
  });
});
