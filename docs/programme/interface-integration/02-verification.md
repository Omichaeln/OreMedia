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
