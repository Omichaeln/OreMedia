# Meta platform app: Facebook Pages and Instagram

**Purpose:** everything needed to take the Meta app from development mode to live with the permissions the
`facebook_page` and `instagram_business` adapters request: app settings, credentials, the permission justifications
App Review asks for, and the screencast scripts. **Owner:** the Ore & Tar administrator of the Meta app (credentials
never pass through anyone else). **App:** OreMedia, id `1111601258212850`, one app for both adapters (Instagram uses
Facebook Login, not Instagram Login). **Controller:** Ore and Tar Enterprises (Pvt) Ltd, Harare, Zimbabwe.

## Order of work

App Review needs a screencast of each permission in use inside the product, and the product only connects a
certified provider (spec 14.6). So certification comes first, in development mode, where every permission already
works for people with a role on the app:

1. Configure the app (below) and set the credentials on Railway.
2. Certify both adapters with test accounts that hold a role on the app (`docs/runbooks/certify-a-channel.md`, steps
   2 to 11). This sets `certifiedAt` and records D-04.
3. Setting `certifiedAt` opens both providers to every tenant. The `publishing.channel.*` flags are defined, but
   connect does not check them yet (open). Until it does, development mode is the gate: only people with a role on
   the app can complete the login.
4. Record the screencasts in the review tenant (below), complete Business Verification, and submit App Review.
5. Before switching the app to live, make connect enforce the `publishing.channel.*` flags (then allowlist tenants
   in the `feature_flags` row one by one), or accept that every tenant can connect from that moment.

## App settings

| Setting                                                          | Value                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| App domains                                                      | `oremedia-production.up.railway.app`                                                      |
| Privacy policy URL                                               | `https://oremedia-production.up.railway.app/legal/privacy`                                |
| User data deletion: data deletion instructions URL               | `https://oremedia-production.up.railway.app/legal/data-deletion`                          |
| Terms of service URL                                             | leave empty (optional; there are no public terms yet)                                     |
| Category                                                         | Business and pages                                                                        |
| App icon                                                         | 1024 × 1024 PNG of the Ore & Tar mark (`apps/web/deployment-brands/ore-and-tar/logo.svg`) |
| Facebook Login: Valid OAuth Redirect URIs                        | `https://oremedia-production.up.railway.app/connect/callback` (only this one)             |
| Facebook Login: Client OAuth login, Web OAuth login              | On                                                                                        |
| Facebook Login: Enforce HTTPS, Use strict mode for redirect URIs | On                                                                                        |
| Facebook Login: Login from devices, Login with JavaScript SDK    | Off (the product uses neither)                                                            |

The legal pages are served by the web service from the Ore & Tar brand pack (`OREMEDIA_DEPLOYMENT_BRAND=ore-and-tar`)
at `/legal/*`. Both must answer 200 before Meta will save the settings. The certification harness uses its own
redirect (`/certify-callback`); add it to the list only while certifying, then remove it.

If the web service moves to a custom domain, change `WEB_ORIGIN` on the api, the redirect URI, the app domain and
both legal URLs together. A redirect URI that does not match exactly fails every connect.

## Credentials

Set these as **sealed** Railway variables on `api`, `worker-core` and `worker-ingest`. Every one of them exchanges
or refreshes tokens, and each reads both values (`providerClientsFromEnv`). Both adapters share the app, so the two
pairs hold the same id and secret:

```
PROVIDER_FACEBOOK_PAGE_CLIENT_ID_REF        = <App ID>
PROVIDER_FACEBOOK_PAGE_SECRET_REF           = <App secret>
PROVIDER_INSTAGRAM_BUSINESS_CLIENT_ID_REF   = <App ID>
PROVIDER_INSTAGRAM_BUSINESS_SECRET_REF      = <App secret>
```

Rotating the app secret means setting all four on all three services, then redeploying them together.

## Permissions and justifications

Source of truth: `requiredScopes` in `packages/providers/src/facebook_page/capability.ts` and
`packages/providers/src/instagram_business/capability.ts`. A connection that lacks any of them is not usable, so
every one must be approved or removed from the capability.

| Permission                  | Adapter(s)         | What the product does with it                                                                                                                                                | Screencast |
| --------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `pages_show_list`           | both               | Reads the Pages the person manages (`/me/accounts`) and the Instagram professional account linked to each, to connect the brand.                                             | A          |
| `pages_manage_posts`        | facebook_page      | Publishes approved posts (text, photos, video) to the connected Page at the scheduled time; on the brand's instruction, edits the text of a post it published or deletes it. | B, E       |
| `pages_read_engagement`     | both               | Reads the Page's recent posts to confirm a publish landed, and reads comments on posts the product published into the Inbox.                                                 | B, D       |
| `pages_manage_engagement`   | facebook_page      | Posts the reply a person on the brand's team writes in the Inbox to a comment on a post the product published.                                                               | D          |
| `read_insights`             | facebook_page      | Reads post and Page metrics (views, clicks, reactions, follows) for the brand's performance reports.                                                                         | C          |
| `instagram_basic`           | instagram_business | Reads the professional account's id and username, and its recent media to confirm a publish landed.                                                                          | A, B       |
| `instagram_content_publish` | instagram_business | Publishes approved images, carousels and Reels to the account at the scheduled time.                                                                                         | B          |
| `instagram_manage_comments` | instagram_business | Reads comments on published media into the Inbox (and groups them by theme), and posts a team member's reply to a comment.                                                   | D          |
| `instagram_manage_insights` | instagram_business | Reads media and account metrics (views, reach, saves, shares, interactions) for performance reports.                                                                         | C          |
| `business_management`       | both               | **Not used by any endpoint; see below.**                                                                                                                                     | –          |

Wording for every justification: "Ore & Tar is a social media agency. Our platform publishes content that the
Page's own team has written and approved, at the time they choose, and reports how it performed and what its
audience said. Only people with a role on the Page can connect it; when they manage several Pages they choose which
Page the brand connects, and they can disconnect it at any time." For `pages_manage_posts` add: "On the Page team's
instruction it also edits the text of a post it published, or deletes it."

### What the product does not do yet

Meta rejects a permission it cannot see in use, and the justifications above say only what the code does. Two
points bear on the submission; close them or remove the scope before submitting:

- **Comment authors.** The brand's own replies are recognised in comment reads by the author id (`from.id`) equal to
  the connected Page or Instagram account id. Instagram returns `from` on comments in recent Graph versions; confirm
  during certification that a reply posted through `/{comment-id}/replies` reads back with `from.id` = the account id,
  otherwise it is stored as a customer comment until the reply's own record corrects it.
- **business_management.** Requested so that `/me/accounts` returns Pages reached through a business portfolio.
  During certification, check whether business-owned client Pages appear without it: if they do, remove it from both
  capabilities; if not, keep it and show a business-owned Page in screencast A.

**Editing and deleting published posts.** On the brand's instruction (a person holding `publication.edit_remote` or
`publication.delete_remote`, never an agent), the product edits the text of a Facebook Page post it published
(`POST /{post-id}` with `message`) or deletes it (`DELETE /{post-id}`); both run under `pages_manage_posts` and are
recorded with the platform's confirmation as evidence (screencast E). Instagram cannot: the Graph API has no edit or
delete for published media, so `instagram_business` declares neither and the product tells the person to delete an
Instagram post on Instagram. No Instagram justification may mention editing or deleting.

## Review tenant and reviewer access

Meta's reviewers sign into the product, which uses Google sign-in only:

1. Create a Google account for the reviewer in a domain allowed by `AUTH_ALLOWED_DOMAINS` (for example a mailbox
   in the Ore & Tar Google Workspace). Paste its address and password only into the App Review form, and turn off
   2-step verification for it until the review ends, or reviewers cannot sign in.
2. Create a tenant named "Meta App Review" with one internal brand ("Ore & Tar Review") and invite that account as
   `admin` (the role must hold `channel.connect`; `brand_manager` does not).
3. Connect the Ore & Tar test Page and its linked Instagram professional account to that brand.
4. After the decision: delete the Google account and the tenant (`operations.deletion.request`).

## Screencast scripts

Record at 1280 × 800 or larger, in English, with no narration needed; add captions naming each permission as it is
used. One video per letter; the App Review form lets you attach the same video to several permissions.

**A. Connect (pages_show_list, instagram_basic, business_management if kept)**

1. Signed out, open the product; sign in with Google as the reviewer.
2. Open Ore & Tar Review, then Settings, then Channels.
3. Under "Connect a channel", choose Connect Facebook Page. Facebook Login opens in a new tab.
4. Show the consent screen with each permission listed; continue.
5. Back on the product, finish connecting. With a login that manages several Pages (record with one), the product
   lists them: choose the test Page and Connect selected. Show the channel listed as connected with the Page's name
   and its granted permissions, and that the other Pages were not connected.
6. Repeat with Connect Instagram Business, choosing the Instagram professional account linked to the test Page.

**B. Publish (pages_manage_posts, pages_read_engagement, instagram_basic, instagram_content_publish)**

1. In Studio, create a post with an image; submit it for review and approve it.
2. Schedule it for two minutes ahead to the Facebook Page and the Instagram account.
3. Show the calendar entry move to published; open the live post on Facebook and on Instagram in another tab.

**C. Insights (read_insights, instagram_manage_insights)**

1. Open Performance for the brand. Show the metrics for the post published in B and the account metrics.
2. Say in a caption that metrics arrive with Meta's own delay (up to 24 hours). Record C a day after B.

**D. Comments and replies (pages_read_engagement, pages_manage_engagement, instagram_manage_comments)**

1. From a separate personal account, comment on the post from B on both platforms.
2. After the next comment sync, open Inbox for the brand (as a user with the `community` or `admin` role). Show the
   conversation for the post from B on each platform with the comment and who wrote it.
3. Choose Reply on the comment, write an answer and send it. Show the reply move from Sending to Sent in the Inbox,
   then open the post on Facebook and on Instagram in another tab and show the reply under the comment.
4. Open Intelligence and show the comments grouped under "Comment clusters" (kinds and counts, never the
   commenter).

**E. Edit and delete (pages_manage_posts)**

1. Open the calendar, select the Facebook publication from B and choose Edit text; change a word and save.
2. Show the request, then the edit confirmed; open the live post on Facebook and show the new text.
3. Choose Request remote deletion, give a reason, confirm; show the publication as "Deleted from channel" and the
   post gone from the Page.
4. Select the Instagram publication from B: show that it offers neither action and says to delete it on Instagram.

## Security questions (Data Protection Assessment)

Answer from what runs today, not the target:

- **Encryption of platform data at rest:** access tokens are envelope-encrypted per credential (spec 14.7). In
  production the data keys are wrapped by `LocalKms`, whose master secret is a Railway variable on the services,
  not a managed KMS (`KMS_KEY_ID_CREDENTIALS` is the target). Say so if asked. Moving to a managed KMS before
  approval is the stronger answer.
- **Where data is stored:** Railway, United States (us-west2 for the services; confirm the bucket region).
- **Who can access it:** role- and brand-scoped access in the product; tokens are never returned by the API or
  logged.
- **Deletion:** the data deletion instructions URL. Disconnecting destroys the token at once.
