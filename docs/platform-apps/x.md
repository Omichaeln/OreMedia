# X platform app: X accounts (`x`)

**Purpose:** everything needed to take the X developer app from a free project to a tier that serves the `x` adapter
(OAuth 2.0 with PKCE, posts with media, replies through `search/recent`, metrics), and to certify and activate the
adapter per environment (RA-01). **Owner:** the Ore & Tar administrator of the X developer account (credentials
never pass through anyone else). **Decision:** D-04 moved X to Release 2; the adapter is built as the fourth
channel and stays `certifiedAt: null` until the runbook is walked. **Controller:** Ore and Tar Enterprises (Pvt)
Ltd, Harare, Zimbabwe.

## Order of work

1. Create the project and app in the X developer portal, configure it (below) and set the credentials on the
   Railway services that need them.
2. Choose the API tier: the free tier serves posting only; `search/recent` (the comment reads the Inbox depends on)
   and `non_public_metrics` need Basic or above. The capability's `comments.read` and the post metric list assume
   Basic; certification step 9 and 10 adjust them to what the tier serves.
3. Certify the adapter against a test account with the harness (`pnpm certify x …`,
   `docs/runbooks/certify-a-provider.md`): connect, publish (text, image, video), find, refresh (refresh tokens
   rotate on every refresh), metrics, comments, revoke (`POST /2/oauth2/revoke`) proven by the refused refresh,
   then `attest`. Set `certifiedAt` in `packages/providers/src/x/capability.ts` by hand from the attested record and
   record the run in D-04.
4. Per environment, the deployment decides where the certified adapter is connectable: the key stays in
   `OREMEDIA_DISABLED_CHANNELS` until the credentials are set on the api, worker-core and worker-ingest;
   `operations.providers.list` (Settings → Channels for owners and admins) reads `disabled`, then
   `credentials_missing`, then `ready`.

## App settings

| Setting                     | Value                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| App type                    | Web App, Automated App or Bot (confidential client: the token endpoint takes Basic auth)   |
| App permissions             | Read and write (posting, media upload, deleting own posts); Direct messages off            |
| Callback URI / Redirect URL | `https://oremedia-production.up.railway.app/connect/callback` (only this one)              |
| Website URL                 | `https://oremedia-production.up.railway.app`                                               |
| Privacy policy, Terms       | `https://oremedia-production.up.railway.app/legal/privacy` (terms left empty)              |
| OAuth 2.0                   | On, with PKCE (the adapter sends `code_challenge_method=S256` and refreshes with rotation) |

The legal pages are served by the web service from the Ore & Tar brand pack at `/legal/*`. The certification harness
uses its own redirect (`/certify-callback`); add it to the callback list only while certifying, then remove it.

If the web service moves to a custom domain, change `WEB_ORIGIN` on the api, the callback URI and the website URL
together. A callback URI that does not match exactly fails every connect.

## Credentials

Set these as **sealed** Railway variables on `api`, `worker-core` and `worker-ingest`. Each of them exchanges or
refreshes tokens, and each reads both values (`providerClientsFromEnv`); the configuration report line
`channel:x` names the missing one:

```
PROVIDER_X_CLIENT_ID_REF = <OAuth 2.0 Client ID>
PROVIDER_X_SECRET_REF    = <OAuth 2.0 Client Secret>
```

Rotating the client secret means setting both on all three services, then redeploying them together. While the
adapter is uncertified or the credentials are not set, keep `x` in `OREMEDIA_DISABLED_CHANNELS` on every service so
the configuration report does not ask for them.

## Scopes and justifications

Source of truth: `requiredScopes` in `packages/providers/src/x/capability.ts`.

| Scope            | What the product does with it                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `users.read`     | Identifies the account that connects (`GET /2/users/me`: id and username) so the connection records who granted it and links to its posts.      |
| `tweet.read`     | Reads the account's recent posts to confirm a publish landed, reads post and account metrics, and reads replies to posts the product published. |
| `tweet.write`    | Publishes approved posts at the scheduled time; on the brand's instruction deletes a post it published; posts the reply a team member writes.   |
| `media.write`    | Uploads images, GIFs and video (chunked INIT / APPEND / FINALIZE) for the posts it publishes.                                                   |
| `offline.access` | Receives a refresh token so the connection outlives the two-hour access token; refresh tokens rotate and the product keeps only the latest one. |

**Editing published posts** is not offered (the capability declares `edit: false`): X allows edits to a post only
briefly after publishing and only on some plans. Deleting is (`delete: true`, `DELETE /2/tweets/{id}`).

**Revoking:** a disconnect in the product asks X to revoke the refresh token (`POST /2/oauth2/revoke`, RFC 7009) and
destroys the stored credential whatever X answers; the outcome is in the audit trail (`channel.remote_revoke`).

## What the product stores

The connection row (account id, username, granted scopes, token expiry, health) and the sealed token envelope
(`credential_refs`, AES-256-GCM with a per-record data key wrapped by the KMS); never a token in logs, events,
Temporal payloads or the API. Published posts keep their id and URL as evidence; replies read from `search/recent`
keep the reply id, text and a salted author hash, never the author's id.

## Security questions

Answer from what runs today: tokens are envelope-encrypted per credential, with the data keys wrapped by `LocalKms`
(a master secret held as a Railway variable) rather than a managed KMS; data is stored in the United States
(Railway, us-west2); tokens are never returned by the API or logged; disconnecting revokes the token at X and
destroys it locally.
