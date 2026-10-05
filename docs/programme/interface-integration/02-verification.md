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

## Assets (PR ASSETS_PR)

| Check                                                                     | Result                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`                                   | pass                                                                                                                               |
| `pnpm lint`                                                               | LINT_RESULT                                                                                                                        |
| `pnpm format`                                                             | FORMAT_RESULT                                                                                                                      |
| `pnpm vitest run --project unit apps/web packages/ui`                     | UNIT_RESULT                                                                                                                        |
| e2e (built app, mock transport, Chromium): shell, media, a11y, responsive | E2E_RESULT                                                                                                                         |
| Screenshots                                                               | prototype vs application at 1440, 768 and 390 px (below and in the PR description); light and dark, grid, eligible grid and drawer |

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
