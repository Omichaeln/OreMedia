# LinkedIn platform app: LinkedIn Pages

**Purpose:** everything needed to take the LinkedIn app from the Community Management API development tier to the
standard tier with the scopes the `linkedin_page` adapter requests. **Owner:** the Ore & Tar administrator of the
LinkedIn app and a super admin of the Ore & Tar LinkedIn Page (credentials never pass through anyone else).
**Controller:** Ore and Tar Enterprises (Pvt) Ltd, Harare, Zimbabwe.

## Order of work

1. Configure the app (below) and set the credentials on Railway.
2. Once the Community Management API development tier is granted, certify the adapter against the Ore & Tar Page
   (`docs/runbooks/certify-a-channel.md`, steps 2 to 11). This sets `certifiedAt` and records D-04. The development
   tier is enough for this.
3. Setting `certifiedAt` opens the provider to every tenant. The `publishing.channel.linkedin_page` flag is defined,
   but connect does not check it yet (open). The development tier's limits are the only gate until then.
4. Record the screencast and apply for the standard tier.

## App settings

| Setting                                     | Value                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Company (LinkedIn Page)                     | Ore & Tar. A Page super admin verifies the app from the Page.                 |
| Privacy policy URL                          | `https://oremedia-production.up.railway.app/legal/privacy`                    |
| App logo                                    | the Ore & Tar mark, square PNG                                                |
| Auth: Authorized redirect URLs for your app | `https://oremedia-production.up.railway.app/connect/callback` (only this one) |
| Products                                    | Community Management API (see the verify note below)                          |

If the web service moves to a custom domain, change `WEB_ORIGIN` on the api, the redirect URL and the privacy URL
together.

## Credentials

Set these as **sealed** Railway variables on `api`, `worker-core` and `worker-ingest`. Each of them exchanges or
refreshes tokens, and each reads both values:

```
PROVIDER_LINKEDIN_PAGE_CLIENT_ID_REF = <Client ID>
PROVIDER_LINKEDIN_PAGE_SECRET_REF    = <Primary Client Secret>
```

## Scopes and justifications

Source of truth: `requiredScopes` in `packages/providers/src/linkedin_page/capability.ts`.

| Scope                   | What the product does with it                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openid`, `profile`     | Identifies the member who connects (`/v2/userinfo`, the `sub` only) so the connection records who granted it.                                                                                                                                                                                                                                                   |
| `rw_organization_admin` | Lists the Pages the member administers (`organizationAcls`, approved roles only) so they choose which Page the brand connects, and reads post and Page statistics (share statistics, followers, page views) for performance reports.                                                                                                                            |
| `w_organization_social` | Uploads images and video and publishes approved posts to the connected Page at the scheduled time; on the brand's instruction, edits the commentary of a post it published (`PARTIAL_UPDATE` on `/rest/posts/{urn}`) or deletes it (`DELETE /rest/posts/{urn}`); and posts as the Page the reply a team member writes in the Inbox to a comment on those posts. |
| `r_organization_social` | Reads the Page's recent posts to confirm a publish landed, and reads comments on posts the product published into the Inbox.                                                                                                                                                                                                                                    |

**Editing and deleting published posts** is in the product: a person holding `publication.edit_remote` or
`publication.delete_remote` (never an agent) asks for it on the publication, and the platform's confirmation is
recorded as evidence. Show it in the screencast after the publish: edit the text, then delete the post.

A member who administers several Pages chooses which one the brand connects; record with a member who administers
the Ore & Tar Page and at least one other, so the choice is shown.

**Comment replies, to certify:** a reply is a nested comment, created on the parent comment
(`POST /rest/socialActions/{comment URN}/comments` with `object` = the post URN and `parentComment` = the comment URN),
and the product keys it by the `$URN` in the response (or `urn:li:comment:(<post URN>,<x-restli-id>)` when only the
header carries the id), the form comment reads use. Confirm during certification: that `object` must be the post URN
(not the activity URN) for a nested comment; that the created comment's `$URN` matches what
`GET /rest/socialActions/{post}/comments` returns; and whether that read returns nested comments at all. The product
reads only the post's comment list, so if nested comments are not in it, other members' replies to a comment and the
brand's own replies are not ingested from LinkedIn (the Inbox still shows the brand's reply from the send record, and
an `outcome_unknown` reply cannot be confirmed from a later read). Reading each comment's replies would be a further
change to the adapter.

**Verify before applying:** LinkedIn has required the Community Management API to be the only product on its app.
`openid` and `profile` come from the "Sign In with LinkedIn using OpenID Connect" product. If LinkedIn will not grant
both on one app, the adapter needs another way to identify the member (for example the role assignee returned by
`organizationAcls`) and those two scopes removed from the capability. Decide during certification step 3.

**Refresh tokens:** LinkedIn issues refresh tokens only to approved partner apps. Until the app is one, access tokens
last 60 days, and each connection goes to `reconnect_needed` when its token expires.

## Standard tier application

Use case, as the form asks for it: "Ore & Tar is a social media agency in Zimbabwe. Our platform lets the teams
behind LinkedIn Pages plan, approve and schedule posts, see what their audience says about them, and see how they
performed. Only Page administrators can connect a Page, choosing which Page when they administer several, and they
can disconnect it at any time."

Screencast (one video, 1280 × 800 or larger, captions naming each scope as it is used):

1. Sign in to the product with Google, as a user with the `admin` role (it connects, approves and schedules); open the brand, then Settings, then Channels.
2. Choose Connect LinkedIn Page. Show LinkedIn's consent screen with the scopes; back on the product, finish
   connecting, choose the Ore & Tar Page among the Pages listed and Connect selected; show the channel listed as
   connected (and only that Page).
3. In Studio, create a post; submit it for review and approve it; schedule it two minutes ahead to the Page.
4. Show the calendar entry move to published, and the post live on the Page.
5. From another member, comment on the post. After the next comment sync, open Inbox and show the comment; choose
   Reply, send an answer, show it move to Sent, and show the reply under the comment on the Page. Then open
   Intelligence and show the comment counted under "Comment clusters".
6. Open Performance and show the post and Page statistics (record this part a day later).
7. Open the calendar, select the publication, choose Edit text, change a word and save; show the edit confirmed and
   the new text on the Page (`w_organization_social`). Then choose Request remote deletion, give a reason and show
   the publication as "Deleted from channel" and the post gone from the Page.
8. Open Settings, then Channels, and disconnect the Page.

## Security questions

Answer from what runs today: tokens are envelope-encrypted per credential, with the data keys wrapped by `LocalKms`
(a master secret held as a Railway variable) rather than a managed KMS; data is stored in the United States
(Railway, us-west2); tokens are never returned by the API or logged; disconnecting destroys the token at once.
