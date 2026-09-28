/**
 * `pnpm smoke:prod`: the production smoke check (docs/runbooks/deploy-railway.md, "Production smoke check") against a
 * deployed web origin, SMOKE_BASE_URL. Prints one line per check and exits 1 when any check fails. It reads its
 * credentials from the environment and prints none of them, nor any signed URL's query string.
 */
import { formatResult, runSmoke, smokeConfigFromEnv } from './checks';

let config;
try {
  config = smokeConfigFromEnv(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
console.log(`Oremedia smoke check against ${config.baseUrl}`);
const results = await runSmoke(config);
for (const r of results) console.log(formatResult(r));
const failed = results.filter((r) => r.outcome === 'fail');
console.log(
  failed.length
    ? `${failed.length} check(s) failed: ${failed.map((r) => r.name).join(', ')}`
    : `all checks passed (${results.filter((r) => r.outcome === 'skip').length} skipped)`,
);
process.exit(failed.length ? 1 : 0);
