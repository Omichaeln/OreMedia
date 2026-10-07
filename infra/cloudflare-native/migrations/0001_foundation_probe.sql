CREATE TABLE IF NOT EXISTS foundation_probe_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'workflow-start', 'workflow-complete', 'queue-consumed')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS foundation_probe_events_request_id_idx
  ON foundation_probe_events (request_id);
