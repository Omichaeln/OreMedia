# Completion ledger (end-to-end build completion, verification and Railway release)

Working ledger for the 2 October 2026 completion mandate. One row per requirement or finding; the evidence
column names the level with the vocabulary of `r1-evidence.md` (SI source inspection, FU fixture tests, DB real
database or workflow tests, SB deployed browser acceptance, RP real provider, PO production observation). A row
moves only on evidence; documentation claims are leads to verify.

## 1. Starting state (discovery, 2 October 2026, 09:50 UTC)

### Repository

- `main` at `da4c90d` (#30, guidelines single publisher). CI on main: see the run recorded in section 4.
- Open pull request: #31 (Brand Kit Agent inventory and architecture note, docs only, awaiting the entry-point
  decision). No other open branches with unmerged work; stale worktrees removed.
- Toolchain: Node 22.22.2 and pnpm 10.6.1 in `package.json` (`engines`, `packageManager`), CI and both
  Dockerfiles. Consistent; no change needed.
- Tests run from the root: `test` (unit), `test:integration` (MySQL 8), `test:cross-tenant`, `test:replay`,
  `test:time-skipping`, e2e under `apps/web/e2e` (opt-in `OREMEDIA_E2E=1` against the built app and the mock
  transport), `smoke:prod` (deployed smoke).

### Railway

| Environment | Project                                                                                               | Web origin                                   | Services                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| production  | `OreMedia Social` `ae355f37-5289-4eee-a691-d12c18d83890`, env `aa208223-4d41-45a9-a747-3a3f66e51a9e`  | `https://oremedia-production.up.railway.app` | api `successful-fulfillment`, worker-core `sparkling-strength`, worker-render `keen-charisma`, `worker-ingest`, web `OreMedia` (Caddy), `redirector`, approval monitor `dynamic-intuition` (cron \*/5), `db-roles`, `db-backup` (cron 03:00 UTC, mysqldump to a 50 GB volume, 14-day retention), `temporal`, `temporal-db`, `MySQL` (mysql:9), `Redis`, `clamav` |
| staging     | `OreMedia Staging` `181fda48-853c-4597-ac4d-f260e55b0b13`, env `cb1bdc0b-69ac-49e1-ba1d-fbfa3166021b` | `https://web-staging-6326.up.railway.app`    | api, worker-core, worker-render, worker-ingest, web, redirector, approval-monitor (cron \*/5), db-roles, temporal, MySQL, `MySQL-zSdm`, Redis, clamav, plus the rehearsal leftovers `mysql-restore` and `restore-rehearsal`                                                                                                                                      |

- Deployed identity, both environments: every repo-sourced service on `main` at `da4c90d` (deploys of
  09:40 UTC, all SUCCESS); production smoke run 28 passed on that commit.
- Migration level: 0019 (`seo_audit`), 108 tables; `db-roles` PASS on both environments at the last run.
- Configuration reports at the last start: production api "configuration complete" (6 capabilities),
  worker-core complete (6), worker-ingest complete (5), worker-render complete (1); staging api complete (5).
- Recovery: nightly logical dump only; Railway MySQL has no point-in-time recovery (`r1-evidence.md` §8).
  Staging restore rehearsal passed (1 October). The 15-minute RPO is not met today: RA-13.

### Findings from the discovery (2 October 2026, afternoon)

- Staging object store: `OBJECT_STORE_ENDPOINT` on the staging api, worker-core and worker-render is the
  placeholder `https://REPLACE_ME_ACCOUNT_ID.r2.cloudflarestorage.com` (seen in the db-backup run log at
  14:20 UTC). Staging uploads, renders and releases cannot have worked; the connection inventory row "Object
  store, staging: set" is corrected to "placeholder". A Railway bucket `staging-backups` (region sjc) now holds
  the staging database dumps; the staging application object store is still a placeholder (owner action or a
  second Railway bucket pair, see the checklist).
- Staging `approval-monitor` and `db-roles` run in `europe-west4`; every other staging service and both MySQL
  volumes are in `us-west2`. The staging approval-monitor fails on every 5-minute run with `Gmail token refresh failed: invalid_client The OAuth client was not found` (staging holds sample Gmail credentials; its log also labels the environment `production`). Owner action: real staging Gmail credentials, or disable the staging cron. A service in another
  region pays about 140 ms per database round trip (measured on the first db-backup run).

### Connection inventory (capability level; variable names and states only, no values)

| Capability                                                                                | Production                                                | Staging                                                      | State                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google sign-in (`AUTH_*`)                                                                 | set                                                       | set                                                          | usable and verified (sign-in works; smoke user signs in with password)                                                                                                    |
| Object store R2 (`OBJECT_STORE_*`)                                                        | set on api, worker-core, worker-render                    | placeholder endpoint (`REPLACE_ME_ACCOUNT_ID`)               | production usable and verified (smoke upload through ingest and ClamAV); staging not usable until real credentials or Railway buckets are set                             |
| Model provider (`OPENROUTER_API_KEY_REF`, `OREMEDIA_MODEL_ID`, `OREMEDIA_IMAGE_MODEL_ID`) | set on worker-core and worker-ingest (sealed)             | set                                                          | configured; bounded real-model evaluation pending (RA-14)                                                                                                                 |
| Meta `facebook_page`, `instagram_business` app credentials                                | set on api and workers                                    | set (samples per handover)                                   | configured but uncertified: Meta app `1111601258212850` unpublished, App Review and Business Verification pending (platform access pending); adapters `certifiedAt: null` |
| LinkedIn `linkedin_page` app credentials                                                  | set                                                       | set (sample)                                                 | configured but uncertified: Community Management API review in progress (platform access pending)                                                                         |
| X `x`                                                                                     | disabled via `OREMEDIA_DISABLED_CHANNELS`                 | disabled                                                     | deliberately disabled (D-04 open; no app)                                                                                                                                 |
| GA4 `ga4_property`, Search Console `search_console_site`                                  | refs absent; kinds in `OREMEDIA_DISABLED_SOURCES`         | refs set on api and worker-core (sample or real: unverified) | production: absent by decision (credentials last); staging: configured, unverified; adapters uncertified; Google sensitive-scope verification pending                     |
| Business Profile `gbp_location`                                                           | absent, flag off                                          | absent                                                       | platform access pending (API access application), D-17 read-only                                                                                                          |
| WordPress `cms_site`                                                                      | per brand (no variable)                                   | per brand                                                    | no pilot site connected; adapter uncertified (D-16)                                                                                                                       |
| Discord `discord_webhook`                                                                 | kind exists                                               |                                                              | deliberately deferred (D-18)                                                                                                                                              |
| Review-mail monitor (Gmail)                                                               | approval monitor runs on production (`dynamic-intuition`) | approval-monitor present                                     | production configuration: to verify in the monitor's logs                                                                                                                 |
| Staging smoke (`STAGING_SMOKE_*`, `STAGING_SMOKE_ENABLED`)                                |                                                           | job skipped on run 28                                        | not enabled: the staging smoke user and secrets do not exist yet (engineering: create with `bootstrap-owner`)                                                             |

Tenant-level channel connections and destinations (OAuth grants per brand) are read through the authenticated
API in section 5; none can exist for the social channels while the adapters are uncertified (the connect start
returns `provider_not_certified`).

## 2. Requirement and finding rows

Columns: ID · user outcome · current state · dependency · implementation · acceptance · tested commit ·
environment · evidence level · remaining blocker · owner.

(filled as each finding is revalidated; see sections below)

## 3. Decisions in force that bound the scope

D-04 (X as a fourth channel: open), D-11 (distinct approver for publications on client brands), D-12 (neutral
product brand), D-13 (approver binding instant), D-16 (WordPress REST), D-17 (Business Profile read-only),
D-18 (Discord deferred, webhook only), D-21 (one person may publish guidelines). Custom CRM integration is out of
scope by the mandate.

## 4. Evidence log

(appended per increment: commit, command, environment, counts, failures, skips)

- 2 October 2026, 14:32 UTC, staging: first scheduled database backup from `infra/railway/db-backup` (PR #32, commit 077980b):
  `DB_BACKUP_PASS oremedia s3://staging-backups-…/db-backups/staging/oremedia/oremedia-20261002T143201Z.sql.gz 16897 bytes binlog=0`.
  The Temporal dump failed on that run (wrong database name, 495 bytes); fixed in 077980b with `SRC2_DB=temporal temporal_visibility`, next run pending.
- 2 October 2026, 14:34 UTC, staging: timed restore drill (`restore.sh`, service `restore-rehearsal` into `mysql-restore`):
  `RESTORE_STEP downloaded +1s`, `unpacked +1s`, `loaded +4s`, `RESTORE_TABLES expected=109 restored=109 migration_rows=20`,
  `RESTORE_PASS oremedia from db-backups/staging/oremedia/oremedia-20261002T143201Z.sql.gz in 4s`. RA-13: RPO 15 minutes by schedule
  (no PITR on Railway MySQL), restore step 4 s on the staging data set; the full application-level path (re-point, holdRestored,
  deletion re-apply, smoke) remains an operator procedure in docs/runbooks/backup-and-restore.md with a three-hour budget.
- 2 October 2026, 15:01 UTC: PR #32 (RA-13) squash-merged as 0ea97fe; production `db-backup` reconnected to the repo (main,
  `infra/railway/db-backup/Dockerfile`, cron `*/15 * * * *`, start command `backup.sh`, region us-west2, Railway bucket
  `production-backups`, prefix `db-backups/production`, local copy on the existing `/backups` volume). First scheduled run,
  15:15 UTC: `DB_BACKUP_PASS oremedia … 183339 bytes binlog=0`, `DB_BACKUP_PASS temporal … 1449759 bytes binlog=0`,
  `DB_BACKUP_DONE 20261002T151540Z` (5 s end to end). RA-13 engineering complete; the RPO is 15 minutes by schedule.
- 2 October 2026, 15:03 UTC: PR #33 (RA-05, RA-06) squash-merged as f4c40f5; production api, worker-core, worker-render,
  worker-ingest, web, redirector, approval monitor, temporal and db-roles deployed SUCCESS; db-roles log `PASS application`
  and `PASS retention: oremedia_retention holds exactly the generated grants` (new retention grants applied). Staging deployed
  the same (db-roles SUCCESS at 15:06).
- 2 October 2026, 15:06 UTC: PR #34 (RA-07) squash-merged as d0c5566; production and staging api, workers and web deployed
  SUCCESS.
- Staging `approval-monitor` still crashes on every run (sample Gmail credentials); unchanged by these merges.
- 2 October 2026, 15:24 UTC: PR #35 (RA-02, RA-03, RA-04, RA-12; migration 0020) squash-merged as 7ac8c67. Production and
  staging api pre-deploy logged `migrations applied` and `configuration complete`; every repo service deployed SUCCESS in both
  environments. Production smoke run 30 (after #34) and run 31 (after #35) passed. Main CI run 103 green.
- 2 October 2026, 15:30 UTC: remediation agents started from 7ac8c67 for RA-10/RA-11 (migration 0021), RA-08/RA-09,
  RA-01 (migration 0022 if needed) and RA-14 (a Railway-run staging acceptance job: fixtures, deployed browser acceptance,
  k6 load, bounded model evaluation, accessibility checklist). No alert destination exists in Railway (no webhooks);
  owner action: provide a Slack, Discord or email webhook destination for deploy and crash alerts.
- 2 October 2026, 17:08 UTC: PR #37 (RA-10, RA-11; migration 0021) squash-merged as 8a9c0ec after a conformance review
  (ordering, destination row lock for createWork, DST day end, zone recheck window). Production api pre-deploy logged
  `migrations applied` and `configuration complete`. PR #36 (RA-14 acceptance job) and PR #38 (RA-08, RA-09) open as drafts;
  RA-01 branch in its review fix round (rebase on 0021, credential made unusable at disconnect with a bounded shred, source
  and CMS remote revoke, health monotonicity).
- Staging acceptance job (service `acceptance`, branch claude/ra14-staging-acceptance): two runs. Fixtures for `acceptance-a`
  and `acceptance-b` PASS (companies, members per role, published brand version, policy, agent principal), `smoke:health`
  PASS; every other HTTP check fails because the job's responses carry no headers at all (`headers=[] set-cookie=absent`
  on every response while the api logs 200 and the bodies arrive). Not reproducible locally with the same built bundle;
  a three-client probe is being added to isolate the Railway-side cause before the deployed browser suites can run.
