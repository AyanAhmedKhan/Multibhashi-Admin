-- identities: the link between the app's user_id (the appspot _id), the teachers-dashboard
-- users.id the facts are keyed by, and the sign-in v2 account. Rebuilt in full nightly from
-- learner_accounts (the identity service's table, MUL-127); empty until that table exists.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.identities` (
  learner_account_id INT64 NOT NULL,
  appspot_id STRING,
  td_user_id INT64,
  status STRING,
  created_at TIMESTAMP,
  exported_at TIMESTAMP
)
CLUSTER BY appspot_id, td_user_id
OPTIONS (description = 'appspot _id <-> teachers-dashboard users.id <-> learner_accounts.id. Nightly from MySQL.');
