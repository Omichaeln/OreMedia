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
