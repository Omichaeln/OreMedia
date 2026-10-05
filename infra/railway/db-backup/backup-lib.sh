#!/bin/sh
# Shared helpers for the db-backup image (sourced, never run): the object store clients, the recovery guards and
# the stamp arithmetic used by object-backup.sh, restore.sh, restore-objects.sh, verify.sh and drill.sh.
# Credentials come from the environment and are passed to the AWS CLI through its environment only; nothing here
# prints a credential, a password or a connection string.

# The backup store (the environment's dedicated backups bucket): OBJECT_STORE_*, as backup.sh uses it. Each client
# runs in a subshell that exports its credentials, so they never appear in a process argument list.
# shellcheck disable=SC2030,SC2031 # the exports are meant to stay inside the subshell
bk_aws() (
  export AWS_ACCESS_KEY_ID="$OBJECT_STORE_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$OBJECT_STORE_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="${OBJECT_STORE_REGION:-auto}" AWS_EC2_METADATA_DISABLED=true
  exec aws --endpoint-url "$OBJECT_STORE_ENDPOINT" "$@"
)

# The application's object store (the assets and releases buckets): SRC_OBJECT_STORE_*, each defaulting to the
# OBJECT_STORE_* value when the buckets live in the same store as the backups.
# shellcheck disable=SC2030,SC2031
src_aws() (
  export AWS_ACCESS_KEY_ID="${SRC_OBJECT_STORE_ACCESS_KEY_ID:-$OBJECT_STORE_ACCESS_KEY_ID}"
  export AWS_SECRET_ACCESS_KEY="${SRC_OBJECT_STORE_SECRET_ACCESS_KEY:-$OBJECT_STORE_SECRET_ACCESS_KEY}"
  export AWS_DEFAULT_REGION="${SRC_OBJECT_STORE_REGION:-${OBJECT_STORE_REGION:-auto}}" AWS_EC2_METADATA_DISABLED=true
  exec aws --endpoint-url "${SRC_OBJECT_STORE_ENDPOINT:-$OBJECT_STORE_ENDPOINT}" "$@"
)

# The restore target store: DST_OBJECT_STORE_*, each defaulting to SRC_OBJECT_STORE_*, then OBJECT_STORE_*.
# shellcheck disable=SC2030,SC2031
dst_aws() (
  export AWS_ACCESS_KEY_ID="${DST_OBJECT_STORE_ACCESS_KEY_ID:-${SRC_OBJECT_STORE_ACCESS_KEY_ID:-$OBJECT_STORE_ACCESS_KEY_ID}}"
  export AWS_SECRET_ACCESS_KEY="${DST_OBJECT_STORE_SECRET_ACCESS_KEY:-${SRC_OBJECT_STORE_SECRET_ACCESS_KEY:-$OBJECT_STORE_SECRET_ACCESS_KEY}}"
  export AWS_DEFAULT_REGION="${DST_OBJECT_STORE_REGION:-${SRC_OBJECT_STORE_REGION:-${OBJECT_STORE_REGION:-auto}}}"
  export AWS_EC2_METADATA_DISABLED=true
  exec aws --endpoint-url "${DST_OBJECT_STORE_ENDPOINT:-${SRC_OBJECT_STORE_ENDPOINT:-$OBJECT_STORE_ENDPOINT}}" "$@"
)

require_backup_store() {
  : "${OBJECT_STORE_ENDPOINT:?OBJECT_STORE_ENDPOINT is required}"
  : "${OBJECT_STORE_ACCESS_KEY_ID:?OBJECT_STORE_ACCESS_KEY_ID is required}"
  : "${OBJECT_STORE_SECRET_ACCESS_KEY:?OBJECT_STORE_SECRET_ACCESS_KEY is required}"
  : "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
}

# The environment name, as the application's logger reads it: OREMEDIA_ENV, else Railway's RAILWAY_ENVIRONMENT_NAME.
env_name() {
  printf '%s' "${OREMEDIA_ENV:-${RAILWAY_ENVIRONMENT_NAME:-}}" | tr '[:upper:]' '[:lower:]'
}

# The source buckets the object backup covers: the application's assets and releases buckets, once each.
source_buckets() {
  printf '%s\n%s\n' "${OBJECT_STORE_BUCKET_ASSETS:-}" "${OBJECT_STORE_BUCKET_RELEASES:-}" | awk 'NF && !seen[$0]++'
}

# Where the object backups of this environment live in the backups bucket.
object_backup_prefix() {
  if [ -n "${OBJECT_BACKUP_PREFIX:-}" ]; then
    printf '%s' "${OBJECT_BACKUP_PREFIX%/}"
  elif [ -n "$(env_name)" ]; then
    printf 'object-backups/%s' "$(env_name)"
  fi
}

# Refuses a restore or drill whose environment is production, unless RESTORE_ALLOW_PRODUCTION names the exact
# target: an operator who means it types the target, nothing else unlocks it. $1 the target, $2 the failure tag.
guard_production() {
  case "$(env_name)" in
    *prod*)
      if [ "${RESTORE_ALLOW_PRODUCTION:-}" != "$1" ]; then
        echo "$2 refusing to run in environment '$(env_name)': set RESTORE_ALLOW_PRODUCTION to the exact target to override"
        exit 1
      fi
      echo "RECOVERY_GUARD production override accepted for this target"
      ;;
  esac
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Refuses a database target that is a source database: by name (SRC_HOST, SRC2_HOST, PROTECTED_DB_HOSTS) and,
# when the source is reachable, by server identity (@@server_uuid), which also catches an alias of the same server.
# $1 the target host, $2 its root password, $3 the failure tag.
guard_db_target() {
  g_dst="$(lower "$1")"
  for g_src in ${SRC_HOST:-} ${SRC2_HOST:-} ${PROTECTED_DB_HOSTS:-}; do
    if [ "$(lower "$g_src")" = "$g_dst" ]; then
      echo "$3 target host is a source database host; refusing to restore over it"
      exit 1
    fi
  done
  if [ -n "${SRC_HOST:-}" ] && [ -n "${SRC_PW:-}" ]; then
    g_src_uuid="$(MYSQL_PWD="$SRC_PW" mysql -h "$SRC_HOST" -uroot --connect-timeout=10 -N -e 'SELECT @@server_uuid' 2>/dev/null || true)"
    g_dst_uuid="$(MYSQL_PWD="$2" mysql -h "$1" -uroot --connect-timeout=10 -N -e 'SELECT @@server_uuid' 2>/dev/null || true)"
    if [ -n "$g_src_uuid" ] && [ "$g_src_uuid" = "$g_dst_uuid" ]; then
      echo "$3 target is the same MySQL server as SRC_HOST (server_uuid); refusing to restore over it"
      exit 1
    fi
    [ -n "$g_src_uuid" ] || echo "RECOVERY_GUARD source server identity not readable; name check only"
  fi
}

# Refuses an object restore target that is a live or backup bucket. Restoring into the backups bucket is allowed
# only under the restore-scratch/ prefix. $1 the target bucket, $2 the target prefix, $3 the source bucket, $4 tag.
guard_bucket_target() {
  g_dst="$(lower "$1")"
  for g_src in "$3" ${OBJECT_STORE_BUCKET_ASSETS:-} ${OBJECT_STORE_BUCKET_RELEASES:-} ${PROTECTED_BUCKETS:-}; do
    if [ -n "$g_src" ] && [ "$(lower "$g_src")" = "$g_dst" ]; then
      echo "$4 target bucket is a live source bucket; refusing to restore into it"
      exit 1
    fi
  done
  if [ "$g_dst" = "$(lower "$BACKUP_BUCKET")" ]; then
    case "$2" in
      restore-scratch/?*) ;;
      *)
        echo "$4 restoring into the backups bucket needs a target prefix under restore-scratch/"
        exit 1
        ;;
    esac
  fi
}

# UTC stamp (20261005T101500Z) to epoch seconds; GNU date, with the BSD form as a fallback for a laptop.
stamp_epoch() {
  date -u -d "$(printf '%s' "$1" | sed 's/^\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z$/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null ||
    date -u -j -f %Y%m%dT%H%M%SZ "$1" +%s
}

stamp_days_ago() {
  date -u -d "-$1 days" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-"$1"d +%Y%m%dT%H%M%SZ
}

# True when UTC stamp $1 is earlier than UTC stamp $2 (both 20261005T101500Z; compared as 14-digit numbers).
stamp_before() {
  [ "$(printf '%s' "$1" | tr -d TZ)" -lt "$(printf '%s' "$2" | tr -d TZ)" ]
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# True when the gzipped dump $1 ends with mysqldump's "-- Dump completed" trailer, which mysqldump writes only after
# the last table: a dump without it was cut short (backup.sh refuses to upload one; verify.sh reports one).
dump_completed() { gzip -dc "$1" 2>/dev/null | tail -n 1 | grep -q '^-- Dump completed'; }

# The newest object (by the UTC stamp in its name) directly under s3://BACKUP_BUCKET/$1 whose name matches the
# extended regular expression $2; empty when there is none.
newest_backup_object() {
  bk_aws s3 ls "s3://$BACKUP_BUCKET/$1" | awk '{print $4}' | grep -E "$2" | LC_ALL=C sort | tail -n 1
}

# The application's object key pattern (packages/modules/assets/src/storage.ts KEY_PATTERN's character set): keys
# outside it are reported, never parsed, so a tab, a space or a newline can never shift a manifest column.
# shellcheck disable=SC2034 # used by the scripts that source this file
KEY_CHARS='^[A-Za-z0-9_.][A-Za-z0-9_./-]*$'

# Path-style addressing for every S3-compatible store (Railway buckets, R2), unless a config file is supplied.
if [ -z "${AWS_CONFIG_FILE:-}" ]; then
  AWS_CONFIG_FILE="${TMPDIR:-/tmp}/oremedia-db-backup-aws.config"
  printf '[default]\ns3 =\n  addressing_style = path\n' > "$AWS_CONFIG_FILE"
  export AWS_CONFIG_FILE
fi
