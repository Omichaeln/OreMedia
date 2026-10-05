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
