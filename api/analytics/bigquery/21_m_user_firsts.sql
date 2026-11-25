-- m_user_firsts (model helper): per signed-in learner, when they were first and last seen in
-- the events, on which platform and channel, the first feature they used and their first value
-- (tutor class started, class joined or quiz started). Feeds retention cohorts (first-seen
-- week, first feature) and activation. Merged per day with min/max, so re-running is idempotent.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_user_firsts` (
  user_id STRING NOT NULL,
  first_seen_date DATE,
  last_seen_date DATE,
  first_platform STRING,
  first_utm_source STRING,
  first_feature STRING,
  first_feature_at TIMESTAMP,
  first_value_at TIMESTAMP,
  modelled_at TIMESTAMP
)
CLUSTER BY user_id
OPTIONS (description = 'Per learner: first/last seen, first feature, first value. Merged nightly.');
