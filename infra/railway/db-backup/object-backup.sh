#!/bin/sh
# Incremental object backup (PR-09): copies new or changed objects from the application's assets and releases
# buckets (OBJECT_STORE_BUCKET_ASSETS, OBJECT_STORE_BUCKET_RELEASES, read with SRC_OBJECT_STORE_*) into the backups
# bucket (BACKUP_BUCKET, OBJECT_STORE_*) under OBJECT_BACKUP_PREFIX/<bucket>/ (default object-backups/<env>):
#
#   objects/<sha256>                    each distinct content once, immutable (content-addressed)
#   manifests/manifest-<stamp>.tsv.gz   one per run: the whole catalog after the run (state, sha256, size, ETag,
#                                       content type, since, key); restore-objects.sh and verify.sh read it
#   cursor                              the last key handled when a run stopped at its bound (carry-over)
#
# Copy only: nothing is ever deleted from a source bucket. A key that disappears from the source (or is replaced
# by new content) stays in the catalog as `gone` for BACKUP_RETENTION_DAYS (default 14), as dumps do, and its
# content is pruned after that unless another catalog row still references it. Each run handles at most
# OBJECT_BACKUP_MAX_OBJECTS objects (default 300) and OBJECT_BACKUP_MAX_BYTES (default 1 GiB, at least one object);
# what is left carries over to the next run, starting after the cursor. Safe to rerun: an unchanged object (same
# size and ETag as its catalog row) is not copied again, and known content is not uploaded again.
#
# Prints OBJECT_BACKUP_PASS <bucket> <copied> <bytes> per bucket, or OBJECT_BACKUP_FAIL <bucket> <reason> and exits 1.
# Run by backup.sh after the database dumps; `object-backup.sh <bucket>` backs up one bucket.
set -eu
export LC_ALL=C
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/backup-lib.sh"

require_backup_store
PREFIX="$(object_backup_prefix)"
[ -n "$PREFIX" ] || {
  echo "OBJECT_BACKUP_FAIL - set OBJECT_BACKUP_PREFIX, OREMEDIA_ENV or RAILWAY_ENVIRONMENT_NAME"
  exit 1
}

if [ $# -eq 0 ]; then
  buckets="$(source_buckets)"
  if [ -z "$buckets" ]; then
    echo "OBJECT_BACKUP_SKIPPED no source bucket (OBJECT_STORE_BUCKET_ASSETS, OBJECT_STORE_BUCKET_RELEASES)"
    exit 0
  fi
  status=0
  for b in $buckets; do
    sh "$0" "$b" || status=1
  done
  exit "$status"
fi

B="$1"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
MAX_OBJECTS="${OBJECT_BACKUP_MAX_OBJECTS:-300}"
MAX_BYTES="${OBJECT_BACKUP_MAX_BYTES:-1073741824}"
EXCLUDE="${OBJECT_BACKUP_EXCLUDE_PREFIXES:-quarantine/}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CUTOFF="$(stamp_days_ago "$RETENTION_DAYS")"
BASE="$PREFIX/$B"
TAB="$(printf '\t')"
reported=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/object-backup.XXXXXX")"
on_exit() {
  rc=$?
  rm -rf "$WORK"
  if [ "$rc" -ne 0 ] && [ "$reported" -eq 0 ]; then echo "OBJECT_BACKUP_FAIL $B exit $rc"; fi
}
trap on_exit EXIT

fail() {
  reported=1
  echo "OBJECT_BACKUP_FAIL $B $1"
  exit 1
}

for v in "$MAX_OBJECTS" "$MAX_BYTES" "$RETENTION_DAYS"; do
  case "$v" in '' | *[!0-9]*) fail "limits must be whole numbers" ;; esac
done
[ "$(lower "$B")" != "$(lower "$BACKUP_BUCKET")" ] || fail "is the backups bucket; refusing to back it up into itself"

# 1. The previous catalog: the newest manifest. An unreadable manifest is a failure, never an empty start.
: > "$WORK/prev.tsv"
prev="$(newest_backup_object "$BASE/manifests/" '^manifest-[0-9]{8}T[0-9]{6}Z\.tsv\.gz$')"
if [ -n "$prev" ]; then
  bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$BASE/manifests/$prev" "$WORK/prev.tsv.gz"
  gzip -t "$WORK/prev.tsv.gz" || fail "previous manifest $prev is not a valid gzip file"
  gzip -dc "$WORK/prev.tsv.gz" | awk '!/^#/' > "$WORK/prev.tsv"
fi

# 2. The source listing (size, ETag, key), keys sorted. Excluded prefixes are skipped; a key outside the
# application's key pattern is reported and fails the run rather than being parsed.
src_aws s3api list-objects-v2 --bucket "$B" --query 'Contents[].[Size,ETag,Key]' --output text > "$WORK/list.txt"
awk -F'\t' -v OFS='\t' -v ex="$EXCLUDE" -v re="$KEY_CHARS" -v bad="$WORK/bad.txt" '
  BEGIN { n = split(ex, xs, " ") }
  $0 == "None" || $0 == "" { next }
  {
    for (i = 1; i <= n; i++) if (xs[i] != "" && index($3, xs[i]) == 1) next
    if (NF != 3 || $1 !~ /^[0-9]+$/ || $3 !~ re) { print > bad; next }
    gsub(/"/, "", $2)
    print $1, $2, $3
  }' "$WORK/list.txt" | sort -t "$TAB" -k3,3 > "$WORK/src.tsv"
errors=0
if [ -s "$WORK/bad.txt" ]; then
  errors=$(wc -l < "$WORK/bad.txt" | tr -d ' ')
  echo "OBJECT_BACKUP_UNSUPPORTED_KEY $B $errors keys outside the application key pattern were not backed up"
fi

# 3. Pending: source objects without a live catalog row of the same size and ETag (new or changed).
awk -F'\t' 'FILENAME == ARGV[1] { if ($1 == "live") live[$7] = $3 "\t" $4; next }
  !(($3 in live) && live[$3] == $1 "\t" $2)' "$WORK/prev.tsv" "$WORK/src.tsv" > "$WORK/pending.tsv"

# 4. Carry-over: start after the cursor of the last bounded run, then wrap around, so a run that stops at its
# bound (or a key that keeps failing) never starves the keys after it.
cursor=""
if bk_aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/$BASE/cursor" "$WORK/cursor" 2>/dev/null; then
  cursor="$(cat "$WORK/cursor")"
fi
awk -F'\t' -v c="$cursor" '$3 "" > c ""' "$WORK/pending.tsv" > "$WORK/ordered.tsv"
awk -F'\t' -v c="$cursor" '$3 "" <= c ""' "$WORK/pending.tsv" >> "$WORK/ordered.tsv"

# 5. Copy, bounded. Each object is downloaded, hashed, and its content uploaded once under objects/<sha256>.
: > "$WORK/copied.tsv"
cut -f2 "$WORK/prev.tsv" | sort -u > "$WORK/known.txt"
attempted=0
copied=0
bytes=0
last=""
while IFS="$TAB" read -r size etag key; do
  if [ "$attempted" -ge "$MAX_OBJECTS" ]; then break; fi
  if [ "$attempted" -gt 0 ] && [ $((bytes + size)) -gt "$MAX_BYTES" ]; then break; fi
  attempted=$((attempted + 1))
  last="$key"
  f="$WORK/object"
  if ! meta="$(src_aws s3api get-object --bucket "$B" --key "$key" "$f" \
    --query '[ContentLength,ETag,ContentType]' --output text < /dev/null 2> /dev/null)"; then
    # Deleted between the listing and the download (a 404 on head) is not an error; anything else is.
    if herr="$(src_aws s3api head-object --bucket "$B" --key "$key" 2>&1 < /dev/null > /dev/null)"; then
      herr="download failed"
    fi
    case "$herr" in
      *"(404)"* | *"Not Found"* | *NoSuchKey*) echo "OBJECT_BACKUP_VANISHED $B $key deleted after the listing" ;;
      *)
        errors=$((errors + 1))
        echo "OBJECT_BACKUP_ERROR $B $key download failed"
        ;;
    esac
    rm -f "$f"
    continue
  fi
  len="$(printf '%s\n' "$meta" | cut -f1)"
  etag="$(printf '%s\n' "$meta" | cut -f2 | tr -d '"')"
  ctype="$(printf '%s\n' "$meta" | cut -f3)"
  actual="$(stat -c %s "$f")"
  if [ "$actual" != "$len" ]; then
    errors=$((errors + 1))
    echo "OBJECT_BACKUP_ERROR $B $key downloaded $actual bytes, the store reported $len"
    rm -f "$f"
    continue
  fi
  sha="$(sha256_of "$f")"
  if ! grep -qx "$sha" "$WORK/known.txt"; then
    if ! bk_aws s3 cp --only-show-errors "$f" "s3://$BACKUP_BUCKET/$BASE/objects/$sha" < /dev/null; then
      errors=$((errors + 1))
      echo "OBJECT_BACKUP_ERROR $B $key upload failed"
      rm -f "$f"
      continue
    fi
    echo "$sha" >> "$WORK/known.txt"
  fi
  printf 'live\t%s\t%s\t%s\t%s\t%s\t%s\n' "$sha" "$actual" "${etag:-None}" "${ctype:-None}" "$STAMP" "$key" >> "$WORK/copied.tsv"
  copied=$((copied + 1))
  bytes=$((bytes + actual))
  rm -f "$f"
done < "$WORK/ordered.tsv"

# 6. The new catalog. Copied rows are live; a live row whose key was copied with new content, or whose key left
# the source, becomes gone (since = now); gone rows older than the retention window are pruned.
awk -F'\t' -v OFS='\t' -v stamp="$STAMP" -v cutoff="$CUTOFF" -v pruned="$WORK/pruned.txt" '
  FILENAME == ARGV[1] { insrc[$3] = 1; next }
  FILENAME == ARGV[2] { now[$7] = $2; print; next }
  $1 == "live" {
    if ($7 in now) { if (now[$7] != $2) print "gone", $2, $3, $4, $5, stamp, $7; next }
    if ($7 in insrc) { print; next }
    print "gone", $2, $3, $4, $5, stamp, $7; next
  }
  $1 == "gone" {
    if (($7 in now) && now[$7] == $2) next
    if ($6 < cutoff) { print $2 > pruned; next }
    print
  }' "$WORK/src.tsv" "$WORK/copied.tsv" "$WORK/prev.tsv" | sort -t "$TAB" -k7,7 -k1,1r > "$WORK/catalog.tsv"
live=$(awk -F'\t' '$1 == "live"' "$WORK/catalog.tsv" | wc -l | tr -d ' ')
gone=$(awk -F'\t' '$1 == "gone"' "$WORK/catalog.tsv" | wc -l | tr -d ' ')

# 7. The manifest of this run, then the pruning (content no catalog row references any more; old manifests).
{
  echo "# oremedia object backup manifest v1"
  echo "# bucket=$B stamp=$STAMP live=$live gone=$gone copied=$copied"
  printf '# state\tsha256\tsize\tetag\tcontent_type\tsince\tkey\n'
  cat "$WORK/catalog.tsv"
} | gzip -6 > "$WORK/manifest.tsv.gz"
manifest="$BASE/manifests/manifest-$STAMP.tsv.gz"
bk_aws s3 cp --only-show-errors "$WORK/manifest.tsv.gz" "s3://$BACKUP_BUCKET/$manifest"
stored="$(bk_aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$manifest" --query ContentLength --output text)"
[ "$stored" = "$(stat -c %s "$WORK/manifest.tsv.gz")" ] || fail "stored manifest size $stored differs"
echo "OBJECT_BACKUP_MANIFEST $B s3://$BACKUP_BUCKET/$manifest live=$live gone=$gone"

removed=0
if [ -s "$WORK/pruned.txt" ]; then
  cut -f2 "$WORK/catalog.tsv" | sort -u > "$WORK/refs.txt"
  sort -u "$WORK/pruned.txt" | comm -23 - "$WORK/refs.txt" > "$WORK/delete.txt"
  while read -r sha; do
    bk_aws s3 rm --only-show-errors "s3://$BACKUP_BUCKET/$BASE/objects/$sha" < /dev/null
    removed=$((removed + 1))
  done < "$WORK/delete.txt"
fi
bk_aws s3 ls "s3://$BACKUP_BUCKET/$BASE/manifests/" | awk '{print $4}' > "$WORK/manifests.txt"
while read -r m; do
  s="$(printf '%s' "$m" | sed -n 's/^manifest-\([0-9]\{8\}T[0-9]\{6\}Z\)\.tsv\.gz$/\1/p')"
  if [ -n "$s" ] && [ "$m" != "manifest-$STAMP.tsv.gz" ] && stamp_before "$s" "$CUTOFF"; then
    bk_aws s3 rm --only-show-errors "s3://$BACKUP_BUCKET/$BASE/manifests/$m" < /dev/null
  fi
done < "$WORK/manifests.txt"
[ "$removed" -eq 0 ] || echo "OBJECT_BACKUP_PRUNED $B $removed objects past the $RETENTION_DAYS-day retention"

# 8. The cursor: kept while work carries over, removed once a run finishes everything pending.
remaining=$(($(wc -l < "$WORK/ordered.tsv" | tr -d ' ') - attempted))
if [ "$remaining" -gt 0 ]; then
  printf '%s' "$last" > "$WORK/cursor.new"
  bk_aws s3 cp --only-show-errors "$WORK/cursor.new" "s3://$BACKUP_BUCKET/$BASE/cursor"
  echo "OBJECT_BACKUP_CARRYOVER $B $remaining objects left for the next run"
elif [ -n "$cursor" ]; then
  bk_aws s3 rm --only-show-errors "s3://$BACKUP_BUCKET/$BASE/cursor"
fi

reported=1
if [ "$errors" -gt 0 ]; then
  echo "OBJECT_BACKUP_FAIL $B $errors errors; copied $copied objects, $bytes bytes"
  exit 1
fi
echo "OBJECT_BACKUP_PASS $B $copied $bytes"
