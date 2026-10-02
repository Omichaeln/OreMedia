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
import { composeModules } from './composition';
import { runAcceptance } from './acceptance/run';

const log = startTelemetry({ service: 'oremedia-api-acceptance' });
const { values } = parseArgs({ options: { teardown: { type: 'boolean', default: false } } });
let config;
try {
  config = acceptanceConfigFromEnv(process.env, process.cwd());
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'acceptance configuration invalid',
  );
  process.exit(2);
}
try {
  configureDatabase({ url: config.databaseUrl });
  composeModules();
  // The result lines go to stdout as plain text next to telemetry's JSON lines, so the deploy log can be grepped.
  const ok = await runAcceptance(config, {
    teardown: values.teardown,
    print: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'acceptance run failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
  await stopTelemetry();
}
