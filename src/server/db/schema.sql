CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  digest_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  canonical_url TEXT UNIQUE NOT NULL,
  hostname TEXT NOT NULL,
  origin TEXT NOT NULL,
  last_fetched_at TEXT,
  last_fetch_outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS robots_cache (
  origin TEXT PRIMARY KEY,
  raw_content TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  response_headers TEXT NOT NULL DEFAULT '{}',
  cached_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 15 AND 1440),
  next_check_at TEXT NOT NULL,
  capture_config TEXT NOT NULL,
  capture_fingerprint TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'balanced' CHECK (sensitivity IN ('low','balanced','high')),
  include_selectors TEXT NOT NULL DEFAULT '[]',
  ignore_selectors TEXT NOT NULL DEFAULT '[]',
  noise_filters TEXT NOT NULL DEFAULT '{"timestamps":true,"counters":true,"tokens":true}',
  learned_ignore_patterns TEXT NOT NULL DEFAULT '[]',
  keyword_rules TEXT NOT NULL DEFAULT '[]',
  is_paused INTEGER NOT NULL DEFAULT 0,
  feed_token TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sub_due ON subscriptions(is_paused, next_check_at);
CREATE INDEX IF NOT EXISTS idx_sub_group ON subscriptions(target_id, capture_fingerprint);
CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_feed_token ON subscriptions(feed_token);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  capture_fingerprint TEXT NOT NULL,
  engine_used TEXT NOT NULL CHECK (engine_used IN ('playwright','http_dom')),
  final_url TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  sanitized_dom TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  screenshot_path TEXT,
  subresource_count INTEGER NOT NULL DEFAULT 0,
  top_level_navigations INTEGER NOT NULL DEFAULT 1,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_lookup ON observations(target_id, capture_fingerprint, captured_at);

CREATE TABLE IF NOT EXISTS monitor_versions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  stored_text TEXT NOT NULL,
  change_summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, version_number)
);

CREATE TABLE IF NOT EXISTS sub_state (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  active_version_id TEXT REFERENCES monitor_versions(id) ON DELETE SET NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  is_currently_down INTEGER NOT NULL DEFAULT 0,
  last_down_alert_at TEXT,
  pending_candidate_hash TEXT,
  pending_candidate_checks INTEGER NOT NULL DEFAULT 0,
  pending_observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
  last_alerted_hash TEXT,
  last_alert_sent_at TEXT,
  recent_checks_window TEXT NOT NULL DEFAULT '[]',
  is_noisy INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  job_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('OK','ERROR','BLOCKED')),
  reason TEXT,
  http_status INTEGER,
  duration_ms INTEGER NOT NULL,
  was_deduplicated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_sub ON check_runs(subscription_id, created_at);

CREATE TABLE IF NOT EXISTS change_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  previous_version_id TEXT REFERENCES monitor_versions(id) ON DELETE SET NULL,
  current_version_id TEXT REFERENCES monitor_versions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('CHANGE','DOWN','RECOVERED')),
  suppressed INTEGER NOT NULL DEFAULT 0,
  text_diff TEXT,
  keyword_matches TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (event_type <> 'CHANGE' OR current_version_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('CHECK','PROBE')),
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  capture_fingerprint TEXT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','CLAIMED','RUNNING','COMPLETED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT NOT NULL,
  lease_expires_at TEXT,
  locked_by TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_group ON jobs(target_id, capture_fingerprint)
  WHERE kind = 'CHECK' AND status IN ('QUEUED','CLAIMED','RUNNING');

CREATE TABLE IF NOT EXISTS notification_destinations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord','telegram','email','in_app')),
  destination_config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'EVENT' CHECK (kind IN ('EVENT','DIGEST')),
  change_event_id TEXT REFERENCES change_events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord','telegram','email','in_app')),
  destination_id TEXT NOT NULL DEFAULT 'default',
  idempotency_key TEXT UNIQUE NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','PENDING_CONFIG','SENT_EXTERNAL','RECORDED_IN_APP','RETRYING','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (kind = 'DIGEST' OR change_event_id IS NOT NULL)
);
