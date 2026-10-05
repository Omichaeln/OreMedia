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
