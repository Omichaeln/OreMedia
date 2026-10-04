# Runbook: certify a provider (channel, source or CMS)

**Purpose:** move a provider adapter from `certifiedAt: null` (its registry refuses it for tenants) to certified
(spec 14.6), and certify each of its capabilities on its own (PR-06, "Certification per capability" below): a
provider-level `certifiedAt` opens the registry, and every capability it offers stays refused or labelled until
its own record exists. One procedure for the three kinds (RA-01): a channel (`linkedin_page`, `instagram_business`,
`facebook_page`, `x`), a source (`ga4_property`, `search_console_site`, `gbp_location`, read-only under D-17) and a
CMS destination (`cms_site`, WordPress). Certification means: the connect proven with a test account, a read, a
write where the kind writes with its read-back, refresh and reconnect, revoke, rate-limit behaviour, error fixtures
captured. **Owner:** platform engineer with the platform's developer app (channels, sources) or the pilot site's
application password (CMS). **Exercised:** the harness runs end to end against the fixture adapters in CI
(`apps/worker-core/src/certify-harness.integration.test.ts`: every required step of each kind, `attest` refusing
before the last step passed); the live runs need each platform's app or site.

Code lives in `packages/providers/src/<key>/` (channels), `packages/providers/src/sources/<kind>/` and
`packages/providers/src/cms/wordpress/`; handwritten fixtures in each `fixtures/*.json` are served by
`packages/providers/src/testing/fixture-server.ts` through the real `ProviderIO`. Platform apps and credentials:
`docs/platform-apps/` (`meta.md`, `linkedin.md`, `x.md`, `google.md`, `wordpress.md`).

## Certification per capability (PR-06)

A provider marked certified says nothing about which capabilities were exercised, so each capability is certified on
its own, with its own evidence. The certifiable capabilities are `connect`, `page_picker`, `publish_text`,
`publish_image`, `publish_video`, `edit`, `delete`, `comment_reply`, `analytics`, `token_refresh` and `reconnect`
(`CertifiableCapability` in `packages/contracts/src/providers.ts`). Which of them a provider offers is derived
from its capability register and adapter methods (`channelCapabilitySupport`, `sourceCapabilitySupport`,
`cmsCapabilitySupport` beside each registry); the others are `not supported` whatever is recorded.

Rules for every run:

- **Designated test resources only.** Use the test accounts, test pages, test properties and the test site named
  for certification (`docs/platform-apps/`). Never a client's account, page, property or site, never a client's
  content (posts, images, videos, comments) and never the pilot's live site: every post, reply, edit and delete
  the harness makes is test material written for the run.
- **One capability, one proof.** A capability is attested only when its own steps passed (`CAPABILITY_STEPS` in
  `tooling/scripts/certify/harness.ts`); a run that exercises text publishing certifies `publish_text` and nothing
  else. A failed step replaces an earlier pass.
- **Unknown means uncertified.** A capability without a record is uncertified; nobody adds a record without the
  attested run behind it.

| Capability      | Channel harness command (step)                         | Source (step)                  | CMS (step)                                                       |
| --------------- | ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------- |
| `connect`       | `exchange` with every required scope (`connect`)       | `exchange` (`connect`)         | `connect` (`connect`)                                            |
| `page_picker`   | `select-account` (`page_picker`)                       | `targets --target` (`targets`) | not supported                                                    |
| `publish_text`  | `publish --text` without media (`publish_text`)        | not supported                  | `write` (`write`)                                                |
| `publish_image` | `publish --image` (`publish_image`)                    | not supported                  | no harness command yet: stays uncertified                        |
| `publish_video` | `publish --video` (`publish_video`)                    | not supported                  | not supported                                                    |
| `edit`          | `edit-post`, read back by reconciliation (`edit`)      | not supported                  | `update` and `unpublish`, each read back (`update`, `unpublish`) |
| `delete`        | `delete-post`, proven absent (`delete`)                | not supported                  | `delete`, proven absent (`delete`)                               |
| `comment_reply` | `comments --reply` accepted (`comment_reply`)          | not supported                  | not supported                                                    |
| `analytics`     | `metrics` with at least one point (`metrics`)          | `read` (`read`)                | not supported                                                    |
| `token_refresh` | `refresh` (`refresh`)                                  | `refresh` (`refresh`)          | not supported (an Application Password does not expire)          |
| `reconnect`     | `exchange` passing after the revoke step (`reconnect`) | the same (`reconnect`)         | `connect` passing after the revoke step (`reconnect`)            |

`attest --environment <name>` (step 12) writes, beside the provider record, one entry per capability whose steps
passed: `{ certifiedAt, environment, evidence }`. Copy each into the adapter capability's `certifications`
(`capability.ts`), adding the decision log entry to `evidence` (for example
`DECISIONS.md D-04 run 2026-10-12; recordings 2026-10-12T09-14-03-512Z-publish.json`), and update the row in
`docs/release/connection-inventory.md` in the same change: `tooling/scripts/certify/inventory.test.ts` fails while
the two disagree. `environment` names the deployment whose platform app the run used (`staging`, `production`).

What the product does with a capability that is not certified on a certified provider (the same refusal as an
uncertified provider, `CAPABILITY_UNSUPPORTED` with `capability_not_certified:<key>:<capability>`):

- `connect`, `page_picker`, each publish kind, `edit`, `delete` (an article unpublish counts as `edit`) and
  `comment_reply` are **blocked** server side: connect start and completion, the account or target choice, variant
  validation (so the release check `capability_valid` fails), `publication.edit_remote` / `delete_remote` and the
  inbox reply all refuse.
- `analytics`, `token_refresh` and `reconnect` are **labelled**: Settings → Channels and Settings → Destinations
  show every capability's state (`operations.providers.list`), but metrics collection, report reads and token
  refresh keep running, since stopping them would break a live connection rather than protect it.

## What a provider's evidence must contain

The harness records every step in `.certify/<provider>/session.json` and attests only when all of the kind's steps
passed (`REQUIRED_STEPS` in `tooling/scripts/certify/harness.ts`):

| Kind    | Required steps, in order                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| channel | `connect` (every required scope granted), `publish` (accepted or completed), `find` (found by reconciliation), `refresh`, `metrics` (at least one declared metric returned), `comments`, `revoke`                            |
| source  | `connect` (every required scope granted), `targets` (at least one readable), `read` (one report page), `refresh`, `revoke`                                                                                                   |
| cms     | `connect` (identity verified), `write` (a draft created and read back with the same hash), `update` (under the read-back precondition, read back), `unpublish` (read back as a draft), `delete` (read back absent), `revoke` |

`revoke` passes when the adapter's `revokeAccess` revoked the grant (the same call a disconnect makes in production)
**and** the next `refresh` (`verify` for a CMS) reports `reconnect_required`; an adapter without a remote revoke is
revoked by hand at the platform and the refused refresh is the proof. A failed step replaces an earlier pass: the
latest run counts.

## Procedure (per provider)

1. Create the platform app or the site identity (settings, credentials, justifications and screencast scripts:
   `docs/platform-apps/`), request the scopes listed in the adapter's `capability.requiredScopes`, complete app
   review where the platform requires it (after certification: the screencasts need the certified provider), and
   store the client id and secret in the secret manager (Appendix A); adapters never read environment variables.
   Register the product's callback as the app's redirect URI: `https://<web domain>/connect/callback`, the same
   for every brand and tenant (`WEB_ORIGIN` on the api). A CMS site needs an application password for an editor
   (`docs/platform-apps/wordpress.md`), nothing on the api.
2. Re-derive the pinned API versions from the platform's current docs and update the constant if needed:
   `LINKEDIN_VERSION` (`linkedin_page/adapter.ts`, YYYYMM, sunset after ~12 months), `META_GRAPH_VERSION`
   (`facebook_page/graph.ts`, shared with Instagram), X API v2 base (`x/adapter.ts`), the Google API versions
   (`sources/<kind>/adapter.ts`), `WP_REST_ROOT` (`cms/wordpress/adapter.ts`).
3. Connect a test account (`auth-url` and `exchange`; a CMS: `connect`): verify `authorizationUrl` (state echoed;
   PKCE on X and Google), `exchangeCode` (grant, `grantedScopes`, `alternatives` for multi-page/organisation
   grants, `selectAccount`), and `missingScopes` against `requiredScopes`; a source lists its `targets` and one is
   chosen; a CMS `verify` proves the identity can edit posts.
4. Write where the kind writes. Channel: publish to the test page/account: text only, single image, carousel,
   video; confirm the `accepted`/`pending` outcome, the `checkStatus` → `ready` → `finalize` → `completed`
   sequence, and the spec 20.3 invariant: call `pending-status` again after `finalize` and observe `completed`,
   never `ready`. CMS: `write` (a draft), `update`, `unpublish`, `delete`, each read back.
5. Read. Channel: read back the post by id and through `findRemotePost` (`find`): prove `found`; delete the post
   and prove `definitely_absent`; break the scan (revoke read scope) and prove `cannot_determine`. Source: `read`
   one report of the chosen target. CMS: the read-backs of step 4.
6. Capture every fixture in the table below from the real platform (redact tokens with `redactBody` before
   saving), replacing the handwritten JSON, and re-run `pnpm exec vitest run --project unit packages/providers`.
7. Refresh and reconnect: let the token approach expiry and run `refresh`; after step 11's revoke, `refresh` must
   report `reconnect_required` (a CMS: `verify`).
8. Rate limits: drive the platform to a 429 on a read and record the headers; confirm the platform documents the
   429 as not executed for the publish mutation (the adapters classify 429 as `rate_limited` with
   `phase: 'before_send'`). If a platform executes a throttled mutation, change that adapter's `classifyError` to
   return `unknown` for 429.
9. Metrics (channels): fetch post and account metrics at +1h and +24h; check every `nativeName` in
   `capability.analytics` is returned or recorded as `unavailable` (never zero); adjust the metric list to what
   the platform currently serves.
10. Comments (channels): read a page with `fetchComments` (cursor paging) and reply with `comment`.
11. Revoke: `revoke` asks the platform through the adapter's `revokeAccess` (Meta `DELETE /me/permissions`,
    LinkedIn `/oauth/v2/revoke`, X `/2/oauth2/revoke`, Google `/revoke`, WordPress
    `/users/me/application-passwords`); then `refresh` (`verify`) proves `reconnect_required`.
12. `status` shows every required step with what its run established, and every capability with whether its
    steps passed; `attest --environment <name>` writes `.certify/<provider>/certification.json` with the steps, a
    `certifiedAt`, the environment and one entry per capability whose steps passed, and refuses while a required
    step is missing. Record the run in `docs/decisions/DECISIONS.md` (D-04 channels, D-16 CMS, the Google rows), set
    `certifiedAt` in the adapter's `capability.ts` to the attested value and copy the capability entries into its
    `certifications` by hand (the harness never edits code), and update `docs/release/connection-inventory.md`.
    Only then does the registry's `get(key)` hand the adapter to tenants, each capability only once it has its
    record, and `operations.providers.list` reads `ready` once `connect` is certified, the deployment has the
    credentials set and the key is not disabled.

## Running the certification harness

The tenant connect flows refuse uncertified providers by design (spec 14.6), so steps 3 to 12 are run with the
certification harness instead: `pnpm certify <provider> <command>` (`tooling/scripts/certify/`). It drives the real
adapter against the platform from your machine, through the same `ProviderIO` production uses (SSRF guard, timeouts,
rate limiter), reaching the uncertified adapter through the registries' `forCertification`. The provider's kind is
found in the registries and decides which commands apply. It never touches the database, the API or any tenant:
what the running product allows is unchanged.

Setup, once per provider:

1. In the platform app, register a redirect URI that nothing in the product handles, for example
   `https://oremedia-production.up.railway.app/certify-callback`. After consent the browser lands there (a not-found
   page) with `?code=…&state=…` in the address bar. Never use the product's own channel callback: it would consume the
   single-use code. A CMS site needs no redirect.
2. Meta: while the app is unpublished (development mode), only people with a role on the app (administrator,
   developer, tester) can authorise it. Use a test Page and Instagram professional account owned by such a person.
   LinkedIn: the Community Management API must be granted before organisation posting works. X: the app's
   project must hold a tier that serves `search/recent` (comments). Google: the OAuth client's test users while the
   consent screen is unverified; the Business Profile API access must be granted for `gbp_location`. WordPress: a
   test site (never the pilot's live site) with an editor's application password.
3. In your shell, set `PROVIDER_<KEY>_CLIENT_ID_REF` and `PROVIDER_<KEY>_SECRET_REF` (the same names the product reads),
   e.g. `PROVIDER_FACEBOOK_PAGE_CLIENT_ID_REF`, `PROVIDER_GA4_PROPERTY_CLIENT_ID_REF`. A CMS needs none.

Commands, by runbook step (`pnpm certify <provider> …`):

| Step | Channel                                                                                                                                                                                                                                                                                                                              | Source                                                                                                            | CMS                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 3    | `auth-url --redirect-uri <uri>`, open the URL, approve, then `exchange --code <code> --state <state>`; the output lists granted and missing scopes and the other pages the login can address (`select-account --account <id>` switches)                                                                                              | `auth-url --redirect-uri <uri>`, `exchange --code <code> --state <state>`, then `targets [--target <externalId>]` | `connect --site https://… --username <u> --secret <application password>` (runs `verify`)                                    |
| 4    | `publish --text "…"` alone (`publish_text`), with `--image url,mime,width,height,bytes[,alt]` (`publish_image`) or `--video url,mime,width,height,bytes,durationMs` (`publish_video`), media at a public HTTPS URL; then `pending-status` and `finalize` while pending; `pending-status` again after `finalize` must say `completed` | n/a (read-only)                                                                                                   | `write --title "…" --html "<p>…</p>"` (a draft; `--publish` only on a test site), `update --html "…"`, `unpublish`, `delete` |
| 5    | `find` after publishing (`found`), after deleting the post on the platform (`definitely_absent`), after removing the read permission (`cannot_determine`); `edit-post --text "…"` (`edit`) and `delete-post` (`delete`) on the last publish, each read back                                                                          | `read [--report <key>] [--days <n>]`                                                                              | the read-backs of step 4                                                                                                     |
| 7    | `refresh`                                                                                                                                                                                                                                                                                                                            | `refresh`                                                                                                         | `verify`                                                                                                                     |
| 9    | `metrics --hours 1` and `metrics --hours 24` (post), `metrics --account-metrics`; the output lists declared metrics not returned and those reported unavailable                                                                                                                                                                      | n/a                                                                                                               | n/a                                                                                                                          |
| 10   | `comments` (add `--cursor` to page), `comments --reply "…"`                                                                                                                                                                                                                                                                          | n/a                                                                                                               | n/a                                                                                                                          |
| 11   | `revoke`, then `refresh` (must report `reconnect_required`); then `auth-url` and `exchange` again (`reconnect`)                                                                                                                                                                                                                      | `revoke`, then `refresh`                                                                                          | `revoke`, then `verify`                                                                                                      |
| 12   | `status`, `attest --environment <name>`                                                                                                                                                                                                                                                                                              | `status`, `attest --environment <name>`                                                                           | `status`, `attest --environment <name>`                                                                                      |

Every request and response is recorded under `.certify/<provider>/recordings/<time>-<command>.json`, with credential
query parameters and token fields redacted and only rate-limit and request-id headers kept: copy the exchanges the
fixture table needs from there (step 6). The test account's tokens (a CMS: the application password) stay in
`.certify/<provider>/session.json` (mode 0600, git-ignored, skipped by `check:secrets`) until
`pnpm certify <provider> forget`; the attested record (`certification.json`, no credentials in it) stays. Step 8
(driving a 429) is done by hand against a read endpoint; record the headers from the recording.

## Per-environment activation after certification

Certification opens the registry; the deployment still decides where a provider is connectable. `operations.providers.list`
(owners and admins; Settings → Channels and Settings → Destinations show it) reports every registered provider with
`certifiedAt`, whether it is listed in `OREMEDIA_DISABLED_CHANNELS` / `OREMEDIA_DISABLED_SOURCES` (or behind an
opt-in such as `OREMEDIA_ENABLE_GBP` that is off), which `PROVIDER_<KEY>_*` references the process reads are set (names
only, never values), and the state derived from those facts: `uncertified`, `disabled`, `credentials_missing` or
`ready`. The connect flows refuse anything but `ready` with the same reason, so the screens say why instead of
failing generically.

## Fixtures each adapter needs captured

Channels (sources and the CMS keep their fixtures in `sources/<kind>/fixtures/auth.json`, `reports.json` and
`cms/wordpress/fixtures/articles.json`, `access.json`: exchange, refresh ok and revoked, revoke ok and refused,
targets, report pages, verify, create, update, conflict, unpublish, delete):

| Scenario                                 | linkedin_page                                                        | instagram_business                                                | facebook_page                                 | x                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Auth exchange (+ identity, account list) | `auth.json/exchange`                                                 | `auth.json/exchange`                                              | `auth.json/exchange`                          | `auth.json/exchange`                                                 |
| Refresh ok / refresh refused             | `auth.json/refresh_ok`, `refresh_revoked`                            | `auth.json/refresh_ok`, `refresh_revoked`                         | `auth.json/refresh_ok`, `refresh_revoked`     | `auth.json/refresh_ok`, `refresh_revoked`                            |
| Revoke ok / already gone / refused       | `auth.json/revoke_ok`, `revoke_refused`                              | `auth.json/revoke_ok`, `revoke_already_gone`, `revoke_refused`    | same as Instagram                             | `auth.json/revoke_ok`, `revoke_refused`                              |
| Publish success (text)                   | `publish.json/text_success`                                          | n/a (media required)                                              | `publish.json/text_success`                   | `publish.json/text_success`                                          |
| Publish → pending (media processing)     | `publish.json/image_pending`                                         | `publish.json/image_pending`, `carousel_pending`                  | `publish.json/video_pending`                  | `publish.json/video_pending`                                         |
| Pending → processing / ready / failed    | `pending.json/check_*`                                               | `pending.json/check_*`                                            | `pending.json/check_*`                        | `pending.json/check_*`                                               |
| Finalize → completed                     | `pending.json/finalize_completed`                                    | `pending.json/finalize_completed`                                 | n/a (no finalize)                             | `pending.json/finalize_completed`                                    |
| Finalize already completed (20.3)        | `pending.json/check_after_finalize`, `finalize_duplicate_then_found` | `pending.json/finalize_already_published`, `check_after_finalize` | `pending.json/check_completed` (repeatable)   | `pending.json/check_after_finalize`, `finalize_duplicate_then_found` |
| Rejected with a validation body          | `publish.json/rejected_validation`                                   | `publish.json/rejected_validation`                                | `publish.json/rejected_validation`            | `publish.json/rejected_validation`                                   |
| Rate limited with headers                | `publish.json/rate_limited`                                          | `publish.json/rate_limited`                                       | `publish.json/rate_limited`                   | `publish.json/rate_limited`                                          |
| 401 / token expired, revoked             | `publish.json/expired_token`, `revoked_token`                        | `publish.json/expired_token`, `revoked_token`                     | `publish.json/expired_token`, `revoked_token` | `publish.json/expired_token`, `suspended`                            |
| 5xx after send                           | `publish.json/server_error_after_send`                               | `pending.json/finalize_5xx`                                       | `publish.json/server_error_after_send`        | `publish.json/server_error_after_send`                               |
| Timeout after send                       | `publish.json/timeout_after_send`                                    | `pending.json/finalize_hang`                                      | `publish.json/timeout_after_send`             | `publish.json/timeout_after_send`                                    |
| Connection refused before send           | closed loopback port (no fixture)                                    | closed loopback port                                              | closed loopback port                          | closed loopback port                                                 |
| Reconciliation found / absent / cannot   | `reconcile.json/found`, `absent`, `cannot_determine`                 | same                                                              | same                                          | same (+ t.co restoration)                                            |
| Metrics page (post, account)             | `read.json/post_metrics`, `account_metrics`                          | same                                                              | same                                          | same                                                                 |
| Comments page + reply                    | `read.json/comments_page`, `comment_reply`                           | same                                                              | same                                          | same                                                                 |

## Known unverified points to close during certification

- Every adapter: the revocation endpoint's answer to a token already revoked (the adapters treat the documented
  cases as `revoked`; anything else is recorded as `failed` and the credential is destroyed locally regardless).

- LinkedIn Page: the organisation ACL projection and role filter; refresh tokens only for approved partner apps; Posts API
  `q=author` scan ordering and page size; `x-restli-id` on 201; alt text limit 4086; per-member/app throttles.
- Instagram: `alt_text` on containers; creating the CAROUSEL parent before children finish; `views` replacing
  `impressions`; 25 posts / 24 h publishing cap (`content_publishing_limit`, not enforced by the limiter); whether
  the user or the page token is required for publishing under the app's login type.
- Facebook: `alt_text_custom` on `/photos`; multi-photo count limit; post/page insight names after Meta's
  impressions deprecation; renewal of a still-valid long-lived user token via `fb_exchange_token`.
- X: tier-dependent rate limits and access to `search/recent` (replies) and `non_public_metrics`; `POST /2/media/metadata`
  for alt text; APPEND chunk size; bare-domain URL detection in weighted counting.
