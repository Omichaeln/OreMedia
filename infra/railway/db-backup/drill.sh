#!/bin/sh
# Timed recovery drill (PR-09), for staging: every step prints DRILL_STEP start and end lines with UTC timestamps
# and elapsed seconds, so the recovery time table in docs/runbooks/backup-and-restore.md is filled from the log.
#
#   drill.sh all                       db, then objects, then the application steps to time by hand
#   drill.sh db                        restore.sh: the newest dump into DST_HOST (the staging mysql-restore service)
#   drill.sh objects                   restore-objects.sh: each bucket in DRILL_BUCKETS (default the assets and
#                                      releases buckets) into DST_BUCKET under DST_PREFIX (default
#                                      restore-scratch/drill-<stamp>/<bucket>/)
#   drill.sh mark <step> start|end     a DRILL_MARK line for a manual step (kill switches, re-point, holdRestored,
#                                      smoke), run where the operator works
#
# Guards, before anything runs: the environment name must be known (OREMEDIA_ENV or RAILWAY_ENVIRONMENT_NAME:
# staging, development, test or local) and not production unless RESTORE_ALLOW_PRODUCTION names the exact target;
# DST_HOST must not be a source database host or server (SRC_HOST's @@server_uuid must be readable, unless
# RESTORE_ALLOW_UNVERIFIED_TARGET names DST_HOST exactly); DST_BUCKET must not be a live bucket (restore.sh and
# restore-objects.sh check the same again).
set -eu
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/backup-lib.sh"
DIR="$(dirname "$0")"
mode="${1:-all}"
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ "$mode" = "mark" ]; then
  case "${3:-}" in start | end) ;; *)
    echo "usage: drill.sh mark <step> start|end"
    exit 2
    ;;
  esac
  echo "DRILL_MARK $2 $3 $(iso) $(date -u +%s)"
  exit 0
fi

[ -n "$(env_name)" ] || {
  echo "DRILL_FAIL environment name unknown: set OREMEDIA_ENV (Railway sets RAILWAY_ENVIRONMENT_NAME)"
  exit 1
}
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
started="$(date -u +%s)"
status=0

# Runs one timed step; $1 the step name, the rest the command.
run_step() {
  s_name="$1"
  shift
  s_start="$(date -u +%s)"
  echo "DRILL_STEP $s_name start $(iso)"
  if "$@"; then
    echo "DRILL_STEP $s_name end $(iso) elapsed=$(($(date -u +%s) - s_start))s"
  else
    echo "DRILL_STEP $s_name fail $(iso) elapsed=$(($(date -u +%s) - s_start))s"
    return 1
  fi
}

drill_db() {
  : "${DST_HOST:?DST_HOST is required (the staging mysql-restore service)}"
  : "${DST_PW:?DST_PW is required}"
  guard_production "$DST_HOST" DRILL_FAIL
  guard_db_target "$DST_HOST" "$DST_PW" DRILL_FAIL
  run_step db-restore sh "$DIR/restore.sh" || status=1
}

drill_objects() {
  : "${DST_BUCKET:?DST_BUCKET is required (a scratch bucket, or the backups bucket with a restore-scratch/ prefix)}"
  require_backup_store
  base_prefix="${DST_PREFIX:-restore-scratch/drill-$STAMP/}"
  buckets="${DRILL_BUCKETS:-$(source_buckets)}"
  [ -n "$buckets" ] || {
    echo "DRILL_FAIL no bucket to restore: set DRILL_BUCKETS or OBJECT_STORE_BUCKET_ASSETS/RELEASES"
    exit 1
  }
  guard_production "$DST_BUCKET" DRILL_FAIL
  for b in $buckets; do
    guard_bucket_target "$DST_BUCKET" "$base_prefix$b/" "$b" DRILL_FAIL
  done
  for b in $buckets; do
    run_step "objects-restore-$b" env RESTORE_BUCKET="$b" DST_PREFIX="$base_prefix$b/" sh "$DIR/restore-objects.sh" ||
      status=1
  done
}

case "$mode" in
  db) drill_db ;;
  objects) drill_objects ;;
  all)
    drill_db
    drill_objects
    echo "DRILL_APPLICATION_STEPS time each with 'drill.sh mark <step> start|end' where you run it:"
    echo "  kill-switches   engage release_dispatch and agent_starts (kill-switch runbook)"
    echo "  repoint         api and workers DATABASE_URL, DATABASE_URL_RETENTION to the restored instance; buckets to the restored copy"
    echo "  hold-restored   publishing.publications.holdRestored per tenant until hasMore is false"
    echo "  smoke           pnpm smoke:prod against the environment, then release the kill switches"
    ;;
  *)
    echo "usage: drill.sh all|db|objects|mark <step> start|end"
    exit 2
    ;;
esac

if [ "$status" -ne 0 ]; then
  echo "DRILL_FAIL $mode after $(($(date -u +%s) - started))s"
  exit 1
fi
echo "DRILL_PASS $mode in $(($(date -u +%s) - started))s"
