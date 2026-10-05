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

| Check                                                                           | Result                                                                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @oremedia/ui typecheck`, `pnpm --filter @oremedia/web typecheck` | RESULT_TC                                                                                                                               |
| `pnpm lint`, `pnpm format`                                                      | RESULT_LINT                                                                                                                             |
| `pnpm vitest run --project unit apps/web packages/ui`                           | RESULT_UNIT                                                                                                                             |
| e2e (built app, mock transport): `apps/web/e2e/agents.e2e.test.ts`              | 10 of 10 pass (the list, the steps and figures, Accept through the sheet, Modify, budget, policy denied, failed, cancel, start, denied) |
| e2e: a11y, responsive, shell                                                    | not run locally (the shared machine's lock queue; CI runs them on the PR)                                                               |
| Screenshots                                                                     | prototype vs application at 1440, 768 and 390 px, light and dark (PR description, "Visual comparison")                                  |

### Visual comparison

VISUAL_COMPARISON
