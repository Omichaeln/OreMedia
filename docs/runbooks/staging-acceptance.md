# Staging acceptance job

**Owner:** platform on-call. **Needs a live environment for:** everything below; the job runs only inside the
staging Railway project. **Exercised locally by:** `apps/api/src/acceptance.integration.test.ts` (fixture
provisioning, its idempotency, sign-in through the password endpoint, the api checks and the teardown against an
in-process api) and `tooling/scripts/acceptance/*.test.ts` (configuration and the output lines).

The deployed acceptance of Release 1 runs **inside** the staging project as a one-off service, because our
engineering sandbox cannot reach `*.railway.app` and the GitHub Actions staging smoke job needs secrets that a person
would have to issue in the UI (`docs/runbooks/uat-journeys.md`, "Staging smoke"). The job provisions its own
throwaway fixtures directly through the application services and the database, obtains its sessions through the
deployed sign-in endpoint, drives the deployed web origin and api, and prints one line per check. No credential
passes through a person, a secret store or a report: the synthetic users' passwords are generated at run time and
exist only in the job's memory; the only inputs are the variables below.

**Never deploy this service in the production project.** It creates companies, members, a brand, content and, with
`LOAD_ENABLED=1`, scheduled publications on whatever channels its fixture brand has.

## 1. What it does

| Phase          | Flag                   | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixtures       | always                 | Two companies, **Acceptance A** (`acceptance-a`) and **Acceptance B** (`acceptance-b`), each with an operator owner (created by the bootstrap, no password, never signs in), and an owner, admin, brand manager, publisher, reviewer and creator; one brand, `Acceptance brand`, with its first standards version published and the default release policy active; an agent principal, `Acceptance agent`. Everything goes through `accessService`, `brandService`, `channelService` (no table write); re-runs reuse what exists. Each run gives every member a fresh random password through the setup-link path (the operator issues the link, the job redeems it in-process). |
| Sign-in        | always                 | Every member signs in through `POST /auth/password/sign-in` on the web origin with the `Origin` header the api checks; the session cookie's value is the bearer every later call uses (`sign-in:<company>:<role>`).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Smoke          | always                 | `tooling/scripts/smoke` (`runSmoke`) with the fixture brand manager as the smoke user: health, CSP, legal pages, brand pack, and the browser-shaped upload through the store and ingest (`smoke:*`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Isolation      | always                 | Company B's owner reads company A's brand by id, presents A's tenant header, and lists brands: refused, refused, none of A (`isolation:*`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Journey        | always                 | Through the deployed api: a content package; then, when the fixture brand has a usable channel, a variant, a review request, an external reviewer link and the reviewer's read through it, the reviewer's approval, the variant scheduled under the approval and cancelled again (`journey:*`). Without a channel the steps after the package are `SKIP` with the reason.                                                                                                                                                                                                                                                                                                        |
| Browser suites | `ACCEPTANCE_E2E` (on)  | vitest + headless Chromium against the web origin: `apps/web/e2e/deployed.e2e.test.ts` (U1 sign-in and navigation, the shell, U2 brand system read, isolation in the UI, sign-out, the a11y audit on the real home and brand system), `a11y.e2e.test.ts` on the public screens, and `studio.e2e.test.ts` in real-api mode when an approved font face exists or can be imported from Google Fonts (`e2e:<suite>:<test>`).                                                                                                                                                                                                                                                         |
| Load           | `LOAD_ENABLED=1`       | `tooling/load/top-of-hour.js` with k6 against `ACCEPTANCE_API_BASE_URL`, the fixture companies that have a usable channel, `EXPECTED_PEAK` (default 50) × `PEAK_MULTIPLIER` (default 2) scheduled publications for the next top of the hour; one `LOAD_PASS` / `LOAD_FAIL` line per threshold. Skipped (`LOAD_SKIP`) when no fixture company has a channel.                                                                                                                                                                                                                                                                                                                      |
| Model eval     | `MODEL_EVAL_ENABLED=1` | One bounded run per task kind in `MODEL_EVAL_TASK_KINDS` (default `copywriting`) under the fixture agent through the api, after setting the brand's day limit to `MODEL_EVAL_BUDGET_MICROS`; waits up to `MODEL_EVAL_TIMEOUT_MS` for a final state, then reads the steps and the settled reservation. The model call happens in staging's worker-core (which holds the model key); the job only observes.                                                                                                                                                                                                                                                                        |

**Channels.** Fixture channel connections are only ever made on a certified provider the staging api deploys (not
in `OREMEDIA_DISABLED_CHANNELS`), and never on a real account. The production registry has no certified provider
today and no fixture provider (`packages/providers/src/registry.ts`; the test fixture adapter is test-only), so the
job reports `ACCEPTANCE_INFO channels: no certified provider …`, the journey's channel steps and the load test are
skipped, and they stay skipped until a channel is certified (`certify-a-channel.md`) and connected on the fixture
brand by a person. The job never connects a channel itself.

## 2. Deploy the job as a Railway service (staging project only)

1. Railway → the **staging** project → **New service** → from this repository, root directory `/`, config-as-code
   path `infra/railway/acceptance/railway.json` (builder Dockerfile, `infra/railway/acceptance/Dockerfile`, restart
   policy never). Name it `acceptance`. Turn **off** automatic deploys on push unless every push to the branch
   should run the acceptance.
2. Start command: leave the image's default, `node apps/api/dist/acceptance-run.js`. For the teardown (section 5)
   set the start command to `node apps/api/dist/acceptance-run.js --teardown` for one deployment and put it back.
3. Variables, as **references** to the staging services' variables (names only; the values never leave Railway):

   | Variable                     | Reference / value                                                                                                                                          |
   | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `DATABASE_URL`               | the `api` service's `DATABASE_URL` (the application role suffices: the fixtures are made through the services; the migrate role also works)                |
   | `WEB_ORIGIN`                 | the `api` service's `WEB_ORIGIN` (the public staging web origin; sign-ins carry it as `Origin`)                                                            |
   | `AUTH_ALLOWED_DOMAINS`       | the `api` service's, when set: the synthetic users take the first allowed domain                                                                           |
   | `OREMEDIA_DISABLED_CHANNELS` | the `api` service's, when set                                                                                                                              |
   | `SMOKE_EXPECT_STORE_ORIGIN`  | optional: the `web` service's `OBJECT_STORE_PUBLIC_ORIGIN` (pins the CSP check)                                                                            |
   | `SMOKE_INGEST_TIMEOUT_MS`    | optional, default 120000                                                                                                                                   |
   | `ACCEPTANCE_EMAIL_DOMAIN`    | optional: the synthetic users' mail domain (default: the first `AUTH_ALLOWED_DOMAINS` entry, else `acceptance.invalid`); must be an allowed domain         |
   | `ACCEPTANCE_API_BASE_URL`    | optional: where the load test and the model evaluation call the api, e.g. the api's private URL `http://api.railway.internal:<PORT>`; default `WEB_ORIGIN` |
   | `ACCEPTANCE_E2E`             | optional: `0` skips the browser suites                                                                                                                     |
   | `LOAD_ENABLED`               | `1` runs the load test; `EXPECTED_PEAK` (50), `PEAK_MULTIPLIER` (2), `DISPATCH_WINDOW_S`, `LOAD_TARGET_AT`, `LOAD_VUS` tune it                             |
   | `MODEL_EVAL_ENABLED`         | `1` runs the model evaluation; `MODEL_EVAL_TASK_KINDS`, `MODEL_EVAL_TIMEOUT_MS` (600000), `MODEL_EVAL_BUDGET_MICROS` (250000) tune it                      |

   No `OREMEDIA_E2E_*`, `SMOKE_EMAIL`, `SMOKE_PASSWORD` or token variable exists: the job makes those values itself
   and passes them to its child processes in their environment only.

4. **Deploy**. The job needs the `api`, `web`, `worker-core` and `worker-render` services up (the upload check
   waits for ingest; the model evaluation waits for worker-core). It exits 0 when everything that ran passed and 1
   otherwise; with restart policy never, Railway shows the deployment as exited. Read the result in the deploy log.
5. To run it again, **Redeploy** the latest deployment. The fixtures are reused; the passwords are new.

## 3. Reading the log

```
ACCEPTANCE_PASS fixtures:acceptance-a ten_… brand brd_… version bv_… policy pol_… agent sp_…, 0 usable channel(s)
ACCEPTANCE_INFO channels: no certified provider in this registry (uncertified: linkedin_page, …; disabled: none)
ACCEPTANCE_PASS sign-in:acceptance-a:owner session issued through the password endpoint
ACCEPTANCE_PASS smoke:health HTTP 200, no degraded capability
ACCEPTANCE_FAIL smoke:upload:cors preflight HTTP 403 …: the bucket CORS must admit PUT from https://…
ACCEPTANCE_PASS isolation:brand-get refused with HTTP 404 NOT_FOUND
ACCEPTANCE_SKIP journey:schedule no usable channel connection on the fixture brand (…)
ACCEPTANCE_PASS e2e:deployed:U1: the owner signs in with email and password, …
LOAD_SKIP no fixture company has a usable channel connection (…)
MODEL_EVAL_PASS copywriting 4 1830
ACCEPTANCE_DONE 41/42 (7 skipped)
```

- `ACCEPTANCE_PASS <name>`, `ACCEPTANCE_FAIL <name> <reason>`, `ACCEPTANCE_SKIP <name> <reason>`: one per check.
  `ACCEPTANCE_DONE <passed>/<total>` counts the checks that ran; skips are listed, not counted. Exit 1 on any
  `ACCEPTANCE_FAIL`, `LOAD_FAIL` or `MODEL_EVAL_FAIL`.
- `LOAD_PASS <metric> <threshold> <values>` / `LOAD_FAIL …`: one per k6 threshold (`tooling/load/top-of-hour.js`:
  schedule p95 < 400 ms and p99 < 1 s, error rate < 1 %, ≥ 99 % dispatched within the window).
- `MODEL_EVAL_PASS <taskKind> <steps> <costMicros>` / `MODEL_EVAL_FAIL <taskKind> <reason>`.
- No line carries a session token, an API key, a reviewer or setup-link token, a password or a signed URL's query:
  every detail is filtered (`tooling/scripts/acceptance/report.ts`, `safeDetail`). The vitest and k6 output that
  streams between the lines is the suites' own; the suites print ids, never credentials.
- The checks run in order: fixtures, sign-in, smoke, isolation, journey, browser suites, load, model evaluation.
  A failed fixture stops the run (`ACCEPTANCE_FAIL fixtures …` then `ACCEPTANCE_DONE`); anything after runs even
  when an earlier check failed.

Record a staging pass in `docs/release/r1-evidence.md` ("UAT") with the date, the deployment and the `ACCEPTANCE_DONE`
line, never the fixture addresses' passwords (there are none to record).

## 4. Running it against a local stack

The entrypoint reads the same variables; against a local api and web (`docs/runbooks/deploy-railway.md` section 2
for the api, `pnpm --filter @oremedia/web build` served by the web container or the e2e static server) run
`pnpm --filter @oremedia/api build && DATABASE_URL=… WEB_ORIGIN=http://127.0.0.1:<port> node apps/api/dist/acceptance-run.js`.
The in-process proof is `TEST_DATABASE_URL=… pnpm test:integration apps/api/src/acceptance.integration.test.ts`,
which exercises every service path the job uses, the password endpoint and, with the test fixture provider, the
whole journey to a scheduled and cancelled publication.

## 5. Teardown: `--teardown`

A deployment with the start command `node apps/api/dist/acceptance-run.js --teardown` leaves nothing usable: every
synthetic member's password is replaced through the same setup-link path with one the job discards, and every
session of every fixture account, the operators' included, is revoked (`teardown:<company>` lines, exit 1 on a
failure). The companies, members, brand, versions and content stay: the product removes a company only through
`process-deletion-request.md`, and the next run provisions fresh credentials over the same rows. Put the start command
back afterwards.

## 6. What a run does not prove

- A real channel: no certified provider exists, so variants, review, approval, scheduling and the load test are
  skipped until one is certified and connected on `Acceptance brand` by a person (`certify-a-channel.md`).
- Google sign-in (D-03): the fixtures are password accounts; the Google path is the UAT journey U1's staging half.
- The studio suite's agent conversation and the mock-only cases, which the suite skips in real-api mode.
