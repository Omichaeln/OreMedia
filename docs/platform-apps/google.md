# Google platform app: Analytics 4, Search Console (ledger R2-1) and Business Profile (R2-2)

**Purpose:** everything needed for the `ga4_property`, `search_console_site` and `gbp_location` source adapters to
connect a Google grant to a brand destination: the OAuth client, the redirect, the scopes and the verification
Google requires for them, and for Business Profile the separate API access Google grants per project (below). **Owner:** the Ore & Tar administrator of the Google Cloud project that already holds the sign-in OAuth client
(D-03). **Controller:** Ore and Tar Enterprises (Pvt) Ltd, Harare, Zimbabwe.

All three sources are read-only: the product reads reports and never writes to a property, a site or a location. AI search
reporting is out of scope here (D-19: an official API only when verified at implementation time, otherwise a
labelled external link; no scraping, no fabricated scores).

## Order of work

1. Configure the OAuth client (below) and set the credentials on Railway. The existing sign-in client may be reused:
   add the redirect and the scopes to it rather than creating a second client.
2. Enable the two APIs on the project: **Google Analytics Admin API** (`analyticsadmin.googleapis.com`, the account
   summaries the connect flow lists properties from) and **Google Search Console API** (`searchconsole.googleapis.com`,
   the site list). The Analytics Data API is enabled with part B (reports).
3. Certify each adapter against a property and a site the Ore & Tar account can read. This is a manual step for now:
   the certify harness (`pnpm certify`, `docs/runbooks/certify-a-channel.md`) knows channel adapters only, so the
   operator walks the connect flow, the target listing and a refresh against the real APIs, records the exchanges
   as fixtures and sets `certifiedAt` in `packages/providers/src/sources/<kind>/capability.ts` (teaching the harness
   source adapters is a follow-up on the ledger's R2-1 row). Until then the kinds are refused for tenants
   (`provider_not_certified:<kind>`) and the settings screen says so.
4. Submit the OAuth consent screen for verification (sensitive scopes, below). While the app is in testing, only the
   test users listed on the consent screen can authorise it, and their refresh tokens expire after seven days.

## OAuth client settings (Google Cloud console → APIs & Services → Credentials)

| Setting                  | Value                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Application type         | Web application                                                                                                  |
| Authorised redirect URIs | the sign-in redirect (`AUTH_REDIRECT_URI`) **and** `https://oremedia-production.up.railway.app/connect/callback` |
| Consent screen: scopes   | the two scopes below, in addition to the sign-in scopes (`openid`, `email`, `profile`)                           |
| Consent screen: app home | `https://oremedia-production.up.railway.app`                                                                     |
| Consent screen: privacy  | `https://oremedia-production.up.railway.app/legal/privacy`                                                       |

The connect flow requests `access_type=offline` and `prompt=consent` on every start, so Google issues a refresh token
each time (a returning user without the consent prompt gets none, and the grant would die with its first access
token). If the web service moves to a custom domain, change `WEB_ORIGIN` on the api, both redirect URIs and the
consent screen's URLs together (Google matches redirect URIs exactly).

## Credentials

Set these as **sealed** Railway variables on `api` (the code exchange) and `worker-core` (the daily token refresh).
One Google OAuth client serves every kind, so the pairs carry the same values (the Business Profile pair and its
enable flag are in the section below):

```
PROVIDER_GA4_PROPERTY_CLIENT_ID_REF        = <Client ID>
PROVIDER_GA4_PROPERTY_SECRET_REF           = <Client secret>
PROVIDER_SEARCH_CONSOLE_SITE_CLIENT_ID_REF = <Client ID>
PROVIDER_SEARCH_CONSOLE_SITE_SECRET_REF    = <Client secret>
```

A kind that is registered but not part of the rollout is listed in comma-separated `OREMEDIA_DISABLED_SOURCES` on
the same services (as `OREMEDIA_DISABLED_CHANNELS`); the configuration report then stops asking for its pair and
the settings screen does not offer it. Each service reports `source:<kind>` at start (runbook section 1c).

## Scopes and justifications

Source of truth: `requiredScopes` in `packages/providers/src/sources/<kind>/capability.ts`.

| Scope                                                 | Kind                  | What the product does with it                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://www.googleapis.com/auth/analytics.readonly`  | `ga4_property`        | Lists the GA4 properties the person can read (Admin API account summaries) so they choose which one the brand connects, and reads that property's reports (part B).                                                                                                        |
| `https://www.googleapis.com/auth/webmasters.readonly` | `search_console_site` | Lists the verified Search Console sites the person can read so they choose which one the brand connects, and reads that site's search analytics (part B).                                                                                                                  |
| `https://www.googleapis.com/auth/business.manage`     | `gbp_location`        | Lists the Business Profile accounts and locations the person manages so they choose which location the brand connects, and reads that location's daily performance metrics (R2-2). The Business Profile APIs accept no narrower scope; the product writes nothing with it. |

All are **sensitive** scopes: Google verifies the app before anyone outside the test-user list can grant them.
Expect the verification to ask for the privacy policy, a demonstration video of the consent flow and of the data in
use, and a justification per scope; the table above is the justification. Restricted-scope (security assessment)
requirements do not apply to these two.

Verification video, in order: sign in; open the brand, Settings, Destinations; Connect Google Analytics 4 property;
Google's consent screen with the scope; back in the product, Finish connecting and the list of properties; confirm
one; the destination listed as healthy; the same for a Search Console site; a report read from each (part B);
Disconnect, after which the grant is destroyed at once.

## Business Profile: API access, the enable flag and what is read (ledger R2-2, D-17)

The Business Profile APIs are not enabled like the others: Google grants access **per Cloud project** after an
application, and until it is granted every call answers 403 `PERMISSION_DENIED` (`SERVICE_DISABLED`). The adapter
is built and tested against fixtures, uncertified (`certifiedAt: null` in
`packages/providers/src/sources/gbp_location/capability.ts`) and **off by default**: the kind is offered only where
the deployment sets `OREMEDIA_ENABLE_GBP=1` beside its app credentials. Nothing in the build needs the access.

Order of work for the owner:

1. Apply for access: Google Cloud console → APIs & Services → the **Business Profile APIs** access request form
   (the project must have an OAuth consent screen with the organisation's contact details, and the request names
   the business, the project id and the use: reading the performance of the business's own locations). Google
   answers by email; expect weeks.
2. Once granted, enable on the project: **My Business Account Management API**
   (`mybusinessaccountmanagement.googleapis.com`, the accounts the connect flow lists), **My Business Business
   Information API** (`mybusinessbusinessinformation.googleapis.com`, each account's locations with a read mask) and
   **Business Profile Performance API** (`businessprofileperformance.googleapis.com`, the daily metrics). Request a
   quota raise if the default per-minute quota is below what the brands' locations need (one call per report, two
   reports, per location per day).
3. Add the `business.manage` scope to the consent screen and re-submit the verification (the scope is sensitive; the
   justification is the row above and the video shows the same connect flow against a location).
4. Set the sealed pair on `api`, `worker-core` and `worker-ingest` (the same OAuth client as the other two kinds):

   ```
   PROVIDER_GBP_LOCATION_CLIENT_ID_REF = <Client ID>
   PROVIDER_GBP_LOCATION_SECRET_REF    = <Client secret>
   OREMEDIA_ENABLE_GBP                 = 1
   ```

   Without `OREMEDIA_ENABLE_GBP=1` the kind stays off: the configuration report does not ask for its pair, the
   settings screen does not offer it, the sweep does not visit its destinations (and `destinations.sources.list`
   reports it `enabled: false`, as any other disabled source).

5. Certify the adapter as for the other kinds (connect flow, location listing, a refresh and a performance read
   against a location the Ore & Tar account manages) and set `certifiedAt`.

What is read, and only that (D-17: no permanent ingestion by default, restricted views with a per-data-type policy):
`gbp.performance` (the day's impressions summed over the four surfaces, website clicks, calls, direction requests,
conversations, bookings) and `gbp.surfaces` (impressions by surface), both under the `gbp.reports` data type of the
brand's source-use policy. The kind's capabilities list `read` only, so a policy cannot retain the rows: the 7-day
operational cache applies (`REPORT_CACHE_DAYS`). Google makes a day's figures final within about five days
(`latencyHours: 120`), so the sweep re-reads that far back. Reviews, local posts and replies are not read or written:
they need write access and the inbox design and stay blocked on D-17.

While the access is pending, a connected location (a project that lists accounts but whose Performance API is not
yet enabled) is not broken: the adapter classifies that 403 as `access_required`, the destination is `degraded`
with that reason in its `destination.report.fetched` audit and read again the next day; no reconnect is asked of
the person, and no retry is attempted inside the day.

## What the product stores

The grant (access token, refresh token, expiry) is sealed with a per-record data key bound to the destination
(`${tenantId}:${destinationId}`) and stored in `credential_refs`; the destination row keeps the credential's id, the
granted scopes and the token's expiry. Because the authorisation request carries `include_granted_scopes`, the
stored `grantedScopes` also list the sign-in scopes the same client was granted earlier (`openid`, `email`,
`profile`); the adapter checks only its own required scope against them. A pending flow (authorised but no target chosen yet) holds the sealed grant
for ten minutes, then it is shredded. The daily `destination-token-refresh` schedule renews tokens due within a day
and rotates the credential row; a revoked grant leaves the destination `unreachable` until a person connects it
again. Disconnecting destroys the credential. Tokens are never returned by the API, logged, or carried in events.

## Security questions

Answer from what runs today, as for the other platform apps: tokens are envelope-encrypted per credential with the
data keys wrapped by `LocalKms` (a master secret held as a Railway variable) rather than a managed KMS; data is
stored in the United States (Railway, us-west2); the api process can seal but not decrypt (wrap-only key);
disconnecting destroys the token at once; nothing is written to Google.
