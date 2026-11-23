-- m_screen_daily: per IST day and screen: views (screen_viewed), unique people (count and an
-- HLL sketch, so a date range can be merged without double counting), dwell time (median, and
-- a histogram over fixed second buckets so a range median can be computed), exits (the last
-- screen of a session) and the top 5 previous and next screens.
-- Dwell: until the next screen in the same session, else until the session's last event,
-- capped at 30 minutes. Opted-out rows are left out.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_screen_daily` (
  event_date DATE,
  screen STRING,
  views INT64,
  users INT64,
  users_hll BYTES,
  median_dwell_s FLOAT64,
  dwell_hist ARRAY<INT64>,
  exits INT64,
  prev_top ARRAY<STRUCT<screen STRING, views INT64>>,
  next_top ARRAY<STRUCT<screen STRING, views INT64>>,
  modelled_at TIMESTAMP
)
PARTITION BY event_date
CLUSTER BY screen
OPTIONS (description = 'Screens per IST day (model, rebuilt per partition by analytics:models).');
