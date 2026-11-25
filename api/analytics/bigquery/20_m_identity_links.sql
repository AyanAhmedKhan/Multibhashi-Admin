-- m_identity_links (model helper): which signed-in user an anonymous_id belongs to, from the
-- events that carry both (identify sends user_identified once per sign-in). It joins the
-- pre-login journey (landing, sign-in steps) to the learner. One row per anonymous_id: when a
-- device was shared, the user seen last with it wins. Merged per day by analytics:models.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_identity_links` (
  anonymous_id STRING NOT NULL,
  user_id STRING,
  first_seen_at TIMESTAMP,
  last_seen_at TIMESTAMP,
  modelled_at TIMESTAMP
)
CLUSTER BY anonymous_id
OPTIONS (description = 'anonymous_id -> user_id (latest), from events with both. Merged nightly.');
