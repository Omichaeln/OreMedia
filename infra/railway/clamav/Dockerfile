# The clamav service: the official image with clamd's size limits raised to cover the video upload cap (1 GiB).
# clamd's defaults (StreamMaxLength 25M, MaxScanSize/MaxFileSize 100M) abort the INSTREAM scan of any larger upload,
# which leaves it quarantined as scanner_unavailable. The build fails if the config file is not where we expect it,
# rather than shipping a scanner with the old limits.
# AlertExceedsMax makes clamd answer `Heuristics.Limits.Exceeded.* FOUND` for a file it could not scan whole (over
# MaxFileSize or MaxScanSize, too deeply nested), never `OK`; the scanner treats that as a detection (fail closed).
FROM clamav/clamav:stable
RUN set -eu; \
    conf=/etc/clamav/clamd.conf; \
    test -f "$conf"; \
    sed -i -E '/^#?[[:space:]]*(StreamMaxLength|MaxScanSize|MaxFileSize|AlertExceedsMax)([[:space:]]|$)/d' "$conf"; \
    printf 'StreamMaxLength 1100M\nMaxScanSize 1100M\nMaxFileSize 1100M\nAlertExceedsMax yes\n' >> "$conf"; \
    grep -E '^(StreamMaxLength|MaxScanSize|MaxFileSize) 1100M$' "$conf" | wc -l | grep -qx 3; \
    grep -E '^AlertExceedsMax yes$' "$conf" | wc -l | grep -qx 1
