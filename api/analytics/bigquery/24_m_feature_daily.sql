-- m_feature_daily: per IST day and feature (AI tutor, live class, quiz, notes, recordings,
-- study material, chat, plans; the events behind each are in the console's features.ts):
-- people (count and HLL sketch), uses (events) and sessions. The feature '_active' counts
-- everyone with any behavioural event that day: the denominator for adoption.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_feature_daily` (
  event_date DATE,
  feature STRING,
  users INT64,
  users_hll BYTES,
  uses INT64,
  sessions INT64,
  modelled_at TIMESTAMP
)
PARTITION BY event_date
CLUSTER BY feature
OPTIONS (description = 'Feature use per IST day (model, rebuilt per partition by analytics:models).');
