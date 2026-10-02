# UAT journeys (R1-F, spec 7 "Pilot readiness")

The eight journeys a pilot client walks before Release 1 is called ready, each with what already proves it without a
person (the mock-transport browser suites run in CI on every change; the production smoke check runs every six
hours) and what still needs a person on staging (SB) with real accounts. Staging credentials are an operator step
(`docs/progress/progress.json` R.8); until the `STAGING_SMOKE_*` secrets exist the staging smoke job is skipped.

Verification modes as in the implementation ledger: FU fixture or unit, SB staging browser, RP real provider.

| #   | Journey                                                                                                        | Automated today (FU)                                                                                                                                                                                                    | On staging (SB)                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | An invited person signs in (Google or a password link), lands on the portfolio, opens their company and brand  | `journey.e2e` "an agency user signs in and sees both companies"; `password.e2e`; `a11y.e2e` sign-in refusals; smoke `health`                                                                                            | Google sign-in with a real invited account; a non-invited account refused with the D-03 message                                         |
| U2  | A new brand is set up: standards published, a channel connected or skipped, setup finished                     | `shell.e2e` "brand system" and "setup checklist (R1-D)" (PR #10); `brand-kit.e2e` onboarding run; `brand.integration` setup (PR #10)                                                                                    | Connect a real Facebook Page / Instagram / LinkedIn Page (RP, after UX-10 certification); the checklist closes on Finish                |
| U3  | An asset is uploaded, scanned, approved and given usage rights                                                 | `shell.e2e` assets lifecycle; smoke `upload:*` (a real upload through the production store, scanner and ingest every six hours)                                                                                         | A real image and a PDF; a rights expiry within 30 days shows in Needs attention                                                         |
| U4  | A brief becomes a package with copy and creative variants for two channels                                     | `journey.e2e` "create a package from an accepted brief and generate variants"; `phase6.e2e` plan items; `studio.e2e`                                                                                                    | Variants generated against the real capability limits of the connected channels                                                         |
| U5  | Review: the request freezes the revision; an external reviewer decides once from a link; approval binds        | `journey.e2e` "request review freezes…", "a reviewer … approves"; `phase5.e2e` portal link, decided once, revoked, expired; `inbox.e2e`                                                                                 | A reviewer outside the company opens the emailed link on a phone and approves; a second visit says "already decided"                    |
| U6  | Schedule and publish: the approved revision goes out on two channels at the brand's time; evidence is recorded | `journey.e2e` "schedules the approved revision to two channels", "dispatch: one channel fails…"; `phase5.e2e` schedule → published; `worker-core` publish-control integration (attempt ledger, outcome_unknown)         | A real post on each certified channel (RP); the evidence shows the remote id and URL; a cancelled-during-dispatch race reports honestly |
| U7  | After publishing: an edit or delete on the channel is reconciled; a post-approval edit holds a later release   | `remote-changes.e2e`; `journey.e2e` "a post-approval edit invalidates the approval", "restore and reconcile"; `phase5.e2e` outcome_unknown reconcile                                                                    | Delete the post on the channel; the calendar shows the remote change within the reconcile window                                        |
| U8  | Performance and next steps: the numbers come back with their freshness; a recommendation becomes a brief       | `shell.e2e` performance, trend, panels (UX-12); `journey.e2e` portfolio performance (UX-11); `phase6.e2e` intelligence workspace, accept a recommendation; `measurement.integration` brand summary, attribute aggregate | Real metrics after the provider's reporting delay (RP); the dictionary's rules read true on the screen (no summed reach, pooled rate)   |

## Running the automated journeys

```
pnpm --filter @oremedia/web build
OREMEDIA_E2E=1 pnpm exec vitest run journey.e2e phase5.e2e phase6.e2e shell.e2e inbox.e2e remote-changes.e2e studio.e2e brand-kit.e2e password.e2e
```

CI runs the same files on every change (`.github/workflows/ci.yml`, job `integration`).

## Staging smoke

`.github/workflows/smoke.yml` has a second job, **Smoke check against staging**, that runs `pnpm smoke:prod` with the
`STAGING_SMOKE_*` secrets (the same six as the production ones, prefixed) once the repository variable
`STAGING_SMOKE_ENABLED` is `1`. Until the operator provisions the staging Google client, store and smoke user
(`docs/progress/progress.json` R.8), the job does not run. Setting the variable without the secrets fails the job
with "SMOKE_BASE_URL is required", which is the intended signal.

The deployed acceptance that needs no person-issued credential is the staging acceptance job
(`staging-acceptance.md`): run inside the staging project, it provisions its own fixture companies, runs the smoke
checks, the browser suites against the real origin (`apps/web/e2e/deployed.e2e.test.ts`: U1, the shell, U2,
isolation) and the api journey, and prints one `ACCEPTANCE_*` line per check.

## Recording a UAT pass

Each staging walk is recorded in `docs/release/r1-evidence.md` (section "UAT") with the date, the account used
(never its credentials), the brand, and the journey numbers passed or failed with the defect reference.
