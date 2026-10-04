/** A timeline time as the editor shows it: m:ss.cc (hundredths), h:mm:ss.cc past an hour. */
export function timecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000) % 60;
  const h = Math.floor(total / 360000);
  const tail = `${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${tail}` : `${m}:${tail}`;
}

/** Seconds as a person types them ("2.5", "1:02.25") → milliseconds; null when it is not a time. */
export function parseTimecode(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d{1,3})?)\s*$/.exec(text);
  if (!m) return null;
  const minutes = m[1] ? Number(m[1]) : 0;
  const seconds = Number(m[2]);
  if (!Number.isFinite(seconds)) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}
