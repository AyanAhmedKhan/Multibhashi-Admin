-- events_dev: the same schema as events_raw, for debug streams (context.debug, the app's
-- ?analytics_debug=1) and staging. The models never read it. Partitions expire after 30 days
-- (MUL-148): test traffic has no reason to stay longer.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.events_dev` (
  event_id STRING,
  event_name STRING,
  event_version INT64,
  event_ts TIMESTAMP,
  received_at TIMESTAMP,
  event_date DATE,
  anonymous_id STRING,
  user_id STRING,
  session_id STRING,
  platform STRING,
  app_version STRING,
  build STRING,
  os STRING,
  browser STRING,
  viewport_w INT64,
  screen STRING,
  previous_screen STRING,
  utm_source STRING,
  utm_medium STRING,
  utm_campaign STRING,
  referrer_domain STRING,
  network STRING,
  country STRING,
  region STRING,
  opted_out BOOL,
  props JSON
)
PARTITION BY event_date
CLUSTER BY event_name, user_id
OPTIONS (
  partition_expiration_days = 30,
  description = 'Debug and staging events (same schema as events_raw). Partitions expire after 30 days.'
);

ALTER TABLE `{{project}}.{{dataset}}.events_dev` SET OPTIONS (partition_expiration_days = 30);
