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

## Rendered-article verification (PR-04)

The read-back through the API (`GET /posts/{id}?context=edit`) stays the proof that the CMS holds what was sent. The
public page is then checked against the whole approved content, not only its first and last paragraph:

- **Manifest.** The text of every block (headings, paragraphs, list items, quotes, captions, FAQ questions and
  answers) and the alt text of every image of the HTML the site was sent: the approved revision's own rendering, or
  the body of the latest edit that went through. The revision is immutable, so the manifest is the one its approval
  fixed. Text is compared entities decoded, whitespace and case folded, and with the typography WordPress applies on
  output (`wptexturize`: curly quotes, en and em dashes, the ellipsis) folded back.
- **Article region.** The page's article body is located by the destination's own selector when one is set
  (Settings → Destinations, "Article region selector": simple selectors such as `div.post-body`), then by the common
  theme defaults: `.entry-content`, `.wp-block-post-content`, `.post-content`, `[itemprop=articleBody]`, `article`,
  `main`. The first selector that names an element decides; a later one is never consulted, so a paragraph that only
  appears outside the region (a sidebar, a related-posts excerpt) does not count. Every manifest block must be in the
  region in order (extra blocks such as sharing buttons are tolerated) and every image alt must be there (lazy-loading
  attributes, `srcset` and `<noscript>` copies do not matter). An interior paragraph changed or removed fails.
- **Canonical identity.** The `<link rel="canonical">` and any HTTP `Link: <…>; rel="canonical"` header must each name
  the article (its address, or its slug's path on the site).
- **Live visibility.** A live article must not carry `noindex`/`none` in its robots or googlebot meta tags
  (`indexable`) nor in an `X-Robots-Tag` header (`header_indexable`, recognised even when the meta tags say `index`; a
  directive scoped to another crawler is ignored, one scoped to googlebot or bingbot counts). A draft is expected to be
  hidden.
- **States.** The publication screen shows four separately: write acknowledged (the CMS accepted the write), CMS
  read-back verified, rendered article verified, live visibility. A validation's outcome is `verified`, `failed` (the
  page answered and contradicts the approved content, the canonical or the visibility) or `unverified`: the page did
  not answer (a timeout, a transport failure, 5xx, 429, 408), was cut at the 2 MiB cap before the article was complete,
  or has no recognisable article region. `unverified` never counts as a pass; the publication's verification then
  reads unverified. The fetch is bounded to 2 MiB and 15 seconds through the SSRF-safe page fetch.

## Security questions

The application password is the only secret and is stored sealed; it is never returned by the API or logged. From
the disconnect on it is unusable in the product; the worker revokes it on the site and destroys it locally, and
the publication sweeper is the floor (an hour) under that destruction. The product never reads other users' content: only
the articles it created (by id) and the rendered public page.
