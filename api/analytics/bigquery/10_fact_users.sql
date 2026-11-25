-- fact_users: every teachers-dashboard learner account (users), keyed by td_user_id. Loaded
-- nightly by analytics:export-facts from the MySQL read replica (MUL-149). No phone, e-mail or
-- name ever leaves MySQL.
-- verified: the learner has an app session (student_sessions), i.e. actually signed in. The
-- monolith creates a users row when an OTP is requested, so unverified rows are OTP requests.
-- verified_at: the first app session. utm_* and lead_source: the learner's first CRM lead
-- (direct_leads). created_date: the IST date of created_at.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.fact_users` (
  td_user_id INT64 NOT NULL,
  created_at TIMESTAMP,
  created_date DATE,
  verified BOOL,
  verified_at TIMESTAMP,
  country_code STRING,
  utm_source STRING,
  utm_medium STRING,
  utm_campaign STRING,
  lead_source STRING,
  exported_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(created_date, MONTH)
CLUSTER BY td_user_id
OPTIONS (description = 'Learner accounts (teachers-dashboard users), verified = signed in at least once. Nightly from MySQL.');
