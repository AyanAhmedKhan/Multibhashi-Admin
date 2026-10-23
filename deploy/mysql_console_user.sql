-- Least-privilege MySQL user for the admin console's RUNTIME (docs/PLAN.md §2).
-- Run once as an administrator on the production database, then put these credentials in
-- deploy/.env.production (DB_USER / DB_PASSWORD) instead of root.
-- Migrations (`node ace migration:run --force`) keep using an admin login: the runtime user
-- can't create or alter tables, which is the point.
--
-- Replace the password and, if possible, '%' with the VPS address ('93.127.172.184').

CREATE USER IF NOT EXISTS 'mb_console'@'%' IDENTIFIED BY 'CHANGE-ME-long-random-password';

-- Read the platform (learners, classes, activity, courses, bookings) for lists and Insights.
GRANT SELECT ON multibhashi.* TO 'mb_console'@'%';
-- Row locks (SELECT … FOR UPDATE on `users`, as the tutor API takes) need LOCK TABLES or
-- UPDATE; LOCK TABLES lets the console lock a learner's row without being able to edit it.
GRANT LOCK TABLES ON multibhashi.* TO 'mb_console'@'%';

-- AI tutor writes the console makes (minutes ±, AI Pro, memory erase).
GRANT INSERT, UPDATE ON multibhashi.ai_tutor_chats TO 'mb_console'@'%';
GRANT INSERT ON multibhashi.ai_tutor_time_logs TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.ai_tutor_learner_memories TO 'mb_console'@'%';
GRANT DELETE ON multibhashi.ai_tutor_session_summaries TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.course_lesson_package_bookings TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.course_lesson_subscriptions TO 'mb_console'@'%';
-- Learner name fix (the app's own profile screen writes the same column). Nothing else on users.
GRANT UPDATE (name, updated_at) ON multibhashi.users TO 'mb_console'@'%';

-- The console's own tables.
GRANT INSERT, UPDATE, DELETE ON multibhashi.console_users TO 'mb_console'@'%';
GRANT INSERT, UPDATE, DELETE ON multibhashi.console_roles TO 'mb_console'@'%';
GRANT INSERT, UPDATE, DELETE ON multibhashi.console_role_permissions TO 'mb_console'@'%';
GRANT INSERT, UPDATE, DELETE ON multibhashi.console_user_roles TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.console_sessions TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.console_approval_requests TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.console_settings TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.console_ai_pro_grants TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.console_cost_invoices TO 'mb_console'@'%';
GRANT INSERT, UPDATE ON multibhashi.console_email_codes TO 'mb_console'@'%';

-- The audit trail: append and read only, so not even the console can rewrite history.
GRANT INSERT ON multibhashi.console_audit_logs TO 'mb_console'@'%';
GRANT UPDATE ON multibhashi.console_audit_head TO 'mb_console'@'%';

-- Optional read-only user for an Insights read replica (DB_ANALYTICS_*):
-- CREATE USER IF NOT EXISTS 'mb_console_ro'@'%' IDENTIFIED BY 'CHANGE-ME-too';
-- GRANT SELECT ON multibhashi.* TO 'mb_console_ro'@'%';
