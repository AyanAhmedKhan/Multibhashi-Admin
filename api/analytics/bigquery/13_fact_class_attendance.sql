-- fact_class_attendance: live-class attendance, one row per source row:
--   source 'attendance': webinar_class_attendances, the trainer or admin marking a learner
--                        present when completing a group class;
--   source 'join_log':   webinar_class_user_logs and session_call_user_logs, the app's Join tap.
-- class_type 'webinar' (group class) or 'session' (1:1). class_slot_at: the class's scheduled
-- start. activity_date: the IST date of occurred_at.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.fact_class_attendance` (
  attendance_key STRING NOT NULL,
  td_user_id INT64,
  class_type STRING,
  class_id INT64,
  source STRING,
  occurred_at TIMESTAMP,
  activity_date DATE,
  class_slot_at TIMESTAMP,
  exported_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(activity_date, MONTH)
CLUSTER BY td_user_id
OPTIONS (description = 'Class attendance and join taps (webinars and 1:1 sessions). Nightly from MySQL.');
