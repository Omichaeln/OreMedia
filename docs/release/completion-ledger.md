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

Evidence levels: implemented (code on main), tested (CI on the merge commit: unit, integration on MySQL 8,
cross-tenant, workflow replay), deployed (production deploy SUCCESS and a passing production smoke run on a commit
that contains the change), externally verified (a real provider, account or client confirmed the behaviour).
Production smoke runs by commit: 30 on d0c5566 (first run containing #32, #33 and #34), 31 on 7ac8c67, 32 on 8a9c0ec,
33 on 74b8703, 34 on 133cfb7, 35 and the scheduled 36 on 726a92b.

| ID    | User outcome                                                        | PR, commit        | Evidence level                                                                      | Remaining blocker                                                                                                 | Owner            |
| ----- | ------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| RA-01 | Providers activate only with certification evidence; revoke is real | #39, 133cfb7      | Deployed, smoke 34; staging acceptance shows every channel uncertified and disabled | Certification with real accounts per `docs/runbooks/certify-a-provider.md`                                        | Owner + engineer |
| RA-02 | CMS draft, live and reverted states are proven by read-back         | #35, 7ac8c67      | Deployed, smoke 31                                                                  | External: a real WordPress site publish, revert and overwrite check                                               | Owner            |
| RA-03 | One text cap: articles to MEDIUMTEXT, channels to 10,000 characters | #35, 7ac8c67      | Deployed, smoke 31; migration 0020 applied                                          | None                                                                                                              |                  |
| RA-04 | Confirmation proves the approved content reached the page           | #35, 7ac8c67      | Deployed, smoke 31                                                                  | External: rendered-page check against a real site                                                                 | Owner            |
| RA-05 | Retention decoupled from ingestion                                  | #33, f4c40f5      | Deployed, smoke 30                                                                  | Production apply mode is a deliberate switch (`RETENTION_SWEEP_APPLY`)                                            | Owner            |
| RA-06 | Calendar and metrics read every page, no 200-row truncation         | #33, f4c40f5      | Deployed, smoke 30                                                                  | None                                                                                                              |                  |
| RA-07 | No principal ids or JSON in forms; effective limits visible         | #34, d0c5566; #36 | Deployed, smoke 30 and 35; `runs.start` aligned in #36                              | None                                                                                                              |                  |
| RA-08 | Rich article and FAQ authoring                                      | #38, 74b8703      | Deployed, smoke 33                                                                  | None                                                                                                              |                  |
| RA-09 | Faithful frozen preview with draft or live intent                   | #38, 74b8703      | Deployed, smoke 33                                                                  | None                                                                                                              |                  |
| RA-10 | GA4 in the property's zone with data-quality flags                  | #37, 8a9c0ec      | Deployed, smoke 32; migration 0021 applied                                          | External: a real GA4 property connected                                                                           | Owner            |
| RA-11 | SEO findings become tracked work                                    | #37, 8a9c0ec      | Deployed, smoke 32                                                                  | None                                                                                                              |                  |
| RA-12 | Preflight read and write race closed (overwrite detection)          | #35, 7ac8c67      | Deployed, smoke 31                                                                  | External: concurrent edit on a real WordPress site                                                                | Owner            |
| RA-13 | 15-minute RPO and 4-hour RTO with a rehearsed restore               | #32, 0ea97fe      | Deployed both environments; staging restore drill RESTORE_PASS                      | Alert destination for a missed backup (no Railway webhook exists)                                                 | Owner            |
| RA-14 | Deployed acceptance, model evaluation, load and a11y                | #36, 726a92b      | Deployed, smoke 35; staging run 7 85/86 checks                                      | Staging object store (upload CSP); model-provider rejection (#40 names the cause); load needs a certified channel | Owner + engineer |

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
- 2 October 2026, 17:27 UTC: PR #38 (RA-08, RA-09) squash-merged as 74b8703 after review fixes (bounded image fetch,
  raster-only article images, consistent FAQ answers, `websites` always frozen).
- 2 October 2026, 17:28 UTC, staging acceptance run 3 (commit 8449a65): `ACCEPTANCE_DONE 85/86 (13 skipped)`.
  Root cause of runs 1 and 2: on Railway, Node 22's built-in global `fetch` returns a Response whose Headers are empty
  (probe: `fetch /health headers=[]`, while the hoisted `undici` fetch and `node:https` see the full header set; env shows
  only NODE_VERSION, no NODE_OPTIONS). The job now probes at start and switches to a node:http(s) client
  (`http-client=node-https`). Passed: fixtures for two companies, twelve password sign-ins through the deployed endpoint,
  smoke health, CSP, legal pages, brand pack, upload intent; api isolation (foreign brand 404, foreign tenant header 403,
  brand list); package create; a11y audits of every public screen in both themes and widths; deployed browser journeys
  (sign-in → portfolio → brand home, shell navigation, published brand version, cross-company isolation, sign-out).
  Failed: `smoke:upload:csp` (staging object store is the placeholder endpoint; owner action). Skipped: channel-dependent
  journey steps and load (no certified provider), studio font import (api answered 500 on `assets.fonts.importGoogle`,
  to diagnose; likely the same placeholder store), mock-only a11y cases. `MODEL_EVAL_FAIL copywriting … budget_exhausted
after 1 step`: the real model path ran one step on the default 0.25 USD budget; re-run with a 2 USD cap pending.
  Platform note: `apps/api/src/auth/router.ts` already works around Railway's outbound proxy rewriting content types
  for Google; the same global-fetch path should move to the explicit undici fetch (follow-up).
- 2 October 2026, 17:37 UTC: production smoke run 33 passed on 74b8703 (#38); every production service deployed SUCCESS.
  Staging acceptance run 4 (2 USD model cap): still `MODEL_EVAL_FAIL … budget_exhausted`; worker-core shows `reserveBudget`
  refused with `Budget exhausted (brand_day)`, so the fixture brand's day limit, not the run budget, is the gate; the job's
  fixture setup is being changed to raise the brand's day and month limits before the evaluation run.
- 2 October 2026, 18:30 UTC: PR #39 (RA-01; migration 0022) squash-merged as 133cfb7 after two review rounds (rebase on 0021,
  credential unusable at disconnect with a bounded shred on the publication sweeper for channels and destinations, revoke/reconnect
  race, audit reason whitelist, health monotonicity, source and CMS remote revoke). Production api pre-deploy logged `migrations
applied` and `configuration complete`; every production service deployed SUCCESS; production smoke run 34 passed on 133cfb7.
  Thirteen of the fourteen RA items are now on main; RA-14's acceptance job (PR #36) remains open while its model-evaluation
  step is completed on staging (`runs.start` now refuses `no_skill`, aligned with `effectiveLimits`; the job provisions the
  built-in copywriting skill for the fixture company).
- 2 October 2026, 18:58 UTC: staging acceptance runs 5 and 6 (19de768, main merged into RA-14) again `ACCEPTANCE_DONE 85/86
(13 skipped)`; the model evaluation timed out at 600 s with the skill version in `sandbox_evaluation`. Root cause (worker-core
  log, correlation `acceptance-0cd073ef…`, nine retries of `Workflow execution already started`): the first grading on staging
  failed at 18:11 UTC and returned the version to draft; the re-request reused the same Temporal workflow id
  (`skill-evaluation:<version>:<suite>`), and the worker's ALLOW_DUPLICATE_FAILED_ONLY reuse policy refuses an id whose earlier
  run completed, so the outbox event could never dispatch. This is a product defect, not a fixture problem: a person pressing
  Evaluate again after a failed grading would see the same hang. Fix pushed to PR #36 as 2c5f7c4: the workflow id carries the
  request's row version (the outbox event's aggregate version, the destination-verify pattern); the acceptance check reads the
  audit trail and names the grading error when its own request fails. The same push marks the test fixture provider ready for
  the RA-01 activation gate, which the in-process acceptance test tripped after the merge (CI integration job red on 19de768).
  The staging event dispatches on its own once worker-core redeploys from main with the new id.
- 2 October 2026, 19:20 UTC: PR #36 (RA-14) squash-merged as 726a92b after CI went green on 2c5f7c4. Every production and
  staging service deployed SUCCESS from 726a92b (staging approval-monitor still crashes on its Gmail credentials, as before);
  production smoke run 35 passed on 726a92b. The staging `acceptance` service now tracks main. Staging acceptance run 7
  (726a92b, worker-core on the per-request workflow id): both stuck evaluation requests dispatched at once
  (`skill-evaluation:…:3` and `…:5`), so the workflow-id defect is confirmed fixed in the deployed environment; both
  gradings then failed within 90 ms with `The model provider rejected the request`, which the acceptance now names
  (`MODEL_EVAL_FAIL … evaluation failed (version 1): …`) instead of timing out. The status behind that rejection is not
  recorded anywhere an operator can see: PR #40 makes both model adapters carry the provider's status and message in the
  error; the next staging run will name the cause (invalid key, unknown model id or malformed request are the candidates;
  staging worker-core has OPENROUTER_API_KEY_REF and OREMEDIA_MODEL_ID set). RA-14 is otherwise complete: fixtures, sign-ins,
  smoke, isolation, journey, a11y, deployed browser suites and the evaluation path proven on staging; the run reported
  `ACCEPTANCE_DONE 85/86 (13 skipped)`, the single failing counted check being `smoke:upload:csp` on the placeholder
  object store (owner action); the model evaluation reports on its own line (`MODEL_EVAL_FAIL`) outside that count.
- 3 October 2026, 01:25 UTC: follow-ups opened as draft PRs, each waiting on CI: #40 (model adapters name the
  provider's status and message on a rejected request), #41 (responsive e2e waits for focus to return to Menu after
  the drawer closes; the race failed #40's first integration run), #42 (Google OIDC requests through undici's fetch,
  the Railway empty-Headers finding) and #43. #43 answers GHSA-vfj7-8cjw-p6xm (braces <=3.0.3, high, published with no
  patched release), which turned `pnpm audit --audit-level high` red on every branch including main: braces is
  dev-only (eslint-plugin-boundaries > micromatch > braces; `pnpm why braces --prod` is empty), so the root
  `package.json` ignores that single advisory through `pnpm.auditConfig.ignoreGhsas` and residual risk R18 records the
  exception, its owner and removal trigger. The commit is ported into #40, #41 and #42. The owner may reject the
  exception by closing #43; merges then wait on an upstream fix.
- 3 October 2026, 01:45 UTC: #43 (audit exception, e5fa896), #41 (focus race, 1236a6c), #40 (rejection detail,
  b8e357a) and #42 (Google OIDC through undici, 9f2c9cf) squash-merged with CI green on each head. Every per-commit
  production service deployed SUCCESS from 9f2c9cf in us-west2; production smoke run 37 passed on 9f2c9cf. Staging
  acceptance run 8 (9f2c9cf): `ACCEPTANCE_DONE 85/86 (13 skipped)`, the counted failure still `smoke:upload:csp`;
  the model evaluation now names its cause, `The model provider rejected the request (401: Missing Authentication
header)`, and worker-core logs `openrouter 401: Missing Authentication header`. The key reference resolves (the
  worker refuses to start without it) and the adapter always sends the header, so the likely casualty is the
  transport: the OpenRouter adapters defaulted to Node's global fetch, the function the acceptance probe caught
  returning empty Headers on Railway. Production's approval monitor sends a Bearer header through the same global
  fetch to Gmail and completes every five minutes, so the fault is not universal; the root cause is not proven. PR
  #45 moves the four OpenRouter adapters to undici's fetch; the next staging run discriminates: the same 401 after
  #45 means the staging `OPENROUTER_API_KEY_REF` value is wrong (owner action; its value was not read).
- 3 October 2026, 02:05 UTC: #45 (OpenRouter adapters on undici's fetch) squash-merged as 3220166 with CI green;
  every per-commit production service deployed SUCCESS from 3220166 in us-west2. Staging acceptance run 9 (3220166,
  evaluation handled by the new worker-core deployment) returned the same `401: Missing Authentication header`, so
  the transport is ruled out by the test stated before the change: the staging `OPENROUTER_API_KEY_REF` value is not a
  working OpenRouter key. Owner action: set a valid OpenRouter key on staging worker-core (its value was not read and
  no production credential was copied); the next acceptance run then reports `MODEL_EVAL_PASS` or a grading result.
  Whether production model calls succeed is not recorded: no production model run is in the evidence.
