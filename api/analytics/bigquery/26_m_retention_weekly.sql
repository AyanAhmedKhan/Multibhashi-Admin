-- m_retention_weekly: weekly cohorts (Monday-start IST weeks). basis 'signup': the verified
-- sign-up week from fact_users, when identities links the learner; else 'first_seen': the
-- week the learner first appeared in the events. channel: the sign-up utm_source, else the
-- first session's. first_feature: the first feature used (m_user_firsts). active_users: cohort
-- members with a session week_offset weeks later (week 0 = the cohort week). Additive across
-- channel and first_feature, so filters just sum. Rebuilt for the last 26 cohort weeks.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_retention_weekly` (
  cohort_week DATE,
  basis STRING,
  channel STRING,
  first_feature STRING,
  week_offset INT64,
  cohort_users INT64,
  active_users INT64,
  modelled_at TIMESTAMP
)
CLUSTER BY cohort_week, basis
OPTIONS (description = 'Weekly retention cohorts by channel and first feature (model).');
