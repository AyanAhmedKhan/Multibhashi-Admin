-- fact_tutor_sessions: AI tutor classes from ai_tutor_chats, one row per chat row. The tutor
-- keeps one row per learner and lesson question and reuses it across classes, so minutes
-- (time_spent, whole minutes) and the turn counts are totals for that row, and started_at is
-- its latest class start. language: from ai_tutor_session_summaries when present. Turns:
-- learner and tutor messages in ai_tutor_chat_details (counts only, never the text).
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.fact_tutor_sessions` (
  chat_id INT64 NOT NULL,
  td_user_id INT64,
  quiz_id INT64,
  quiz_question_id INT64,
  status STRING,
  created_at TIMESTAMP,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  updated_at TIMESTAMP,
  activity_date DATE,
  minutes INT64,
  language STRING,
  learner_turns INT64,
  tutor_turns INT64,
  exported_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(activity_date, MONTH)
CLUSTER BY td_user_id
OPTIONS (description = 'AI tutor classes (ai_tutor_chats and their turn counts). Nightly from MySQL.');
