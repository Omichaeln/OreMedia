/**
 * The staging acceptance job's configuration (docs/runbooks/staging-acceptance.md), read from the environment the
 * Railway service injects. Every error names the variable that is missing or malformed, never its value.
 */
export interface AcceptanceConfig {
  /** The application database the fixtures are provisioned in (DATABASE_URL: the api's or the migrate role's URL). */
  databaseUrl: string;
  /** The deployed web origin, exactly the api's WEB_ORIGIN: the Origin header of every sign-in and the e2e target. */
  webOrigin: string;
  /** Where the load test and the model evaluation send their tRPC calls (ACCEPTANCE_API_BASE_URL; default the web origin). */
  apiBaseUrl: string;
  /** The domain of the synthetic users' addresses (ACCEPTANCE_EMAIL_DOMAIN, else the first AUTH_ALLOWED_DOMAINS entry). */
  emailDomain: string;
  /** Passed to the smoke checks unchanged (SMOKE_EXPECT_STORE_ORIGIN, SMOKE_INGEST_TIMEOUT_MS). */
  expectStoreOrigin?: string;
  ingestTimeoutMs?: number;
  /** Provider keys the staging api does not deploy (OREMEDIA_DISABLED_CHANNELS, the api's own setting). */
  disabledChannels: ReadonlySet<string>;
  /** The repository checkout the browser suites and the k6 script are run from (ACCEPTANCE_REPO_DIR). */
  repoDir: string;
  e2e: { enabled: boolean; chromiumPath?: string };
  load: {
    enabled: boolean;
    expectedPeak: number;
    peakMultiplier: number;
    dispatchWindowS?: number;
    targetAt?: string;
    vus?: number;
  };
  modelEval: { enabled: boolean; taskKinds: string[]; timeoutMs: number; budgetMicros: number };
  /**
   * The settle step before the fixtures (tooling/scripts/acceptance/settle.ts): the commit this job was built from
   * (RAILWAY_GIT_COMMIT_SHA; null = unknown, the revision condition is skipped) and how long to wait for the api to
   * serve it with every migration applied (ACCEPTANCE_SETTLE_TIMEOUT_MS, default 20 minutes).
   */
  settle: { revision: string | null; timeoutMs: number };
}

const flag = (value: string | undefined): boolean => value?.trim() === '1';

const positive = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

const origin = (name: string, value: string | undefined): string => {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required (https://<web domain>)`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.origin !== trimmed) throw new Error(`${name} must be a bare origin such as ${url.origin}`);
  return url.origin;
};

/** A mail domain the synthetic users can carry: lower case, no `@`, no spaces. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Reads the configuration from the environment; throws naming what is missing (names only). */
export function acceptanceConfigFromEnv(
  env: Record<string, string | undefined>,
  cwd: string,
): AcceptanceConfig {
  // The job creates companies and content and may schedule publications: it refuses to run anywhere that is not
  // explicitly staging. The flag is a variable of the staging service; a production environment name or origin
  // refuses even with it.
  if (env['ACCEPTANCE_CONFIRM_STAGING']?.trim() !== '1')
    throw new Error('ACCEPTANCE_CONFIRM_STAGING=1 is required: this job runs only in the staging project');
  if (/prod/i.test(env['RAILWAY_ENVIRONMENT_NAME'] ?? ''))
    throw new Error(
      'RAILWAY_ENVIRONMENT_NAME names a production environment: the acceptance job never runs there',
    );
  const databaseUrl = env['DATABASE_URL']?.trim();
  if (!databaseUrl)
    throw new Error('DATABASE_URL is required (the application database the fixtures live in)');
  const webOrigin = origin('WEB_ORIGIN', env['WEB_ORIGIN']);
  if (/production/i.test(webOrigin))
    throw new Error('WEB_ORIGIN is a production origin: the acceptance job never runs against production');
  const apiBaseUrl = env['ACCEPTANCE_API_BASE_URL']?.trim()
    ? origin('ACCEPTANCE_API_BASE_URL', env['ACCEPTANCE_API_BASE_URL'])
    : webOrigin;
  const allowed = (env['AUTH_ALLOWED_DOMAINS'] ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const emailDomain = (
    env['ACCEPTANCE_EMAIL_DOMAIN']?.trim() ||
    allowed[0] ||
    'acceptance.invalid'
  ).toLowerCase();
  if (!DOMAIN.test(emailDomain)) throw new Error('ACCEPTANCE_EMAIL_DOMAIN is not a mail domain');
  if (allowed.length && !allowed.includes(emailDomain))
    throw new Error(
      'ACCEPTANCE_EMAIL_DOMAIN must be one of AUTH_ALLOWED_DOMAINS, or the api refuses every sign-in',
    );
  const store = env['SMOKE_EXPECT_STORE_ORIGIN']?.trim();
  const ingest = Number(env['SMOKE_INGEST_TIMEOUT_MS'] ?? '');
  const taskKinds = (env['MODEL_EVAL_TASK_KINDS'] ?? 'copywriting')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const chromiumPath = env['OREMEDIA_CHROMIUM_PATH']?.trim();
  const targetAt = env['LOAD_TARGET_AT']?.trim();
  if (targetAt && Number.isNaN(Date.parse(targetAt)))
    throw new Error('LOAD_TARGET_AT must be an ISO timestamp');
  return {
    databaseUrl,
    webOrigin,
    apiBaseUrl,
    emailDomain,
    ...(store ? { expectStoreOrigin: origin('SMOKE_EXPECT_STORE_ORIGIN', store) } : {}),
    ...(Number.isFinite(ingest) && ingest > 0 ? { ingestTimeoutMs: ingest } : {}),
    disabledChannels: new Set(
      (env['OREMEDIA_DISABLED_CHANNELS'] ?? '')
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean),
    ),
    repoDir: env['ACCEPTANCE_REPO_DIR']?.trim() || cwd,
    e2e: {
      enabled: env['ACCEPTANCE_E2E'] === undefined || flag(env['ACCEPTANCE_E2E']),
      ...(chromiumPath ? { chromiumPath } : {}),
    },
    load: {
      enabled: flag(env['LOAD_ENABLED']),
      expectedPeak: positive('EXPECTED_PEAK', env['EXPECTED_PEAK'], 50),
      peakMultiplier: positive('PEAK_MULTIPLIER', env['PEAK_MULTIPLIER'], 2),
      ...(env['DISPATCH_WINDOW_S']
        ? { dispatchWindowS: positive('DISPATCH_WINDOW_S', env['DISPATCH_WINDOW_S'], 120) }
        : {}),
      ...(targetAt ? { targetAt } : {}),
      ...(env['LOAD_VUS'] ? { vus: positive('LOAD_VUS', env['LOAD_VUS'], 10) } : {}),
    },
    modelEval: {
      enabled: flag(env['MODEL_EVAL_ENABLED']),
      taskKinds: taskKinds.length ? taskKinds : ['copywriting'],
      timeoutMs: positive('MODEL_EVAL_TIMEOUT_MS', env['MODEL_EVAL_TIMEOUT_MS'], 600_000),
      budgetMicros: positive('MODEL_EVAL_BUDGET_MICROS', env['MODEL_EVAL_BUDGET_MICROS'], 250_000),
    },
    settle: {
      revision: env['RAILWAY_GIT_COMMIT_SHA']?.trim() || null,
      timeoutMs: positive('ACCEPTANCE_SETTLE_TIMEOUT_MS', env['ACCEPTANCE_SETTLE_TIMEOUT_MS'], 20 * 60_000),
    },
  };
}
