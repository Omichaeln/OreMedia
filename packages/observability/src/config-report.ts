import type { Logger } from './logger';

type Env = Record<string, string | undefined>;

/**
 * One capability a service offers and the settings it needs, checked by the module that reads them (its own reader's
 * names, so the check and the reader cannot disagree). `missing` returns the NAMES of the settings that are absent,
 * never their values; empty when the capability is configured.
 */
export interface CapabilityCheck {
  /** Stable capability name as operators read it: `uploads`, `models`, `web_origin`, `channel:<providerKey>`. */
  capability: string;
  missing(env: Env): string[];
}

export interface ConfigurationReport {
  /** Capability names that cannot work with this configuration (what /health exposes: names only). */
  degraded: string[];
  /** Per degraded capability, the setting names it lacks (the startup log line; never exposed over HTTP). */
  missing: Record<string, string[]>;
  /** OREMEDIA_CONFIG_STRICT=1 and something is degraded: the service must refuse to start. */
  refuse: boolean;
}

/** Strict mode is opt-in: only the exact value `1` turns it on; unset, empty or anything else is off. */
export const configStrict = (env: Env): boolean => env['OREMEDIA_CONFIG_STRICT'] === '1';

/** Pure evaluation of a service's capability checks against an environment. */
export function evaluateConfiguration(checks: readonly CapabilityCheck[], env: Env): ConfigurationReport {
  const missing: Record<string, string[]> = {};
  for (const check of checks) {
    const names = check.missing(env);
    if (names.length) missing[check.capability] = [...new Set(names)];
  }
  const degraded = Object.keys(missing);
  return { degraded, missing, refuse: degraded.length > 0 && configStrict(env) };
}

/**
 * The startup configuration report: ONE line per start (plus a warning when OREMEDIA_CONFIG_STRICT holds a value
 * other than `1`, which leaves strict mode off). Degraded capabilities are an error-level line naming each
 * capability and the settings it lacks (names only); the service keeps running unless strict mode is on (the caller
 * exits when `refuse` is set). A fully configured service logs one info line.
 */
export function reportConfiguration(
  log: Logger,
  checks: readonly CapabilityCheck[],
  env: Env = process.env,
): ConfigurationReport {
  const report = evaluateConfiguration(checks, env);
  const strict = env['OREMEDIA_CONFIG_STRICT'];
  if (strict && !configStrict(env))
    log.warn(
      { flag: 'OREMEDIA_CONFIG_STRICT' },
      'OREMEDIA_CONFIG_STRICT is set but not to 1: strict mode stays off (set it to 1 to turn it on)',
    );
  if (!report.degraded.length) {
    log.info({ count: checks.length }, 'configuration complete: every capability is configured');
    return report;
  }
  log.error(
    {
      degraded: report.degraded,
      missingSettings: report.missing,
      outcome: report.refuse ? 'refused' : 'running',
    },
    report.refuse
      ? 'configuration incomplete: capabilities degraded; OREMEDIA_CONFIG_STRICT=1, refusing to start'
      : 'configuration incomplete: capabilities degraded; running without them',
  );
  return report;
}
