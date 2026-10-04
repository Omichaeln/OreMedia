# Runbook: deploy Oremedia on Railway

**Scope:** first provisioning, routine deploys, rollback. **Owner:** platform. **Status of automation:** the
configuration in `infra/railway/` is complete for the services that exist; provisioning needs a Railway account
and cannot be performed from the build environment (no `RAILWAY_TOKEN`). Nothing below has been executed.

## 1. Provision (once per environment: development, staging, production)

1. Create a Railway project per environment. Never share a database or credentials between environments.
2. Add plugins: **MySQL** (application), **Redis**. If self-hosting Temporal, add a **second MySQL** for it.
3. Create a Cloudflare R2 bucket pair (`assets`, `releases`), private, with versioning and lifecycle rules.
4. For each application service: "New service → GitHub repo" (this repository), leave **Root Directory** at the
   repository root, set **Config-as-code path** to `infra/railway/<service>/railway.json`, and set the variables:
   - all services: `DATABASE_URL`, `REDIS_URL`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TLS_CERT_REF`,
     `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OREMEDIA_APP` (api | worker-core | worker-ingest | redirector);
   - `api`: `AUTH_ISSUER_URL` (optional, default `https://accounts.google.com`), `AUTH_CLIENT_ID`,
     `AUTH_CLIENT_SECRET` (sealed variable), `AUTH_REDIRECT_URI`, optional `AUTH_ALLOWED_DOMAINS` (section 1a),
     `PORT` (e.g. `3001`), `WEB_ORIGIN` (required in production), optional `PASSWORD_HASH_CONCURRENCY` (password
     hashes run at once, default 4; each needs about 128 MiB, so size the service's memory for 4 × 128 MiB = 512 MiB
     on top of its baseline, or lower it; section 1a step 6), `REVIEW_PORTAL_ORIGIN`, `KMS_KEY_ID_CREDENTIALS`
     (wrap-only permission), `OBJECT_STORE_*`, `LINK_REDIRECT_DOMAIN`, per-provider `PROVIDER_<KEY>_CLIENT_ID_REF` and
     `PROVIDER_<KEY>_SECRET_REF` (sealed; the code exchange needs both, see `docs/platform-apps/`), and per source
     kind `PROVIDER_GA4_PROPERTY_CLIENT_ID_REF` / `PROVIDER_GA4_PROPERTY_SECRET_REF` and
     `PROVIDER_SEARCH_CONSOLE_SITE_CLIENT_ID_REF` / `PROVIDER_SEARCH_CONSOLE_SITE_SECRET_REF` (sealed; one Google
     OAuth client serves both, `docs/platform-apps/google.md`), optional `OREMEDIA_DISABLED_SOURCES`; the Business
     Profile pair `PROVIDER_GBP_LOCATION_CLIENT_ID_REF` / `PROVIDER_GBP_LOCATION_SECRET_REF` with `OREMEDIA_ENABLE_GBP=1`
     only once Google granted the project Business Profile API access (R2-2; off by default);
   - `worker-core`: `DATABASE_URL_RETENTION` (step 5: the retention role's user, used only by the retention sweep);
   - `worker-core`, `worker-ingest`: `KMS_KEY_ID_CREDENTIALS` (decrypt permission), `MODEL_ROUTING_POLICY_REF`,
     `OPENROUTER_API_KEY_REF` and `OREMEDIA_MODEL_ID` (ADR-11; set a monthly credit limit on the key), `IMAGE_GEN_PROVIDER=openrouter` with `OREMEDIA_IMAGE_MODEL_ID` (an OpenRouter image model id) for `images.generate`, `VIDEO_GEN_PROVIDER=openrouter` with `OREMEDIA_VIDEO_MODEL_ID` (an OpenRouter video model id) for `videos.generate` (see the rollout below), `SPEECH_GEN_PROVIDER=openrouter` with `OREMEDIA_SPEECH_MODEL_ID` (an OpenRouter text-to-speech model id) and optional `OREMEDIA_SPEECH_VOICE` for `speech.generate`, `OBJECT_STORE_*`, provider credentials `PROVIDER_<KEY>_CLIENT_ID_REF` and `PROVIDER_<KEY>_SECRET_REF` (token refresh reads both), and on `worker-core` and `worker-ingest` the source pairs `PROVIDER_GA4_PROPERTY_*` and `PROVIDER_SEARCH_CONSOLE_SITE_*` (worker-core's daily destination token refresh and worker-ingest's daily report sweep read both) with optional `OREMEDIA_DISABLED_SOURCES`, and `PROVIDER_GBP_LOCATION_*` with `OREMEDIA_ENABLE_GBP=1` where the Business Profile kind is enabled (R2-2);
   - `worker-render`: `OBJECT_STORE_*` only (no credentials, no model keys);
   - `approval-monitor`: `OREMEDIA_APP=approval-monitor`, `DATABASE_URL` (referenced from the api), sealed
     `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN`. Its **Cron Schedule** is `*/5 * * * *` (UTC,
     every five minutes, as both environments run it) and is set in the service's Railway settings (Settings → Cron
     Schedule): it is not config-as-code, and `infra/railway/approval-monitor/railway.json` deliberately carries no
     `cronSchedule`. Without real Gmail credentials (staging today) every run fails with `invalid_client`: set them
     or remove the schedule there;
   - `web`: `API_INTERNAL_URL` (runtime: the api on the private network, section 1a), `OBJECT_STORE_PUBLIC_ORIGIN`
     (runtime: the object store origin allowed in `font-src` and `connect-src`, section 1b; uploads fail without it), `OREMEDIA_DEPLOYMENT_BRAND`
     (runtime, D-12: the brand pack in `apps/web/deployment-brands`, `ore-and-tar` for this deployment; unset is the
     neutral product brand; the pack also serves the public legal pages at `/legal/*`), `VITE_REVIEW_PORTAL_ORIGIN`
     (build arg). `VITE_API_URL` stays unset: the app calls `/trpc` on its own origin.
     No variable disables SSRF protection; there is no such flag in the hosted product.
5. Apply the database roles from inside the environment (Railway's MySQL is reachable only on the private
   network): add a `db-roles` service from this repository with `OREMEDIA_APP=api`, Dockerfile
   `infra/railway/Dockerfile`, start command `node dist/db-roles-apply.js`, restart policy never and no health
   check, and the variables `DATABASE_URL` (the admin connection, `${{MySQL.MYSQL_URL}}`), `DB_APP_PASSWORD` and
   `DB_RETENTION_PASSWORD` (generated, for example `${{secret(48)}}`; optional `DB_APP_USER` and
   `DB_RETENTION_USER` default to `oremedia_app` and `oremedia_retention`). Each deploy of it creates the users
   when missing, sets their passwords, revokes and re-grants exactly `packages/db/roles/app-role.sql` and
   `retention-role.sql`, then logs the same `PASS`/`FAIL` lines as `pnpm db:roles:check` (section 3b). It waits
   for every table the role names before it grants, so a push carrying a migration can redeploy it alongside the
   api. Then point the application services' `DATABASE_URL` at the application user: a MySQL URL whose user is
   `oremedia_app`, whose password is the reference `${{db-roles.DB_APP_PASSWORD}}`, and whose host and database
   are `${{MySQL.RAILWAY_PRIVATE_DOMAIN}}` and `${{MySQL.MYSQL_DATABASE}}` (nobody types the password); worker-core's
   `DATABASE_URL_RETENTION` names the retention user the same way. Migrations need DDL the application role does
   not hold, so the api (and the approval monitor, which also migrates) keep `DATABASE_URL_MIGRATE` set to the admin
   connection: `migrate.js` uses it for the pre-deploy step only and the running process never reads it. Both SQL
   files are generated
   (`pnpm tsx tooling/scripts/generate-db-roles.ts`); redeploy `db-roles` after a migration that adds tables (the
   app role's grants are per table).
6. Temporal Cloud: create the namespace, upload the client certificate as `TEMPORAL_TLS_CERT_REF`. Self-hosted:
   deploy `infra/railway/temporal` with `MYSQL_SEEDS`, `DB_PORT`, `MYSQL_USER`, `MYSQL_PWD` from the second MySQL.

## 1a. Google sign-in and the single public origin (D-03)

Google authenticates (OpenID Connect, authorization code + PKCE + state + nonce, `apps/api/src/auth`); Oremedia's
policy layer authorises. Values below are never written into the repository; secrets are Railway sealed variables.

1. **One public origin.** Browser cookies must be first-party, and `*.up.railway.app` subdomains are separate sites,
   so the browser only ever talks to the `web` service's domain (a custom domain such as `app.<company>` is
   recommended). The `web` container's Caddy (`infra/railway/web/Caddyfile`) serves the SPA and reverse-proxies
   `/trpc/*`, `/v1/*`, `/mcp`, `/mcp/*`, `/auth/*` and `/health` to the `api` service over Railway's private
   network:
   - `api`: set `PORT` (e.g. `3001`). The API listens on all interfaces, IPv6 included, as the private network
     requires. Remove the `api` service's public domain (Settings → Networking) once `web` proxies to it: REST
     (`/v1`) and MCP (`/mcp`) are reachable through the web domain too.
   - `web`: `API_INTERNAL_URL=http://api.railway.internal:<api PORT>` (the private DNS name Railway shows for the
     `api` service). Unset or wrong, the proxied paths answer 503 and the `web` deploy health check (`/health`,
     proxied to the api) fails.
   - `api`: `WEB_ORIGIN=https://<web domain>`. Same-origin browser calls need no CORS; the value admits
     cross-origin callers from that origin, and it fixes the channel-connect callback: every provider returns to
     `${WEB_ORIGIN}/connect/callback`, the one redirect URI registered with Meta and LinkedIn (spec 14.7). Unset,
     the API uses the redirect the browser sends (development only). The value must be a bare origin (no path or
     trailing slash; https in production) or the api refuses to start. Channels can be connected only from that
     address: a flow started on another hostname of the app (the Railway domain beside a custom one) cannot find its
     brand at the callback, so point people at the WEB_ORIGIN address.
   - Client addresses (audit hashes, the per-address rate limit on `/auth/*`): Caddy trusts `X-Forwarded-For` only
     from private and 100.64.0.0/10 peers and, with `trusted_proxies_strict`, takes the right-most untrusted entry,
     so a value the browser sends is ignored **if Railway's edge appends** the client address to an incoming
     `X-Forwarded-For`. Verify this once per environment before relying on per-address limits: send
     `curl -H 'X-Forwarded-For: 203.0.113.7' https://<web domain>/health` and check the api request log /
     `auth_events.ip_hash` does not follow the header (compare with a request without it). If Railway overwrites
     instead of appending, the result is the same; if it passes the header through unchanged and puts the client
     elsewhere, adjust `header_up X-Forwarded-For` in the Caddyfile to that source.
2. **Google Cloud Console** (the Google Workspace or Cloud project that owns sign-in): APIs & Services → OAuth
   consent screen: user type **Internal** when every user is in your Workspace (otherwise External, published),
   scopes `openid`, `email`, `profile` only. Credentials → Create credentials → OAuth client ID → **Web
   application**; Authorised redirect URI: `https://<web domain>/auth/google/callback` (exactly; one per
   environment). No JavaScript origins are needed (the browser never calls Google from script).
3. **Variables on `api`:** `AUTH_CLIENT_ID` (the client ID), `AUTH_CLIENT_SECRET` (the client secret, **sealed**),
   `AUTH_REDIRECT_URI=https://<web domain>/auth/google/callback` (the same string as in step 2),
   `AUTH_ISSUER_URL` only to override the default `https://accounts.google.com`.
   **Strongly recommended:** `AUTH_ALLOWED_DOMAINS=company.com,subsidiary.com`: only Google Workspace accounts whose
   `hd` claim is listed may sign in (consumer Gmail accounts have no `hd` and are refused). It is optional so that
   Gmail users can be invited, but without it any Google account may attempt sign-in (and is then refused unless
   invited). Either way, the first link of a Google account to an existing user, an invitation or the bootstrap
   owner requires Google to be authoritative for the address: the account's `hd` equals the email's domain, or
   the address is `@gmail.com` / `@googlemail.com`. A personal Google account created on a company address is
   refused ("Use your organisation's Google account", reason `email_not_authoritative`), so invite company people
   by their Workspace address and make sure that domain is a Google Workspace domain. In production the api refuses to start (exit 2,
   the log names the variable) when `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` or `AUTH_REDIRECT_URI` is missing or an
   issuer/redirect URL is not https.
4. **Second factor.** Oremedia does not see whether Google asked for a second factor (`users.mfa_enrolled` stays
   false; see DECISIONS.md D-03). Enforce 2-Step Verification in the Google Workspace admin console (Security →
   Authentication → 2-Step Verification → Enforcement: On) for the organisational units that use Oremedia, and set
   `AUTH_ALLOWED_DOMAINS` so only those Workspace accounts can sign in. Do not enable `mfaRequired` in a brand
   policy: no Google-authenticated user satisfies it, so review decisions under that policy would be refused.
5. **Sessions.** A successful sign-in sets `__Host-oremedia_session` (opaque, HttpOnly, Secure, SameSite=Lax,
   Path=/, no Domain; only its SHA-256 is stored) and `__Host-oremedia_csrf` (the double-submit value the app
   echoes in `X-Oremedia-CSRF`). In production only the `__Host-` names are read, so a sibling subdomain cannot
   plant a session. A session ends after 12 hours idle or 7 days after sign-in, on Sign out, on a role change, or
   when the person signs in again in the same browser. Sign-in outcomes (success and every refusal reason,
   including `internal_error`) are in `auth_events`. `/auth/*` is rate-limited per client address (30 per minute
   per route, the same limiter and Redis store as the API); over the limit it answers 429 and records nothing.
   Signing out inside a support session (`sup_` bearer) closes that support session.
6. **Password sign-in (second method).** A person can also sign in with their email address and a password, next to
   (not instead of) Google. Nothing to configure beyond the variables above, but **`WEB_ORIGIN` is required in
   production** (the api refuses to start without it: exit 2, log "web origin configuration invalid"): `POST /auth/password/sign-in` and `POST /auth/password/setup` accept a request only when its
   `Origin` header equals `WEB_ORIGIN` (login CSRF defence; unset, the request's own host is compared, which is for
   development), and the one-time setup links an owner or admin issues are `${WEB_ORIGIN}/set-password#token=…`
   (unset, a relative link the Members screen completes with its own address). `AUTH_ALLOWED_DOMAINS` applies to
   the email domain of password sign-ins too, with or without Google configured.
   - **Setting a password:** there is no mailer. An owner or admin opens Settings → Members → **Password link** for
     a member and hands the link over directly (it is shown once; only its SHA-256 is stored, the token is in the
     URL fragment so it never reaches a log, and the response is not kept for idempotent replay: a retry issues a
     new link, which replaces the old one). A link works once, for 72 hours; issuing another replaces it; it also
     serves as the password reset. It is refused for yourself (your own row points to Settings → Account), for an
     owner or admin unless an owner issues it, and for a person who also belongs to another company. Redeeming one
     ends every other session of that person.
   - **Link passwords stay in one company.** Whoever held the link chose that password (possibly the admin who
     issued it), so it is recorded as `setup_link` (`users.password_origin`) until the person changes it
     themselves. Signing in with it never accepts invitations to other companies, and the moment the person becomes
     an active member of a second company (accepting an invitation with Google, or becoming a new company's
     owner) it is removed and all their sessions end; they sign in with Google or set their own password.
   - **Own password:** a signed-in person sets, changes or removes their password in Settings → Account. A first
     password needs a sign-in from the last 15 minutes; a change or a removal needs the current password; removal is
     offered only while Google is linked. A change ends their other sessions.
   - **Storage and limits:** passwords are 12 to 128 characters with no composition rules, stored only as salted
     scrypt hashes (N=2^17, r=8, p=1) in `users.password_hash`. Every failed sign-in answers the same
     `invalid_credentials` (an unknown address costs the same scrypt as a real one). Besides the per-address limit
     (20 sign-ins and 10 setups per minute), **ten password attempts for one email address within fifteen minutes
     without a success lock password sign-in for that address for the rest of the fifteen minutes** (429,
     `Retry-After`). Anyone who knows the address can trigger this; Google sign-in still works for that person
     meanwhile. Attempts are counted before they are checked, so concurrent guesses cannot exceed the limit, and a
     successful sign-in clears the count; the counter lives in the rate limiter's store (Redis in production, so it
     holds across api instances). The same count guards the current-password check in Settings → Account (per
     person). At most `PASSWORD_HASH_CONCURRENCY` hashes run at once (about 128 MiB each) and 64 more wait; beyond
     that a password request answers 503 with `Retry-After` (the app says the server is busy). Outcomes are in
     `auth_events` with provider `password` (`auth.sign_in`, `auth.password_setup`, `auth.password_set`,
     `auth.password_remove`); issuing and redeeming a link are also in the company's audit trail.
   - **Migration:** 0013 adds `password_setup_tokens` and `users.password_origin` (applied by the api's pre-deploy command); the application
     database role needs its grants (`packages/db/roles/app-role.sql`, regenerated).

### First owner (once per new company)

There is no self-sign-up: every person is either the owner created here or invited by an owner.

1. Deploy the api (migrations applied by its pre-deploy command, including 0003).
2. Open a shell on the running api service (Railway CLI: `railway ssh --service api`, or the service's shell in the
   dashboard) and run, with the owner's real Google address:
   `node dist/bootstrap-owner.js --email owner@company.com --name "Owner Name" --company "Company Name" --slug company-name`
   It creates an active user for that email (or reuses an active one), the company and the owner membership
   (`accessService.bootstrapOwner` → `createTenantWithOwner`, one transaction: nothing is left behind on failure),
   audits `tenant.bootstrap` in the new company and prints the company id. It refuses a slug that exists and a
   disabled user. Use the owner's Google Workspace address (or a Gmail address): see step 3 of section 1a.
3. The owner opens `https://<web domain>/sign-in` and chooses **Continue with Google** with that same Google
   account. The verified email matches the user created in step 2, so the Google identity is linked to it
   (`auth.identity_link`); from then on the person is recognised by Google's stable subject, not the email.
4. The owner invites everyone else from the company's settings (`access.members.invite`). An invited person signs
   in with Google using the invited address; the invitation is accepted on that first sign-in. Anyone else sees
   "This Google account has not been invited".

## 1b. Brand fonts: Google Fonts egress and the font CSP

The brand kit imports font families from Google Fonts (`assets.fonts.importGoogle`, in the `api` request) and
shows previews of the brand's own font files in the browser.

1. **Egress from `api`:** HTTPS (443) to `fonts.googleapis.com` (the css2 stylesheet) and `fonts.gstatic.com` (the
   WOFF2 files). No other host is contacted: a stylesheet naming any other source is refused, redirects are not
   followed, and every request goes through the SSRF-safe dispatcher. If egress is filtered, allow exactly these two
   hosts; blocked, an import fails with `PROVIDER_UNAVAILABLE` and nothing is written. Nothing about the person or
   the company is sent: the request carries the family, weights and styles, and a desktop browser User-Agent so
   Google lists WOFF2 files.
2. **`web`:** set `OBJECT_STORE_PUBLIC_ORIGIN` to the object store's origin as its signed URLs carry it (scheme and
   host only, e.g. `https://<account>.r2.cloudflarestorage.com`). The Caddyfile adds it to `font-src` (the brand kit
   and studio load font files from signed URLs) and to `connect-src` (the web app uploads files by PUT to a signed
   upload URL). Unset, the CSP blocks both: every upload from the web app fails, and font previews fall back to the
   system font (exports are unaffected, the render worker never uses the CSP).
3. **Verify:** in a brand kit draft, Typography → Import from Google Fonts → `Inter`, weights 400 and 700; the
   banner reports four files importing and, after ingest, the list shows Inter 400 and 700 from Google Fonts. Assign
   one to Body: the preview line is drawn in Inter (no CSP violation in the browser console).

## 1c. Configuration report: what each service can do with its variables

Every Node service checks, at start, the settings each of its **capabilities** needs, using the names the code that
reads them uses (so the report and the code cannot disagree). A missing setting does **not** stop the service:
production keeps running with that capability degraded, and the gap is reported.

| Capability      | Settings it needs (names only)                                                                                                                                                                                                                                                                              | Checked on                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `uploads`       | `OBJECT_STORE_BUCKET_ASSETS`, `OBJECT_STORE_BUCKET_RELEASES`, `OBJECT_STORE_ENDPOINT` (or `OBJECT_STORE_REGION`), `OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY`                                                                                                                            | api, worker-core, worker-render |
| `channel:<key>` | `PROVIDER_<KEY>_CLIENT_ID_REF` and `PROVIDER_<KEY>_SECRET_REF`, for every registered provider (`linkedin_page`, `instagram_business`, `facebook_page`, `x`), unless the provider key is explicitly listed in comma-separated `OREMEDIA_DISABLED_CHANNELS` on that service                                   | api, worker-core, worker-ingest |
| `source:<kind>` | `PROVIDER_<KIND>_CLIENT_ID_REF` and `PROVIDER_<KIND>_SECRET_REF`, for every registered source adapter (`ga4_property`, `search_console_site`; `gbp_location` only where `OREMEDIA_ENABLE_GBP=1`, R2-2), unless the kind is explicitly listed in comma-separated `OREMEDIA_DISABLED_SOURCES` on that service | api, worker-core, worker-ingest |
| `cms:<vendor>`  | Nothing: a website (`cms_site`, R2-3) is connected per brand with its own integration identity, sealed by the broker. The line reports the registered adapter (`cms:wordpress`) unless `cms_site` is listed in `OREMEDIA_DISABLED_SOURCES` on that service                                                  | api, worker-core, worker-ingest |
| `models`        | `OPENROUTER_API_KEY_REF` with `OREMEDIA_MODEL_ID` (or `MODEL_ROUTING_POLICY_REF`); or `ANTHROPIC_API_KEY_REF`                                                                                                                                                                                               | worker-core, worker-ingest      |
| `web_origin`    | `WEB_ORIGIN`                                                                                                                                                                                                                                                                                                | api                             |

- `uploads` on the api signs upload and download URLs; on worker-core it copies media for publishing and deletes
  objects; on worker-render it ingests uploads and writes renders. `channel:<key>` on the api connects channels; on
  worker-core it publishes and refreshes tokens; on worker-ingest it refreshes tokens and pulls metrics and comments.
  `models` on worker-core runs agents and generators; on worker-ingest it classifies comments. `source:<kind>` on
  the api connects destinations (R2-1); on worker-core it refreshes their tokens daily; on worker-ingest it reads
  their GA4, Search Console and (where enabled) Business Profile reports daily (the `destination-report-sweep` schedule, 04:00 UTC, created by
  worker-ingest at start on task queue `ingest-metrics`, overlap skipped; one child per destination per day, so a
  rerun of a day is refused by its workflow id, and a quota 429 leaves the destination `degraded` until the next
  day's run catches up from the last stored day). `cms:<vendor>` on the api connects websites (the secret is sealed
  there, never opened); on worker-core it verifies the secret (`destinationVerifyWorkflowV1`) and publishes articles
  on `publish-cms_site`; on worker-ingest the technical SEO audit (R2-4) crawls each website's public pages weekly
  (the `seo-audit-sweep` schedule, Mondays 05:00 UTC, created by worker-ingest at start on `ingest-metrics`, overlap
  skipped; one child per website per ISO week; 200 pages, depth 3, 20 min, ≥ 250 ms between fetches, 2 MiB per page;
  only under a `cms.audit` source-use policy allowing reads; docs/contracts/seo-audit.md) and an admin or publisher
  can run one from the Performance screen (once per website per day); the adapter is uncertified (`certifiedAt: null`, D-16) until its read-back tests ran on the
  pilot site, so tenants are refused the connect until then.
- The `web` service (Caddy) has no report: its `OBJECT_STORE_PUBLIC_ORIGIN` is checked by the production smoke check
  (section 3a) through the CSP it serves. The `redirector` has none either: both its settings (`DATABASE_URL`,
  `LINK_HASH_SECRET_REF`) already stop it at start when missing.
- **Reading the startup line.** Each service logs exactly one line at start. Configured: level `info`,
  `configuration complete: every capability is configured`. Otherwise level `error`,
  `configuration incomplete: capabilities degraded; running without them`, with `degraded` (the capability names) and
  `missingSettings` (per capability, the setting names to set). Values are never logged. Set the named variables on
  that service and redeploy it; the line turns `info`.
- **Health.** The api's `/health` (and each worker's `/health`) answers `{ "ok": true, "degraded": [...] }` with the
  capability names only (no setting name, no value; `/health` is public through the web origin). It stays 200 while
  degraded, so Railway's health check still passes; the smoke check (section 3a) fails on a non-empty list. The
  capability names (for example `uploads`, `channel:x`) are therefore publicly visible to anyone who requests
  `/health`; no setting name or value ever is.
- **Strict mode (off by default).** `OREMEDIA_CONFIG_STRICT=1` on a service makes a degraded capability fatal: the
  same line says `refusing to start` and the process exits 2 (the deploy's health check then fails). Only the exact
  value `1` turns it on. Turn it on per service once that service's report is clean, so a later deploy that loses a
  variable fails instead of running degraded.
- **Activation state per provider (RA-01).** `operations.providers.list` (owners and admins; Settings → Channels
  and Settings → Destinations) reports every registered channel, source and CMS adapter with `certifiedAt`, whether
  it is disabled on this service's configuration, which `PROVIDER_<KEY>_*` references are set (names only) and the
  derived state `uncertified` / `disabled` / `credentials_missing` / `ready`; the connect flows refuse anything but
  `ready` with the same reason.
- **Intentionally unsupported channels.** `OREMEDIA_DISABLED_CHANNELS` is an explicit deployment policy for a
  provider that is registered in the product but not part of the current production rollout (for example, `x` while
  its app credentials and certification are unavailable). It defaults to empty, so omitting the variable does not hide
  a missing provider configuration. Set it only on the api, worker-core and worker-ingest services, and remove the key
  before enabling that channel; this does not certify or connect the provider. `OREMEDIA_DISABLED_SOURCES` is the
  same policy for a source kind (R2-1), set on the api and worker-core. The Business Profile kind (`gbp_location`,
  R2-2) is the other way round: off unless `OREMEDIA_ENABLE_GBP=1` is set beside its pair on the api, worker-core and
  worker-ingest, because Google grants its API access per project after an application
  (`docs/platform-apps/google.md`); omitting the flag never reads as a missing configuration.

## 2. Deploy

Railway builds each service from the Dockerfile on push to the configured branch. The `api` service runs
`node dist/migrate.js && node dist/seed-builtin-skills.js` as its pre-deploy command (expand/contract migrations,
forward-safe; then the Release 1 built-in skill packages are registered as platform skills, idempotent by key).
Workers deploy after the API. `worker-ingest` (metric collection, listening, CRM) and `redirector` are provisioned
with Phase 6 and Phase 5 respectively; until their apps exist their `railway.json` files must not be deployed. Artifacts are built once per commit and promoted by environment, never rebuilt per environment.

Rollout order for a change touching workflows: deploy workers with the new workflow version first (old versions
stay registered until in-flight histories drain), then the API that starts the new version.

Rollout order for worker-rendered proposal previews (migration 0002, flag `creative.preview_render`, default off):
a render worker built before previews treats a preview job as an ordinary job, renders the committed base revision
and writes publishable `rendered_exports`. The flag keeps the API from creating preview jobs until every render
worker understands them:

1. Apply migration 0002 (`node dist/migrate.js`, the api pre-deploy command, or run it on its own first): the
   preview-aware `worker-render` reads `render_previews` for every job, so it must not start on the old schema.
   Re-apply `app-role.sql` (step 5): the new tables need their grants.
2. Deploy `worker-render` on the preview-aware build and wait until no instance of the previous build is running
   (Railway → worker-render → Deployments shows only the new one; worker logs show `worker started` from it).
3. Deploy the API (and the other workers) as usual. With the flag still off, `operations.propose` with
   `previewRender` returns the scene preview only and queues nothing.
4. Enable `creative.preview_render` with `operations.flags.set` ([feature flags](feature-flags.md): one tenant first, then global). To roll back
   `worker-render` to a build without previews, disable the flag first and let queued preview jobs finish.

Rollout order for video generation (migration 0007, flag `creative.video_generation`, default off; ADR-11, ledger 4.25):

1. Apply migration 0007 (adds `video_generation` to `usage_ledger.kind`; an enum value appended at the end, so
   MySQL changes only metadata) with the api pre-deploy command. It must precede the workers: a video charge written
   against the old enum fails.
2. Confirm the clamav service's stream limit (`StreamMaxLength`, clamd's documented default 25 MB) covers the clips
   the chosen model produces at its longest duration; a clip above it fails the scan and stays quarantined. Raise it
   on the clamav service first if needed.
3. Set `VIDEO_GEN_PROVIDER=openrouter` and `OREMEDIA_VIDEO_MODEL_ID` on `worker-core` and deploy it.
4. Enable `creative.video_generation` with `operations.flags.set` ([feature flags](feature-flags.md): one tenant first, then global). A skill
   that should generate video lists both `videos.generate` and `videos.status` in its allowed tools. Turning the
   flag off stops new generations; `videos.status` still collects clips already paid for.

Rollout order for speech generation (migration 0008, flag `creative.audio_generation`, default off; ADR-11, ledger
4.26): apply migration 0008 (adds `audio_generation` to `usage_ledger.kind`, appended, metadata only) before the
workers; set `SPEECH_GEN_PROVIDER`, `OREMEDIA_SPEECH_MODEL_ID` and, if the model needs one, `OREMEDIA_SPEECH_VOICE` on
`worker-core` and deploy it; then enable the flag per tenant with `operations.flags.set` ([feature flags](feature-flags.md)). A skill that should narrate lists `speech.generate`.

Rollout order for video and audio uploads (migration 0026, STU-2a; no flag: a person's video or audio upload is
accepted as soon as the API is on the new build):

1. Apply migration 0026 (additive: nullable `asset_versions.media_info`, `upload_intents.rejection_detail`,
   `render_jobs.progress`, `rendered_exports.duration_ms`/`fps`/`poster_storage_key`/`captions_storage_key`, and
   `cancelled` appended to `render_jobs.state`, metadata only) with the api pre-deploy command.
2. Before the merge that ships this (the api deploys on merge and accepts video at once), raise the clamav service's
   `StreamMaxLength`, `MaxScanSize` and `MaxFileSize` to 1100M: point the service at this repository with config
   file `infra/railway/clamav/railway.json` (the official image plus the raised limits; the build fails if clamd's
   config file moves), in staging first, then production. Video uploads are up to 1 GiB and are streamed to clamd;
   below the limit clamd gives no verdict and the upload stays quarantined (`scanner_unavailable`, the detail names
   `StreamMaxLength`).
3. Deploy `worker-render` on the new image (ffmpeg in the image, task queue `video` polled; `VIDEO_CONCURRENCY`
   default 1; resources in infra/railway/README.md). In production a container without ffmpeg/ffprobe refuses to
   start (`refusing to start (task queue video)` in its log), so a broken image fails its deploy. Check the start
   line names all three queues: `worker-render polling task queues render, media, video`.
   The reviewer's captions track is fetched by the browser (then played from a blob URL): the assets bucket's CORS
   rules must allow GET from the web origin, as they already allow the browser's upload PUT. Without that rule the
   video still plays, without captions.
4. Deploy the API and the other workers as usual. Upload completions now carry the intent's kind and video/audio
   ones start `videoIngestWorkflowV1` on `video`; image, font and PDF uploads keep `assetIngestWorkflowV1` on `media`.
   Rolling back the API leaves person video/audio intents refused again; workflows already started on `video` finish
   on worker-render, which must stay on the new build until they drain.

Rollout order for plan items (migration 0014, UX-09): apply 0014 (`plan_items`, additive; the api pre-deploy
command does it) and re-apply `app-role.sql` (the new table needs its grants); then deploy the api and workers in
the usual order. The built-in `campaign-planning` skill gains `content.proposePlan` and an optional `briefId`
input, so the seed registers a new draft version of it on deploy: a person evaluates and publishes that version
(Settings → Skills) before planning runs record their calendar; until then runs use the published version, which
returns the calendar as output only. Rolling the api back leaves the table in place, unused.

Rollout order for Google sign-in (migration 0003, D-03):

1. Apply migration 0003 (`external_identities`, `auth_events`; additive) with the api pre-deploy command and
   re-apply `app-role.sql` (step 5: the new tables need their grants).
2. Set the section 1a variables on `api` and deploy it. Its `/auth/*` routes exist from this deploy.
3. Set `API_INTERNAL_URL` on `web` and deploy it; from then on the browser reaches the api through the web origin.
   Rolling `web` back restores the static-only container (no proxy): the app then cannot reach the api, so roll back
   `web` only together with a plan for how the browser reaches the api.
4. Expect sign-outs on this deploy: the 12-hour idle limit applies to existing rows too, so any session with
   `last_seen_at` NULL and `created_at` older than 12 hours (tokens issued before this release) stops working at
   once, and its user signs in again (with Google). Pasted development tokens older than 12 hours stop as well.

## 3. Verify

1. `GET https://<web domain>/health` returns `{ "ok": true, "degraded": [] }` (served by the api through the web
   proxy); a non-empty `degraded` names what is not configured (section 1c).
2. `https://<web domain>/sign-in` → **Continue with Google** returns to the portfolio signed in; an account that
   was not invited returns to the sign-in page with "This Google account has not been invited".
3. Worker logs show `worker started` for every task queue.
4. Dashboards: outbox oldest-undispatched age < 60 s; dispatch lateness p99 < 60 s; no `outcome_unknown` growth.

## 3a. Production smoke check

`pnpm smoke:prod` checks a deployed environment from outside, through the web origin as a browser reaches it, and
prints one line per check (`PASS`, `FAIL` or `SKIP` with a detail); it exits 1 when any check fails. It prints no
password, no session token and no signed URL query string.

| Check                                  | Passes when                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                               | `GET /health` is 200 with `ok` and an empty `degraded` (section 1c)                                                                                                                                                                                                                                                                                                    |
| `csp`                                  | the page's CSP admits the object store origin in `connect-src` and `font-src` (exactly `SMOKE_EXPECT_STORE_ORIGIN` if set)                                                                                                                                                                                                                                             |
| `legal:privacy`, `legal:data-deletion` | `/legal/privacy` and `/legal/data-deletion` answer 200 HTML                                                                                                                                                                                                                                                                                                            |
| `brand.json`                           | `/deployment-brand/brand.json` is a pack the web app accepts                                                                                                                                                                                                                                                                                                           |
| `upload:*`                             | with the smoke user's credentials: sign in, upload intent, the CSP admits the signed URL's origin, the store answers the CORS preflight for the web origin (bucket CORS), PUT a small PNG, complete, then ingest accepts it (`assets.uploads.get`) within `SMOKE_INGEST_TIMEOUT_MS` (default 120 s), and `upload:cleanup` retires the accepted asset (`assets.retire`) |

The upload stops at the first failing step and names it (`upload:cors` means the R2 bucket's CORS policy must allow
`PUT` and `GET` from the web origin with the `content-type` header). It signs the smoke user out at the end. The
upload uses a person's password sign-in, not a REST API key: an API key acts as a service principal, which may only
propose uploads (`asset.upload` is propose-only for agents), so `assets.uploads.createIntent` refuses it.

**Run it by hand:** `SMOKE_BASE_URL=https://<web domain> pnpm smoke:prod` (add the variables below for the upload).

**Scheduled run:** `.github/workflows/smoke.yml` runs every 6 hours and on demand (Actions → Production smoke check
→ Run workflow). It never runs on pull requests. It reads these repository secrets (Settings → Secrets and variables
→ Actions → New repository secret):

| Secret                      | Value                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `SMOKE_BASE_URL`            | the web origin, exactly `WEB_ORIGIN` (required)                                             |
| `SMOKE_EXPECT_STORE_ORIGIN` | optional: the object store origin, as set in the web service's `OBJECT_STORE_PUBLIC_ORIGIN` |
| `SMOKE_EMAIL`               | optional (all four or no upload): the smoke user's email address                            |
| `SMOKE_PASSWORD`            | the smoke user's password                                                                   |
| `SMOKE_TENANT_ID`           | the smoke company's id (`ten_…`)                                                            |
| `SMOKE_BRAND_ID`            | the smoke brand's id (`brd_…`)                                                              |

**Creating the smoke company, brand and user (the owner does this; the credentials go straight into the secrets and
pass through no one else):**

1. Create a dedicated company with the owner's own account as its owner (section "First owner", with
   `--company "Oremedia smoke" --slug oremedia-smoke`); note the company id it prints (`SMOKE_TENANT_ID`).
2. Sign in as that owner, switch to the smoke company and create one brand, `Smoke`; its id is in the address bar
   (`/c/<company>/b/<brand>/…`, `SMOKE_BRAND_ID`). This company and brand are dedicated and throwaway: uploads land
   only here, and each run retires the image it uploaded (retired assets leave the library, though their rows and stored files remain, one small PNG per run).
3. Invite a dedicated address in an allowed domain (`AUTH_ALLOWED_DOMAINS`), e.g. `oremedia-smoke@<domain>`, with the
   **brand manager** role (it uploads and retires its own smoke image, which needs the asset approve permission; the
   smoke company has no channels, so it can publish nothing), then Settings → Members → **Password link** for it.
   Open the link yourself and choose a long random password (a password manager); this link password stays in the
   smoke company only (section 1a step 6). Never reuse it anywhere.
4. Put the address and password into `SMOKE_EMAIL` and `SMOKE_PASSWORD`, and the two ids into their secrets. Run the
   workflow once by hand and read its log.
5. To rotate: issue a new Password link for the smoke user, set a new password and update `SMOKE_PASSWORD`. To stop
   the upload check, delete `SMOKE_PASSWORD`; to stop the workflow, disable it in the Actions tab.

## 3b. Staging smoke check and the database-role check

The same workflow has a **Smoke check against staging** job that runs `pnpm smoke:prod` with the `STAGING_SMOKE_*`
secrets (the six above, prefixed) once the repository variable `STAGING_SMOKE_ENABLED` is `1`; the eight UAT
journeys it stands in front of are in `uat-journeys.md`.

`pnpm db:roles:check` (R1-G, D-25) proves which user each connection runs as and whether it holds exactly the
generated grants: run locally through the Railway CLI with the service's variables injected (`railway link` to
the environment and api service, then `railway run pnpm db:roles:check`; the deployed images carry no tooling), it
reads `DATABASE_URL` and, when set, `DATABASE_URL_RETENTION`, runs only `SELECT CURRENT_USER()` and `SHOW GRANTS`
(roles expanded), prints one line per finding and no credential, and exits 1 on root, on a database-wide or
wildcard privilege, on GRANT OPTION, on a missing grant or on one beyond the role. The `db-roles` service of
section 1 step 5 logs the same lines after it applies the roles (`db-roles-apply`), so its deploy log is the
in-environment form of this check: read it after step 5 on staging, then on production, and paste the lines into
`docs/release/r1-evidence.md`.

## 4. Rollback

- Railway → service → Deployments → **Redeploy** the previous build (seconds). Schema changes are forward-safe,
  so the previous build runs against the new schema.
- Feature flags are default-off; a misbehaving capability is disabled by flag before any redeploy.
- Kill switches (`operations.killSwitch.set`): `agent_starts` stops new agent runs; `release_dispatch` holds all
  publications at dispatch. Both are per tenant or per brand and audited.
- Public posts cannot be rolled back by reverting code; removal is a separate authorised action.
