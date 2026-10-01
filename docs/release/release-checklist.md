# Release 1 checklist (R1-I)

The ordered gate from a green `main` to a verified production release, each step naming its evidence. A step is
ticked only with the evidence in hand; "it should work" is not a status. Owner decisions that gate a step are named.

## Before the release decision

1. [ ] `main` is green: CI run id recorded in `r1-evidence.md` (static, unit, integration + cross-tenant + OpenAPI,
       workflow replay, time-skipping, supply chain).
2. [ ] Every implementation-ledger row for Release 1 reads merged and deployed, or names its blocker
       (`docs/programme/production-ui/03-implementation-ledger.md`).
3. [ ] Open owner decisions that affect behaviour are either decided or carry a working default the owner has seen
       (D-13, D-14, D-15; `docs/decisions/DECISIONS.md`).
4. [ ] Database roles applied on staging, then production, and proven: `railway run pnpm db:roles:check` (the
       api service linked) reports PASS for the application role and the retention role (R1-G, D-25).
5. [ ] Staging smoke green (`STAGING_SMOKE_ENABLED=1`, `smoke.yml` staging job) and the eight UAT journeys walked on
       staging (`docs/runbooks/uat-journeys.md`), results recorded (R1-F).
6. [ ] Restore rehearsal done on Railway: PITR into a separate instance, object retrieval, held-vs-reconciled
       behaviour, no duplicate publication; recorded in `r1-evidence.md` (R1-H).
7. [ ] Channel certification: `certifiedAt` set for each pilot channel after the real-app runbook
       (`docs/runbooks/certify-a-channel.md`), D-04 recorded (UX-10).
8. [ ] Residual risks reviewed with named owners (`docs/operations/residual-risks.md`); R1 (multi-channel approval
       consumption) and R16 (on-call) closed or accepted in writing.

## Releasing

9. [ ] The exact commit on `main` and the image digests per service recorded (Railway deployment ids) in
       `r1-evidence.md`; Railway builds per environment today (R15), so the commit is the identity.
10. [ ] Migrations: the api's deploy log reads "migrations applied"; any new table's grants re-applied by the MySQL
        admin (deploy runbook §1 step 5) before the worker that writes it starts.
11. [ ] All services SUCCESS on the commit (Railway), `GET /health` with an empty `degraded`, production smoke run
        green (`smoke.yml`), run id recorded.
12. [ ] A person walks U1, U3 and U8 on production with the smoke company; nothing is published from it.

## After

13. [ ] The evidence pack is updated with the run ids, dates and the known limitations at release.
14. [ ] The rollback path is confirmed (deploy runbook §4): previous deployment ids per service noted, and the
        workflow-version rule (`rollback-workflow-version.md`) checked for any workflow shipped in this release.
