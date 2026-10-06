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
