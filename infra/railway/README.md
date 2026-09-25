# Railway deployment (spec 17.1)

Application services, plus a short-lived approval monitor, each use the repository root as their root directory and a config-as-code path under `infra/railway/<service>/railway.json`:

| Service            | Image                             | `OREMEDIA_APP` variable | Ports / health                                                                   |
| ------------------ | --------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `api`              | `infra/railway/Dockerfile`        | `api`                   | `PORT` (HTTP), `/health`; runs migrations as its pre-deploy command              |
| `worker-core`      | `infra/railway/Dockerfile`        | `worker-core`           | `PORT`, `/health` once all workers started; queues `core`, `agents`, `publish-*` |
| `worker-ingest`    | `infra/railway/Dockerfile`        | `worker-ingest`         | `PORT`, `/health` once workers started; `ingest-*`, `listening`, `crm`           |
| `worker-render`    | `infra/railway/Dockerfile.render` | (fixed)                 | `PORT`, `/health` once workers started; `render`, `media`; Chromium              |
| `redirector`       | `infra/railway/Dockerfile`        | `redirector`            | `PORT`, `/health`; tracked-link redirects on `LINK_REDIRECT_DOMAIN`              |
| `web`              | `infra/railway/Dockerfile.web`    | (fixed)                 | `PORT`, `/health` (proxied); SPA + API proxy (`API_INTERNAL_URL`)                |
| `approval-monitor` | `infra/railway/Dockerfile`        | `approval-monitor`      | Railway cron; Gmail review-status poller, exits after each run                   |

`worker-ingest` (Phase 6) and `redirector` (Phase 5) are listed for completeness: their `railway.json` files are in place, but the apps do not exist yet and the services must not be created until they do.

Database roles: `DATABASE_URL` on every service points at the application role (`packages/db/roles/app-role.sql`); `worker-core` additionally sets `DATABASE_URL_RETENTION`, a second MySQL user with the retention role (`packages/db/roles/retention-role.sql`), used only by the retention sweep's activities.

Managed dependencies: Railway MySQL (application), Railway Redis, Cloudflare R2 (object storage, external: Railway offers no S3-compatible store), and Temporal Cloud (recommended) or the `temporal` service above with its own Railway MySQL instance. Variables follow Appendix A names exactly; secrets are Railway sealed variables.

The `web` service is the only public origin: its Caddy reverse-proxies `/trpc`, `/v1`, `/mcp`, `/auth` and `/health` to `api` over the private network (`API_INTERNAL_URL`), so Google sign-in cookies are first-party (decision D-03; runbook section 1a).

The step-by-step procedure, rollback and the kill switches are in `docs/runbooks/deploy-railway.md`.

`approval-monitor` is a separate Railway cron service. Configure its Cron Schedule as `0 */6 * * *` (UTC), set `OREMEDIA_APP=approval-monitor`, and reference the API service's `DATABASE_URL` in the monitor service. It also requires sealed `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` variables. The monitor records Meta and LinkedIn review evidence in the global `provider_review_statuses` table; an approval email does not auto-certify a provider because the certification runbook still requires real publish/read-back and metrics checks.
