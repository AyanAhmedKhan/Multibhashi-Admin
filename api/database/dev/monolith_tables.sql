-- LOCAL DEVELOPMENT ONLY: minimal copies of the monolith tables the console reads or
-- writes, so it can run against the Docker MySQL. Production already has the real ones
-- (owned by the AdonisJS v4 monolith); `node ace console:dev-schema` refuses to run
-- against anything but a local database.
-- Columns follow the monolith's code (user-activity-claude.md, GrantAiTutorMinutes,
-- PaymentController, CourseController); only what the console uses is declared.

CREATE TABLE IF NOT EXISTS student_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NOT NULL UNIQUE,
  user_id INT UNSIGNED NOT NULL,
  device VARCHAR(16) NULL,
  app_version VARCHAR(32) NULL,
  started_at BIGINT NOT NULL,
  last_heartbeat BIGINT NOT NULL,
  ended_at BIGINT NULL,
  active_seconds INT NOT NULL DEFAULT 0,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_ss_user (user_id, started_at),
  KEY idx_ss_started (started_at),
  KEY idx_ss_heartbeat (last_heartbeat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_learning_segments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NOT NULL UNIQUE,
  user_id INT UNSIGNED NOT NULL,
  student_session_id INT UNSIGNED NULL,
  screen_type VARCHAR(32) NOT NULL,
  resource_type VARCHAR(24) NULL,
  resource_id VARCHAR(64) NULL,
  context_type VARCHAR(24) NULL,
  course_lesson_id INT UNSIGNED NULL,
  started_at BIGINT NOT NULL,
  last_heartbeat BIGINT NOT NULL,
  ended_at BIGINT NULL,
  active_seconds INT NOT NULL DEFAULT 0,
  idle_seconds INT NOT NULL DEFAULT 0,
  status VARCHAR(12) NOT NULL DEFAULT 'active',
  inactivity_prompts INT NOT NULL DEFAULT 0,
  inactivity_timeouts INT NOT NULL DEFAULT 0,
  end_reason VARCHAR(24) NULL,
  metadata JSON NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_sls_user (user_id, started_at),
  KEY idx_sls_screen (screen_type, started_at),
  KEY idx_sls_status (status, last_heartbeat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_activity_events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  student_session_id INT UNSIGNED NULL,
  student_learning_segment_id INT UNSIGNED NULL,
  event_type VARCHAR(48) NOT NULL,
  resource_type VARCHAR(24) NULL,
  resource_id VARCHAR(64) NULL,
  duration_sec INT NULL,
  context_type VARCHAR(24) NULL,
  -- Attribution the backend writes (ActivityController.recordEvents); older local copies get
  -- them from `console:dev-schema` (ALTER).
  webinar_class_id INT UNSIGNED NULL,
  session_call_id INT UNSIGNED NULL,
  course_booking_id INT UNSIGNED NULL,
  course_lesson_id INT UNSIGNED NULL,
  user_quiz_log_id INT UNSIGNED NULL,
  metadata JSON NULL,
  created_at_ms BIGINT NOT NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_sae_type (event_type, created_at_ms),
  KEY idx_sae_user (user_id, created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_daily_activity (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  activity_date DATE NOT NULL,
  active_minutes INT NOT NULL DEFAULT 0,
  app_minutes INT NOT NULL DEFAULT 0,
  idle_minutes INT NOT NULL DEFAULT 0,
  sessions_count INT NOT NULL DEFAULT 0,
  learning_segments_count INT NOT NULL DEFAULT 0,
  ai_tutor_minutes INT NOT NULL DEFAULT 0,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  UNIQUE KEY uq_sda (user_id, activity_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The monolith names a course in `title` (there is no `name` column).
CREATE TABLE IF NOT EXISTS courses (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NULL,
  slug VARCHAR(255) NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS course_lessons (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  quiz_id INT UNSIGNED NULL,
  category VARCHAR(64) NULL,
  course_level VARCHAR(64) NULL,
  lesson_number INT NULL,
  lesson_order INT NULL,
  is_deleted TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_cl_course (course_id, course_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  quiz_id INT UNSIGNED NOT NULL,
  type_code VARCHAR(32) NULL,
  sub_type_code VARCHAR(32) NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_qq_quiz (quiz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS course_lesson_packages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  mrp DECIMAL(10,2) NULL,
  selling_price DECIMAL(10,2) NULL,
  duration_days INT NULL,
  total_quizzes INT NULL,
  has_ai_tutor TINYINT NOT NULL DEFAULT 0,
  ai_chat_type VARCHAR(32) NULL,
  ai_chat_duration INT NULL,
  features JSON NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS course_lesson_package_bookings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_booking_id INT UNSIGNED NULL,
  course_lesson_package_id INT UNSIGNED NULL,
  course_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  level_name VARCHAR(64) NULL,
  expire_on BIGINT NULL,
  package_name VARCHAR(64) NULL,
  mrp DECIMAL(10,2) NULL,
  selling_price DECIMAL(10,2) NULL,
  duration_days INT NULL,
  total_lessons INT NULL,
  total_quizzes INT NULL,
  has_ai_tutor TINYINT NOT NULL DEFAULT 0,
  ai_chat_type VARCHAR(32) NULL,
  ai_chat_duration INT NULL,
  features JSON NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_clpb_user (user_id, course_id, level_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS course_lesson_subscriptions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_booking_id INT UNSIGNED NULL,
  course_lesson_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  subscribed_on BIGINT NULL,
  plan_type VARCHAR(32) NULL,
  expired_on BIGINT NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_cls_user (user_id, course_lesson_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CRM enquiries (the monolith's DirectLead model); the console reads a name from here
-- when the account still has the app's placeholder name.
CREATE TABLE IF NOT EXISTS direct_leads (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  name VARCHAR(255) NULL,
  phone VARCHAR(32) NULL,
  email VARCHAR(255) NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_dl_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quizzes (QuizController / SessionController.saveQuizLog). Speaking (SQ) and Writing (WQ)
-- answers live in three detail tables, one per delivery, each under its parent log. Only the
-- user_ details carry the LSRW marking columns here (the backend writes them only there), so
-- the console's "degrade without LSRW columns" path runs locally too.
CREATE TABLE IF NOT EXISTS quizzes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_quiz_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NULL,
  user_id INT UNSIGNED NOT NULL,
  quiz_id INT UNSIGNED NOT NULL,
  assignment_id INT UNSIGNED NULL,
  course_booking_id INT UNSIGNED NULL,
  type VARCHAR(32) NULL,
  assessment_type VARCHAR(20) NULL,
  quiz_start_timestamp BIGINT NULL,
  quiz_end_timestamp BIGINT NULL,
  total_questions INT NULL,
  total_correct_answer INT NULL,
  total_incorrect_answer INT NULL,
  total_question_attempt INT NULL,
  total_timeout INT NULL,
  is_quiz_finised TINYINT NOT NULL DEFAULT 0,
  attempt INT NOT NULL DEFAULT 1,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_uql_user (user_id, quiz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_quiz_log_details (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NULL,
  user_quiz_log_id INT UNSIGNED NOT NULL,
  quiz_question_id INT UNSIGNED NOT NULL,
  question_start_timestamp BIGINT NOT NULL DEFAULT 0,
  question_end_timestamp BIGINT NOT NULL DEFAULT 0,
  is_correct TINYINT NULL,
  relevance_score DOUBLE NULL,
  grammar_score DOUBLE NULL,
  answer TEXT NULL,
  finished_on_time TINYINT NULL,
  time_taken DOUBLE NULL,
  pronunciation_score DOUBLE NULL,
  audio_quality_score DOUBLE NULL,
  scoring_version INT NULL,
  prompt_version VARCHAR(32) NULL,
  model_name VARCHAR(64) NULL,
  final_percentage DECIMAL(5,2) NULL,
  evaluation_json JSON NULL,
  evaluation_status VARCHAR(16) NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_uqld_log (user_quiz_log_id, quiz_question_id),
  KEY idx_uqld_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webinar_class_quiz_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NULL,
  user_id INT UNSIGNED NOT NULL,
  quiz_id INT UNSIGNED NOT NULL,
  webinar_class_id INT UNSIGNED NULL,
  quiz_start_timestamp BIGINT NULL,
  quiz_end_timestamp BIGINT NULL,
  total_questions INT NULL,
  total_timeout INT NULL,
  is_quiz_finised TINYINT NOT NULL DEFAULT 0,
  attempt INT NOT NULL DEFAULT 1,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_wcql_user (user_id, quiz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webinar_class_quiz_log_details (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NULL,
  webinar_class_quiz_log_id INT UNSIGNED NOT NULL,
  quiz_question_id INT UNSIGNED NOT NULL,
  question_start_timestamp BIGINT NOT NULL DEFAULT 0,
  question_end_timestamp BIGINT NOT NULL DEFAULT 0,
  is_correct TINYINT NULL,
  relevance_score DOUBLE NULL,
  grammar_score DOUBLE NULL,
  answer TEXT NULL,
  finished_on_time TINYINT NULL,
  time_taken DOUBLE NULL,
  pronunciation_score DOUBLE NULL,
  audio_quality_score DOUBLE NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_wcqld_log (webinar_class_quiz_log_id, quiz_question_id),
  KEY idx_wcqld_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_call_quiz_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NULL,
  user_id INT UNSIGNED NOT NULL,
  quiz_id INT UNSIGNED NOT NULL,
  session_call_id INT UNSIGNED NULL,
  quiz_start_timestamp BIGINT NULL,
  quiz_end_timestamp BIGINT NULL,
  total_questions INT NULL,
  total_timeout INT NULL,
  is_quiz_finised TINYINT NOT NULL DEFAULT 0,
  attempt INT NOT NULL DEFAULT 1,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_scql_user (user_id, quiz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_call_quiz_log_details (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NULL,
  session_call_quiz_log_id INT UNSIGNED NOT NULL,
  quiz_question_id INT UNSIGNED NOT NULL,
  question_start_timestamp BIGINT NOT NULL DEFAULT 0,
  question_end_timestamp BIGINT NOT NULL DEFAULT 0,
  is_correct TINYINT NULL,
  relevance_score DOUBLE NULL,
  grammar_score DOUBLE NULL,
  answer TEXT NULL,
  finished_on_time TINYINT NULL,
  time_taken DOUBLE NULL,
  pronunciation_score DOUBLE NULL,
  audio_quality_score DOUBLE NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  KEY idx_scqld_log (session_call_quiz_log_id, quiz_question_id),
  KEY idx_scqld_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Evidence marking's accepted assessments (LsrwEvaluationStore; migration
-- 1791504000000_quiz_ai_evaluation_cache_schema in the migrations repo).
CREATE TABLE IF NOT EXISTS quiz_ai_evaluation_cache (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  context_hash CHAR(64) NOT NULL,
  quiz_question_id INT UNSIGNED NULL,
  evaluation_json JSON NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  UNIQUE KEY uq_qaec_hash (context_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
