# Release 2 handover (connectors)

Status of every Release 2 row at the close of the build phase, the credentials the owner connects last, the
steps only the owner can take, and what Release 3 still waits on. Verification states use the ledger's
vocabulary: FU full unit and integration coverage, LW live workflow against a database or Temporal, SB staging
browser, RP real provider, PO production observation. Figures and run numbers are from `r1-evidence.md`.

## 1. Rows

| Row  | Work package, PR       | Implemented                                                                                                                                                                                                      | Tested                                                                                      | Deployed                                             | Externally verified                                                                                                                                                                                                   |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-0 | WP-11, #15             | Brand destinations, source-use policies (per kind and data type, versioned, review date), Settings → Destinations                                                                                                | FU, cross-tenant harness, migration 0015/0016 roll-forward, mock e2e                        | 5711b3a, smoke 16                                    | PO: deployed and healthy; no real destination yet                                                                                                                                                                     |
| R2-1 | WP-12 #17, WP-13 #18   | GA4 and Search Console source adapters, OAuth connect flow, daily token refresh, report sweep (04:00 UTC), `destination_report_rows`, read model (summary, rows, opportunities), Performance → Web section       | FU incl. fixture-server adapter tests, paging, quota 429, refresh-and-retry; LW on Temporal | 884ad96 and 99953fd, migration 0017, smoke 17 and 18 | RP pending: Google platform app verification, provider refs, source certification (`pnpm certify ga4_property` / `search_console_site`, then `certifiedAt`); activation state readable in `operations.providers.list` |
| R2-2 | WP-17, #21 (read-only) | Business Profile source adapter (accounts → locations, daily performance, surfaces) behind `OREMEDIA_ENABLE_GBP`, `access_required` classification; D-17 keeps reads only, no retention by default               | FU, generic sweep/read model/prune through the fixture source                               | bec1538, smoke 21                                    | RP pending: Business Profile API access, refs, flag, certification (`pnpm certify gbp_location`, read-only); reviews/posts out of scope                                                                               |
| R2-3 | WP-14, #19             | Article document type, CMS adapter contract, WordPress REST adapter, connect a website with a sealed Application Password, destination publish path (draft by default), read-back, edit refused on drift, revert | FU incl. 401/403, conflict, paging, CHECK constraints in migration 0018                     | f42c03f, migration 0018, smoke 19                    | RP pending: pilot site named, Application Password, certification (`pnpm certify cms_site`, D-16; `docs/platform-apps/wordpress.md`)                                                                                  |
| R2-4 | WP-15, #20             | Bounded SEO audit crawler (200 pages, depth 3, 2 MiB, robots, sitemap, SSRF-pinned), weekly sweep (Mondays 05:00 UTC), on-demand run, findings with suggested tasks, Performance → Audit section                 | FU, loopback-site integration, migration 0019 roll-forward                                  | da70f0a, migration 0019, smoke 20                    | LW/SB pending: a staging site to crawl; lab data only, field data not connected                                                                                                                                       |
| R2-5 | WP-16, #22             | Overview screen and `overview.summary` read model: source-labelled figures, coverage and freshness, drill-downs, organic vs paid and Oremedia vs native stated honestly, limits panel                            | FU, integration incl. 210-publication window, cross-tenant, e2e and a11y                    | e185aa7, smoke 22                                    | SB pending: staging walk with real sources                                                                                                                                                                            |

Every row above is on the role users, with roles re-applied and `PASS` after each migration, and every deploy
confirmed by the production smoke run named.

## 2. Credentials the owner connects (handled last, by decision)

Set each on the Railway service named, in staging first and then production. Values never pass through the
assistant; the configuration report (`configuration complete` in each service log) and `/health` confirm them.

| Credential                                | Variables (api unless stated; workers reference the api)                                                                                                       | Where to obtain                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Google OAuth client (sign-in and sources) | `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` (sealed), redirect per `docs/platform-apps/google.md`                                                                   | Google Cloud console; production is set, staging holds a sample                 |
| GA4 and Search Console provider refs      | `PROVIDER_GA4_PROPERTY_CLIENT_ID_REF/_SECRET_REF`, `PROVIDER_SEARCH_CONSOLE_SITE_CLIENT_ID_REF/_SECRET_REF`; remove the kinds from `OREMEDIA_DISABLED_SOURCES` | Same OAuth client once the sensitive scopes are verified                        |
| Business Profile                          | `PROVIDER_GBP_LOCATION_CLIENT_ID_REF/_SECRET_REF` and `OREMEDIA_ENABLE_GBP=1`                                                                                  | After Google grants the project Business Profile API access                     |
| WordPress pilot site                      | No variable: each brand connects its site in Settings → Destinations with the site URL, user and Application Password                                          | The pilot site's WordPress admin (Users → Application Passwords)                |
| Model provider                            | `OPENROUTER_API_KEY_REF` (sealed), `OREMEDIA_MODEL_ID`, `OREMEDIA_IMAGE_MODEL_ID` on worker-core; worker-ingest references them                                | OpenRouter                                                                      |
| Object store                              | `OBJECT_STORE_*` on api, worker-core, worker-render                                                                                                            | Cloudflare R2 buckets and an access key                                         |
| Review-mail monitor                       | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` on approval-monitor (staging crashes on the sample values; expected)                           | A Google OAuth client with the Gmail read scope and a refresh token             |
| Meta and LinkedIn apps                    | `PROVIDER_FACEBOOK_PAGE_*`, `PROVIDER_INSTAGRAM_BUSINESS_*`, `PROVIDER_LINKEDIN_PAGE_*`                                                                        | Production is set; staging holds samples; app review per `docs/platform-apps/*` |
| Staging smoke                             | GitHub secrets `STAGING_SMOKE_BASE_URL`, `STAGING_SMOKE_*` and `STAGING_SMOKE_ENABLED=1`                                                                       | A staging smoke user created with `bootstrap-owner`                             |

## 3. Steps only the owner can take

1. Google: verify the sensitive scopes on the OAuth consent screen, then certify the GA4 and Search Console
   adapters with the harness (`docs/runbooks/certify-a-provider.md`: connect, targets, read, refresh, revoke,
   `attest`), set `certifiedAt` from the attested record; apply for Business Profile API access.
2. Meta and LinkedIn: Business Verification, App Review and the Community Management API (UX-10).
3. Name the pilot WordPress site and issue its Application Password; the adapter is certified after the harness
   walk against a test site (`pnpm certify cms_site`: write, update, unpublish, delete with read-backs, revoke,
   `attest`), per `docs/platform-apps/wordpress.md`.
4. Railway: delete the two leftover hello-world services (`alluring-bravery`, `function-bun`) behind 2FA; approve the
   deletion of the staging `mysql-restore` and `restore-rehearsal` services once an application-level restore has
   been walked on staging; rename the generated worker service names in the dashboard if wanted.
5. Approve the metric dictionary (X-5) and configure alert rules (X-6) in the monitoring system of choice.

## 4. Release 3

| Row  | State                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R3-1 | Discord announcements: deferred by D-18 (webhook only, no bot); the `discord_webhook` kind already exists                               |
| R3-2 | X and TikTok: blocked on platform apps and certification per channel; no TikTok adapter                                                 |
| R3-3 | Advanced experiments: open, no owner decision yet                                                                                       |
| R3-4 | CRM, revenue and paid-media connectors: only when a brand needs verified outcomes; the overview states paid as not connected until then |
