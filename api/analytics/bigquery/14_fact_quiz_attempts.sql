-- fact_quiz_attempts: one row per quiz attempt, from the three quiz log tables the console's
-- quiz pages already read (user_quiz_logs, webinar_class_quiz_logs, session_call_quiz_logs).
-- context: course | webinar | session. attempt_key: '<context>:<log id>'. started_at: the
-- app's quiz_start_timestamp when valid, else the row's created_at. score_pct: correct over
-- total questions, where the log has those counts. No answer text is read.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.fact_quiz_attempts` (
  attempt_key STRING NOT NULL,
  context STRING,
  log_id INT64,
  td_user_id INT64,
  quiz_id INT64,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  activity_date DATE,
  finished BOOL,
  attempt_number INT64,
  total_questions INT64,
  answered INT64,
  correct INT64,
  incorrect INT64,
  timeouts INT64,
  score_pct FLOAT64,
  exported_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(activity_date, MONTH)
CLUSTER BY td_user_id
OPTIONS (description = 'Quiz attempts (the quiz log tables). Nightly from MySQL.');
