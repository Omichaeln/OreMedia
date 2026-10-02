# Progress report, 2 October 2026

Oremedia build programme: where the system stands, what has been proven and at which level, what remains and who holds
each remaining item. Figures come from the two ledgers (`docs/progress/progress.json`, rendered at
`docs/progress/index.html`, and `docs/programme/production-ui/03-implementation-ledger.md`), the release evidence
(`docs/release/r1-evidence.md`) and the handover (`docs/release/r2-handover.md`), all updated to this date. Verification
levels use the ledger vocabulary: FU unit and integration against fixtures, LW live workflow against a database or
Temporal, SB staging browser, RP real provider, PO production observation.

## 1. Headline

| Measure                                                        | Value                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Progress-ledger items complete                                 | 226 of 301 (56 in progress, 13 open, 4 blocked, 2 not applicable) |
| Gate criteria verified                                         | 25 of 29                                                          |
| Pull requests merged on `main` since the repository recreation | 69 (the production UI programme is #3 to #24)                     |
| Database migrations                                            | 20 (0000 to 0019), 108 tables, roles regenerated per migration    |
| Modules                                                        | 17 (`packages/modules/*`), 4 source and CMS adapters              |
| Production deploys verified this week                          | 11 (every merge of #7 to #24), smoke runs 7 to 23 all passed      |
| Environments                                                   | production and staging on Railway, both on the role users         |

Phases 0 to 6 of the original programme (decisions, foundation, brand and assets, studio, agents, review and
publication, measurement) are complete or complete-with-live-items. Phase 7 (pilot readiness) and the production UI
programme's Release 1 and Release 2 are implemented, tested and deployed; their remaining verification is the staging
walk and real-provider runs, both of which wait on credentials and platform approvals the owner holds.

## 2. What is proven, by level

| Level | What it covers today                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FU    | Every row of both ledgers: unit (1,096 tests), integration against MySQL 8 (700), cross-tenant harness (370 inputs across api, worker-core, worker-ingest and render), mock-transport browser suites (418 cases incl. a11y, responsive and journeys), Temporal time-skipping and replay jobs in CI                                                                      |
| LW    | Workflows on worker-core and worker-ingest in production: publication, reconciliation, ingestion, comment pulls, destination token refresh (03:10 UTC), destination report sweep (04:00 UTC), SEO audit sweep (Mondays 05:00 UTC), retention sweep on its own role                                                                                                      |
| PO    | Production tracks `main`; each deploy checked service by service (migrations applied, both database roles PASS, configuration complete on api, worker-core and worker-ingest); `pnpm smoke:prod` every six hours and after each merge (health with nothing degraded, CSP, legal pages, brand pack, browser-shaped upload to R2 through ingest and the live ClamAV scan) |
| SB    | Not yet: the staging browser walk waits on the credentials the owner connects last                                                                                                                                                                                                                                                                                      |
| RP    | Not yet for any channel or source: the registry refuses uncertified adapters, so production publishes to no real channel and reads no real source until certification                                                                                                                                                                                                   |

## 3. Release 1, production social core (programme rows UX-01 to UX-20, R1-A to R1-I)

Implemented, merged (#3 to #11) and deployed. The social core now has authoritative package documents, discoverable
documents and packages with cursor pagination, named scheduling in brand-zone time, the asset catalogue, the channel
variant editor, reviewer media preview, Studio to review, keep-mine conflict handling, responsive Studio panels,
task-oriented agent setup, Studio agent conversation, plan items and acceptance, budget controls, skill lifecycle,
portfolio performance, performance panels, the brand-publication impact preview and deployment brand verification.
Operations rows added the staging smoke job and UAT runbook, the database roles in both environments, the restore
rehearsal and the release evidence pack. UX-10 (provider certification) stays blocked on Meta Business Verification,
App Review and LinkedIn's Community Management API.

## 4. Release 2, connectors (programme rows R2-0 to R2-5)

All six rows merged (#15 to #22) and deployed between 5711b3a and e185aa7, each confirmed by a smoke run; conformance
reviews ran before every merge and every blocking finding was fixed first.

| Row  | Delivered                                                                                                                                                                | Waits on                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| R2-0 | Brand destinations, versioned source-use policies per kind and data type, Settings → Destinations                                                                        | staging walk                                                 |
| R2-1 | GA4 and Search Console adapters, OAuth connect, daily refresh, report sweep, read model, Performance → Web                                                               | Google scope verification, provider refs, certification      |
| R2-2 | Business Profile read-only adapter behind `OREMEDIA_ENABLE_GBP`, D-17 reads only                                                                                         | Business Profile API access, refs, flag, certification       |
| R2-3 | Article document type, WordPress adapter, website connect with a sealed Application Password, draft-first publish, read-back, drift refusal, revert, rendered validation | pilot site named and its Application Password, certification |
| R2-4 | Bounded SEO audit crawler, weekly sweep, on-demand run, findings with tasks, Performance → Audit                                                                         | a staging site to crawl                                      |
| R2-5 | Overview screen and `overview.summary`: source-labelled figures, coverage and freshness, splits stated honestly, limits panel                                            | staging walk                                                 |

Findings closed during review that would otherwise have reached production: a report page cap that stored truncated
windows, a publication target not enforced as exactly one channel or destination, an article edit that could overwrite
without a read-back, an SEO audit lock never released, a calendar read that undercounted windows beyond 200
publications, and free-text 403 matching that could mis-classify a permission refusal.

## 5. Release 3 and later

| Row  | State                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-1 | Discord: deferred by D-18 (webhook announcements only); the destination kind exists                                                                                                       |
| R3-2 | X and TikTok: blocked on platform apps and certification per channel                                                                                                                      |
| R3-3 | Advanced experiments: open, no decision yet                                                                                                                                               |
| R3-4 | CRM, revenue and paid media: only when a brand needs verified outcomes                                                                                                                    |
| 8.x  | Expansion capabilities (listening, CRM attribution, reputation, agency intelligence, lifecycle, video editing, co-editing, managed autopublish, forecasting): open, each separately gated |

## 6. What changed in the ledgers this week

- Implementation ledger (#24): every R2 row now names its PR, commit, migration, roles check and smoke run; R3 rows
  carry their decisions; X-7 records the retention work; R1-F and R1-G are current.
- Progress ledger (this change): a new section U mirrors the 39 programme rows so the rendered page covers the whole
  build; eight stale items updated with dated evidence, two of them (R2 object storage, the staging environment's
  completion within R.8) moved to complete; the page summary moved from 193 of 223 to 226 of 301.

## 7. Open items by holder

Owner (listed with variable names in `docs/release/r2-handover.md`):

1. Credentials, staging first: Google OAuth staging client, GA4 and Search Console refs, Business Profile refs and
   flag, OpenRouter, R2 object store, the Gmail monitor, and the GitHub staging smoke secrets with a smoke user.
2. Platform approvals: Google sensitive scopes, Business Profile API access, Meta Business Verification and App
   Review, LinkedIn Community Management API.
3. The pilot WordPress site and its Application Password.
4. Railway: delete the two leftover hello-world services behind 2FA, approve the deletion of the staging restore
   services once an application-level restore has been walked, rename the generated worker names if wanted.
5. Decisions still open: the metric dictionary approval (X-5), alert rules and their host (X-6), R3-3.

Build side, once the above land:

1. Staging walk of the UAT journeys and the Release 2 screens (SB on every row).
2. Certification runs per channel and source (`pnpm certify`, `certifiedAt`), then the first real publish and read-back.
3. A real-model evaluation run (4.g1), a staging k6 burst run (7.2), an application-level restore on the production
   dump (7.3), and a manual WCAG 2.2 AA review (F.5).

## 8. Risks worth stating

- Every production figure so far is proven against fixtures and the smoke path, not a real channel or source; the
  first certification walk may surface platform behaviour the fixtures do not model. Mitigation: adapters classify
  every failure and never retry tightly; the registry gate keeps uncertified adapters out of production.
- Railway's MySQL has no point-in-time recovery; the recovery point is the nightly dump. Mitigation: restore rehearsed,
  held-versus-reconciled behaviour tested locally, Temporal keeps publication state fenced.
- Credentials are being connected last by decision, so the staging environment currently proves infrastructure, not
  product behaviour. Mitigation: every service reports its missing settings by name at start, and the smoke job on
  staging is wired behind one secret.
