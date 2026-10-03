#!/bin/sh
# Restores one dump from the object store into a SEPARATE MySQL instance (DST_HOST; never production) and
# verifies it: the table count against the dump's CREATE TABLE statements and the migration ledger rows.
# RESTORE_KEY names the object (default: the newest under BACKUP_PREFIX/RESTORE_NAME). Prints the elapsed time
# of each step for the recovery-time evidence, then RESTORE_PASS or RESTORE_FAIL. The application-level steps
# that follow a restore (holdRestored, reconciliation) are in docs/runbooks/backup-and-restore.md.
set -eu

: "${DST_HOST:?DST_HOST is required}"
: "${DST_PW:?DST_PW is required}"
: "${OBJECT_STORE_ENDPOINT:?OBJECT_STORE_ENDPOINT is required}"
: "${OBJECT_STORE_ACCESS_KEY_ID:?OBJECT_STORE_ACCESS_KEY_ID is required}"
: "${OBJECT_STORE_SECRET_ACCESS_KEY:?OBJECT_STORE_SECRET_ACCESS_KEY is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
BACKUP_PREFIX="${BACKUP_PREFIX:-db-backups}"
NAME="${RESTORE_NAME:-oremedia}"
DB="${RESTORE_DB:-oremedia}"
export AWS_ACCESS_KEY_ID="$OBJECT_STORE_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$OBJECT_STORE_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${OBJECT_STORE_REGION:-auto}"
export AWS_EC2_METADATA_DISABLED=true
S3="aws --endpoint-url $OBJECT_STORE_ENDPOINT s3"
started="$(date +%s)"
step() { echo "RESTORE_STEP $1 at +$(( $(date +%s) - started ))s"; }

key="${RESTORE_KEY:-}"
if [ -z "$key" ]; then
  latest="$($S3 ls "s3://$BACKUP_BUCKET/$BACKUP_PREFIX/$NAME/" | awk '{print $4}' | grep "^${NAME}-" | sort | tail -n 1)"
  [ -n "$latest" ] || { echo "RESTORE_FAIL no dump under $BACKUP_PREFIX/$NAME/"; exit 1; }
  key="$BACKUP_PREFIX/$NAME/$latest"
fi
echo "RESTORE_SOURCE s3://$BACKUP_BUCKET/$key"
$S3 cp --only-show-errors "s3://$BACKUP_BUCKET/$key" /tmp/restore.sql.gz
step downloaded
gunzip -f /tmp/restore.sql.gz
expected="$(grep -c '^CREATE TABLE' /tmp/restore.sql || true)"
step unpacked

n=0
until MYSQL_PWD="$DST_PW" mysqladmin ping -h "$DST_HOST" -uroot --silent; do
  n=$((n+1)); [ "$n" -gt 60 ] && { echo "RESTORE_FAIL target unreachable"; exit 1; }; sleep 5
done
MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot -e "DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\`"
MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot "$DB" < /tmp/restore.sql
step loaded
restored="$(MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB'")"
ledger="$(MYSQL_PWD="$DST_PW" mysql -h "$DST_HOST" -uroot -N -e "SELECT COUNT(*) FROM \`$DB\`.__drizzle_migrations" 2>/dev/null || echo n/a)"
echo "RESTORE_TABLES expected=$expected restored=$restored migration_rows=$ledger"
rm -f /tmp/restore.sql
step verified
if [ "$expected" = "$restored" ] && [ "$restored" -gt 0 ]; then
  echo "RESTORE_PASS $NAME from $key in $(( $(date +%s) - started ))s"
else
  echo "RESTORE_FAIL table count"; exit 1
fi
