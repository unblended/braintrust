CREATE INDEX IF NOT EXISTS idx_analytics_events_type_user_created
  ON analytics_events(event_type, slack_user_id, created_at);
