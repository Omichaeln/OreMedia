/**
 * Operator entrypoint (docs/runbooks/staging-acceptance.md): the staging acceptance job. Provisions the throwaway
 * fixture companies through the application services, then drives the deployed web origin and api with the smoke
 * checks, the browser suites, the api journeys and, behind their flags, the load test and the model evaluation.
 * Prints one ACCEPTANCE_PASS / ACCEPTANCE_FAIL / ACCEPTANCE_SKIP line per check, ACCEPTANCE_DONE at the end, and
 * exits 1 when anything that ran failed. Never run it against production: it creates companies and content.
 *
 *   node dist/acceptance-run.js              # provision (idempotent) and run
 *   node dist/acceptance-run.js --teardown   # lock the fixture accounts and revoke their sessions
 */
import { parseArgs } from 'node:util';
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { closeDatabase, configureDatabase } from '@oremedia/db';
import { acceptanceConfigFromEnv } from '../../../tooling/scripts/acceptance/config';
import { chooseFetch, probeOrigin } from '../../../tooling/scripts/acceptance/probe';
import { safeDetail } from '../../../tooling/scripts/acceptance/report';
import { configureFetch } from './acceptance/client';
import { composeModules } from './composition';
import { runAcceptance } from './acceptance/run';

const log = startTelemetry({ service: 'oremedia-api-acceptance' });
const { values } = parseArgs({ options: { teardown: { type: 'boolean', default: false } } });
let config;
try {
  config = acceptanceConfigFromEnv(process.env, process.cwd());
} catch (err) {
  log.error(
    { errorMessage: safeDetail(err instanceof Error ? err.message : String(err)) },
    'acceptance configuration invalid',
  );
  process.exit(2);
}
try {
  // Which fetch the bundle runs with: a polyfilled or wrapped fetch would show here (and drop response headers).
  process.stdout.write(
    `ACCEPTANCE_INFO fetch=${globalThis.fetch?.name || 'none'} headers=${globalThis.Headers?.name || 'none'} node=${process.version}\n`,
  );
  // The startup probe: the deployment's public paths through three clients, then the one the job uses
  // (docs/runbooks/staging-acceptance.md, "Reading the log").
  const probe = await probeOrigin(config.webOrigin);
  for (const line of probe.lines) process.stdout.write(`${line}\n`);
  const client = chooseFetch(probe, process.env['ACCEPTANCE_HTTP_CLIENT']);
  process.stdout.write(`ACCEPTANCE_INFO http-client=${client.name}\n`);
  configureFetch(client.fetch);
  configureDatabase({ url: config.databaseUrl });
  composeModules();
  // The result lines go to stdout as plain text next to telemetry's JSON lines, so the deploy log can be grepped.
  const ok = await runAcceptance(config, {
    teardown: values.teardown,
    print: (line) => process.stdout.write(`${line}\n`),
    fetch: client.fetch,
  });
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  log.error(
    { errorMessage: safeDetail(err instanceof Error ? err.message : String(err)) },
    'acceptance run failed',
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
  await stopTelemetry();
}
