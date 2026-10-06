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
