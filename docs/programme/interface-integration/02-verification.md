# Verification

Kept per PR. "Locally verified" means the built application against the in-process mock transport in Chromium;
"externally verified" means a deployed environment and real providers; "unverified" is said as such.

## Foundation (PR: tokens, Lato, shell, primitives, Portfolio, Home)

| Check                                                                                       | Result                                                                                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/ui typecheck`, `pnpm --filter @oremedia/web typecheck`             | pass                                                                                                                       |
| `pnpm lint`                                                                                 | pass                                                                                                                       |
| `pnpm vitest run --project unit apps/web packages/ui`                                       | 171 tests pass                                                                                                             |
| e2e (built app, mock transport): shell, responsive, deployment-brand, a11y, journey, agents | see the PR description for the run                                                                                         |
| Screenshots                                                                                 | prototype vs application at 1440 and 390 px for Portfolio and Home (PR description); other screens follow in their own PRs |

Deviations recorded in this PR: the interface's lighter glyph colours (`#CFCAC1` separators, `#9A958C` chevrons,
arrows and placeholders) read below 4.5:1 on its surfaces, so glyphs and placeholders use the muted text colour
(`#6F6B64`, 4.9:1) and the lighter value is reserved for non-text marks; D-28 (Inbox kept, Overview under Performance, account menu), D-30 (home's "+ New
document"), the Portfolio's per-brand channel flags (the interface shows "Instagram token expires in 4 days" per
brand; the application shows the brand's setup state here and channel health on the brand's Settings and Calendar,
since reading every brand's channels on the portfolio would be one request per brand).

## Review and the external portal (PR: `claude/ui-review`, base `claude/ui-foundation`)

| Check                                                                          | Result                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @oremedia/web typecheck`                                        | pass                                                                                                                           |
| `pnpm lint`                                                                    | pass                                                                                                                           |
| `pnpm vitest run --project unit apps/web packages/ui`                          | pass (the review-attention file gains 5 tests for the new derivations)                                                         |
| e2e (built app, mock transport): phase5 (review inbox + portal)                | 16 pass                                                                                                                        |
| e2e: journey (two companies; includes the inbox approval and the invalidation) | 12 pass; responsive, a11y and shell were left to CI at the coordinator's request (the shared e2e lock)                         |
| Screenshots                                                                    | application vs interface at 1440, 768 and 390 px, light and dark, with a request selected and the portal open (PR description) |

Visual comparison (the interface's `review.html` / `portal.html` against the built application on the mock data):

- Matches at 1440: the two columns (`300px minmax(0,1fr)`), the list header (title, one explanatory line, four
  filter chips wrapping to two rows at 300 px), the request rows (bold title, due at the right in small tabular
  figures, a dot and the state, a further flag after a dot in the accent colour, the selected row tinted), the
  request header (id · revision · created above the title, the state pill at the top right), the change note as a
  tinted box, FROZEN MANIFEST with the hash · brand · policy line at the right and one row per variant (file or
  hatched placeholder at 160 px, channel, caption, ALT, the bound hashes in 10 px), REVIEWERS and EXTERNAL LINKS
  side by side with "+ New link", COMMENTS with the OUTDATED tag, the "Your decision" card with its note, the ink
  "Approve revision N" and the outlined "Request changes".
- Matches at 768: the two columns hold (the interface stacks below 760 px, the application below 768 px).
- Matches at 390: the list stacks above the detail; REVIEWERS and EXTERNAL LINKS stack; the manifest row keeps the
  thumbnail at 112 px beside the text; no horizontal scrolling.
- Deviations, and why: the interface's list has no Refresh; the application keeps a small ghost "Refresh" at the header's right (an existing behaviour). The chips carry no counts (the interface's form; the navigation badge keeps the count). The interface draws a hatched thumbnail with the size for every variant; the application shows the frozen file itself where one was rendered (image, video or "Open file"), with the size and the other channels it serves under it, and the hatched placeholder reading "no rendered file" or "same file as <channel>" where there is none — one file frozen for several channels is shown once, under the first channel it serves (spec 13.3; the e2e counts them). "text sha256 · export sha256 · settings sha256 bound" carries the real short hashes. A muted line under FROZEN MANIFEST names the revision, content hash, creative revisions and the frozen timing, which the decision binds and which the interface shows nowhere. The interface has one free-text change note; the application has typed notes (stale, changed since freeze, changes requested, approval invalidated, link revoked), each in the tinted-box form, warning and critical tints by tone. "Preview" appears only on the link just created: the token is shown once and never stored, so an older link cannot be previewed. REVIEWERS names a member only when the session may list members (owner, admin); other roles see the user id. After approval the interface's "Approved and bound …" line reads "Approved and bound · Approval apr_… binds this exact package until …" (the e2e reads the approval id from it). "Your decision" adds the manifest's short hash and the refusal rule to the interface's sentence. The portal cannot greet the reviewer by name or name the person who asked (the reviewer view carries neither), so it reads "You were asked to review"; the wordmark is the deployment's name (the portal has no company), the h1 is the article's title when there is one and "Your review" otherwise (no package title in the reviewer view); the hash · brand · policy line is shown (the e2e requires the full hash); "Exit preview" has no counterpart because the portal is its own origin. The application keeps its "Nothing selected" state (the interface always has a selection). The captures use the fallback face because Lato is not reachable offline (as in the foundation's captures). Dark theme holds in both views; the hatched placeholder is faint on the dark surfaces (the foundation's tint values).
