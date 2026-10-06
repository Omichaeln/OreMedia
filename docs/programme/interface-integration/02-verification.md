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
