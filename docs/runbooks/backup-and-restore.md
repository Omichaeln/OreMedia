# Runbook: database backup and restore

**When:** scheduled (every 15 minutes, automatic), and on any loss or corruption of the application database or the Temporal persistence database.
**Owner:** platform on-call. **Targets (RA-13):** recovery point objective 15 minutes, recovery time objective 4 hours. **Exercised:** restore drill on Railway staging with `restore.sh` (timed `RESTORE_STEP` lines; the result is recorded in `docs/release/completion-ledger.md`).

## What runs

The `db-backup` service in each Railway environment is built from `infra/railway/db-backup/Dockerfile` (`mysql:9` client tools plus the AWS CLI) and runs `backup.sh` on the cron schedule in `infra/railway/db-backup/railway.json` (`*/15 * * * *`). Each run:

1. Dumps `SRC_DB` from `SRC_HOST` (the application database) and, when `SRC2_HOST` is set, `SRC2_DB` from `SRC2_HOST` (the Temporal persistence database) with `mysqldump --single-transaction --routines --triggers --events`. When binary logging is on, `--source-data=2` records the binlog position in the dump.
2. Gzips each dump and copies it to the object store at `s3://$BACKUP_BUCKET/$BACKUP_PREFIX/<name>/<name>-<UTC stamp>.sql.gz` (`oremedia` and `temporal`), then confirms the stored size with a head request.
3. Keeps a local copy on the service volume when `BACKUP_LOCAL_DIR` (default `/backups`) exists, and deletes copies older than `BACKUP_RETENTION_DAYS` (default 14) from the store and the volume.
4. Prints one `DB_BACKUP_PASS <name> s3://… <size> bytes binlog=<0|1>` line per database and `DB_BACKUP_DONE`, or `DB_BACKUP_FAIL …` and exits 1. A dump under 1 KiB is a failure, not a success.

Railway's managed MySQL has no point-in-time recovery, so the dump is the recovery point. A 15-minute cadence gives an RPO of at most 15 minutes plus the dump time; the actual dump time is in the deploy log of each run.

Variables (all read from the environment; values are never printed): `SRC_HOST`, `SRC_DB`, `SRC_PW` (reference the MySQL service), `SRC2_HOST`, `SRC2_DB`, `SRC2_PW` (reference `temporal-db`), `OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY`, `OBJECT_STORE_REGION` (reference the api service), `BACKUP_BUCKET` (the releases bucket), `BACKUP_PREFIX` (`db-backups/production` or `db-backups/staging`), `BACKUP_RETENTION_DAYS`.

## Monitoring

- The run must print `DB_BACKUP_DONE` within a few minutes of each quarter hour. A missing run, a `DB_BACKUP_FAIL` line or a cron job that exits non-zero is an incident: Railway marks the deployment failed and the project webhook (deploy-railway runbook, alerts) delivers it.
- Weekly: list `s3://$BACKUP_BUCKET/$BACKUP_PREFIX/oremedia/` and confirm objects exist for the last 14 days and the latest is less than 30 minutes old.

## Restore

Never restore over production. Restore into a separate MySQL instance, verify, then import tenant rows (restore-single-tenant runbook) or switch the application to the restored instance.

1. Create or reuse a separate MySQL service in the environment (`mysql-restore` in staging). Note its private host and root password; do not paste either into a ticket.
2. Run `restore.sh` as a one-off deployment of the `db-backup` image with: `DST_HOST`, `DST_PW`, the `OBJECT_STORE_*` and `BACKUP_BUCKET`/`BACKUP_PREFIX` variables above, `RESTORE_NAME` (`oremedia` or `temporal`), `RESTORE_DB` (the database to create; default `oremedia`) and optionally `RESTORE_KEY` (a specific object; default the newest dump under the prefix). Start command: `restore.sh`.
3. Read the log: `RESTORE_STEP` lines give the time of each step (download, load, verify) and `RESTORE_PASS <key> <tables> tables, <n> migrations in <N>s` is the evidence. The script fails if the table count in the restored instance differs from the dump's `CREATE TABLE` count, or if `__drizzle_migrations` has no rows.
4. Confirm the migration ledger: the last row of `__drizzle_migrations` in the restored instance must match the latest file in `packages/db/drizzle/`. A dump taken before the current release restores cleanly only when the migration set is roll-forward compatible (every migration is; `packages/db/src/migrations.integration.test.ts`).
5. Application steps after a full restore, before any worker reconnects: engage the `release_dispatch` and `agent_starts` kill switches (kill-switch runbook), point the api and workers at the restored instance (`DATABASE_URL`, `DATABASE_URL_RETENTION`), then run `publishing.publications.holdRestored` for every tenant until `hasMore` is false (restore-single-tenant runbook step 5) so nothing restored republishes, and re-apply deletion requests made after the restore point (step 6 there). Temporal: restore the `temporal` dump into the Temporal persistence instance before starting the Temporal server; in-flight workflows resume from their persisted history and re-read publication state, which the hold command has already changed.
6. Release the kill switches, run the staging smoke suite against the environment (`pnpm smoke`), and record the drill or incident in the completion ledger with the `RESTORE_PASS` time.

## Recovery time budget

| Step | Budget | Evidence |
| --- | --- | --- |
| Detect and decide | 30 min | incident ticket |
| Provision the restore instance | 15 min | Railway service created |
| `restore.sh` (download, load, verify) | 60 min for a database up to about 5 GB | `RESTORE_PASS … in Ns` |
| Re-point services, hold restored rows, re-apply deletions | 45 min | holdRestored responses |
| Smoke and release | 30 min | smoke run |

The sum is three hours against the four-hour objective. The staging drill measures the third row; the others are operator steps with the budgets above.
