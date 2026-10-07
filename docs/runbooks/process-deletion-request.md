# Runbook: process a deletion request (spec 17.5)

**When:** a tenant owner/admin asks for a brand or the whole tenant to be deleted (`operations.deletion.request`),
or a retention question comes up. **Owner:** platform on-call (the automated fan-out runs by itself; the operator
completes the stores the worker cannot reach). **Exercised:** locally by
`apps/worker-core/src/deletion.integration.test.ts`: a tenant deletion through the API and the outbox route runs
`deletionRequestWorkflowV1` (fake Temporal host, real activities) and leaves no row of the tenant in any
tenant-scoped table except audit events, release evidence and the request itself, anonymises its users, deletes its
objects, crypto-shreds its credentials, leaves the other tenant byte-for-byte untouched and is a no-op on a second
run; a brand deletion narrows to the brand; the retention sweep's dry run counts and its real run removes only rows
past their TTL; the operator confirmations complete the request. The re-application after a restore is exercised
by `runbooks.integration.test.ts` ("restore a single tenant"). **Needs a live environment for:** the Temporal
namespace retention check, the log backend purge, bucket versioning/lifecycle, backup expiry, and the DELETE grant
of the retention and deletion database roles on the insert-only tables (the local run uses root;
`deletion-role.integration.test.ts` runs it on the roles).

## What runs by itself

1. `operations.deletion.request { subjectType: 'tenant' | 'brand', subjectId, reason }` (owner/admin,
   `billing.manage`, audited `deletion.request`) records a `deletion_requests` row and emits
   `operations.deletion_requested`; the outbox starts `deletionRequestWorkflowV1` on task queue `core` with workflow
   id `deletion:<deletionRequestId>` (USE_EXISTING: a redelivered event joins it).
2. The workflow runs every registered handler as its own activity, in order (`apps/worker-core/src/deletion-handlers.ts`):
   `credentials` (crypto-shred: wrapped data key and ciphertext overwritten), `objects` (every storage key the rows
   name, tenant prefix checked), then `agents`, `review`, `publishing`, `measurement`, `community`, `intelligence`,
   `experiments`, `content`, `creative`, `assets`, `skills`, `billing`, `brand`, `operations`, `access` (rows purged
   children-first in batches; users left without any membership anonymised; the tenant row kept as a tombstone), and
   `indexes`. Retained by design: `audit_events`, `remote_evidence`, `deletion_requests` (spec 17.5 audit and
   release evidence).
3. Each step records its completion on the request (`fanout.<handler>` and the store roll-up
   `fanout.database` / `object_storage` / `indexes` …) and an audit event `deletion.step` with the per-table counts
   (`metadata.evidence`, e.g. `publications=3,publication_attempts=3`). A retried step finds its entry done and
   skips. The request ends `blocked` with `blocked_reason = operator action required: temporal_visibility, logs,
backups, provider_side`.

## Operator steps (the `blocked` stores)

Find open requests: `SELECT id, tenant_id, subject_type, subject_id, state, blocked_reason, fanout FROM
deletion_requests WHERE state <> 'completed'` (platform read-only session), and the evidence: `operations.audit.query
{ query: { resourceType: 'deletion_request', resourceId } }` in the tenant.

1. **temporal_visibility.** Workflow ids and search attributes carry ids only (no names or content). Running
   workflows of the deleted tenant end at their next activity (their rows are gone: NOT_FOUND, non-retryable).
   Closed histories expire with the namespace retention; record the date:
   `temporal operator namespace describe --namespace "$TEMPORAL_NAMESPACE"` (Retention) — completion date =
   request completion + retention. For an early purge of a known workflow id:
   `temporal workflow delete --namespace "$TEMPORAL_NAMESPACE" --workflow-id "deletion:<deletionRequestId>"` (and any
   `pub:<publicationId>`, `render:<renderJobId>`, `run:<runId>`, `ingest:<uploadIntentId>`, `metrics:<publicationId>`
   ids listed in the request's audit trail). Workflows have no TenantId search attribute (open: add one so a
   `--query 'TenantId="…"'` purge is possible).
2. **logs.** Logs carry allowlisted fields only (ids, codes). Confirm the log sink's retention (≤ 30 days) and record
   the expiry date, or purge by `tenantId` in the log backend.
3. **backups.** Backups expire with the PITR window; record the expiry date. Any restore before it must re-apply this
   request (restore-single-tenant step 6: `deletion.reapply`, then the workflow again).
4. **provider_side.** Posts stay on the platforms unless the tenant asked for removal before deletion
   (`publishing.publications.deleteRemote` per post). Record what was asked.
5. Record each step: `deletion.confirmOperatorAction(actor, deletionRequestId, step, note)` (operations module; no API
   procedure yet, open) — the request completes when no step is left (`deletion.operator_action` audited).
6. Object versions: the `objects` step deletes the current object; noncurrent versions go with the bucket's lifecycle
   rule (noncurrent version expiry), as do `releases/<tenant>/` copies. Confirm the rule on both buckets once.

## Retention (the daily TTL sweep)

`retentionSweepWorkflowV1` runs daily at 02:30 UTC from the Temporal schedule `retention-sweep` (created by
worker-core at start). It is a **dry run** (counts only, `retention.apply` audit only on a real run) unless
worker-core runs with `RETENTION_SWEEP_APPLY=true`: at every start the schedule's action args are brought in line
with the variable, so switching the mode is a restart with it set (or unset). Classes and defaults (D-09 to
confirm): agent transcripts 90 days (`agent_steps`, `tool_invocations`; run summaries kept), metrics 25 months
(`metric_snapshots`, `link_clicks`), raw customer-voice messages 12 months (`messages`; cluster sample refs
cleared). A tenant's `retention_policies` row overrides the days; `retention_days = NULL` keeps the class
indefinitely. Destination report rows (`destination_report_rows`) and SEO audit runs (`seo_audit_runs`,
`seo_audit_pages`) are expired per destination by the brand's source-use policy (D-17: `retention_days` with
`retain`, else the 7-day report cache / last-runs keep rule), whether or not the destination is still connected,
its kind enabled or certified, or its last fetch succeeded; the report and audit runs prune the same way after a
planned run, so no fetch is needed for a copy to expire. A `temporal schedule update … --input '{"dryRun":false}'`
by hand holds only until the next worker-core start.

## Database role

The application role has no DELETE on insert-only tables (spec 6.1, `packages/db/roles/app-role.sql`). The retention
sweep runs on its own role (`packages/db/roles/retention-role.sql`, generated from `RETENTION_ROLE_GRANTS` in
`packages/db/src/global-tables.ts`) through worker-core's `DATABASE_URL_RETENTION` connection: DELETE on
`agent_steps`, `tool_invocations`, `metric_snapshots` and `link_clicks` (the insert-only tables a TTL class removes),
DELETE on `messages`, UPDATE on `customer_voice_clusters`, SELECT on those and `retention_policies`, INSERT on
`audit_events`; no other privilege. Without `DATABASE_URL_RETENTION` the sweep runs on the application role and a
real (non-dry) run fails with `ER_TABLEACCESS_DENIED_ERROR` (retried the next day; each tenant is one transaction).
The deletion workflow's handler steps run on the deletion role (`packages/db/roles/deletion-role.sql`, generated from
`DELETION_ROLE_DELETES` in `packages/db/src/global-tables.ts`) through worker-core's `DATABASE_URL_DELETION`
connection: the application role's table grants (not the migrations table) plus DELETE on the insert-only tables a deletion removes
(`creative_revisions`, `rendered_exports`, `render_previews`, `preview_exports`, `review_decisions`, `usage_ledger`,
`evaluation_results`, `experiment_assignments`, `experiment_results`, and the TTL tables above); `audit_events`,
`remote_evidence` and `auth_events` stay undeletable and no insert-only row can be updated. `beginDeletion` and
`finishDeletion` stay on the application role. Without `DATABASE_URL_DELETION` the handler steps run on the
application role and the first one that reaches an insert-only table (`agents`, on `agent_steps`) fails with
`ER_TABLEACCESS_DENIED_ERROR`: the step's transaction rolls back, it stays pending and is retried, so set the
variable (deploy runbook §1 step 5) and the retried step completes. Proof: `packages/db/src/deletion-role.integration.test.ts`
(what the engine allows the role) and `apps/worker-core/src/deletion-role.integration.test.ts` (a tenant deletion
refused on the application role, completed on the deletion role).
