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

## Why this is not yet a full OreMedia migration

The current OreMedia runtime still depends on boundaries that are not replaced by this branch:

1. **MySQL domain model** — 116 Drizzle MySQL tables and 30 migrations. D1 is SQLite-compatible and requires a deliberate schema/data migration, not a connection-string swap.
2. **Temporal** — multiple task queues, schedules, child workflows, signals, replay fixtures, and versioning rules. Cloudflare Workflows can replace selected orchestration but does not automatically preserve Temporal semantics.
3. **Redis** — runtime/cache/coordination usage must be mapped to KV, Durable Objects, Queues, or an external Redis service with explicit consistency decisions.
4. **Media rendering** — Chromium, ffprobe/ffmpeg, and multi-minute video work remain in `worker-render`. Browser Run can cover selected browser automation, while Containers can cover Linux binaries, but the existing renderer needs a measured port and acceptance run.
5. **Malware scanning** — ClamAV and quarantine behavior remain outside this foundation. A replacement requires an isolated scanner design and evidence from the asset-ingest tests.
6. **Provider/API/auth behavior** — Meta, LinkedIn, Google OAuth, billing, consent, deletion, and all product routes still belong to the current API and worker services.

Until these gates are implemented and tested, the Cloudflare Worker must remain labelled `foundation-only` and must not be promoted as the production OreMedia API.

## Local verification

```bash
pnpm --filter @oremedia/web build
pnpm dlx wrangler@4.147.0 d1 migrations apply oremedia-cf-native-db --remote --config wrangler.cloudflare-native.jsonc
pnpm dlx wrangler@4.147.0 deploy --config wrangler.cloudflare-native.jsonc

curl -fsS https://<worker-host>/health
curl -fsS https://<worker-host>/cf-capabilities
curl -fsS -X POST https://<worker-host>/cf-foundation/probe
```

The probe should return `202` with a Workflow ID. Query the D1 events with Wrangler and verify `request`, `queue-consumed`, `workflow-start`, and `workflow-complete` records for the same request ID.

## Production-readiness gates before cutover

- [ ] D1-compatible schema has been reviewed against the current MySQL migrations and tenant isolation checks.
- [ ] Authentication/session/token storage has a reviewed Cloudflare-compatible design.
- [ ] Each Temporal workflow has a Workflows design, retry/idempotency proof, and replay-equivalent tests.
- [ ] Redis replacement or retained external dependency is explicitly selected.
- [ ] Renderer and scanner replacements pass real media acceptance tests.
- [ ] Provider certification remains fail-closed until Meta/LinkedIn review and channel runbook gates pass.
- [ ] API, web, worker, and cron cutover has a rollback plan and an observed production smoke run.
- [ ] The existing Railway deployment remains the serving production until all gates pass.
