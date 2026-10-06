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

## Review and the external portal (PR: `claude/ui-review`, base `main`)

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

## Brand system (PR: claude/ui-brand-system)

| Check                                                                                                 | Result                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`, `pnpm lint`                                                  | pass                                                                                                 |
| `pnpm vitest run --project unit apps/web packages/ui`                                                 | pass (`mock-contract.test.ts` timed out once at 5 s under machine load; passes alone)                |
| e2e (built app, mock transport): brand-kit, facts, logos, typography, assist, a11y, responsive, shell | see the PR description for the run                                                                   |
| Screenshots                                                                                           | prototype vs application at 1440, 768 and 390 px for the overview and every section (PR description) |

Visual comparison (interface `brand-system-*.png` against the application's `system-*.png`):

- 1440: the secondary navigation column (200 px, "BRAND SYSTEM" label, the eleven headings, the Facts count in
  accent) and the header row (brand name, state pill, the two secondary buttons on the right) match; the interface's short record id (`bv_4:9a3d…41bc`) is not shown, since the application never surfaces record ids (the e2e suites enforce it). The
  overview's dark statement card beside the voice summary and tone pills, the eight ruled white summary cards in
  three columns with the ninth cell showing the grid's ground, and the "HOW THIS IS USED" label and note follow the
  interface. Deviations: the interface's "Version 4 · Published" pill and the "v4 · published / v5 · in review"
  switch become "● Published" and "● Proposed update" (D-22: one brand system, versions internal); the statement
  on the card is the brand's positioning from Messaging and is absent when none is written (the mock brand has
  none), and the card's colour is the palette's darkest token rather than a hand-picked one; the interface's
  "CHANGED" marks on a draft in view have no counterpart (the proposal is reviewed in the editor, not overlaid on
  the read views); the last heading reads "History" rather than "Versions"; the overview has no "Overview" heading,
  as in the interface.
- 768: the navigation stays a column (the interface stacks below 760 px; the application's `md` step is 768 px,
  D-31) and the content column narrows; the summary cards fall to two columns.
- 390: the navigation becomes a sticky row under the 52 px bar ("BRAND SYSTEM" then the headings, scrolling
  sideways), the header's pills and buttons wrap under the name, the statement card sits above the voice, the
  cards stack in one column. No horizontal scrolling. The application keeps a 16 px gutter where the interface
  keeps 40 px.
- Section pages: each takes the interface's heading row (22 px bold title, muted line, secondary buttons on the
  right); a heading with several application sections (Voice & writing, Patterns & templates, Channel guidance)
  shows them as a row of pills, which the interface does not have. Colour: swatches in a 150 px grid with the
  token's key and hex, text pairings as ruled rows with the ratio and the verdict dot. Facts: the workspace is
  unboxed (search and actions on one row, the filters under it, categories as uppercase labels, facts as ruled
  rows) where the interface shows filter pills and a "Propose a fact" box; the application's dialog-based add,
  approve, correct, merge and withdraw flows stay. Objectives: the active objective as a white card ("● Active
  since", name, primary metric, guardrails), closed ones as a ruled "HISTORY", the form under a rule; the
  interface's "This month" figures have no measurement behind them and are not shown. History: applied states as
  ruled rows with "Compare with now"; the comparison in a white card. Editors (brand kit, guidance, logos,
  typography specimen, skill import, voice extraction, section assistant) keep their forms on the foundation's
  `Panel`, `Field` and `Input`.
- Wording changed in a test: `brand-kit.e2e.test.ts` opens the voice section from the overview card named "Voice &
  writing" (the interface's label; it was "Voice & personality").
