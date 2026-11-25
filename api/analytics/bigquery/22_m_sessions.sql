-- m_sessions: one row per app session (the SDK's session_id: a new one after 30 minutes
-- without activity) per IST day: start, end, duration, events, screens, entry and exit
-- screen, platform, app version. A session that crosses midnight is split at the day boundary.
-- person: the signed-in user_id, else 'anon:<anonymous_id>'. Opted-out rows are left out.
-- Person-level, so partitions expire with the raw events (395 days).
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_sessions` (
  session_date DATE,
  session_id STRING,
  person STRING,
  user_id STRING,
  anonymous_id STRING,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  duration_s INT64,
  events INT64,
  screen_views INT64,
  entry_screen STRING,
  exit_screen STRING,
  platform STRING,
  app_version STRING,
  os STRING,
  browser STRING,
  country STRING,
  utm_source STRING,
  modelled_at TIMESTAMP
)
PARTITION BY session_date
CLUSTER BY user_id
OPTIONS (
  partition_expiration_days = 395,
  description = 'App sessions per IST day (model, rebuilt per partition by analytics:models).'
);
