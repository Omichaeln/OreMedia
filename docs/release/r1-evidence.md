# Release 1 evidence pack (R1-I)

What Release 1 is, what proves it, and what is still open, as of 1 October 2026. Every claim names its evidence;
a row without evidence is open. Verification modes as in the implementation ledger: FU fixture or unit, LW local
database or workflow, SB staging browser, RP real provider, PO production observation.

## 1. Identity

| Item                   | Value                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository             | `Omichaeln/OreMedia`, branch `main`                                                                                                                                      |
| Last production commit | `3363900` (WP-10, PR #11), 1 October 2026 03:54 UTC; previous `2487550` (WP-8, PR #10), `56538de` (WP-7, PR #9), `1d38411` (WP-6, PR #8), `4d70f61` (WP-4, PR #7)        |
| Artifact identity      | Railway builds each service from the Dockerfile per environment (residual risk R15): the commit is the identity; the Railway deployment ids per service are in section 5 |
| Web app                | `apps/web` (Vite build served by Caddy, `Dockerfile.web`); deployment brand pack `ore-and-tar`                                                                           |
| Services               | api, worker-core, worker-ingest, worker-render, redirector, web, plus Temporal, Temporal DB, MySQL, Redis, ClamAV                                                        |

## 2. Parity matrix (production UI programme, Release 1)

From `docs/programme/production-ui/03-implementation-ledger.md`; the ledger is the source and this table its snapshot.

| Work package | Rows                             | State                                                                                                                                             |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP-1         | UX-02, UX-13, UX-14, R1-A        | merged #3, deployed                                                                                                                               |
| WP-2         | UX-04, UX-03, UX-06, UX-01, R1-C | merged #4, deployed                                                                                                                               |
| WP-3         | UX-05, R1-B                      | merged #5, deployed                                                                                                                               |
| WP-5         | UX-08, UX-09, UX-16, UX-17       | merged #6, deployed (migration 0014 `plan_items`; app-role grants re-application pending, R1-G)                                                   |
| WP-4         | UX-15, UX-18, UX-07              | merged #7, deployed (smoke run 9)                                                                                                                 |
| WP-6         | D-15, UX-11, UX-12               | merged #8, deployed (smoke run 10); dictionary awaits owner approval (X-5)                                                                        |
| WP-7         | UX-20, D-13                      | merged #9, deployed (smoke run 11)                                                                                                                |
| WP-8         | R1-D, R1-E, UX-19                | merged #10, deployed (2487550, all services SUCCESS 03:30 UTC; smoke run 12); SB pending                                                          |
| WP-9         | UX-10                            | blocked: Meta Business Verification / App Review and LinkedIn Community Management API                                                            |
| WP-10        | R1-F, R1-G, R1-H, R1-I           | merged #11, deployed (3363900, all services SUCCESS 03:56 UTC; smoke run 13); staging walk, role application and restore (R1-H) need the operator |

Every row's verification state (FU done; LW and SB pending per row) is in the ledger.

## 3. Test matrix

Run on every change by `.github/workflows/ci.yml` (job names as the checks on each PR):

| Check                                                        | Covers                                                                                                                                                                                                                                                   | Last PR green |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Format, lint, typecheck, schema and secrets checks           | prettier, eslint (boundaries), tsc per package, schema tenancy, secret scan                                                                                                                                                                              | #9, #10       |
| Unit tests                                                   | 120 files (vitest `unit`)                                                                                                                                                                                                                                | #9, #10       |
| Integration, cross-tenant harness (MySQL 8) and OpenAPI diff | module and app integration suites, every procedure and agent tool re-run as the foreign tenant (331 cases), contract diff, 13 browser suites against the mock transport (14 with PR #10's responsive suite; 383 cases incl. a11y, deployment brand, CSP) | #9, #10       |
| Temporal workflow replay                                     | every shipped workflow version replays its recorded history                                                                                                                                                                                              | #9, #10       |
| Temporal time-skipping tests                                 | schedule and dispatch timing                                                                                                                                                                                                                             | #9, #10       |
| Dependency and container scans, Trivy                        | supply chain                                                                                                                                                                                                                                             | #9, #10       |

Outside CI: `pnpm smoke:prod` against production every six hours and on demand (runs 7 to 13 passed, 30 September
to 1 October 2026; run 12 on the WP-8 commit, run 13 on the WP-10 commit); the staging job waits on `STAGING_SMOKE_ENABLED` (R1-F).

## 4. Certification matrix (UX-10, D-04)

| Channel            | Adapter                                     | `certifiedAt` | Runbook executed | Blocker                                                              |
| ------------------ | ------------------------------------------- | ------------- | ---------------- | -------------------------------------------------------------------- |
| Facebook Page      | `packages/providers/src/facebook_page`      | null          | no               | Meta Business Verification and App Review (submission pack prepared) |
| Instagram Business | `packages/providers/src/instagram_business` | null          | no               | same Meta app                                                        |
| LinkedIn Page      | `packages/providers/src/linkedin_page`      | null          | no               | LinkedIn Community Management API access                             |
| X                  | `packages/providers/src/x`                  | null          | no               | Release 2 (D-04); disabled by `OREMEDIA_DISABLED_CHANNELS=x`         |

The registry refuses an uncertified adapter; production therefore publishes to no real channel until a row above
carries a date. The certification harness (`pnpm certify`) and the runbook (`docs/runbooks/certify-a-channel.md`)
are ready to run once the apps are approved.

## 5. Railway inventory (production project `ae355f37-5289-4eee-a691-d12c18d83890`, environment `production`)

| Service name           | Service id                             | Role                                         | Deployment on `3363900`           |
| ---------------------- | -------------------------------------- | -------------------------------------------- | --------------------------------- |
| successful-fulfillment | `8ffd0889-b494-45bf-8bac-4331d5b7fcce` | api                                          | SUCCESS 03:54 to 03:56 UTC        |
| OreMedia               | `dcc31060-cbb1-4842-b987-88924850486b` | web                                          | SUCCESS 03:54 to 03:56 UTC        |
| keen-charisma          | `74563d26-b342-4a7b-9c66-138c8569083b` | worker (role to confirm from its deploy log) | SUCCESS 03:54 to 03:56 UTC        |
| worker-ingest          | `616d6e2e-96dd-4b57-9ae7-c85edb03059c` | worker-ingest                                | SUCCESS 03:54 to 03:56 UTC        |
| sparkling-strength     | `4820740c-0eb4-4c41-bebb-286e2562b9d5` | worker (role to confirm from its deploy log) | SUCCESS 03:54 to 03:56 UTC        |
| dynamic-intuition      | `a4cdc4b2-e44f-4754-9c82-6e8cf334d3f4` | worker (role to confirm from its deploy log) | SUCCESS 03:54 to 03:56 UTC        |
| redirector             | `70250b7f-13ef-4b26-8354-7db8a4366f72` | redirector                                   | SUCCESS 03:54 to 03:56 UTC        |
| temporal               | `0545f3fe-5f1b-4090-8ef8-e4aee7eb5259` | Temporal server                              | SUCCESS 03:54 to 03:56 UTC        |
| temporal-db            | `9cf0cb48-8c4a-4b74-b51b-6c3e8103ff7c` | Temporal persistence                         | not rebuilt per commit            |
| MySQL                  | `af87d8a4-cb50-4dc0-b317-9fe3ff0e5b82` | application database                         | not rebuilt per commit            |
| Redis                  | `467fe6a5-cf24-4f4c-97f9-fe62a5722479` | rate limiter, caches                         | not rebuilt per commit            |
| clamav                 | `1e885fbd-7fc1-4fb3-8c88-3ee5a5ffc152` | upload scanner                               | not rebuilt per commit            |
| alluring-bravery       | `1acab570-175e-451b-9e15-1ba5e9644cab` | leftover hello-world                         | staged for deletion (owner's 2FA) |
| function-bun           | `4c95b66e-c683-4443-8c62-a9bdd3d15d53` | leftover hello-world                         | staged for deletion (owner's 2FA) |

The role column is known for the api (the service the migration log names), the web, worker-ingest, the redirector,
Temporal and ClamAV; the three generated-name workers run worker-core and worker-render between them and are to be
confirmed from their deploy logs before release. Railway names may be changed by the operator without changing the ids. Staging project: "OreMedia
Staging" (web `https://web-staging-6326.up.railway.app`), api deployed and stopped at the missing Google client;
four services not yet connected (R.8).

## 6. Database roles (R1-G, D-25)

Both environments connect as the MySQL root user today. `packages/db/roles/app-role.sql` and `retention-role.sql`
are generated from the schema (`pnpm tsx tooling/scripts/generate-db-roles.ts`, regenerated with migration 0014).
Applying them is the MySQL admin's step (deploy runbook §1 step 5); `pnpm db:roles:check` then proves the
connection runs as the role with exactly the generated grants. Evidence to add: the check's output on staging, then
production, with the date.

## 7. UAT (R1-F)

Journeys and their automated coverage: `docs/runbooks/uat-journeys.md`. Staging walks: none yet (staging
credentials pending). Record each walk here: date, account (never credentials), brand, journeys passed, defects.

## 8. Restore rehearsal (R1-H)

Local tenant-scoped export and import rehearsed (`runbooks.integration.test.ts` 7.11) with the restore hold
command. On Railway: not yet (PITR into a separate instance, object retrieval, held-vs-reconciled behaviour, no
duplicate publication). Depends on R1-G so the rehearsal runs on the application role.

## 9. Known limitations at this commit

- No channel is certified (section 4): the product schedules, reviews and holds, but publishes nothing real.
- Both environments run as MySQL root until R1-G is applied.
- `flag` for a brand version publish is refused until approval binding v2 (D-13); `invalidate_and_hold` is the behaviour.
- The metric dictionary (D-15) and the baseline rule (D-14) are applied as working defaults pending the owner's approval.
- Residual risks R1 to R17 (`docs/operations/residual-risks.md`): R1 (multi-channel approval consumption), R16 (no on-call rota) and R17 (no real-brand UAT) are the ones a pilot cannot carry.
- Two leftover Railway services await the owner's two-factor confirmation to delete.
- The production-readiness gate (`docs/operations/production-readiness.md`) still reads "not ready for the client pilot"; its open rows map to WP-9 and WP-10.

## 10. Release checklist

`docs/release/release-checklist.md`, ticked with the evidence above as each step completes.
