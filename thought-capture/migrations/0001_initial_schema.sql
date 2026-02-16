-- Initial schema for Thought Capture
-- All timestamps are ISO 8601 TEXT strings in UTC
-- UUIDs generated via crypto.randomUUID() in application code

CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  slack_message_ts TEXT NOT NULL UNIQUE,
  text TEXT,
  classification TEXT NOT NULL DEFAULT 'unclassified',
  classification_source TEXT NOT NULL DEFAULT 'pending',
  classification_model TEXT,
  classification_latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  snooze_until TEXT,
  created_at TEXT NOT NULL,
  classified_at TEXT,
  status_changed_at TEXT,
  text_purged_at TEXT,
  bot_reply_ts TEXT
);

CREATE INDEX IF NOT EXISTS idx_thoughts_user_classification_status
  ON thoughts(slack_user_id, classification, status);
CREATE INDEX IF NOT EXISTS idx_thoughts_user_created
  ON thoughts(slack_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
  ON thoughts(created_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_snooze_until
  ON thoughts(snooze_until);
CREATE INDEX IF NOT EXISTS idx_thoughts_bot_reply_ts
  ON thoughts(bot_reply_ts);

CREATE TABLE IF NOT EXISTS user_prefs (
  slack_user_id TEXT PRIMARY KEY,
  digest_day INTEGER NOT NULL DEFAULT 1,
  digest_hour INTEGER NOT NULL DEFAULT 9,
  digest_minute INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  welcomed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_prefs_digest_schedule
  ON user_prefs(digest_day, digest_hour, digest_minute);

CREATE TABLE IF NOT EXISTS digest_deliveries (
  id TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  snoozed_item_count INTEGER NOT NULL DEFAULT 0,
  slack_message_ts TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_deliveries_user_period
  ON digest_deliveries(slack_user_id, period_start);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
  ON analytics_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_created
  ON analytics_events(slack_user_id, created_at);
