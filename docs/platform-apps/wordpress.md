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
   read-back precondition (PR-03: install the conditional-write plugin on the test site first, or `update` reports
   `limited`), `unpublish`, `delete` proven absent, `revoke` (the application password deleted through
   `/users/me/application-passwords`) proven by the refused `verify`, then `attest`. Set `certifiedAt` in
   `packages/providers/src/cms/wordpress/capability.ts` by hand from the attested record and record the run in D-16.
3. Per environment, the deployment decides where the certified adapter is connectable: `cms_site` stays in
   `OREMEDIA_DISABLED_SOURCES` until the pilot site is named; `operations.providers.list` (Settings → Destinations
   for owners and admins) reads `disabled` or `ready` (a CMS has no app credential references to set).
4. Connect the pilot site in Settings → Destinations (site address, username, application password): the secret is
   sealed by the broker and verified by `destinationVerifyWorkflowV1`; writes land as drafts unless the connection
   was granted live publishing.

## Site requirements

| Requirement                                                                              | Why                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| HTTPS on a public host                                                                   | The adapter refuses `http://`, credentials in the URL and private or loopback hosts (SSRF policy, every hop re-checked).     |
| REST API reachable at `/wp-json/wp/v2`                                                   | The adapter addresses posts, categories, tags and the user there; a site that disables the REST API cannot be connected.     |
| Application Passwords enabled                                                            | WordPress 5.6+, HTTPS required by WordPress itself; some security plugins disable them (re-enable for the integration user). |
| An integration user with the Editor role (Administrator only if the site requires it)    | `edit_posts` is required (verify refuses a user without it); `publish_posts` decides whether live publishing can be granted. |
| Pretty permalinks optional                                                               | `/wp-json` is served with or without them.                                                                                   |
| The Oremedia conditional-write plugin, on InnoDB tables (for edits of existing articles) | Without it the site is in **limited mode** (below): new drafts, publishes, reverts and deletes work; edits are refused.      |

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
| `GET /wp-json/oremedia/v1/capabilities`                                                           | PR-03: the conditional-write handshake before every update and on every verification (the destination records `conditional` or `limited`).                                                                                                                                                                                                                                                              |
| `POST /wp-json/oremedia/v1/posts/{id}`                                                            | PR-03: every update of an existing article (an edit, the revert to a draft): the plugin compares the stored precondition and writes in one atomic step, or answers 412 with the current post; never core's unconditional `POST /posts/{id}`.                                                                                                                                                            |
| `POST /posts/{id}` with `status=draft` only                                                       | Limited mode only: sets a live article back to a draft (the rollback of a publish); a status-only update replaces no content.                                                                                                                                                                                                                                                                           |
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

## Concurrent edits: the conditional-write plugin and limited mode (PR-03)

**What core WordPress offers.** Nothing that makes an update conditional. `POST /wp/v2/posts/{id}` applies the
fields it is given unconditionally: no `ETag` is sent and `If-Match`, `If-Unmodified-Since` or a revision
precondition are ignored. This was checked on 4 October 2026 in the sources of WordPress 7.1.2 (the current
release) and of trunk (7.2-alpha-64082: no precondition handling in `class-wp-rest-server.php` or
`class-wp-rest-posts-controller.php`), and empirically: the plugin's test suite first sends a stale write with
`If-Match` and `If-Unmodified-Since` to core's endpoint and shows it replacing another user's edit. The developer
documentation site (developer.wordpress.org) could not be reached from the build environment; the sources were read
instead. `modified_gmt` is second-granular and revisions may be disabled (`WP_POST_REVISIONS = false`), so neither
can serve as a precondition either, and a read-then-write from the client is never atomic.

**The plugin** (`infra/wordpress/oremedia-conditional-write`, GPL-2.0-or-later, PHP 7.4+, WordPress 6.0+):

- every save of a post advances a write counter in post meta (`_oremedia_write_counter`): before the row changes
  (`pre_post_update`), after its terms and meta are saved (`wp_after_insert_post`), on term changes and on
  content-relevant meta changes (editor locks excluded), each time with one atomic `UPDATE … SET meta_value =
meta_value + 1`. It depends on neither the clock nor revisions;
- `oremedia_write` on a post read with `context=edit` carries the counter and a SHA-256 fingerprint of the row (title,
  content, excerpt, status, slug, password, parent, menu order, modified instant). The adapter stores both with the
  read-back as the write token (`wpcw1:<counter>:<fingerprint>`);
- `POST /wp-json/oremedia/v1/posts/{id}` with `expected_version`, `expected_fingerprint` and `post` opens a
  transaction, locks the counter row and the post row (`SELECT … FOR UPDATE`), compares both, applies `post` through
  core's own `/wp/v2/posts/{id}` handler (its validation, permissions and hooks) in the same transaction and commits;
  otherwise it rolls back and answers 412 with the current post and token. A save that started earlier already
  advanced the counter (before its row update) and is seen; one that starts later waits on the counter row lock
  until the commit; a writer that bypasses WordPress hooks changes the row and is caught by the fingerprint;
- `GET /wp-json/oremedia/v1/capabilities` (users who can edit posts) reports the plugin, its version, protocol 1 and
  `conditional_update`, which is false unless the posts and postmeta tables are InnoDB (no transactions or row locks
  on MyISAM or a SQLite drop-in).

**Install** (the site administrator; a test site first): copy the directory `oremedia-conditional-write` (without
`tests/`) into `wp-content/plugins/` and activate it, or into `wp-content/mu-plugins/` with a loader that requires the
main file. Then run Verify on the destination in Settings → Destinations: the destination shows **Safe updates**.

**Limited mode** (no plugin, protocol mismatch, or non-transactional tables): the adapter refuses every update that
would replace content before anything is sent (`limited_mode`), with the site's current revision for the person;
creating drafts, publishing new articles, the revert to a draft (status only) and deleting still work. The
destination shows **Limited mode** in Settings → Destinations, and a refused edit on the publication shows the
website's current article beside the edit with a link to the site's editor. A handshake that cannot be read (5xx,
transport) decides nothing: the edit is retried later, never sent unconditionally.

**When an edit is refused** (`conflict`: the site moved since the stored read-back), nothing was written; the refusal
stores the current revision as the new read-back together with the site's body and the refused text, and the
publication screen sets them side by side (differing blocks marked). The person either re-applies the edit to the
current version (a new edit request whose precondition is the version shown: refused again if the site moved again)
or opens the article in the site's editor (`/wp-admin/post.php?post=<id>&action=edit`).

**What remains outside the plugin**: a later blind save by someone else (the block editor saving a screen opened
before Oremedia's write) still lands after Oremedia's write, as WordPress always behaves; Oremedia's read-back after
every write records what the site then holds.

**Tests.** The adapter's semantics are proven against a stateful WordPress-like fixture
(`packages/providers/src/testing/wordpress-site.ts`, `conditional-write.test.ts`) in `pnpm test`. The plugin itself
has a suite against a real WordPress and MySQL (no docker):

```sh
git clone --depth 1 --branch 7.1.2 https://github.com/WordPress/WordPress /tmp/wordpress
# a throwaway MySQL 8 (InnoDB) the script may create and drop databases on, reachable by socket
WP_CORE_DIR=/tmp/wordpress MYSQL_SOCKET=/path/to/mysql.sock \
  infra/wordpress/oremedia-conditional-write/tests/run.sh
```

It installs WordPress into a temporary copy, activates the plugin and runs `tests/conditional-write-test.php` twice
(revisions on, `WP_POST_REVISIONS = false`): core ignoring preconditions, the handshake, a write on the current token,
replay refused, stale writes refused with the content untouched after an edit by another user over REST, an edit by
another process, a same-second term change (row and `modified_gmt` unchanged), a same-second content save, a direct
table update, eight concurrent writes on one token (one 200, seven 412), a writer held off while the compare and
write holds its locks, a core validation failure rolled back, and MyISAM refused (501).
