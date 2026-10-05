#!/bin/sh
# Restores one dump from the object store into a SEPARATE MySQL instance (DST_HOST; never production) and
# verifies it: the table count against the dump's CREATE TABLE statements and the migration ledger rows.
# RESTORE_KEY names the object (default: the newest under BACKUP_PREFIX/RESTORE_NAME). Prints the elapsed time
# of each step for the recovery-time evidence, then RESTORE_PASS or RESTORE_FAIL. The application-level steps
# that follow a restore (holdRestored, reconciliation) are in docs/runbooks/backup-and-restore.md.
# Before anything is loaded: the environment name must be known (OREMEDIA_ENV or RAILWAY_ENVIRONMENT_NAME: staging,
# development, test, local, or production only when RESTORE_ALLOW_PRODUCTION names DST_HOST exactly); the target must
# not be a source database (SRC_HOST, SRC2_HOST, PROTECTED_DB_HOSTS by name, and SRC_HOST by @@server_uuid, which
# must be readable on both servers unless RESTORE_ALLOW_UNVERIFIED_TARGET names DST_HOST exactly); and the dump must
# match its sha256 sidecar and pass gzip -t. A dump without a sidecar (taken before sidecars existed) is refused
# unless RESTORE_ALLOW_UNVERIFIED=1.
set -eu
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/backup-lib.sh"

: "${DST_HOST:?DST_HOST is required}"
: "${DST_PW:?DST_PW is required}"
: "${OBJECT_STORE_ENDPOINT:?OBJECT_STORE_ENDPOINT is required}"
: "${OBJECT_STORE_ACCESS_KEY_ID:?OBJECT_STORE_ACCESS_KEY_ID is required}"
: "${OBJECT_STORE_SECRET_ACCESS_KEY:?OBJECT_STORE_SECRET_ACCESS_KEY is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
BACKUP_PREFIX="${BACKUP_PREFIX:-db-backups}"
NAME="${RESTORE_NAME:-oremedia}"
DB="${RESTORE_DB:-oremedia}"
started="$(date +%s)"
step() { echo "RESTORE_STEP $1 at +$(( $(date +%s) - started ))s $(date -u +%Y-%m-%dT%H:%M:%SZ)"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

guard_production "$DST_HOST" RESTORE_FAIL
guard_db_target "$DST_HOST" "$DST_PW" RESTORE_FAIL

key="${RESTORE_KEY:-}"
if [ -z "$key" ]; then
  latest="$(bk_aws s3 ls "s3://$BACKUP_BUCKET/$BACKUP_PREFIX/$NAME/" | awk '{print $4}' | grep "^${NAME}-[0-9TZ]*\.sql\.gz$" | sort | tail -n 1 || true)"
  [ -n "$latest" ] || { echo "RESTORE_FAIL no dump under $BACKUP_PREFIX/$NAME/"; exit 1; }
  key="$BACKUP_PREFIX/$NAME/$latest"
fi
echo "RESTORE_SOURCE s3://$BACKUP_BUCKET/$key"
bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$key" "$WORK/restore.sql.gz"
step downloaded
if bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$key.sha256" "$WORK/restore.sql.gz.sha256" 2>/dev/null; then
  want="$(awk '{print $1; exit}' "$WORK/restore.sql.gz.sha256")"
  got="$(sha256_of "$WORK/restore.sql.gz")"
  [ "$want" = "$got" ] || { echo "RESTORE_FAIL checksum mismatch: sidecar $want, dump $got"; exit 1; }
  echo "RESTORE_CHECKSUM sha256=$got matches the sidecar"
elif [ "${RESTORE_ALLOW_UNVERIFIED:-}" = "1" ]; then
  echo "RESTORE_CHECKSUM no sidecar; RESTORE_ALLOW_UNVERIFIED=1, continuing without a checksum"
else
  echo "RESTORE_FAIL no sha256 sidecar for $key (set RESTORE_ALLOW_UNVERIFIED=1 for a dump taken before sidecars)"
  exit 1
fi
gzip -t "$WORK/restore.sql.gz" || { echo "RESTORE_FAIL $key is not a valid gzip file"; exit 1; }
step checksum-verified
gunzip -f "$WORK/restore.sql.gz"
expected="$(grep -c '^CREATE TABLE' "$WORK/restore.sql" || true)"
step unpacked

n=0
until MYSQL_PWD="$DST_PW" mysqladmin ping -h "$DST_HOST" -uroot --silent; do
  n=$((n+1)); [ "$n" -gt 60 ] && { echo "RESTORE_FAIL target unreachable"; exit 1; }; sleep 5
done
MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot -e "DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\`"
MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot "$DB" < "$WORK/restore.sql"
step loaded
restored="$(MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB'")"
ledger="$(MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot -N -e "SELECT COUNT(*) FROM \`$DB\`.__drizzle_migrations" 2>/dev/null || echo n/a)"
echo "RESTORE_TABLES expected=$expected restored=$restored migration_rows=$ledger"
rm -f "$WORK/restore.sql"
step verified
if [ "$expected" = "$restored" ] && [ "$restored" -gt 0 ]; then
  echo "RESTORE_PASS $NAME from $key in $(( $(date +%s) - started ))s"
else
  echo "RESTORE_FAIL table count"; exit 1
fi
