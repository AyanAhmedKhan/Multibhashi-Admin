-- events_raw: one row per product event the collector (/e, a Vercel Function) accepted.
-- Schema exactly as design/IMPLEMENTATION-CONTRACTS.md section 5.4. Written only by the
-- collector (insertAll); read only by the nightly models and analytics:parity. Dashboards
-- never read it. event_date is the IST date of received_at.
-- Retention: partitions expire after 395 days (13 months), so raw events delete themselves.
-- No personal data: user_id is the appspot _id, never a phone, e-mail or name.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.events_raw` (
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
  partition_expiration_days = 395,
  description = 'Product events from the collector (contract section 5.4). Partitions expire after 395 days.'
);

-- The collector stream may create the table first: enforce the retention either way.
ALTER TABLE `{{project}}.{{dataset}}.events_raw` SET OPTIONS (partition_expiration_days = 395);
