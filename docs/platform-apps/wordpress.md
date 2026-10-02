# WordPress site: the website CMS (`cms_site`)

**Purpose:** everything needed to connect a brand's WordPress site to the `cms_site` adapter (REST API v2 with an
Application Password over HTTP Basic, ledger R2-3, D-16), to certify the adapter against a test site and to activate
it per environment (RA-01). **Owner:** the site's administrator (the application password never passes through
anyone else) with the platform engineer for certification. **Decision:** D-16 keeps WordPress as the working
assumption for the pilot CMS; the adapter stays `certifiedAt: null` until the runbook is walked against a site.

## Order of work

1. Confirm the site meets the requirements (below) and create an application password for the integration user.
2. Certify the adapter against a **test** site, never the pilot's live site, with the harness (`pnpm certify cms_site …`,
   `docs/runbooks/certify-a-provider.md`): `connect` (verify), `write` (a draft) and its read-back, `update` under the
   read-back precondition, `unpublish`, `delete` proven absent, `revoke` (the application password deleted through
   `/users/me/application-passwords`) proven by the refused `verify`, then `attest`. Set `certifiedAt` in
   `packages/providers/src/cms/wordpress/capability.ts` by hand from the attested record and record the run in D-16.
3. Per environment, the deployment decides where the certified adapter is connectable: `cms_site` stays in
   `OREMEDIA_DISABLED_SOURCES` until the pilot site is named; `operations.providers.list` (Settings → Destinations
   for owners and admins) reads `disabled` or `ready` (a CMS has no app credential references to set).
4. Connect the pilot site in Settings → Destinations (site address, username, application password): the secret is
   sealed by the broker and verified by `destinationVerifyWorkflowV1`; writes land as drafts unless the connection
   was granted live publishing.

## Site requirements

| Requirement                                                                           | Why                                                                                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| HTTPS on a public host                                                                | The adapter refuses `http://`, credentials in the URL and private or loopback hosts (SSRF policy, every hop re-checked).     |
| REST API reachable at `/wp-json/wp/v2`                                                | The adapter addresses posts, categories, tags and the user there; a site that disables the REST API cannot be connected.     |
| Application Passwords enabled                                                         | WordPress 5.6+, HTTPS required by WordPress itself; some security plugins disable them (re-enable for the integration user). |
| An integration user with the Editor role (Administrator only if the site requires it) | `edit_posts` is required (verify refuses a user without it); `publish_posts` decides whether live publishing can be granted. |
| Pretty permalinks optional                                                            | `/wp-json` is served with or without them.                                                                                   |

## Credentials

Nothing on the api or the workers: the integration identity (username and application password) is entered once
per brand in Settings → Destinations and sealed per destination (`credential_refs`, AES-256-GCM with a per-record
data key wrapped by the KMS). The configuration report line `cms:wordpress` reports the adapter as present unless
`cms_site` is listed in `OREMEDIA_DISABLED_SOURCES`. Rotating the password means revoking it on the site and
reconnecting the destination with the new one.

## What the product does on the site

Source of truth: `packages/providers/src/cms/wordpress/adapter.ts`.

| Call                                                                                              | What the product does with it                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /users/me?context=edit`                                                                      | Verifies the identity and its capabilities (the connect flow's health check, the daily refresh, `verify` in the harness).                                                                                                                                                                                                                                                                               |
| `POST /posts`                                                                                     | Creates the article as a draft (or published, only where the connection was granted live publishing).                                                                                                                                                                                                                                                                                                   |
| `GET /posts/{id}?context=edit`                                                                    | Reads the article back after every write (identity, status, content hash, modified instant: the evidence).                                                                                                                                                                                                                                                                                              |
| `POST /posts/{id}`                                                                                | Updates the article only when the remote still matches the read-back (hash and modified instant); otherwise `conflict`.                                                                                                                                                                                                                                                                                 |
| `POST /posts/{id}` with `status=draft`                                                            | Sets a live article back to a draft (the rollback of a publish).                                                                                                                                                                                                                                                                                                                                        |
| `DELETE /posts/{id}`                                                                              | Moves the article to the site's bin.                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /categories`, `GET /tags`, `POST …`                                                          | Resolves the article's terms by exact name, creating missing ones.                                                                                                                                                                                                                                                                                                                                      |
| `GET /users/me/application-passwords/introspect`, `DELETE /users/me/application-passwords/{uuid}` | A disconnect leaves the sealed secret, unusable from that moment (only the revoke may open it), to `destinationRevokeWorkflowV1` (worker-core), which revokes the application password in use, records `destination.remote_revoke` and destroys the stored secret whatever the site answered; the publication sweeper shreds any secret still intact an hour later (`destination.credential_shredded`). |

The rendered page is fetched without credentials for validation (bounded size, the site's own host, redirects
re-checked hop by hop).

## Security questions

The application password is the only secret and is stored sealed; it is never returned by the API or logged. From
the disconnect on it is unusable in the product; the worker revokes it on the site and destroys it locally, and
the publication sweeper is the floor (an hour) under that destruction. The product never reads other users' content: only
the articles it created (by id) and the rendered public page.
