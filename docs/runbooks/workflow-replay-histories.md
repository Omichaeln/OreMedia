# Runbook: retained workflow histories and the replay gate

**When:** you add a workflow type or a new version of one (`fooWorkflowV2`), you want another representative history
for a version that is still registered, a replay failure blocks a pull request, or a version has drained and can be
retired.
**Owner:** the engineer changing workflows; platform on-call for retirements. **Exercised:** by
`pnpm test:replay` (CI job "Temporal workflow replay") on every pull request: `packages/workflows/replay/replay.replay.test.ts`
replays every retained history, and `packages/workflows/replay/negative.replay.test.ts` proves that an incompatible
change to a copy of a deployed workflow fails replay. **Needs a live environment for:** the open-execution check
before a retirement (step R1).

## What the gate is

Spec 19.4: Temporal replays an execution's history against whatever workflow code the worker runs. If the code no
longer issues the same commands in the same order (an activity added, removed or reordered, a timer removed, a
signal handled differently), the execution fails with a nondeterminism error. The gate replays **retained
histories**, recorded once from the code that was deployed, against the **candidate** bundles built from the current
code, before any merge.

| What                  | Where                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Retained histories    | `tooling/test-fixtures/histories/<workflowType>/<case>.json` (Temporal WorkflowHistory JSON)                     |
| Provenance (each)     | `tooling/test-fixtures/histories/<workflowType>/<case>.meta.json`: commit, time, server, SDK, sha256             |
| Required set          | `tooling/test-fixtures/histories/manifest.json`: every supported type, its queue and its cases; past retirements |
| How each was produced | `packages/workflows/replay/cases/*.ts` (one case per history: input, fake activities, signals/cancel)            |
| Recorder              | `packages/workflows/replay/record.ts` (`pnpm replay:record`)                                                     |
| Gate                  | `packages/workflows/replay/*.replay.test.ts` (vitest project `replay`, `pnpm test:replay`)                       |

The candidate bundle of each queue entry (`packages/workflows/src/queues/<entry>.ts`) is built with
`bundleWorkflowCode`, exactly as the worker apps' `tsup.config.ts` build `dist/workflows.<entry>.js`; the gate checks
that the apps bundle exactly the queue entries it replays. Replay needs no Temporal server.

The gate fails when:

- any retained history replays with an error (nondeterminism or any other replay failure);
- a workflow type that a queue entry registers (an exported function named `…V<N>`) has no manifest entry, or a
  manifest entry is not registered by the queue it names;
- a manifest entry lists no history, or a listed `<case>.json` / `<case>.meta.json` is missing, or a history file
  is on disk but not listed;
- a history's bytes differ from the sha256 in its provenance, its first event is not the workflow type it is filed
  under, how it ends differs from its provenance, or it is not sanitised (identity, stack traces, local paths,
  secret-like values, non-synthetic tenants, emails or hosts, payloads decoded);
- a committed history or provenance file was changed after its first commit, or the checkout is shallow;
- a case required on `origin/main` (`REPLAY_BASE_REF`) was dropped while its type is still registered, without a
  retirement entry;
- a retained history has no recording case in `packages/workflows/replay/cases`;
- nothing is discovered: zero manifest entries or histories fail the suite, and the vitest project sets
  `passWithNoTests: false`, so a run that finds no test files fails too.

## Add histories for a new workflow type or version

1. Write the new version as a new file (`foo.workflow.v2.ts`) and export it from its queue entry next to the
   previous version (never edit a deployed workflow file: `packages/workflows/test/workflow-versions.test.ts`).
2. Add recording cases for it in `packages/workflows/replay/cases/<area>.ts` (and list the array in
   `cases/index.ts` when you add a file). Cover the main path and the branches that change the command sequence:
   activity retries that succeed, non-retryable failures that are caught, every signal it handles, cancellation,
   timers that fire, `continueAsNew`, child workflows, and at least one **in-flight** case (`state: 'open'`) for each
   durable wait, because open executions are the ones production replays. Use synthetic ids only (`tenant()` gives
   `tnt_replay_<n>`; hosts under `.example`): no tenant data, no secrets.
3. Commit the workflow source. The recorder refuses to run while any `.ts` under `packages/workflows/src` differs
   from `HEAD`, so the commit it writes into each provenance file is the code the history came from.
4. Record (a Temporal CLI binary runs its dev server; nothing outside the machine is touched):
   `TEMPORAL_CLI_PATH=/path/to/temporal pnpm replay:record fooWorkflowV2`
   It only writes histories that do not exist yet, checks each one is sanitised and replays against the same bundle,
   and prints the manifest lines still to add.
5. Add the type and its case names to `tooling/test-fixtures/histories/manifest.json`.
6. `pnpm test:replay` must pass. Commit the histories, their provenance and the manifest together.

To add another history to a version that already has some, do the same with a **new case name**.

## Never regenerate a retained history in place

A retained history stands for executions that the deployed code already wrote. Recording it again from the
candidate code only re-encodes the candidate's behaviour, so it would replay by construction and hide exactly the
incompatibility the gate exists to catch (in-flight executions would then fail in production with nondeterminism
errors). That is why the recorder never overwrites (`wx`), each provenance file pins the sha256 of its history, and
the gate fails when a committed history changes after its first commit.

If a retained history fails replay, the change is incompatible: revert it, or ship it as a new version
(`fooWorkflowV<N+1>`) with new starts routed to it while the old version stays registered until it drains (see
[Roll back a workflow version safely](rollback-workflow-version.md)). Do not touch the history.

If a history itself is wrong (recorded from a fake answer production can never give), record a corrected case
under a new name, then remove the wrong one from the manifest and the disk and add a `retired` entry for it
(`{ "workflowType", "histories": ["<case>"], "reason", "retiredOn": "YYYY-MM-DD" }`); the reviewer sees the reason.

## Retire a version once no executions remain

R1. Confirm that nothing of the version is open or can start, in production and in staging:
`temporal workflow count --query 'WorkflowType="fooWorkflowV1" AND ExecutionStatus="Running"'` returns 0 in the
namespace (Temporal UI: running workflows of that type = 0), no Temporal schedule starts it, and no outbox route
starts it (`register*OutboxRoutes`). Keep the query output for the pull request.
R2. Remove its export from the queue entry and delete its workflow file (deleting is allowed; editing is not).
R3. Move its manifest entry to `retired` with `"histories": "all"`, the reason and the date, and delete its history
directory. The gate fails if a retired type is still registered.
R4. `pnpm test:replay` and `pnpm test` pass; deploy the workers after the last execution has closed, never before.
