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
