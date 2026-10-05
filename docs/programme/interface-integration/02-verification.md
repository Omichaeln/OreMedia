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

## Settings (PR: claude/ui-settings)

| Check                                                                    | Result                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/web typecheck`, `pnpm lint`, `pnpm format`      | pass                                                                                                     |
| `pnpm vitest run --project unit apps/web packages/ui`                    | 172 pass; `mock-contract.test.ts` timed out once under machine load and passes rerun alone               |
| e2e (built app, mock transport, under the shared lock): phase6, password | **PHASE6**; password 6/6 pass. a11y, responsive, shell, deployment-brand and journey run in CI on the PR |
| Screenshots                                                              | every tab at 1440, 768 and 390 px against `ui-ref/shots/settings-*.png`                                  |

Visual comparison. 1440: the header, tab row (ink underline, 20 px apart), the "Connected channels" group with its
summary and the ink "Connect a channel", the rows (bold name with a small handle, the limits line, a dot with the
state, a white rule button) and the muted token note match the interface; the application's rows carry two extra
things the interface's demonstration data does not: a second status line (checked time, token expiry, missing
scopes) and both Reconnect and Manage on a row whose access is dead (the interface shows Reconnect alone, but
Disconnect must stay reachable). Platforms are listed under the connected rows as the interface lists them, with
Details beside Connect for the activation, credential references and capability certification the application
also shows (nothing dropped); the interface's connect wizard is replaced by the server's authorisation link, which
the application already had. The "Websites and sources" group (destinations) follows on the same tab with its
former sections. 768: the rows keep their three columns; the tabs fit. 390: the name takes its own line and the
state sits beside the controls (the interface's own 390 capture squeezes its limits column to one word per line);
the tab row scrolls sideways; nothing overflows. Appearance matches the interface's three preview cards, with the
account group under them; Mandates as cards; Release policy rows and kill-switch cards; Members rows with the
actions under each; Budgets rows with bars. The Settings title uses the foundation's 28 px `PageHeader` (the
interface's markup says 24 px here); dark theme checked on every tab.

Deviations recorded: "Test publish (dry run)", "Re-authorise" on a healthy channel, "New mandate", "Resume" and
"Renew" have no procedure behind them and are not shown; the token note says the server refuses uncertified
providers (no beta tier exists); the e2e expectations adjusted are listed in the PR.
