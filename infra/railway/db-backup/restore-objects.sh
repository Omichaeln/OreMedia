#!/bin/sh
# Restores a bucket's object backup (object-backup.sh), or one key prefix of it, from the backups bucket into a
# target bucket, then verifies every restored object against the manifest's sha256 by reading it back from the
# target. Never a live bucket: the target must differ from RESTORE_BUCKET, OBJECT_STORE_BUCKET_ASSETS,
# OBJECT_STORE_BUCKET_RELEASES and PROTECTED_BUCKETS (the backups bucket only under a restore-scratch/ prefix), an
# existing target key is never overwritten (it is verified instead, and a different content fails the restore),
# and in production the target must be named in RESTORE_ALLOW_PRODUCTION.
#
#   RESTORE_BUCKET      the source bucket whose backup is restored (its name under OBJECT_BACKUP_PREFIX)
#   DST_BUCKET          the target bucket; DST_PREFIX (optional, e.g. restore-scratch/drill-1/) is put before each key
#   RESTORE_KEY_PREFIX  optional: restore only keys starting with it (e.g. assets/ten_x/ for one tenant)
#   RESTORE_MANIFEST    optional: a manifest file name (manifest-<stamp>.tsv.gz); default the newest
#   RESTORE_INCLUDE_GONE=1  also restore keys deleted from the source within the retention window (their last content)
#   RESTORE_PARALLEL    concurrent transfers (default 8)
#   DST_OBJECT_STORE_*  the target store (default SRC_OBJECT_STORE_*, then OBJECT_STORE_*)
#
# Prints timed RESTORE_STEP lines and OBJECT_RESTORE_PASS <n> objects in <s>s, or OBJECT_RESTORE_FAIL and exits 1.
set -eu
export LC_ALL=C
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/backup-lib.sh"
TAB="$(printf '\t')"

field() { printf '%s\n' "$1" | cut -f"$2"; }

# Workers (run by xargs from the main run below; their environment is the main run's, exported).
if [ "${1:-}" = "--copy-one" ] || [ "${1:-}" = "--verify-one" ]; then
  sha="$(field "$2" 1)"
  ctype="$(field "$2" 3)"
  key="$(field "$2" 4)"
  target="$DST_PREFIX$key"
  f="$(mktemp "$WORK/object.XXXXXX")"
  trap 'rm -f "$f"' EXIT
  if [ "$1" = "--copy-one" ]; then
    # An existing key is left as it is; the verify pass decides whether it matches.
    if grep -qxF "$target" "$WORK/existing.txt"; then exit 0; fi
    bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$BASE/objects/$sha" "$f" || {
      echo "OBJECT_RESTORE_ERROR $key backup content $sha unreadable"
      exit 1
    }
    [ "$(sha256_of "$f")" = "$sha" ] || {
      echo "OBJECT_RESTORE_ERROR $key backup content does not match its sha256 (corrupt backup)"
      exit 1
    }
    if [ "$ctype" = "None" ] || [ -z "$ctype" ]; then
      dst_aws s3 cp --only-show-errors "$f" "s3://$DST_BUCKET/$target" || {
        echo "OBJECT_RESTORE_ERROR $key upload failed"
        exit 1
      }
    else
      dst_aws s3 cp --only-show-errors --content-type "$ctype" "$f" "s3://$DST_BUCKET/$target" || {
        echo "OBJECT_RESTORE_ERROR $key upload failed"
        exit 1
      }
    fi
    exit 0
  fi
  dst_aws s3 cp --only-show-errors "s3://$DST_BUCKET/$target" "$f" 2>/dev/null || {
    echo "OBJECT_RESTORE_MISMATCH $key missing in the target"
    exit 1
  }
  got="$(sha256_of "$f")"
  [ "$got" = "$sha" ] || {
    echo "OBJECT_RESTORE_MISMATCH $key target sha256 $got, manifest $sha"
    exit 1
  }
  exit 0
fi

require_backup_store
: "${RESTORE_BUCKET:?RESTORE_BUCKET is required}"
: "${DST_BUCKET:?DST_BUCKET is required}"
DST_PREFIX="${DST_PREFIX:-}"
KEY_PREFIX="${RESTORE_KEY_PREFIX:-}"
PARALLEL="${RESTORE_PARALLEL:-8}"
PREFIX="$(object_backup_prefix)"
[ -n "$PREFIX" ] || {
  echo "OBJECT_RESTORE_FAIL set OBJECT_BACKUP_PREFIX, OREMEDIA_ENV or RAILWAY_ENVIRONMENT_NAME"
  exit 1
}
case "$PARALLEL" in '' | *[!0-9]* | 0)
  echo "OBJECT_RESTORE_FAIL RESTORE_PARALLEL must be a positive whole number"
  exit 1
  ;;
esac
if [ -n "$DST_PREFIX" ] && ! printf '%s' "$DST_PREFIX" | grep -Eq "$KEY_CHARS"; then
  echo "OBJECT_RESTORE_FAIL DST_PREFIX has characters outside the key pattern"
  exit 1
fi
BASE="$PREFIX/$RESTORE_BUCKET"
started="$(date +%s)"
step() { echo "RESTORE_STEP objects-$1 at +$(($(date +%s) - started))s $(date -u +%Y-%m-%dT%H:%M:%SZ)"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/restore-objects.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export WORK BASE DST_BUCKET DST_PREFIX

guard_production "$DST_BUCKET" OBJECT_RESTORE_FAIL
guard_bucket_target "$DST_BUCKET" "$DST_PREFIX" "$RESTORE_BUCKET" OBJECT_RESTORE_FAIL

# 1. The manifest: the newest (or the one named), checked as gzip and for the bucket it describes.
manifest="${RESTORE_MANIFEST:-}"
if [ -z "$manifest" ]; then
  manifest="$(newest_backup_object "$BASE/manifests/" '^manifest-[0-9]{8}T[0-9]{6}Z\.tsv\.gz$')"
  [ -n "$manifest" ] || {
    echo "OBJECT_RESTORE_FAIL no manifest under $BASE/manifests/"
    exit 1
  }
fi
echo "RESTORE_SOURCE s3://$BACKUP_BUCKET/$BASE/manifests/$manifest"
bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$BASE/manifests/$manifest" "$WORK/manifest.tsv.gz"
gzip -t "$WORK/manifest.tsv.gz" || {
  echo "OBJECT_RESTORE_FAIL manifest is not a valid gzip file"
  exit 1
}
gzip -dc "$WORK/manifest.tsv.gz" > "$WORK/manifest.tsv"
grep -q "^# bucket=$RESTORE_BUCKET " "$WORK/manifest.tsv" || {
  echo "OBJECT_RESTORE_FAIL manifest does not describe bucket $RESTORE_BUCKET"
  exit 1
}

# 2. The selection: live rows (and, with RESTORE_INCLUDE_GONE=1, the newest gone row of a key with no live row)
# under the key prefix, as sha256, size, content type, key.
awk -F'\t' -v OFS='\t' -v p="$KEY_PREFIX" -v gone="${RESTORE_INCLUDE_GONE:-0}" -v re="$KEY_CHARS" '
  /^#/ || index($7, p) != 1 { next }
  NF != 7 || $7 !~ re || $2 !~ /^[0-9a-f]+$/ { bad++; next }
  $1 == "live" { live[$7] = $2 OFS $3 OFS $5 OFS $7; next }
  $1 == "gone" && gone == "1" && (!($7 in old) || $6 > since[$7]) { old[$7] = $2 OFS $3 OFS $5 OFS $7; since[$7] = $6 }
  END {
    for (k in live) print live[k]
    for (k in old) if (!(k in live)) print old[k]
    if (bad) exit 3
  }' "$WORK/manifest.tsv" > "$WORK/rows.tsv" || {
  echo "OBJECT_RESTORE_FAIL manifest has malformed rows"
  exit 1
}
sort -t "$TAB" -k4,4 "$WORK/rows.tsv" > "$WORK/selected.tsv"
n=$(wc -l < "$WORK/selected.tsv" | tr -d ' ')
[ "$n" -gt 0 ] || {
  echo "OBJECT_RESTORE_FAIL nothing to restore under '$KEY_PREFIX' in $manifest"
  exit 1
}
bytes=$(awk -F'\t' '{ s += $2 } END { printf "%d", s }' "$WORK/selected.tsv")
echo "OBJECT_RESTORE_SELECTED $n objects, $bytes bytes, into s3://$DST_BUCKET/$DST_PREFIX"
step manifest

# 3. Copy (keys already in the target are not written), then read every object back and compare its sha256.
dst_aws s3api list-objects-v2 --bucket "$DST_BUCKET" --prefix "$DST_PREFIX" --query 'Contents[].[Key]' \
  --output text | awk '$0 != "None"' > "$WORK/existing.txt"
existing=$(awk -F'\t' -v p="$DST_PREFIX" 'FILENAME == ARGV[1] { e[$0] = 1; next } (p $4) in e' \
  "$WORK/existing.txt" "$WORK/selected.tsv" | wc -l | tr -d ' ')
[ "$existing" -eq 0 ] || echo "OBJECT_RESTORE_EXISTING $existing keys already in the target: not overwritten, verified below"
rc=0
tr '\n' '\0' < "$WORK/selected.tsv" | xargs -0 -n 1 -P "$PARALLEL" sh "$0" --copy-one > "$WORK/copy.log" 2>&1 || rc=$?
grep '^OBJECT_RESTORE_' "$WORK/copy.log" || true
if [ "$rc" -ne 0 ]; then
  echo "OBJECT_RESTORE_FAIL $(grep -c '^OBJECT_RESTORE_ERROR' "$WORK/copy.log" || true) objects not copied"
  exit 1
fi
step copied
rc=0
tr '\n' '\0' < "$WORK/selected.tsv" | xargs -0 -n 1 -P "$PARALLEL" sh "$0" --verify-one > "$WORK/verify.log" 2>&1 || rc=$?
grep '^OBJECT_RESTORE_' "$WORK/verify.log" || true
if [ "$rc" -ne 0 ]; then
  echo "OBJECT_RESTORE_FAIL $(grep -c '^OBJECT_RESTORE_MISMATCH' "$WORK/verify.log" || true) of $n objects failed verification"
  exit 1
fi
step verified
echo "OBJECT_RESTORE_PASS $n objects in $(($(date +%s) - started))s"
