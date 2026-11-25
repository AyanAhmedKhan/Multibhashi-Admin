-- m_health_daily: app health per IST day (MUL-154 events): kind 'error' (app_error by type),
-- 'api_slow' (calls over 3 s by endpoint group, ms) and 'web_vital' (LCP/INP in ms, CLS), per
-- screen, app version and platform, with p50/p75/p95 and the count rated poor. Essential
-- events, so opted-out learners are included (aggregate counts only).
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_health_daily` (
  event_date DATE,
  kind STRING,
  name STRING,
  screen STRING,
  app_version STRING,
  platform STRING,
  events INT64,
  users INT64,
  p50 FLOAT64,
  p75 FLOAT64,
  p95 FLOAT64,
  poor INT64,
  modelled_at TIMESTAMP
)
PARTITION BY event_date
CLUSTER BY kind, name
OPTIONS (description = 'Errors, slow API calls and web vitals per IST day (model).');
