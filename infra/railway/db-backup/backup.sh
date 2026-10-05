#!/bin/sh
# Dumps SRC_DB from SRC_HOST (and, when SRC2_HOST is set, SRC2_DB from SRC2_HOST: the Temporal persistence
# database) with mysqldump, gzips each dump, copies it to the object store under BACKUP_PREFIX and deletes copies
# older than BACKUP_RETENTION_DAYS (default 14) from the store and from the local volume when one is mounted.
# Prints one DB_BACKUP_PASS line per database with the object key and size, or DB_BACKUP_FAIL and exits 1.
# Each dump gets a sha256 sidecar (<dump>.sha256, sha256sum format) that restore.sh and verify.sh check.
# After the dumps the same run backs up the assets and releases buckets (object-backup.sh); the two halves run as
# separate processes, so a failing dump never skips the object backup or the reverse, and the run exits 1 if
# either failed. Secrets come from the environment only; nothing is echoed.
set -eu

if [ "${1:-}" != "--databases" ]; then
  status=0
  sh "$0" --databases || status=1
  if [ -n "${OBJECT_STORE_BUCKET_ASSETS:-}${OBJECT_STORE_BUCKET_RELEASES:-}" ]; then
    sh "$(dirname "$0")/object-backup.sh" || status=1
  else
    echo "OBJECT_BACKUP_SKIPPED no source bucket (OBJECT_STORE_BUCKET_ASSETS, OBJECT_STORE_BUCKET_RELEASES)"
  fi
  exit "$status"
fi

: "${SRC_HOST:?SRC_HOST is required}"
: "${SRC_DB:?SRC_DB is required}"
: "${SRC_PW:?SRC_PW is required}"
: "${OBJECT_STORE_ENDPOINT:?OBJECT_STORE_ENDPOINT is required}"
: "${OBJECT_STORE_ACCESS_KEY_ID:?OBJECT_STORE_ACCESS_KEY_ID is required}"
: "${OBJECT_STORE_SECRET_ACCESS_KEY:?OBJECT_STORE_SECRET_ACCESS_KEY is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
BACKUP_PREFIX="${BACKUP_PREFIX:-db-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
export AWS_ACCESS_KEY_ID="$OBJECT_STORE_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$OBJECT_STORE_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${OBJECT_STORE_REGION:-auto}"
export AWS_EC2_METADATA_DISABLED=true
S3="aws --endpoint-url $OBJECT_STORE_ENDPOINT s3"
S3API="aws --endpoint-url $OBJECT_STORE_ENDPOINT s3api"

dump_one() {
  name="$1"; host="$2"; db="$3"; pw="$4"
  file="${TMPDIR:-/tmp}/${name}-${STAMP}.sql.gz"
  # --source-data records the binary log position when binary logging is on, so a later binlog replay can
  # continue from this dump; without binary logging the option is dropped (the dump is the whole recovery point).
  binlog="$(MYSQL_PWD="$pw" mysql -h "$host" -uroot -N -e "SELECT @@log_bin" 2>/dev/null || echo 0)"
  extra=""
  [ "$binlog" = "1" ] && extra="--source-data=2"
  # shellcheck disable=SC2086
  # A space-separated list of databases (the Temporal pair "temporal temporal_visibility") is dumped with
  # --databases, so the dump carries CREATE DATABASE and USE statements and restores with a plain mysql < dump.
  case "$db" in
    *" "*) dbs="--databases $db" ;;
    *) dbs="$db" ;;
  esac
  # shellcheck disable=SC2086
  MYSQL_PWD="$pw" mysqldump -h "$host" -uroot --single-transaction --routines --triggers --events \
    --set-gtid-purged=OFF $extra $dbs | gzip -6 > "$file"
  size="$(stat -c %s "$file")"
  [ "$size" -gt 1024 ] || { echo "DB_BACKUP_FAIL $name dump too small ($size bytes)"; exit 1; }
  key="$BACKUP_PREFIX/$name/${name}-${STAMP}.sql.gz"
  sum="$(sha256sum "$file" | awk '{print $1}')"
  printf '%s  %s\n' "$sum" "${name}-${STAMP}.sql.gz" > "$file.sha256"
  $S3 cp --only-show-errors "$file" "s3://$BACKUP_BUCKET/$key"
  remote="$($S3API head-object --bucket "$BACKUP_BUCKET" --key "$key" --query ContentLength --output text)"
  [ "$remote" = "$size" ] || { echo "DB_BACKUP_FAIL $name stored size $remote differs from $size"; exit 1; }
  # The sidecar goes up after the dump is confirmed, so a sidecar always names a complete dump.
  $S3 cp --only-show-errors "$file.sha256" "s3://$BACKUP_BUCKET/$key.sha256"
  if [ -d "$LOCAL_DIR" ]; then
    cp "$file" "$LOCAL_DIR/" && find "$LOCAL_DIR" -name "${name}-*.sql.gz" -mtime "+$RETENTION_DAYS" -delete
  fi
  rm -f "$file" "$file.sha256"
  echo "DB_BACKUP_PASS $name s3://$BACKUP_BUCKET/$key $size bytes binlog=$binlog sha256=$sum"
}

prune_remote() {
  name="$1"
  cutoff="$(date -u -d "-${RETENTION_DAYS} days" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%Y%m%dT%H%M%SZ)"
  $S3 ls "s3://$BACKUP_BUCKET/$BACKUP_PREFIX/$name/" | awk '{print $4}' | while read -r f; do
    [ -n "$f" ] || continue
    stamp="$(echo "$f" | sed -n "s/^${name}-\([0-9TZ]*\)\.sql\.gz\(\.sha256\)\{0,1\}$/\1/p")"
    [ -n "$stamp" ] || continue
    if [ "$(echo "$stamp" | tr -d TZ)" -lt "$(echo "$cutoff" | tr -d TZ)" ]; then
      $S3 rm --only-show-errors "s3://$BACKUP_BUCKET/$BACKUP_PREFIX/$name/$f"
      echo "DB_BACKUP_PRUNED $name $f"
    fi
  done
}

dump_one oremedia "$SRC_HOST" "$SRC_DB" "$SRC_PW"
prune_remote oremedia
if [ -n "${SRC2_HOST:-}" ]; then
  : "${SRC2_DB:?SRC2_DB is required with SRC2_HOST}"
  : "${SRC2_PW:?SRC2_PW is required with SRC2_HOST}"
  dump_one temporal "$SRC2_HOST" "$SRC2_DB" "$SRC2_PW"
  prune_remote temporal
fi
echo "DB_BACKUP_DONE $STAMP"
