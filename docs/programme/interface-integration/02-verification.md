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

## Reports (PR #108, D-29)

| Check                                                                                                         | Result                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm check:schema`                                             | pass (format after `pnpm contracts:write` regenerated `docs/contracts/openapi.json` with the ten `reports.*` procedures, additive)                                                                                                                                                                |
| `pnpm test` (unit)                                                                                            | pass, including `packages/modules/reports/src/figures.test.ts` (7) and `apps/web/src/features/reports/report-helpers.test.ts` (3)                                                                                                                                                                 |
| `pnpm test:integration` for the module, the procedure coverage, roles and migration state (TEST_DATABASE_URL) | 4 files, 39 tests pass (`reports.integration.test.ts`: builder state at a version, the send record, the preference, drafting with its budget charge, cross-tenant)                                                                                                                                |
| `pnpm test:cross-tenant`                                                                                      | 6 files, 525 tests pass; every `reports.*` procedure has a fixture (`tooling/test-fixtures/src/inputs/reports.ts`) and seed                                                                                                                                                                       |
| e2e (built app, mock transport): `reports.e2e.test.ts`, `mock-contract.test.ts`                               | 17 tests pass: navigation and Recent, figures equal to the mock's measurement composition, sections, save at a version, Re-draft and Ask (and their "unavailable" path), Mark as sent, the preference, a reviewer's refusal, the keyboard path and the audit at 390 and 1280 px in light and dark |
| `pnpm db:roles:check`                                                                                         | not run locally (needs `DATABASE_URL`); the role files were regenerated with `tooling/scripts/generate-db-roles.ts` and `roles-files.test.ts` passes                                                                                                                                              |
| `pnpm test:time-skipping`                                                                                     | not applicable: no workflow touched                                                                                                                                                                                                                                                               |
| Screenshots                                                                                                   | application at 1440, 768 and 390 px against `ui-ref/shots/reports-1440.png` / `-390.png` (PR description, "Visual comparison")                                                                                                                                                                    |

Visual comparison. 1440: the builder column (300 px, sticky, scrolling on its own) carries the interface's order
and copy exactly: Reports and its line, RECENT rows (brand · month, dot + Draft / Sent date), REPORT with Brand and
Month selects and the Previous month / Last year pair, SECTIONS with ticks and page numbers, EXECUTIVE SUMMARY
with Re-draft and its note, the REPORT ASSISTANT card with its opening line, question field and Ask, Prepared
for / by, Brand kit (version link, five swatches, type line, Dark / Light), the freshness line, Download PDF
(primary), Send to client / Save draft, the auto-draft switch. The preview column is the interface's `#ECEAE5`
ground (`bg-muted`) with the pages at 794 × 1122 scaled to fit, the cover in the brand kit's dark colour and
display face, then the four pages with the same running heads, kickers, 40 px titles, tile grid, dark band, trend
and highlights, share bar, channel table and cards, ranked posts, format bars, numbered recommendations and the
"About this report" panel. 768: the same two columns (the interface stacks below 760 px). 390: stacked, the
builder first, the pages scaled to the width, no horizontal scrolling.

Deviations, each deliberate: (1) Reach is never summed (D-15), so the "Reach" tile reads "Not summed" with the
dictionary's words, the share bar and the six-month trend are impressions (a flow), the channel table has no
Audience / Net new columns (account-level follower snapshots are not in the publication rollup) and the posts
page lists each post's own reach; the interface's demonstration sums reach and shows audience. (2) The objective
band ("Subscriber sign-ups, target 120") is replaced by the sample band (posts published, the D-14 comparison
state and how many posts carry numbers): the report has no objective target to show and never invents one.
(3) The assistant's suggestion chips are not shown (they were demonstration prompts); the assistant's answer is
placed by the model and added to the saved summary or recommendations rather than kept as preview-only
highlights, so what is added is what is saved. (4) The send form has no "Send report": email delivery and
view-only links do not exist on this deployment, and the form says so and offers "Mark as sent" + the PDF.
(5) The freshness line reports stale values from the figures rather than a per-channel "last synced" (the
measurement module reports freshness per value), and has no "Sync" button (collection is scheduled, not on
demand). (6) The auto-draft switch's label adds "Stored as a preference: the schedule is not active on this
deployment yet." (7) The interface's `#9A958C` page numbers and notes use the muted text colour (4.5:1); the
brand kit's own text colours are pushed toward black or white until they read on their surface (`legible`), so
a pale neutral or a dark-on-dark accent never fails contrast inside the pages. (8) Engagement rate is engagements
÷ impressions (the dictionary's definition), not ÷ reach as the interface's footer says, and the footer says so.

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

## Assets (PR #107)

| Check                                                                     | Result                                                                                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`                                   | pass                                                                                                                                                            |
| `pnpm lint`                                                               | pass on every committed file (the only errors were in the uncommitted screenshot scratch tool)                                                                  |
| `pnpm format`                                                             | pass on every file this PR changes (`prettier --check` on the diff against main)                                                                                |
| `pnpm vitest run --project unit apps/web packages/ui`                     | 178 tests pass (23 files; 7 new in `use-assets.test.ts`)                                                                                                        |
| e2e (built app, mock transport, Chromium): shell, media, a11y, responsive | media: 5 pass; shell `assets:` tests: 2 pass (the full shell, a11y and responsive suites are left to CI on the PR per the coordinator, the box being saturated) |
| Screenshots                                                               | prototype vs application at 1440, 768 and 390 px (below and in the PR description); light and dark, grid, eligible grid and drawer                              |

Visual comparison (`ui-ref/shots/assets-*.png` against the built application on the mock transport):

- 1440: the heading, description, search field and ink Upload sit as the interface's; one chip row in the interface's
  order (All selected in ink) followed by a rule and the application's "Eligible for" purpose chips (an addition the
  interface lacks: `assets.search` is a different query from the librarian's list and the shell e2e relies on it); the
  grid is `repeat(auto-fill, minmax(160px, 1fr))` with 18 px gaps, 4:5 frames, the "kind · tag" caption inside the
  frame, the name at 13 px and the dot + state at 11 px, as the interface. Differences: the mock brand has four assets
  with thumbnails where the interface shows ten hatched placeholders (the hatching appears only where an asset has no
  version); on a thumbnail the caption sits on a card-tinted pill so it stays readable over a photo; the h1 is the
  foundation's 28 px `PageHeader` (the interface's Assets markup uses 24 px) and the description 15 px (interface 13);
  the chips are the foundation's 28 px `Chip` (interface 26); a retired card dims its frame only, not its words (50 %
  text would fail 4.5:1); the Duplicates chip is not offered (ingest refuses duplicates); a "N assets shown" foot is
  the application's paging.
- 768: the chip row wraps to two lines (the rule between the groups is shown from 1024 px only), the grid has four
  columns; no horizontal scroll.
- 390: the search field and Upload share one row under the description, chips wrap to three lines, the grid has two
  columns (the interface's 36 px gutters give it one column at 390; the application's 16 px gutters give two); no
  horizontal scroll.
- Drawer: `min(340px, 92vw)`, "id · vN" and ×, a 4:3 preview with the caption (or the media player for video and
  audio), the name at 16 px bold (interface 17), dot + state, one notice per status in the accent tint (good states
  on the muted tint), Kind / Channels / Territory / Rights until / Used in as the interface's definition list, then
  Derivatives and Versions rows under uppercase labels and the existing Approve / Retire / rights form at the foot
  (the interface's state-specific buttons such as "Extend rights" or "Link to existing" map onto these: rights are
  extended through the rights form; there is no link-duplicate command in the API). "EXIF GPS stripped" has no field
  in the DTO and is not shown.
- Dark theme: the hatching, pills, chips, cards, notices and drawer hold on the dark tokens.

## Settings (PR: claude/ui-settings)

| Check                                                                    | Result                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`, `pnpm lint`, `pnpm format`      | pass                                                                                                     |
| `pnpm vitest run --project unit apps/web packages/ui`                    | 172 pass; `mock-contract.test.ts` timed out once under machine load and passes rerun alone               |
| e2e (built app, mock transport, under the shared lock): phase6, password | **PHASE6**; password 6/6 pass. a11y, responsive, shell, deployment-brand and journey run in CI on the PR |
| Screenshots                                                              | every tab at 1440, 768 and 390 px against `ui-ref/shots/settings-*.png`                                  |

Visual comparison. 1440: the header, tab row (ink underline, 20 px apart), the "Connected channels" group with its
summary and the ink "Connect a channel", the rows (bold name with a small handle, the limits line, a dot with the
state, a white rule button) and the muted token note match the interface; the application's rows carry two extra
things the interface's demonstration data does not: a second status line (checked time, token expiry, missing
scopes) and both Reconnect and Manage on a row whose access is dead (the interface shows Reconnect alone, but
Disconnect must stay reachable). Platforms are listed under the connected rows as the interface lists them, with
Details beside Connect for the activation, credential references and capability certification the application
also shows (nothing dropped); the interface's connect wizard is replaced by the server's authorisation link, which
the application already had. The "Websites and sources" group (destinations) follows on the same tab with its
former sections. 768: the rows keep their three columns; the tabs fit. 390: the name takes its own line and the
state sits beside the controls (the interface's own 390 capture squeezes its limits column to one word per line);
the tab row scrolls sideways; nothing overflows. Appearance matches the interface's three preview cards, with the
account group under them; Mandates as cards; Release policy rows and kill-switch cards; Members rows with the
actions under each; Budgets rows with bars. The Settings title uses the foundation's 28 px `PageHeader` (the
interface's markup says 24 px here); dark theme checked on every tab.

Deviations recorded: "Test publish (dry run)", "Re-authorise" on a healthy channel, "New mandate", "Resume" and
"Renew" have no procedure behind them and are not shown; the token note says the server refuses uncertified
providers (no beta tier exists); the e2e expectations adjusted are listed in the PR.

## Campaigns (PR: #105)

| Check                                                                                                                | Result                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm --filter @oremedia/web typecheck`                                                                              | pass                                                                                 |
| `pnpm lint`, `pnpm format`                                                                                           | pass                                                                                 |
| `pnpm vitest run --project unit apps/web packages/ui`                                                                | 173 tests pass (two new: the brief row's state line, the variant line's status text) |
| e2e (built app, mock transport): phase6, journey (the screen's files); a11y and responsive once before the lock rule | see the PR description for the run                                                   |
| Screenshots                                                                                                          | prototype vs application at 1440, 768 and 390 px, light and dark (PR description)    |

### Visual comparison

Matches the interface: the three-column grid (`240px 290px minmax(0,1fr)` from 1280 px, the interface's
narrower `minmax(170px,210px) minmax(190px,250px)` set from 768 px, stacked below), each column scrolling on its
own; the campaigns column (title and "+", rows of bold name, "dates · state" in tabular figures, "Missed date" in
the critical text colour); the briefs column on the card tint (BRIEFS label, "+ Brief", the campaign's line with
its objective, rows of the message and one dot-and-state line, the selected row white); the brief as a document
(the "BRIEF · STATE" eyebrow, the 22 px message as the title, the Audience / Channels / Constraints definition
rows at `100px minmax(0,1fr)`, the PLAN label with its rows date · channel · item · format divided by rules, the
CONTENT PACKAGES label with "rev N · state" at the right of each name and a dot-and-text line per variant, and the
action row "Open in studio" (ink) / "Draft variants with agent" / "Send package for review"); the incomplete note
as the interface's accent-tinted row; the "Suggested … · not accepted" accent line beside PLAN; the `om-in` entry on
the screen (rows arriving from queries do not animate, as the foundation sets).

Deviates, and why:

- "1 missed date" is the interface's demonstration count; the application knows only that a campaign is still open
  past its end date, so the row says "Missed date" (no count is invented).
- The create forms stay where the application opens them today ("+" opens the campaign form at the top of its
  column, "+ Brief" the brief form at the top of the briefs column, both in the interface's form style); the
  interface draws the brief form in the third column. The briefs column also keeps the application's "All briefs"
  row and its campaign line (name · state · dates, Edit, Close campaign, and "Objective · …" when the campaign
  serves one), which the interface's demonstration has no controls for.
- A brief's state line keeps the application's state words ("Awaiting acceptance", "In progress") and appends
  "Suggested plan" and "Incomplete" after a middle dot, so the tests' wording and the real states both hold; the
  interface shows one of those words per row.
- The plan rows of a draft brief are editable in place (date, channel, theme and format as fields in the row,
  Save and Drop under it), since the application edits the proposed plan here; the interface's rows are
  read-only with an "Edit" that has nothing behind it. Accepted plans render as the interface's read-only rows.
- The "Awaiting acceptance" banner with "Accept brief" stays (the interface's "Accept plan" under the plan rows),
  because it also says how many packages acceptance creates and carries the permission refusal.
- The package list keeps the application's create-package form under it and still opens the full package detail
  (revisions, variants, generation, review, revise) below the brief when a package is chosen; the interface opens
  packages only in the studio. "Open in studio" links to the document the chosen package pins (or the studio's
  creation screen when it pins none) and says what is missing when no package is chosen; "Draft variants with
  agent" opens the run form on `copywriting` prefilled from the brief; "Send package for review" opens the review
  request for the chosen package's draft revision in a right drawer and says why when the revision cannot be sent.
- Header and row measures come from the shared `ColumnHeader` / `listButton` (22 px title, 16 px gutters) so the
  four column screens stay alike; the interface's campaigns header is 20 px with 20 px gutters.
- Lato does not load against the mock transport (no network), so the captures fall back to the system face; the
  interface's captures have Lato.

## Calendar (PR #101)

| Check                                                                                 | Result                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`                                               | pass                                                                                                                                                                                                                                                                                                                                                |
| `pnpm lint`                                                                           | pass                                                                                                                                                                                                                                                                                                                                                |
| `pnpm vitest run --project unit apps/web packages/ui`                                 | 171 tests pass (528 e2e cases skipped without `OREMEDIA_E2E`)                                                                                                                                                                                                                                                                                       |
| gitleaks (`origin/main..HEAD`)                                                        | no leaks                                                                                                                                                                                                                                                                                                                                            |
| e2e `phase5` (calendar and publishing, review, portal) and `remote-changes`           | pass (the PR carries the final run's counts)                                                                                                                                                                                                                                                                                                        |
| e2e `journey` (phone width)                                                           | 32 / 34: the two failures ("switching to company B shows none of company A's rows", "a creator restricted to brand 1 sees only it") assert the Portfolio's markers and the shell's single "Brand" label and fail on the foundation base without this change (the foundation worktree carries their fix); every calendar step of the journey passes  |
| e2e `a11y`, calendar audits at 390 / 1280 px, light and dark, with a publication open | zero violations. The keyboard path at 1280 px first reported the header controls and the banner's link as covered by the open drawer (WCAG 2.4.11); the content column now pads its right edge by the drawer's width (verified in the screenshots). The keyboard path and the dialog test then timed out under machine load; CI runs them on the PR |
| e2e `responsive`, `shell`                                                             | CI runs them on the PR (the shared machine's e2e lock); the screenshot run reports no horizontal overflow at 1440, 768 or 390 px in any variant                                                                                                                                                                                                     |
| Screenshots                                                                           | 1440, 768 and 390 px, light and dark, month, week and with a publication open, against `ui-ref/shots/calendar-*.png` (below and in the PR)                                                                                                                                                                                                          |

Visual comparison. 1440: the layout and hierarchy match the interface: the period as a 28 px bold title with the
muted timezone line; the segmented Month / Week, white ‹ Today ›, the ink Schedule at the right; the channel banner;
the ruled white grid with the MON…SUN row, today's number on an ink circle, the selected day tinted, one dot per
publication in its state's colour; the eyebrow "MONDAY, OCTOBER 5" and rows of time · title · channel · dot + state;
the open publication as a 360 px right sheet (id, ×, title, channel · time, the state in bold, the explanation, the
sections, the actions at the foot). 768: the same, the drawer beside a narrowed column. 390: as the interface's phone
shot (the wrapped header, the banner, the seven-column grid at 86 px rows, the eyebrow and rows), with the open
publication as a card under the day list. Dark: every surface from the tokens.

Deviations and why: the banner is the foundation's `StatusBanner` (bold title, explanation, ghost "Reconnect →",
critical tint) rather than the interface's one-line accent-tint row, because the application has a title and an
explanation to show and the phase 5 suite asserts them; the day-list rows carry the publication id under the channel
(the journey suite reads rows by id, and a person reconciling a partial success needs it); the state labels are the
application's ("Processing", "Live", "Draft saved"); the drawer is a fixed non-modal `aside` from 768 px and a card
under the list below that width (the interface's 92 vw sheet would cover the rows and controls the phone-width suites
use while a publication is open), and the content column makes room for it (the interface's own `calDetailW`); the
schedule form stays on the screen as the interface's card "Schedule a channel variant" (the suites expect it on a
plain day URL and open it by `?schedule=`), reached by the header's Schedule; Refresh stays as a ghost control; the
week title keeps the year; out-of-month numbers and the weekday row use the muted text colour (4.5:1); Lato does not
render in the capture environment.

## Agents (PR: `claude/ui-agents`, base `claude/ui-foundation`)

| Check                                                                           | Result                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @oremedia/ui typecheck`, `pnpm --filter @oremedia/web typecheck` | pass                                                                                                                                                         |
| `pnpm lint`, `pnpm format`                                                      | pass on the branch's files (`prettier --check` on every changed file); the root run flagged only the scratch screenshot script, deleted before commit        |
| `pnpm vitest run --project unit apps/web packages/ui`                           | 176 tests pass (5 new helper tests: run title, relative time, figures, step tone, tool line)                                                                 |
| e2e (built app, mock transport): `apps/web/e2e/agents.e2e.test.ts`              | 10 of 10 pass (the list, the steps and figures, Accept through the sheet, Modify, budget exhausted, policy denied, failed, cancel, start, permission denied) |
| e2e: a11y, responsive, shell                                                    | not run locally (the shared machine's lock queue); CI runs them on the PR                                                                                    |
| Screenshots                                                                     | application at 1440, 768 and 390 px, light and dark, plus the start form, against `ui-ref/shots/agents-1440.png` / `agents-390.png` (below and in the PR)    |

Visual comparison (the mock has one completed copywriting run with one model step, so the application shows one
row and one step where the prototype shows six runs and five steps):

- Matches at 1440: the two columns (330 px rule-divided list, the detail at 32 × 36 px gutters and 760 px max),
  "Agent runs" with the ink "New run", the row (bold goal, dot + state · relative time, the selected row tinted), the
  eyebrow (id · principal · task · mode), the 22 px title, the dot + state, the three figures in a ruled strip, the
  step rows (dot, summary, tool line, timing on the right), the redaction note, and the ink / white action pair.
- Deviates: the eyebrow shows the service principal id and the task kind (the run DTO carries ids, not the agent's
  name or the skill key); "Tool calls" and "Tokens" have no "/ 20" and "/ 40k" ceiling because the run DTO does not
  carry its budget; a tool line names policy and outcome only when they are not allowed/ok, and the redacted input
  sits under a disclosure; a "Run record" disclosure keeps the initiator, times, model and correlation id the
  prototype does not show; the prototype's Retry / Run again / Open result / Create a mandate have no procedure
  behind them and are not shown; the list heading is 22 px (`text-xl`) where the prototype sets 20 px.
- 768: the two columns hold (list at 330 px, the detail beside it) under the narrow bar; no horizontal scroll.
- 390: stacks as the prototype does, list first, then the detail at 20 px gutters; the figure strip keeps its three
  columns; no horizontal scroll.
- Dark: every surface, rule, dot and tint comes from the tokens; checked at 1440, 768 and 390.
- Start a run (1440): the prototype's order (title, selects, segmented Mode with its note, three budget figures,
  brief, Start run / Cancel) with the application's fields: a service principal select (the prototype has none), the
  skill select, the budget figures read-only (the server sets them from the principal's budget) with the granted
  mode, remaining spend and denied actions under them, and the skill's schema fields in place of one "Instructions"
  textarea; no "Target" select (nothing behind it).

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

## Studio (PR: claude/ui-studio)

| Check                                                                                                 | Result                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`, `pnpm lint`, `prettier --check`                              | pass                                                                                                                                      |
| `pnpm vitest run --project unit apps/web packages/ui`                                                 | pass (174), including the new `create/content-types.test.ts`                                                                              |
| e2e (built app, mock transport): studio-entry, studio, studio-generate, video-studio, video-ai, shell | pass                                                                                                                                      |
| e2e a11y and responsive, studio entries only (`-t studio`, both studio screens, every width)          | pass (26); the full suites run in CI                                                                                                      |
| Screenshots                                                                                           | interface vs application at 1440, 768 and 390 px, light and dark, for create, the format step (with and without a size), design and video |

Visual comparison (interface `studio-*.png` and the prototype's pick / design / video states, rendered from
`Oremedia.html`, against the application):

- Create (1440, 390): the 52 px white bar with the back arrow and "brand / Studio / Create", the 28 px "What are you
  making?" with its line, the two cards (200 px tinted illustration, 22 px name, format count on the right,
  description, tools line) and the "CONTINUE" rows (thumbnail, bold title, kind, when it changed, arrow) match.
  Deviations: the format counts are what the application makes (10 page formats, 4 video presets; the interface
  shows 31 and 13); the illustrations use the ink, accent and card tokens rather than the demo brand's palette; the
  Continue rows say Still or Motion without the size (the document list carries no format) and keep the
  application's row menu (Duplicate…, Archive / Restore) and the "Show archived documents only" filter; card radius
  is the 10 px token where the interface draws 14 px; the cards do not stagger in (one entrance on `main`).
- Format step (1440, 768): the Still / Motion switch, the "PLATFORM" list with counts, the platform title and note,
  168 px size cards with the proportional frame, "Custom size" under a rule, and the "LAYOUTS" column (label, size,
  dimensions, two-column tiles, the ink "Open in canvas" / "Open in timeline" and its note) match. Additions: content
  type chips when a size can be several (a square is a post, a carousel or custom artwork), the "New document title"
  field above Open (the title was editable before creating), a frame-rate select for video, the size's aspect ratio.
  The custom size is in pixels only (the renderer's limits; the interface also offers millimetres for print, which
  the application does not make) and video has no custom size. Platforms are the application's channels
  (Instagram, Facebook, LinkedIn, X, TikTok, YouTube), not the interface's Pinterest, display ads and print.
- Format step (390): the interface keeps two columns; the application stacks the platform list, the sizes and the
  layouts (D-31 stacking below `md`). No horizontal scrolling.
- Design workspace: the bar ("brand / Studio / Still / title", Rename, the dot-and-label save state, actions on the
  right with "Send for review" in ink), the flush white columns with pill tabs (Layers, Assets, Templates;
  Generate, Agent, Comments, Checks, History), the tinted canvas ground and the white insert bar and page strip
  follow the interface. Deviations: the interface's 44 px tool rail is the application's insert bar above the
  canvas; Export lives in the History tab's exports (no "Export PNG" button in the bar); the bar also carries Redo,
  Save now, the panel toggles and the theme toggle (no account menu in a full-screen workspace).
- Video workspace: the bar ("Motion / title", size, frame rate and length, save state), the library left, the
  monitor centre, the inspector and video panels right, and the timeline across the full width below with
  "Timeline", "+ Caption", "+ Title" follow the interface. The monitor sits on the tinted ground (the interface's
  near-black ground has no token that holds in both themes); "Prompt to video" is the application's Storyboard and
  AI edit tabs. At 390 px the monitor, the list editor, the panels and the library stack.
- Save states: the bar shows "Saved · revision n", "Saving…", "Unsaved changes", "Not saved"; under the bar,
  `SaveBanners` (StatusBanner) say "Autosave failed" with "Retry save", "Someone saved a newer revision while you were
  editing" while changes are re-applied, and "Revision n was saved while you were editing" during a conflict, whose
  decision stays in the existing dialog. Saves, rebases and conflict detection are unchanged.
- Wording changed in tests (same expectations, the interface's flow): the create screen's h1 is "What are you
  making?"; documents start from the format step's layouts and "Open in canvas" / "Open in timeline" instead of
  "Use …", "Details", "Blank canvas…", "Custom size…" and the content-type tiles; a copy starts from a row's
  "Duplicate…"; the Studio index renders without the brand navigation (shell and responsive suites).

## Performance and portfolio performance (PR #112: claude/ui-performance)

| Check                                                                                           | Result                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`, `pnpm lint`, `pnpm format`                             | pass                                                                                           |
| `pnpm vitest run --project unit apps/web packages/ui`                                           | pass (new: median, lift, signed percent, channel freshness, best slot)                         |
| e2e (built app, mock transport): shell (performance, web, overview, audit), journey, responsive | pass locally; a11y and the rest in CI on the PR                                                |
| New assertions run against `origin/main`'s screen                                               | fail there (no "not compared" tile line, no expandable row), pass here                         |
| Screenshots                                                                                     | application at 1440, 768 and 390 px, light, and 1440 and 390 dark, against `performance-*.png` |

Visual comparison (interface `performance-1440.png` / `-390.png` against the application):

- Matches at 1440: the 28 px title with the brand · company · objective line; the controls on the right (brand
  select, the 7 / 30 / 90 days segment, a secondary button); the channel chips with dots and the freshness line on
  the right with a stale channel in the warning colour; the figure tiles as one ruled strip (12 px radius, 1 px
  rules between tiles, label, 22 px figure, change line, the OBJECTIVE tag); the trend in a white card (title,
  muted line, readout top right, y axis 0 / mid / max, x labels, publication dots under the axis); By channel and
  When it lands side by side; What the creative did as three-or-more columns of uppercase feature labels with a
  diverging bar per value; the CONTENT label with the sort chips on the right and the ruled table; the AI review
  and Next content cycle cards with accent eyebrows, ruled lists and Keep / Drop on each row.
- Deviations and why: the trend is columns per day published, not a line of daily reach (collection pulls
  lifetime totals at fixed ages, so there is no honest per-calendar-day series; a line across empty days would
  invent continuity), with the previous period as the dashed series instead of an 8-week rolling baseline; no
  sparklines in the tiles (per-day latest values mix post ages, so recent days would always read low); "Monthly
  report" absent (PR #108's Reports route is not on main) and "Export" absent (no export exists); the content
  table has no thumbnail column and no per-post "AI review of this post" (no such read model), the open row shows
  the post's engagement quality and tracked links; the AI review's Worked / Didn't / Likely reasons become
  Movements / Findings / Likely reasons, because insights carry no direction and only experimentally supported
  entries are findings (spec 16.3); the steer field and "Create briefs for kept items" are not shown (the analyst
  run takes no steer, and Keep already creates the brief on the server); channel dots are one neutral mark, not
  per-provider colours (no provider-specific styling in generic code); the slot rows are six-hour clock ranges,
  not Morning / Midday / Afternoon / Evening, and each cell prints its rate and measured / posted. The web
  sources and audit sections remain below the interface's content (the overview's drill-downs land on them).
- 768: tiles fall to four, then two per row; By channel and When it lands stay side by side; the content table
  shows Post, Channel, the selected metric and vs. median, the other columns from 768 px up.
- 390: the controls wrap under the title, tiles two per row, cards stack, the table keeps Post (channel in its
  meta line), the selected metric and vs. median. No horizontal scrolling (responsive e2e).
- Dark: every surface, rule, bar and text uses tokens; checked at 1440 and 390.
- Portfolio performance: the interface draws its brands table inside Performance with "All brands"; the
  application keeps `/portfolio/performance` (the brand select's "All brands" goes there) with the same header
  and period control and a ruled table per company. The interface's Approval time, Objective and Trend columns
  have no read model per brand and are not shown.
- Wording changed in a test: `shell.e2e.test.ts` reads the posts as table rows and opens a post from the row's
  button (it was a "Details" button in a list).

## Intelligence and Experiments (PR #111, `claude/ui-intelligence`, base `main`)

| Check                                                                                                                                         | Result                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format`, `pnpm lint`, `pnpm typecheck`                                                                                                  | pass                                                                                                                                                                                                                                            |
| `pnpm vitest run --project unit apps/web packages/ui`                                                                                         | pass (new helper tests: rank, confidence, benefit, anomaly sentence, coverage detail, workspace experiment state, variants line, allocation, window, progress)                                                                                  |
| e2e (built app, mock transport): `phase6.e2e.test.ts`, `journey.e2e.test.ts`                                                                  | 51 of 51 pass                                                                                                                                                                                                                                   |
| `pnpm --filter @oremedia/editor build:renderer`, `pnpm test`, `pnpm audit --audit-level high` (with #110's overrides cherry-picked), gitleaks | pass (2155 tests); audit 0; no leaks                                                                                                                                                                                                            |
| `pnpm test:integration`                                                                                                                       | exit 1: suite-level failures in `apps/api/src/acceptance`, `auth` and `mcp` integration files only (API files this frontend change does not touch); the cause was not established here and is left for review. `pnpm test:cross-tenant` not run |
| e2e: a11y, responsive, shell                                                                                                                  | not run locally (shared machine); CI runs them on the PR                                                                                                                                                                                        |
| Screenshots                                                                                                                                   | 1440, 768 and 390 px light, 1440 and 390 px dark: every Intelligence tab and the Experiments list with a supported, a running and a designed experiment                                                                                         |

Visual comparison against `ui-ref/shots/intelligence-*.png` and `experiments-*.png` (the mock has four
recommendations, one comment theme and five experiments, so counts differ from the prototype's):

- Intelligence, matches at 1440: the 960 px column, the heading with "Ranked against <metric>" in ink and "learned
  from <brand>'s data only", "Run brand analyst now" as the white button on the right, the white freshness and
  coverage strip, the six tabs in the interface's order on one rule with the ink underline, the screen opening on
  "What to do next", the recommendation cards (10 px white card, "01" rank in muted tabular figures, 15 px bold
  title, Benefit / Effort / Confidence, the rationale, the ink action and the white Dismiss), What we learned's
  uppercase groups with dot rows, Customer voice's theme · kind · count rows, the Experiments tab's name · mode ·
  dot + state rows, and the playbook's practice · strength · review rows.
- Intelligence, deviates: a ghost "Refresh" sits beside "Run brand analyst now" (the query client never refetches
  on focus, so it is the only way to see changes made elsewhere); the strip shows one freshness per view and no
  per-channel ages or "Unsupported" line (the workspace reports neither); What changed has no figure tiles (the
  workspace carries statements, not metric values or deltas) and keeps a "Movements" list over "Anomalies & data
  gaps"; anomalies are sentences instead of the previous bar chart; each insight keeps a muted line with its label,
  strength, period and evidence; a card cites its insights' statements and the learning hypothesis under the
  rationale; Customer voice has no quotes or trends (the server keeps sample references, never text) and adds
  "Reply in the Inbox →"; the playbook shows "Approved" without a name (the entry carries a user id only), keeps the
  proposals and the propose form, and says "Reconsider by" where the prototype says "Review after"; a dismissed card
  keeps full opacity (the prototype's 50 % fails 4.5:1).
- Experiments, matches at 1440: the `minmax(260px,320px) minmax(0,1fr)` columns, "Experiments" with the white
  "New", rows (bold name, "A vs. B", dot + state · mode, the selected one tinted), the detail at 32 × 36 px gutters
  and 760 px (mode pill, short design hash, 22 px title, mode note, the 4 px bar with the label and state, RESULT
  rows with n, x and rate, the bold difference · verdict, the interval and p, guardrails, the 140 px
  PRE-REGISTRATION table).
- Experiments, deviates: the title is the hypothesis (an experiment has no separate name); the bar measures the
  smallest arm against the minimum sample only once a result exists, and the window elapsed while running
  (observations are not reported before a result); the result adds the verdict reason, exposure where recorded,
  the conclusion label, computed time, method and design hash; the table adds "Design hash" (full), "Frozen" and
  "Origin" rows; Pre-register and Start stay separate steps ("Pre-register (freeze design)", then "Start"), as the
  server has them; the list keeps "Refresh" and "Load more" at its foot; the list heading is 22 px where the
  prototype sets 20 px (as Agents).
- 768: both screens hold their layout (the Experiments columns from 768 px); no horizontal scroll.
- 390: Intelligence's tabs scroll sideways inside their rule as in the prototype, cards and rows stack their
  columns; Experiments stacks the list above the detail; no horizontal scroll.
- Dark: every surface, rule, dot, pill and the bar come from the tokens; checked at 1440 and 390.
- Wording changed in tests (`phase6.e2e.test.ts`, `a11y.e2e.test.ts`): the views that are not the default are
  opened with `?view=changed`; freshness and coverage are read from the strip (`freshness`); the rank is "Rank 1"
  (sr-only beside the visible "01") instead of "#1"; the anomaly is checked as its sentence instead of the chart's
  table; "Reconsider by" is capitalised; "directional; not causal" is checked on the detail (where the interface
  places it) instead of the list row. New assertions: the screen opens on "What to do next"; a reason pill
  dismisses with that reason.
