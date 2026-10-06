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
