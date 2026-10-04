# Completion report: end-to-end build completion, verification and Railway release

Owner-facing close of the 2 October 2026 completion mandate. Every statement below comes from evidence already
written down in the repository, chiefly `docs/release/completion-ledger.md`. Where the ledger does not state
something, this report says "not recorded". The four verification states are kept apart throughout: implemented
means the code is on `main`; tested means unit, integration or CI coverage; deployed means the commit runs on
Railway production with a passing smoke run; externally verified means real-world evidence against a real account,
site or provider.

## 1. Summary

Production runs `main` at `aa2c5d8` (4 October 2026), confirmed by production smoke run 73 and green main CI on
that commit; all 14 production services are healthy and the schema is at migration 0029. Since the remediation
release of 2 October (RA-01 to RA-14, PRs #32 to #45, recorded below and in ledger sections 2 and 4), PRs #46 to #78
added and released the Brand System guidance model, SVG logos, the facts workspace and AI-assisted Brand System
setup; the template-led Studio with AI generation, scoped refinement and show/hide; video and audio media, the video
timeline editor with an ffmpeg compositor and AI storyboard and recut; team roles, member disable and a sole-owner
guard; campaign edit and close and document archive; an operator-only feature flag setter; Temporal schedule
reconciliation; and the security review fixes (regex backtracking, upload pinning under ingest, SVG CSS gaps,
clamd limit alerts, one-hop proxy trust, AI-boundary budget and untrusted-text controls, access hardening). Every one
of them is tested and deployed with a passing production smoke run; ledger section 5 lists each PR, its merge
commit, migration and smoke run.

What is not established: no channel, source or CMS provider is certified, so production publishes to no real
channel and reads no real source until the platform apps are approved and each adapter is certified with real
accounts. No production model run is recorded. Staging acceptance passes 94 of 96 counted checks: the staging object
store is still a placeholder (owner action), and AI-assisted Brand System setup on staging ends with
`model_routing_denied` (being root-caused; see ledger section 5). The copywriting model evaluation on staging still
grades below the bar on the injection-reporting rubric. One production incident was found: on 4 October `temporal-db`
ran out of connections for about ten minutes, stalling workflow starts and costing one Temporal backup point
(residual risk R19). Railway has no alert destination, so such incidents reach nobody until the owner provides one.

## 2. Capability matrix

Production commit for every row: `aa2c5d8`, every production service deployed SUCCESS, production smoke run 73. The
deployed column names the run that first confirmed the row's most recent PR.

| Capability area                          | Implemented                                                                                                                                                                                           | Tested                                                                                                                                | Deployed                                                                     | Externally verified                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content planning and calendar            | Packages, scheduling and plan items #3 #4 #6; structured forms RA-07 #34; campaign edit and close #73                                                                                                 | Unit, integration and e2e suites in CI; team and campaign journeys in `shell.e2e`                                                     | Smoke 72 (#73)                                                               | Staging browser journeys for sign-in, portfolio, brand home and navigation pass. Scheduling to a channel: none, needs a certified channel                                                    |
| Publishing per channel provider          | Facebook Page, Instagram Business, LinkedIn Page and X adapters; certification harness, activation state, channel health and remote revoke RA-01 #39                                                  | Harness against fixture adapters in CI                                                                                                | Smoke 34 onward                                                              | None. Every adapter has `certifiedAt: null`; Meta Business Verification and App Review, LinkedIn Community Management API; X disabled (D-04)                                                 |
| CMS destinations                         | WordPress REST adapter and article lifecycle #19 #35; rich article authoring #38; markup regexes linear-time #64 #72                                                                                  | Fixture adapter tests; linear-time growth tests for every sanitiser and markup pattern                                                | Smoke 62 (#72)                                                               | None: needs a WordPress test site (D-16)                                                                                                                                                     |
| Sources, analytics and SEO audit         | GA4 and Search Console adapters #17 #18 #37; overview #22; SEO audit with tracked findings #20 #37, workflow v2 #57, retried plan resumes its run #77                                                 | Fixture-server adapter tests; loopback crawl; overview fixture pinned to midday UTC #65                                               | Smoke 55 (#77)                                                               | None: Google sensitive-scope verification and certification pending; production refs absent by decision                                                                                      |
| Brand System                             | One brand system per brand #48; guidance model #52; SVG logos #50 #51; facts workspace #53 (0023); AI-assisted setup, section assistant and history #58 (0024)                                        | Unit, integration and e2e (brand-kit, facts, logos, assist); acceptance journeys #71                                                  | Smoke 49 (#58)                                                               | Staging: brand pack and published version journeys pass; the AI-assisted setup journey fails with `model_routing_denied` (open)                                                              |
| Studio (graphics)                        | Template-led creation and starters #56; Generate workflow, editable AI artwork and scoped refinement #59 (0025); show and hide `setVisibility` #70                                                    | Unit, integration and e2e (studio, studio-entry, studio-generate)                                                                     | Smoke 66 (#70)                                                               | Staging Studio journeys depend on the object store (placeholder). AI image fill for empty image areas is not registered in any deployment                                                    |
| Video                                    | Media foundation, proxies, waveforms, exports, review playback #54 (0026); timeline model, editor and ffmpeg compositor #55 (0027); AI storyboard, assembly and recuts #60 (0028)                     | Real-ffmpeg tests on decoded frames; end-to-end render workflow test; e2e video-studio and video-ai (in CI since #68)                 | Smoke 60 (#60); worker-render polls `render`, `media`, `video`               | No production video render recorded                                                                                                                                                          |
| Media library, uploads and scanning      | Asset lifecycle #5; video and audio uploads #54; upload pinned under ingest, size-signed URLs, SVG CSS and reference gaps closed, clamd `AlertExceedsMax` #66                                         | Integration tests for post-scan replacement and over-cap reads; SVG corpus                                                            | Smoke 67 (#66); clamd logged the heuristic alert enabled with 1100 MB limits | Production: every smoke run uploads through R2, ingest and the live ClamAV scan. Staging: none (placeholder store)                                                                           |
| Agents, skills and model evaluation      | Agents, budgets, skills and imports #6 #7 #27; acceptance with bounded model evaluation #36; adapters name provider errors #40 #46 #47; AI boundaries (budget caps, untrusted text, propose-only) #67 | Unit and integration incl. late-cost ledgering; acceptance integration test                                                           | Smoke 65 (#67)                                                               | Staging: real model calls succeed (gradings return scores); the copywriting evaluation grades below the bar on injection reporting. No production model run recorded                         |
| Team, access and security                | Roles, brand grants, member disable and enable #73; sole-owner guard #78; setup-link confinement, no secrets in idempotency records, `REDIS_URL` required in production #69; one-hop proxy trust #66  | Integration incl. concurrent last-owner demotions; cross-tenant harness (514 cases) with own-tenant checks for id-less procedures #75 | Smoke 73 (#78)                                                               | Production api started under the `REDIS_URL` gate                                                                                                                                            |
| Operations: flags, schedules and workers | Operator-only flag setter, dead flags removed #74; Temporal schedules reconciled with the code #76; worker smoke tests on a real Temporal server #76                                                  | Time-skipping and worker smoke suites in CI                                                                                           | Smoke 68 (#76); no schedule drift at start                                   | Not applicable                                                                                                                                                                               |
| Retention                                | Retention independent of fetches #33; credential shred at disconnect #39                                                                                                                              | Retention and deletion suites in CI                                                                                                   | `db-roles` PASS retention after every schema change                          | None. The sweep is a dry run unless `RETENTION_SWEEP_APPLY=true` (D-09)                                                                                                                      |
| Backup and restore                       | 15-minute backups and a timed restore drill RA-13 #32                                                                                                                                                 | Exercised on Railway                                                                                                                  | Every 15 minutes since 2 October                                             | Staging restore drill passed (109 of 109 tables). One Temporal dump failed on 4 October 06:01 UTC (`Too many connections`, R19)                                                              |
| Observability and alerting               | Configuration report, `/health`, production smoke #11                                                                                                                                                 | Smoke and configuration report in CI                                                                                                  | Smoke every six hours and after each merge; runs 40 to 73 in this increment  | None for alerting: no alert destination exists                                                                                                                                               |
| Acceptance, load and accessibility       | Staging acceptance #36, settle step #62, journeys for the newer features #71; WCAG 2.2 AA suite; k6 load script                                                                                       | Acceptance integration test and a11y suite in CI; CI e2e list guard and mock-API contract check #68                                   | Staging `acceptance` service tracks `main`                                   | Staging since #71: `ACCEPTANCE_DONE 94/96 (24 skipped)`; failures `smoke:upload:csp` (placeholder store) and `brand-system:assist` (`model_routing_denied`). Load: needs a certified channel |

## 3. Deployment identities

Source for every repo-sourced service in both environments: the `main` branch of this repository. Production and
staging both build per environment on Railway, so the commit is the identity.

### Production

Project `OreMedia Social` `ae355f37-5289-4eee-a691-d12c18d83890`, environment
`aa208223-4d41-45a9-a747-3a3f66e51a9e`, web origin `https://oremedia-production.up.railway.app`. Current commit
`aa2c5d8`, smoke run 73.

| Service                  | Role                                                            | Region                                             | Schedule                                                                |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `successful-fulfillment` | api                                                             | us-west2, Railway deployment record of aa2c5d8     | always on                                                               |
| `sparkling-strength`     | worker-core                                                     | us-west2, Railway deployment record of aa2c5d8     | always on; Temporal schedules listed below                              |
| `keen-charisma`          | worker-render                                                   | us-west2, Railway deployment record of aa2c5d8     | always on                                                               |
| `worker-ingest`          | worker-ingest                                                   | us-west2, Railway deployment record of aa2c5d8     | always on; Temporal schedules listed below                              |
| `OreMedia`               | web, served by Caddy                                            | us-west2, Railway deployment record of aa2c5d8     | always on                                                               |
| `redirector`             | redirector                                                      | us-west2, Railway deployment record of aa2c5d8     | always on                                                               |
| `dynamic-intuition`      | approval monitor                                                | us-west2, Railway deployment record of aa2c5d8     | cron every 5 minutes                                                    |
| `db-roles`               | applies and checks the application and retention database roles | us-west2, Railway deployment record of aa2c5d8     | runs on deploy                                                          |
| `db-backup`              | `mysqldump` of the application and Temporal databases           | us-west2                                           | cron `*/15 * * * *`, bucket `production-backups`, local `/backups` copy |
| `temporal`               | Temporal server                                                 | not recorded in the ledger                         | always on                                                               |
| `temporal-db`            | Temporal persistence                                            | not recorded in the ledger                         | not rebuilt per commit                                                  |
| `MySQL`                  | application database, mysql:9                                   | us-west2 per `docs/runbooks/backup-and-restore.md` | not rebuilt per commit                                                  |
| `Redis`                  | rate limiter and caches                                         | not recorded in the ledger                         | not rebuilt per commit                                                  |
| `clamav`                 | upload scanner                                                  | not recorded in the ledger                         | not rebuilt per commit                                                  |

The platform-app documents state us-west2 for the services as a whole; the ledger records the region only for
`db-backup`. Temporal schedules recorded in `progress-report-2026-10-02.md` and the deletion runbook: retention sweep
daily at 02:30 UTC, destination token refresh at 03:10 UTC, destination report sweep at 04:00 UTC and the SEO audit
sweep on Mondays at 05:00 UTC.

### Staging

Project `OreMedia Staging` `181fda48-853c-4597-ac4d-f260e55b0b13`, environment
`cb1bdc0b-69ac-49e1-ba1d-fbfa3166021b`, web origin `https://web-staging-6326.up.railway.app`. Every service deployed
SUCCESS from `aa2c5d8` apart from the approval monitor, which crashes on its Gmail credentials.

| Service                                                         | Role                                                   | Region                                        | Schedule                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------- |
| api, worker-core, worker-render, worker-ingest, web, redirector | application                                            | us-west2                                      | always on                                                                  |
| `approval-monitor`                                              | review-mail monitor                                    | europe-west4                                  | cron every 5 minutes, failing on every run                                 |
| `db-roles`                                                      | database roles                                         | europe-west4                                  | runs on deploy                                                             |
| `db-backup`                                                     | database dumps to the Railway bucket `staging-backups` | not recorded in the ledger; bucket region sjc | the runbook sets `*/15 * * * *`; the deployed staging cron is not recorded |
| `acceptance`                                                    | staging acceptance job                                 | us-west2                                      | one-off runs, restart policy never, tracks `main`                          |
| temporal, MySQL, `MySQL-zSdm`, Redis, clamav                    | platform services                                      | us-west2 for both MySQL volumes               | always on                                                                  |
| `mysql-restore`, `restore-rehearsal`                            | restore drill target and runner                        | not recorded in the ledger                    | one-off                                                                    |

## 4. Connection inventory

Names and states only, as recorded in section 1 of the ledger and corrected by its later findings.

| Capability                                               | Production                                        | Staging              | State                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| Google sign-in, `AUTH_*`                                 | set                                               | set                  | usable and verified                                                                            |
| Object store R2, `OBJECT_STORE_*`                        | set on api, worker-core, worker-render            | placeholder endpoint | production usable and verified by smoke; staging not usable                                    |
| Model provider                                           | set on worker-core and worker-ingest, sealed      | set                  | configured; staging key rejected by OpenRouter, `401: Missing Authentication header`           |
| Meta `facebook_page`, `instagram_business`               | set on api and workers                            | samples              | configured but uncertified; Meta app unpublished, App Review and Business Verification pending |
| LinkedIn `linkedin_page`                                 | set                                               | sample               | configured but uncertified; Community Management API review in progress                        |
| X `x`                                                    | disabled by `OREMEDIA_DISABLED_CHANNELS`          | disabled             | deliberately disabled; D-04 open, no app                                                       |
| GA4 `ga4_property`, Search Console `search_console_site` | refs absent, kinds in `OREMEDIA_DISABLED_SOURCES` | refs set, unverified | production absent by decision; staging configured, unverified; adapters uncertified            |
| Business Profile `gbp_location`                          | absent, flag off                                  | absent               | platform access pending; D-17 read-only                                                        |
| WordPress `cms_site`                                     | per brand, no variable                            | per brand            | no pilot site connected; adapter uncertified; D-16                                             |
| Discord `discord_webhook`                                | kind exists                                       | not recorded         | deliberately deferred; D-18                                                                    |
| Review-mail monitor, Gmail                               | runs as `dynamic-intuition`                       | present, crashing    | production configuration to verify in the monitor's logs; staging holds sample credentials     |
| Staging smoke, `STAGING_SMOKE_*`                         | not applicable                                    | job skipped          | not enabled; the staging smoke user and secrets do not exist yet                               |
| Alert destination                                        | none                                              | none                 | no Railway webhook exists                                                                      |
| Database backup bucket                                   | `production-backups`                              | `staging-backups`    | production passing; staging application dump passed, Temporal dump fix awaiting its next run   |

## 5. Owner-action checklist

Each item names what to do, why it blocks, where to do it and what engineering does once it is done. Values are set
in Railway or the platform consoles and never pass through engineering or this report.

1. [ ] **Staging object store.** Set real Cloudflare R2 credentials for staging, or create a Railway bucket pair for
       assets and releases with CORS allowing the staging web origin. It blocks every staging upload, render and
       release, the `smoke:upload:csp` check, the Studio font import and therefore the Studio suite of the acceptance
       job. Where: Railway, project `OreMedia Staging`, the `OBJECT_STORE_*` variables on the api, worker-core and
       worker-render services, with `OBJECT_STORE_PUBLIC_ORIGIN` on web. Engineering then re-runs the staging
       acceptance job, expects `smoke:upload:put` and `smoke:upload:csp` to pass and the Studio suite to run, and
       records the run in the ledger.
2. [ ] **Staging Gmail monitor.** Provide real staging Gmail credentials, or disable the staging approval-monitor
       cron. Every five-minute run fails with `invalid_client`, so the staging approval-monitor proves nothing and
       its failures fill the staging logs. Where: Railway, `OreMedia Staging`, service
       `approval-monitor`, variables `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN`, or the
       service's cron schedule. Engineering then confirms a clean run in the service log. The ledger also records
       that this service runs in europe-west4, away from the database in us-west2.
3. [ ] **Alert destination.** Provide a Slack, Discord or email webhook for deploy and crash alerts. Without it a
       failed backup, a crashed worker or a failed deploy reaches nobody; the backup runbook relies on the project
       webhook. Where: Railway project settings, webhooks, for both projects. Engineering then wires deploy and
       crash events to it, sends a test alert and records it in the ledger.
4. [ ] **Provider certification with real accounts.** Each adapter stays refused for tenants until certified:
   - [ ] X: create the X developer app and decide D-04; `docs/platform-apps/x.md`.
   - [ ] LinkedIn: obtain the Community Management API development tier; `docs/platform-apps/linkedin.md`.
   - [ ] Facebook and Instagram: certify in development mode with test accounts, then Business Verification and App
         Review; `docs/platform-apps/meta.md`.
   - [ ] WordPress: name a test site and issue an Application Password; `docs/platform-apps/wordpress.md`.
   - [ ] GA4 and Search Console: verify the sensitive scopes on the Google OAuth consent screen and provide a
         property and site the account can read; `docs/platform-apps/google.md`.

   It blocks every real publication, every real source read, the review-to-schedule journey steps and the load
   test. Where: each platform's developer console, then Railway variables `PROVIDER_*` on the api with the workers
   referencing them, and removal of the kind from `OREMEDIA_DISABLED_CHANNELS` or `OREMEDIA_DISABLED_SOURCES`.
   Engineering then walks `docs/runbooks/certify-a-provider.md` with `pnpm certify <kind>`, sets `certifiedAt` from
   the attested record, connects the provider on the acceptance brand, re-runs the acceptance job with load enabled
   and records each result.

5. [ ] **Business Profile and Discord stay deferred.** No action now: Business Profile per D-17 and Discord per
       D-18. When the owner lifts either decision, engineering scopes the work as described in section 6.
6. [ ] **Sandbox network access to `*.railway.app`.** The engineering sandbox cannot reach the Railway origins, which
       is why the acceptance job runs inside the staging project rather than from engineering's side. Where: the network access setting of the engineering sandbox environment. Engineering then runs
       smoke and acceptance checks against staging directly.
7. [ ] **Staging fixture skill version.** The staging copywriting evaluation still grades skill version 1. Import
       the brand-copywriting package version seeded by #63 into the staging fixture company (or approve engineering
       doing it through the product's import flow) so the evaluation grades the current package. The OpenRouter key
       on staging now works: gradings return scores (ledger section 5).
8. [ ] **Railway "Wait for CI".** Turn on "Wait for CI" for the ten repo-sourced production services so a red commit
       on `main` cannot deploy. No API exposes the setting. Where: Railway, each service, Settings, Source.
9. [ ] **Retention apply mode (D-09).** Confirm the retention periods, then set `RETENTION_SWEEP_APPLY=true` on
       production worker-core. Until then the sweep reports what it would delete and deletes nothing.

Carried forward from `docs/release/r2-handover.md` and still open: delete the leftover hello-world services
`alluring-bravery` and `function-bun` behind two-factor confirmation; approve the deletion of staging
`mysql-restore` and `restore-rehearsal` once an application-level restore has been walked; approve the metric
dictionary, X-5, and the alert rules, X-6; the staging smoke GitHub secrets once engineering creates the smoke user
with `bootstrap-owner`.

## 6. Deferred scope

| Item                                      | State                                                                                                                                                   | Source                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Business Profile writes                   | Deferred by D-17. The read-only adapter is built behind `OREMEDIA_ENABLE_GBP` and uncertified; reviews, local posts and replies are not read or written | D-17, `docs/platform-apps/google.md`        |
| Discord                                   | Deferred by D-18: webhook announcements only, no bot; the `discord_webhook` kind exists                                                                 | D-18, R3-1                                  |
| Custom CRM integration or codebase merger | Out of scope by the mandate; CRM, revenue and paid-media connectors come only when a brand needs verified outcomes                                      | Ledger section 3, R3-4                      |
| UX regression check UX-01 to UX-20        | Not yet run                                                                                                                                             | programme instruction; no run in the ledger |
| Brand Kit Agent implementation            | Not started. Architecture docs in PR #31, open and awaiting the owner's entry-point decision                                                            | Ledger section 1                            |
| X and TikTok                              | X disabled with D-04 open; no TikTok adapter                                                                                                            | R3-2                                        |
| Advanced experiments                      | Open, no owner decision                                                                                                                                 | R3-3                                        |
| Brand version `flag` policy               | Refused until approval binding v2; `invalidate_and_hold` is the behaviour                                                                               | D-13                                        |
| Manual accessibility walk                 | Checklist exists, not walked                                                                                                                            | `docs/release/accessibility-checklist.md`   |
| Staging UAT walks and application restore | No staging UAT walk recorded; application-level restore not walked                                                                                      | `r1-evidence.md` sections 7 and 8           |

## 7. Residual risks

| Risk                                                                       | Exposure                                                                                                              | Likelihood                                          | Control in place                                                                                                                                                     | Mitigation                                                                                                                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Temporal database connection exhaustion (R19)                              | Workflow starts stall and backups miss their Temporal dump while `temporal-db` refuses connections                    | Observed once, 4 October 2026 05:56 to 06:05 UTC    | Outbox retries workflow starts; smoke every six hours                                                                                                                | Set `SQL_MAX_CONNS` and `SQL_MAX_IDLE_CONNS` on `temporal` (staging first) or raise `max_connections`; alert on connection count once an alert destination exists |
| Railway global `fetch` returns a Response with empty Headers               | Any server code on Railway that reads response headers through Node 22's global `fetch`, incl. Google OIDC            | Observed on staging; production impact not recorded | The acceptance job probes at start and switches to a `node:https` client; `apps/api/src/auth/router.ts` already works around content-type rewriting for Google       | PR #42, open: Google OIDC requests go through undici's fetch                                                                                                      |
| Staging object store is a placeholder                                      | Staging cannot prove uploads, renders, releases or the Studio suite                                                   | Certain until fixed                                 | Production store verified by every smoke run                                                                                                                         | Owner action 1                                                                                                                                                    |
| No alert destination                                                       | Failed backups, crashed workers and failed deploys reach nobody                                                       | High until configured                               | Smoke every six hours; backup failures mark the Railway deployment failed                                                                                            | Owner action 3; on-call rota per residual risk R16                                                                                                                |
| Uncertified providers                                                      | No real publication or source read; first real runs may surface behaviour the fixtures do not model                   | Certain until certified                             | The registry refuses uncertified adapters; failures are classified and never retried tightly                                                                         | Owner action 4, then the certification runbook                                                                                                                    |
| Model evaluation below the bar on staging                                  | The copywriting skill grades below the bar on the injection-reporting rubric; production model behaviour not recorded | Every staging run since #63                         | Real model calls succeed on staging; the grading names its failing checks and scores (#49)                                                                           | Owner action 7 (current package version on the fixture company), then re-grade; tracked in ledger section 5                                                       |
| `pnpm audit` exception for GHSA-vfj7-8cjw-p6xm, braces, no patched release | Lint tooling only: eslint-plugin-boundaries > micromatch > braces; no production package depends on braces            | Low                                                 | CI still fails on every other high or critical advisory; Trivy scans the images; residual risk R18                                                                   | Remove the entry once a patched braces, micromatch or eslint-plugin-boundaries ships; the owner may reject it by closing #43                                      |
| Retention sweep apply state                                                | Data kept longer than policy while the sweep runs dry, or deleted early once applied                                  | Not recorded                                        | The sweep is a dry run unless `RETENTION_SWEEP_APPLY=true`; retention role PASS in production                                                                        | Confirm D-09 retention periods, then record the worker-core mode in the ledger                                                                                    |
| One-hour credential shred floor                                            | A disconnected credential may remain intact, though unusable, for up to an hour if the revoke workflow is delayed     | Low                                                 | The broker refuses a disconnected credential for anything but the remote revoke; the publication sweeper shreds any credential still intact an hour after disconnect | Accept as designed, or shorten the sweeper floor if the owner requires it                                                                                         |
| No point-in-time recovery on Railway MySQL                                 | Up to 15 minutes of data plus dump time lost on a failure                                                             | Low                                                 | 15-minute dumps in production; staging dumps and restore drill passed                                                                                                | Walk the application-level restore within the three-hour budget                                                                                                   |
| Staging services split across regions                                      | About 140 ms per database round trip for `approval-monitor` and `db-roles`                                            | Certain while unchanged                             | None recorded                                                                                                                                                        | Move both services to us-west2                                                                                                                                    |

## 8. Evidence pack index

All times are UTC on 2 October 2026 unless stated. "Not recorded" means the ledger names no run number.

| Time                 | What                                                                                                                                | Commit                 | Run                                  | File                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| 09:40 to 09:50       | Starting state: both environments on `main`, all deploys SUCCESS                                                                    | `da4c90d`              | production smoke 28                  | `docs/release/completion-ledger.md` §1                                        |
| 14:20                | Staging object store placeholder found in the db-backup log                                                                         | not recorded           | not recorded                         | `docs/release/completion-ledger.md` §1 findings                               |
| 14:32                | First staging scheduled backup, application database passed; Temporal dump failed                                                   | `077980b`, PR #32      | not recorded                         | `docs/release/completion-ledger.md` §4                                        |
| 14:34                | Staging timed restore drill: 109 of 109 tables, 20 migration rows, 4 s                                                              | `077980b`, PR #32      | not recorded                         | `docs/release/completion-ledger.md` §4; `docs/runbooks/backup-and-restore.md` |
| 15:01, 15:15         | PR #32 RA-13 merged; production `db-backup` on cron every 15 minutes; first run passed                                              | `0ea97fe`              | smoke 30, first run containing it    | `docs/release/completion-ledger.md` §4                                        |
| 15:03                | PR #33 RA-05, RA-06 merged; both environments deployed; retention grants PASS                                                       | `f4c40f5`              | smoke 30, first run containing it    | `docs/release/completion-ledger.md` §4                                        |
| 15:06                | PR #34 RA-07 merged and deployed                                                                                                    | `d0c5566`              | production smoke 30                  | `docs/release/completion-ledger.md` §4                                        |
| 15:24                | PR #35 RA-02, RA-03, RA-04, RA-12 merged; migration 0020 applied                                                                    | `7ac8c67`              | production smoke 31; main CI run 103 | `docs/release/completion-ledger.md` §4                                        |
| 15:30                | No alert destination in Railway recorded as owner action                                                                            | not applicable         | not applicable                       | `docs/release/completion-ledger.md` §4                                        |
| 17:08                | PR #37 RA-10, RA-11 merged; migration 0021 applied                                                                                  | `8a9c0ec`              | smoke 32                             | `docs/release/completion-ledger.md` §4                                        |
| 17:27                | PR #38 RA-08, RA-09 merged                                                                                                          | `74b8703`              | production smoke 33 at 17:37         | `docs/release/completion-ledger.md` §4                                        |
| 17:28                | Staging acceptance run 3: 85/86, 13 skipped; global-fetch empty-Headers root cause                                                  | `8449a65`              | acceptance run 3                     | `docs/release/completion-ledger.md` §4; `docs/runbooks/staging-acceptance.md` |
| 17:37                | Staging acceptance run 4: evaluation stopped by the brand day budget                                                                | not recorded           | acceptance run 4                     | `docs/release/completion-ledger.md` §4                                        |
| 18:30                | PR #39 RA-01 merged; migration 0022 applied                                                                                         | `133cfb7`              | production smoke 34                  | `docs/release/completion-ledger.md` §4                                        |
| 18:58                | Staging acceptance runs 5 and 6: 85/86, 13 skipped; evaluation workflow-id defect found                                             | `19de768`              | acceptance runs 5 and 6              | `docs/release/completion-ledger.md` §4                                        |
| 19:20                | PR #36 RA-14 merged; every service in both environments deployed                                                                    | `726a92b`              | production smoke 35                  | `docs/release/completion-ledger.md` §4                                        |
| after 19:20          | Staging acceptance run 7: workflow-id fix confirmed; gradings rejected by the model provider                                        | `726a92b`              | acceptance run 7                     | `docs/release/completion-ledger.md` §4                                        |
| 1 October 2026       | Database roles applied in both environments; earlier restore rehearsal 103 of 103 tables                                            | `3363900` and later    | production smoke 13 and 14           | `docs/release/r1-evidence.md` §§5, 6, 8                                       |
| 4 Oct 05:56 to 06:05 | `temporal-db` connection exhaustion; smoke 53 failed on `upload:ingest`; 06:01 Temporal dump failed                                 | `18ab1f3`              | smoke 53                             | `docs/release/completion-ledger.md` §5 findings                               |
| 4 Oct 06:13 to 14:28 | PRs #75, #77, #64, #65, #63, #55, #60, #62, #72, #71, #69, #67, #70, #66, #76, #74, #68, #73, #78 merged and deployed one at a time | `a18583a` to `aa2c5d8` | smoke 54 to 73, all passed           | `docs/release/completion-ledger.md` §5                                        |
| 4 Oct from 09:19     | Staging acceptance after #71: `ACCEPTANCE_DONE 94/96 (24 skipped)`                                                                  | `0155f6e` onward       | acceptance service log               | `docs/release/completion-ledger.md` §5 findings                               |
| standing             | Provider certification matrix: every adapter `certifiedAt: null`                                                                    | `aa2c5d8`              | not applicable                       | `docs/release/r1-evidence.md` §4; `docs/platform-apps/*.md`                   |
| standing             | Manual accessibility checklist, not walked                                                                                          | `aa2c5d8`              | not applicable                       | `docs/release/accessibility-checklist.md`                                     |
| standing             | Release gate, unticked                                                                                                              | not applicable         | not applicable                       | `docs/release/release-checklist.md`                                           |
