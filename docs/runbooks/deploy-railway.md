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
     `PROVIDER_<KEY>_SECRET_REF` (sealed; the code exchange needs both, see `docs/platform-apps/`);
   - `worker-core`: `DATABASE_URL_RETENTION` (step 5: the retention role's user, used only by the retention sweep);
   - `worker-core`, `worker-ingest`: `KMS_KEY_ID_CREDENTIALS` (decrypt permission), `MODEL_ROUTING_POLICY_REF`,
     `OPENROUTER_API_KEY_REF` and `OREMEDIA_MODEL_ID` (ADR-11; set a monthly credit limit on the key), `IMAGE_GEN_PROVIDER=openrouter` with `OREMEDIA_IMAGE_MODEL_ID` (an OpenRouter image model id) for `images.generate`, `VIDEO_GEN_PROVIDER=openrouter` with `OREMEDIA_VIDEO_MODEL_ID` (an OpenRouter video model id) for `videos.generate` (see the rollout below), `SPEECH_GEN_PROVIDER=openrouter` with `OREMEDIA_SPEECH_MODEL_ID` (an OpenRouter text-to-speech model id) and optional `OREMEDIA_SPEECH_VOICE` for `speech.generate`, `OBJECT_STORE_*`, provider credentials `PROVIDER_<KEY>_CLIENT_ID_REF` and `PROVIDER_<KEY>_SECRET_REF` (token refresh reads both);
   - `worker-render`: `OBJECT_STORE_*` only (no credentials, no model keys);
   - `web`: `API_INTERNAL_URL` (runtime: the api on the private network, section 1a), `OBJECT_STORE_PUBLIC_ORIGIN`
     (runtime: the object store origin allowed in `font-src` and `connect-src`, section 1b; uploads fail without it), `OREMEDIA_DEPLOYMENT_BRAND`
     (runtime, D-12: the brand pack in `apps/web/deployment-brands`, `ore-and-tar` for this deployment; unset is the
     neutral product brand; the pack also serves the public legal pages at `/legal/*`), `VITE_REVIEW_PORTAL_ORIGIN`
     (build arg). `VITE_API_URL` stays unset: the app calls `/trpc` on its own origin.
     No variable disables SSRF protection; there is no such flag in the hosted product.
5. Apply the application DB role: replace the placeholders in `packages/db/roles/app-role.sql` and run it as the
   MySQL admin; point `DATABASE_URL` at that user. Apply the retention role the same way with
   `packages/db/roles/retention-role.sql` (a second user, its own password in the secret store) and point
   worker-core's `DATABASE_URL_RETENTION` at it. Both files are generated (`pnpm tsx tooling/scripts/generate-db-roles.ts`)
   and must be re-applied after a migration that adds tables (the app role's grants are per table).
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
4. Enable `creative.preview_render` (feature_flags row: tenant allowlist first, then `enabled_default`). To roll back
   `worker-render` to a build without previews, disable the flag first and let queued preview jobs finish.

Rollout order for video generation (migration 0007, flag `creative.video_generation`, default off; ADR-11, ledger 4.25):

1. Apply migration 0007 (adds `video_generation` to `usage_ledger.kind`; an enum value appended at the end, so
   MySQL changes only metadata) with the api pre-deploy command. It must precede the workers: a video charge written
   against the old enum fails.
2. Confirm the clamav service's stream limit (`StreamMaxLength`, clamd's documented default 25 MB) covers the clips
   the chosen model produces at its longest duration; a clip above it fails the scan and stays quarantined. Raise it
   on the clamav service first if needed.
3. Set `VIDEO_GEN_PROVIDER=openrouter` and `OREMEDIA_VIDEO_MODEL_ID` on `worker-core` and deploy it.
4. Enable `creative.video_generation` (feature_flags row: tenant allowlist first, then `enabled_default`). A skill
   that should generate video lists both `videos.generate` and `videos.status` in its allowed tools. Turning the
   flag off stops new generations; `videos.status` still collects clips already paid for.

Rollout order for speech generation (migration 0008, flag `creative.audio_generation`, default off; ADR-11, ledger
4.26): apply migration 0008 (adds `audio_generation` to `usage_ledger.kind`, appended, metadata only) before the
workers; set `SPEECH_GEN_PROVIDER`, `OREMEDIA_SPEECH_MODEL_ID` and, if the model needs one, `OREMEDIA_SPEECH_VOICE` on
`worker-core` and deploy it; then enable the flag per tenant. A skill that should narrate lists `speech.generate`.

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

1. `GET https://<web domain>/health` returns `{ ok: true }` (served by the api through the web proxy).
2. `https://<web domain>/sign-in` → **Continue with Google** returns to the portfolio signed in; an account that
   was not invited returns to the sign-in page with "This Google account has not been invited".
3. Worker logs show `worker started` for every task queue.
4. Dashboards: outbox oldest-undispatched age < 60 s; dispatch lateness p99 < 60 s; no `outcome_unknown` growth.

## 4. Rollback

- Railway → service → Deployments → **Redeploy** the previous build (seconds). Schema changes are forward-safe,
  so the previous build runs against the new schema.
- Feature flags are default-off; a misbehaving capability is disabled by flag before any redeploy.
- Kill switches (`operations.killSwitch.set`): `agent_starts` stops new agent runs; `release_dispatch` holds all
  publications at dispatch. Both are per tenant or per brand and audited.
- Public posts cannot be rolled back by reverting code; removal is a separate authorised action.
