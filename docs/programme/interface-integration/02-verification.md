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
