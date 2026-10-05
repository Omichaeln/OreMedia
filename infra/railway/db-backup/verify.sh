#!/bin/sh
# Backup integrity check (PR-09), run as its own scheduled job from the db-backup image (start command verify.sh;
# daily, docs/runbooks/backup-and-restore.md). Read-only: it never writes to any bucket or database.
#
#   Dumps, per name in VERIFY_NAMES (default oremedia, plus temporal when SRC2_HOST is set): the newest dump under
#   BACKUP_PREFIX/<name>/ is at most VERIFY_MAX_AGE_MINUTES old (default 30), matches its sha256 sidecar, passes
#   gzip -t and ends with mysqldump's "-- Dump completed" trailer (a dump cut short has none).
#   Objects, per source bucket (OBJECT_STORE_BUCKET_ASSETS, OBJECT_STORE_BUCKET_RELEASES): the newest manifest
#   under OBJECT_BACKUP_PREFIX/<bucket>/manifests/ is at most VERIFY_MAX_AGE_MINUTES old and passes gzip -t, and
#   VERIFY_OBJECT_SAMPLE (default 5) random live objects of it match their sha256 and size in the backup.
#   VERIFY_OBJECTS=0 skips the object checks (an environment without object backups).
#
# Prints one BACKUP_VERIFY_CHECK line per check, then BACKUP_VERIFY_PASS, or BACKUP_VERIFY_FAIL and exits 1.
set -eu
export LC_ALL=C
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/backup-lib.sh"

require_backup_store
BACKUP_PREFIX="${BACKUP_PREFIX:-db-backups}"
MAX_AGE="${VERIFY_MAX_AGE_MINUTES:-30}"
SAMPLE="${VERIFY_OBJECT_SAMPLE:-5}"
NAMES="${VERIFY_NAMES:-oremedia${SRC2_HOST:+ temporal}}"
for v in "$MAX_AGE" "$SAMPLE"; do
  case "$v" in '' | *[!0-9]*)
    echo "BACKUP_VERIFY_FAIL VERIFY_MAX_AGE_MINUTES and VERIFY_OBJECT_SAMPLE must be whole numbers"
    exit 1
    ;;
  esac
done
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
NOW="$(date -u +%s)"
checks=0
failures=0
ok() {
  checks=$((checks + 1))
  echo "BACKUP_VERIFY_CHECK ok $*"
}
bad() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  echo "BACKUP_VERIFY_CHECK FAIL $*"
}
# Checks the age of a stamped name; $1 the label, $2 the stamp.
fresh() {
  age=$((NOW - $(stamp_epoch "$2")))
  if [ "$age" -le $((MAX_AGE * 60)) ]; then
    ok "$1 is $((age / 60))m old"
  else
    bad "$1 is $((age / 60))m old (limit ${MAX_AGE}m)"
  fi
}

for name in $NAMES; do
  latest="$(newest_backup_object "$BACKUP_PREFIX/$name/" "^${name}-[0-9]{8}T[0-9]{6}Z\\.sql\\.gz\$")"
  if [ -z "$latest" ]; then
    bad "dump $name: no dump under $BACKUP_PREFIX/$name/"
    continue
  fi
  key="$BACKUP_PREFIX/$name/$latest"
  fresh "dump $key" "$(printf '%s' "$latest" | sed 's/^.*-\([0-9]\{8\}T[0-9]\{6\}Z\)\.sql\.gz$/\1/')"
  if ! bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$key" "$WORK/dump.sql.gz"; then
    bad "dump $key: download failed"
    continue
  fi
  if ! bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$key.sha256" "$WORK/dump.sha256" 2>/dev/null; then
    bad "dump $key: no sha256 sidecar"
  else
    want="$(awk '{print $1; exit}' "$WORK/dump.sha256")"
    got="$(sha256_of "$WORK/dump.sql.gz")"
    if [ "$want" = "$got" ]; then ok "dump $key: sha256 matches the sidecar"; else bad "dump $key: sha256 $got, sidecar $want"; fi
  fi
  if ! gzip -t "$WORK/dump.sql.gz" 2>/dev/null; then
    bad "dump $key: gzip -t failed"
  else
    ok "dump $key: gzip -t"
    if dump_completed "$WORK/dump.sql.gz"; then
      ok "dump $key: ends with the '-- Dump completed' trailer"
    else
      bad "dump $key: no '-- Dump completed' trailer (dump cut short)"
    fi
  fi
  rm -f "$WORK/dump.sql.gz" "$WORK/dump.sha256"
done

if [ "${VERIFY_OBJECTS:-1}" != "0" ]; then
  PREFIX="$(object_backup_prefix)"
  buckets="$(source_buckets)"
  if [ -z "$PREFIX" ] || [ -z "$buckets" ]; then
    bad "objects: not configured (OBJECT_STORE_BUCKET_ASSETS/RELEASES and OBJECT_BACKUP_PREFIX or the environment name; VERIFY_OBJECTS=0 skips)"
  fi
  for b in $buckets; do
    base="$PREFIX/$b"
    m="$(newest_backup_object "$base/manifests/" '^manifest-[0-9]{8}T[0-9]{6}Z\.tsv\.gz$')"
    if [ -z "$m" ]; then
      bad "objects $b: no manifest under $base/manifests/"
      continue
    fi
    fresh "objects $b: manifest $m" "$(printf '%s' "$m" | sed 's/^manifest-\(.*\)\.tsv\.gz$/\1/')"
    if ! bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$base/manifests/$m" "$WORK/manifest.tsv.gz" ||
      ! gzip -t "$WORK/manifest.tsv.gz" 2>/dev/null; then
      bad "objects $b: manifest $m unreadable or not gzip"
      continue
    fi
    ok "objects $b: manifest $m gzip -t"
    gzip -dc "$WORK/manifest.tsv.gz" | awk -F'\t' '$1 == "live"' |
      awk 'BEGIN { srand() } { print rand() "\t" $0 }' | sort | head -n "$SAMPLE" | cut -f2- > "$WORK/sample.tsv"
    while IFS="$(printf '\t')" read -r _state sha size _etag _ctype _since key; do
      if bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$base/objects/$sha" "$WORK/object" < /dev/null &&
        [ "$(sha256_of "$WORK/object")" = "$sha" ] && [ "$(stat -c %s "$WORK/object")" = "$size" ]; then
        ok "objects $b: $key sha256 and size match"
      else
        bad "objects $b: $key content $sha missing or does not match"
      fi
      rm -f "$WORK/object"
    done < "$WORK/sample.tsv"
  done
fi

if [ "$failures" -gt 0 ]; then
  echo "BACKUP_VERIFY_FAIL $failures of $checks checks failed"
  exit 1
fi
echo "BACKUP_VERIFY_PASS $checks checks"
