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
