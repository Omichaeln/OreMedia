# Cloudflare-native migration runbook

## Status

This branch deploys a **Cloudflare-native foundation**, not a replacement for the complete OreMedia production stack.

The foundation is intentionally isolated from existing Cloudflare resources and uses:

- Worker: `oremedia-cf-native`
- D1: `oremedia-cf-native-db`
- R2: `oremedia-cf-native-assets`
- Queue: `oremedia-cf-native-events`
- Workflow: `oremedia-cf-native-foundation`

The resources belong to the `Omichael@oreandtar.com` Cloudflare account. They must not be reused by unrelated projects.

## Verified foundation capabilities

- Vite web assets build and serve through Worker static assets.
- `GET /health` reports Worker liveness.
- `GET /cf-capabilities` exposes a non-secret capability matrix.
- `POST /cf-foundation/probe` writes a D1 event, enqueues a message, and starts a durable Workflow.
- The Queue consumer records consumption in D1.
- The Workflow records start and completion in D1 across a durable sleep boundary.
- Existing `/trpc/*`, `/auth/*`, `/v1/*`, and `/mcp*` routes fail closed with `503 NOT_MIGRATED` rather than pretending the production API exists.

## Deployment and secret configuration

The reproducible configuration is `wrangler.cloudflare-native.jsonc`. The GitHub Actions workflow is manual-or-branch-triggered and requires the following repository Actions secret:

- `CLOUDFLARE_API_TOKEN` — an account-scoped Cloudflare API token with only the permissions needed to deploy this Worker and manage its isolated resources.

Never commit the token or place it in `vars`. The workflow passes the GitHub commit SHA to Wrangler as `OREMEDIA_CF_COMMIT`; local deployments should do the same with `--var OREMEDIA_CF_COMMIT:<sha>`.

The isolated D1 migration is applied explicitly:

```bash
pnpm dlx wrangler@4.147.0 d1 migrations apply oremedia-cf-native-db --remote --config wrangler.cloudflare-native.jsonc
```

The Worker is deployed with:

```bash
pnpm --filter @oremedia/web build
pnpm dlx wrangler@4.147.0 deploy \
  --config wrangler.cloudflare-native.jsonc \
  --var OREMEDIA_CF_COMMIT:"$(git rev-parse HEAD)"
```

## Why this is not yet a full OreMedia migration

The current OreMedia runtime still depends on boundaries that are not replaced by this branch:

1. **MySQL domain model** — 116 Drizzle MySQL tables and 30 migrations. D1 is SQLite-compatible and requires a deliberate schema/data migration, not a connection-string swap.
2. **Temporal** — multiple task queues, schedules, child workflows, signals, replay fixtures, and versioning rules. Cloudflare Workflows can replace selected orchestration but does not automatically preserve Temporal semantics.
3. **Redis** — runtime/cache/coordination usage must be mapped to KV, Durable Objects, Queues, or an external Redis service with explicit consistency decisions.
4. **Media rendering** — Chromium, ffprobe/ffmpeg, and multi-minute video work remain in `worker-render`. Browser Run can cover selected browser automation, while Containers can cover Linux binaries, but the existing renderer needs a measured port and acceptance run.
5. **Malware scanning** — ClamAV and quarantine behavior remain outside this foundation. A replacement requires an isolated scanner design and evidence from the asset-ingest tests.
6. **Provider/API/auth behavior** — Meta, LinkedIn, Google OAuth, billing, consent, deletion, and all product routes still belong to the current API and worker services.

Until these gates are implemented and tested, the Cloudflare Worker must remain labelled `foundation-only` and must not be promoted as the production OreMedia API.

## Cost assumptions

These are planning estimates, not a quote, and exclude external AI/provider, Google Workspace, Meta/LinkedIn, database/Temporal, domain, tax, and engineering costs:

- **Development/low traffic:** approximately `$5–$15/month` for Workers Paid and light R2/Queues/Workflows usage.
- **Small production:** approximately `$10–$40/month` before meaningful AI inference.
- **Active production:** approximately `$30–$100+/month`, mainly driven by logs, Durable Object coordination, R2 operations, container rendering, and AI.
- **Cloudflare-native metadata plus regular rendering/AI:** plan approximately `$30–$200+/month` until measured workload data is available.

Workers AI and external AI inference must be metered per tenant. Rendering and scanner costs are workload-dependent and must be benchmarked before any production commitment.

## Local verification

```bash
pnpm --filter @oremedia/web build
pnpm exec tsc --noEmit -p infra/cloudflare-native/tsconfig.json
pnpm exec prettier --check .
pnpm dlx wrangler@4.147.0 deploy --config wrangler.cloudflare-native.jsonc --dry-run

curl -fsS https://<worker-host>/health
curl -fsS https://<worker-host>/cf-capabilities
curl -fsS -X POST https://<worker-host>/cf-foundation/probe
```

The probe should return `202` with a Workflow ID. Query the D1 events with Wrangler and verify `request`, `queue-consumed`, `workflow-start`, and `workflow-complete` records for the same request ID.

## Rollback and recovery

- **No Railway cutover was performed.** Railway remains the serving production deployment and is the immediate application rollback target.
- Do not change production DNS, OAuth redirect URIs, Meta/LinkedIn settings, or Railway services as part of this foundation deployment.
- For a Cloudflare-only regression, stop the foundation workflow trigger and roll the Worker back to the last known-good Worker version using the Cloudflare dashboard or the pinned Wrangler rollback/version command after checking the version list.
- The D1 database and R2 bucket are isolated and contain only foundation probe data/assets. Do not delete them as a rollback action; preserve them for diagnosis and recovery.
- Before any future data migration, take a source MySQL backup, export/validate the target dataset, run tenant-count/checksum comparisons, and rehearse restore. This branch performs **no production data migration**.

## Production-readiness gates before cutover

- [ ] D1-compatible schema has been reviewed against the current MySQL migrations and tenant isolation checks.
- [ ] Authentication/session/token storage has a reviewed Cloudflare-compatible design.
- [ ] Each Temporal workflow has a Workflows design, retry/idempotency proof, and replay-equivalent tests.
- [ ] Redis replacement or retained external dependency is explicitly selected.
- [ ] Renderer and scanner replacements pass real media acceptance tests.
- [ ] Provider certification remains fail-closed until Meta/LinkedIn review and channel runbook gates pass.
- [ ] API, web, worker, and cron cutover has a rollback plan and an observed production smoke run.
- [ ] The existing Railway deployment remains the serving production until all gates pass.
