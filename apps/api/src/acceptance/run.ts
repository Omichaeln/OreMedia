import path from 'node:path';
import { readMigrationState } from '@oremedia/db';
import type { AcceptanceConfig } from '../../../../tooling/scripts/acceptance/config';
import type { FetchLike } from '../../../../tooling/scripts/acceptance/http';
import { runK6, runVitest } from '../../../../tooling/scripts/acceptance/processes';
import {
  fail,
  formatAcceptance,
  formatDone,
  formatLoad,
  formatModelEval,
  skip,
  summarize,
  type AcceptanceResult,
} from '../../../../tooling/scripts/acceptance/report';
import { waitForSettled, type SettleProbes } from '../../../../tooling/scripts/acceptance/settle';
import { signOut } from './client';
import {
  ensureFontAssetVersion,
  isolationChecks,
  journeyChecks,
  modelEvalChecks,
  sessionKey,
  signInFixtures,
  smokeChecks,
  type Sessions,
} from './checks';
import {
  brandSystemChecks,
  factChecks,
  logoChecks,
  studioChecks,
  videoChecks,
  type StoreState,
} from './feature-checks';
import { provisionFixtures, providerAvailability, teardownFixtures, type FixtureTenant } from './fixtures';

/**
 * The staging acceptance job (docs/runbooks/staging-acceptance.md): fixtures, the smoke checks, the browser suites,
 * the api journeys (the content journey, then brand system, facts, SVG logo, Studio and video), then (each behind its flag) the top-of-hour load test and the bounded model evaluation. Prints
 * the ACCEPTANCE_* / LOAD_* / MODEL_EVAL_* lines through `print` and returns whether everything that ran passed.
 */
export interface RunOptions {
  teardown: boolean;
  print: (line: string) => void;
  /** The HTTP client the smoke checks use (the api client is configured through client.ts `configureFetch`). */
  fetch?: FetchLike;
}

const E2E_FILES = {
  deployed: 'apps/web/e2e/deployed.e2e.test.ts',
  a11y: 'apps/web/e2e/a11y.e2e.test.ts',
  studio: 'apps/web/e2e/studio.e2e.test.ts',
};

const describeProviders = (cfg: AcceptanceConfig): string => {
  const p = providerAvailability(cfg.disabledChannels);
  return p.usable.length
    ? `certified providers: ${p.usable.join(', ')}`
    : `no certified provider in this registry (uncertified: ${p.uncertified.join(', ') || 'none'}; disabled: ${p.disabled.join(', ') || 'none'})`;
};

/** The settle step's probes against the deployment: the api's /health through the web origin, and the database. */
const settleProbes = (cfg: AcceptanceConfig, f: FetchLike): SettleProbes => ({
  health: async () => {
    const res = await f(`${cfg.webOrigin}/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { revision?: unknown } | null;
    return { status: res.status, revision: typeof body?.revision === 'string' ? body.revision : null };
  },
  migrations: () => readMigrationState(),
});

async function browserSuites(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenantA: FixtureTenant,
  tenantB: FixtureTenant,
): Promise<AcceptanceResult[]> {
  const a = sessions.get(sessionKey(tenantA, 'owner'));
  const b = sessions.get(sessionKey(tenantB, 'owner'));
  if (!a || !b) return [skip('e2e', 'the owners of both companies need a session')];
  const font = await ensureFontAssetVersion(cfg, sessions, tenantA);
  const files = [E2E_FILES.deployed, E2E_FILES.a11y, ...(font.assetVersionId ? [E2E_FILES.studio] : [])];
  const results = await runVitest(files, {
    repoDir: cfg.repoDir,
    timeoutMs: 30 * 60_000,
    env: {
      OREMEDIA_E2E_WEB_ORIGIN: cfg.webOrigin,
      OREMEDIA_E2E_API_URL: cfg.webOrigin,
      OREMEDIA_E2E_TOKEN: a.token,
      OREMEDIA_E2E_TENANT: tenantA.tenantId,
      OREMEDIA_E2E_BRAND: tenantA.brandId,
      OREMEDIA_E2E_EMAIL: tenantA.members.owner.email,
      OREMEDIA_E2E_PASSWORD: tenantA.members.owner.password,
      OREMEDIA_E2E_COMPANY_NAME: tenantA.name,
      OREMEDIA_E2E_BRAND_NAME: tenantA.brandName,
      OREMEDIA_E2E_B_EMAIL: tenantB.members.owner.email,
      OREMEDIA_E2E_B_PASSWORD: tenantB.members.owner.password,
      OREMEDIA_E2E_B_TENANT: tenantB.tenantId,
      OREMEDIA_E2E_B_BRAND: tenantB.brandId,
      ...(font.assetVersionId ? { OREMEDIA_E2E_FONT: font.assetVersionId } : {}),
      ...(cfg.e2e.chromiumPath ? { OREMEDIA_CHROMIUM_PATH: cfg.e2e.chromiumPath } : {}),
      OREMEDIA_E2E: undefined,
    },
  });
  return font.assetVersionId
    ? results
    : [...results, skip('e2e:studio', `no approved font face: ${font.detail}`)];
}

async function loadTest(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenants: FixtureTenant[],
  print: RunOptions['print'],
) {
  const withChannels = tenants.filter(
    (t) => t.channelConnectionIds.length && sessions.has(sessionKey(t, 'owner')),
  );
  if (!withChannels.length) {
    print(`LOAD_SKIP no fixture company has a usable channel connection (${describeProviders(cfg)})`);
    return true;
  }
  const results = await runK6(path.join('tooling', 'load', 'top-of-hour.js'), {
    repoDir: cfg.repoDir,
    timeoutMs: 3 * 3600_000,
    env: {
      BASE_URL: cfg.apiBaseUrl,
      TENANTS: JSON.stringify(
        withChannels.map((t) => ({
          tenantId: t.tenantId,
          token: sessions.get(sessionKey(t, 'owner'))?.token,
          brandId: t.brandId,
          channelConnectionIds: t.channelConnectionIds,
        })),
      ),
      EXPECTED_PEAK: String(cfg.load.expectedPeak),
      PEAK_MULTIPLIER: String(cfg.load.peakMultiplier),
      ...(cfg.load.dispatchWindowS ? { DISPATCH_WINDOW_S: String(cfg.load.dispatchWindowS) } : {}),
      ...(cfg.load.targetAt ? { TARGET_AT: cfg.load.targetAt } : {}),
      ...(cfg.load.vus ? { VUS: String(cfg.load.vus) } : {}),
    },
  });
  for (const r of results) print(formatLoad(r));
  return results.every((r) => r.ok);
}

export async function runAcceptance(cfg: AcceptanceConfig, opts: RunOptions): Promise<boolean> {
  const { print } = opts;
  const fixtureOptions = { emailDomain: cfg.emailDomain, webOrigin: cfg.webOrigin };
  if (opts.teardown) {
    const results = await teardownFixtures(fixtureOptions);
    for (const r of results) print(formatAcceptance(r));
    const s = summarize(results);
    print(formatDone(s));
    return s.failed === 0;
  }

  const results: AcceptanceResult[] = [];
  const emit = (rs: AcceptanceResult[]) => {
    for (const r of rs) print(formatAcceptance(r));
    results.push(...rs);
  };
  const guard = async (name: string, run: () => Promise<AcceptanceResult[]>) => {
    try {
      emit(await run());
    } catch (err) {
      emit([fail(name, err instanceof Error ? `${err.name}: ${err.message}` : 'failed')]);
    }
  };

  // The job redeploys on the same push as the api: nothing is provisioned until the api serves this commit with
  // every bundled migration applied (docs/runbooks/staging-acceptance.md, "Reading the log").
  const settled = await waitForSettled(settleProbes(cfg, opts.fetch ?? fetch), {
    revision: cfg.settle.revision,
    timeoutMs: cfg.settle.timeoutMs,
    print,
  });
  emit([settled]);
  if (settled.outcome !== 'pass') {
    print(formatDone(summarize(results)));
    return false;
  }

  let tenants: FixtureTenant[];
  try {
    tenants = await provisionFixtures(fixtureOptions);
    emit(
      tenants.map((t) => ({
        name: `fixtures:${t.slug}`,
        outcome: 'pass' as const,
        detail: `${t.tenantId} brand ${t.brandId} version ${t.publishedVersionId} policy ${t.policyVersionId} agent ${t.servicePrincipalId}, ${t.channelConnectionIds.length} usable channel(s)`,
      })),
    );
  } catch (err) {
    emit([fail('fixtures', err instanceof Error ? `${err.name}: ${err.message}` : 'failed')]);
    print(formatDone(summarize(results)));
    return false;
  }
  const [tenantA, tenantB] = tenants as [FixtureTenant, FixtureTenant];
  print(`ACCEPTANCE_INFO channels: ${describeProviders(cfg)}`);

  const signedIn = await signInFixtures(cfg, tenants);
  emit(signedIn.results);
  const { sessions } = signedIn;
  let loadOk = true;
  let evalOk = true;
  try {
    await guard('smoke', () => smokeChecks(cfg, tenantA, opts.fetch ?? fetch));
    await guard('isolation', () => isolationChecks(sessions, tenantA, tenantB));
    await guard('journey', () => journeyChecks(sessions, tenantA, describeProviders(cfg)));
    // The journeys of the features shipped after RA-14, in this order: the brand system journey restores what it
    // changes, the logo journey finds whether the object store takes uploads, and Studio and video depend on that.
    await guard('brand-system', () => brandSystemChecks(cfg, sessions, tenantA));
    await guard('facts', () => factChecks(sessions, tenantA));
    let store: StoreState = { usable: false, reason: 'the SVG logo upload did not finish' };
    await guard('logo', async () => {
      const logo = await logoChecks(cfg, sessions, tenantA);
      store = logo.store;
      return logo.results;
    });
    await guard('studio', () => studioChecks(cfg, sessions, tenantA, store, describeProviders(cfg)));
    await guard('video', () => videoChecks(cfg, sessions, tenantA, store));
    if (cfg.e2e.enabled) await guard('e2e', () => browserSuites(cfg, sessions, tenantA, tenantB));
    else emit([skip('e2e', 'ACCEPTANCE_E2E=0')]);
    if (cfg.load.enabled) loadOk = await loadTest(cfg, sessions, tenants, print);
    else print('LOAD_SKIP LOAD_ENABLED is not 1');
    if (cfg.modelEval.enabled) {
      const evals = await modelEvalChecks(cfg, sessions, tenantA, print);
      for (const r of evals) print(formatModelEval(r));
      evalOk = evals.every((r) => r.ok);
    } else print('MODEL_EVAL_SKIP MODEL_EVAL_ENABLED is not 1');
  } finally {
    for (const s of sessions.values()) await signOut(cfg.webOrigin, s.token);
  }
  const s = summarize(results);
  print(formatDone(s));
  return s.failed === 0 && loadOk && evalOk;
}
