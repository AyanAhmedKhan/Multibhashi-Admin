# Consolidating the activity pipeline into product analytics (MUL-155)

**Status:** plan. Nothing is retired yet, and retiring anything needs the user's go-ahead and a
change in the monolith (teachers-dashboard), which belongs to another developer.

**Goal:** time-in-app and the learning events come from the product events in BigQuery, so
the monolith stops writing the activity tables on the production Cloud SQL primary.

See `docs/PRODUCT_ANALYTICS.md` for the new pipeline and `design/product-analytics/DESIGN.md`
§10 for the phases.

## 1. Two pipelines today

| | Old: activity pipeline | New: product events |
|---|---|---|
| App side | `src/services/activity.js`, `learningSession.js`: app open/close, 30 s heartbeats, engaged time on 6 learning screens, `quiz_*` events | `src/lib/analytics`: typed events from the tracking plan, screen views on every route, sessions |
| Transport | monolith `/activity/*`, **unauthenticated**, keyed by phone (XS-02) | the collector `/e` on the app's own domain (Vercel Function), validated against the plan |
| Storage | 4 MySQL tables on the **production primary**: `student_sessions`, `student_learning_segments`, `student_activity_events`, `student_daily_activity` (02:00 IST rollup), with no retention | BigQuery `events_raw` (asia-south1, 395-day partition expiry) and the nightly models |
| Read by | Insights → Users & growth, Screens & content, AI tutor usage, Quizzes (app events), the quiz before/after metrics | Insights → Product analytics tabs, the weekly digest |

## 2. What maps to what

| Concept | Old | New | Checked by `analytics:parity` |
|---|---|---|---|
| Active learners per day | `student_sessions` distinct `user_id` | `m_sessions` distinct `user_id` | yes, gates retirement (±10 %) |
| Time in app | `student_sessions.active_seconds` (heartbeats) | `m_sessions.duration_s` (first to last event) | yes, gates (±25 %: engaged vs wall time) |
| Sessions | app open to close | a new session after 30 min idle, split at midnight | yes, informative only (different definitions) |
| Engaged time per learning screen | `student_learning_segments` | `m_screen_daily` dwell (median, histogram) | no: different measure (idle-aware vs time to next screen); compared by eye on the Screens tabs |
| Quiz opened | `quiz_start` | `quiz_opened` (the SDK bridge) | yes, gates (±10 %) |
| Quiz completed | `quiz_completed` | `quiz_completed` | yes, gates (±10 %) |
| Recording played | `video_play` | `recording_played` | yes, gates (±10 %) |
| Quiz telemetry (`quiz_question_shown`, `quiz_answer_submitted`, …) | sent to both pipelines under the same names | the same | yes, informative (±10 %) |
| Daily rollup | `student_daily_activity` | the models (no rollup table needed) | n/a |
| AI tutor messages | `ai_tutor_message` (never sent: always 0) | `tutor_first_turn`, `tutor_session_ended` | n/a: the old one never worked |

## 3. Steps

**A. Run both, measure (now).**
- Both pipelines run. Nothing changes in the app or the monolith.
- Run `analytics:parity` each week (or nightly after the models). It prints each concept's daily
  figures on both sides, the difference, and how many days in a row the gating concepts have
  matched.
- `--json` makes it easy to keep a record.

**B. Move time-in-app readers.** When parity holds (gate 1 below), Insights → Users & growth
and Screens & content can take their time-in-app figures from BigQuery. Two ways:
- point those queries at the models;
- or retire the MySQL tabs in favour of the product tabs, which already show the same things.

The quiz before/after metrics (`quiz:daily-metrics`) read `quiz_*` events from
`student_activity_events`. They move last, because a before/after comparison must not change
source in the middle of a measurement (the quiz measurement runs until about 7 Dec 2026).

**C. Retire the old writes (monolith).** Only after every gate below. The monolith's
`/activity/*` endpoints keep **accepting** requests and return `200` without writing, so old app
builds never error. A flag in the monolith makes this reversible.

Before switching off:
- archive the four tables' history to BigQuery (`archive_student_sessions`, …), keyed by
  `td_user_id`, through a one-off `analytics:export-facts`-style job;
- include the archive tables in `analytics:forget-user`.

**D. Remove the endpoints.** Once no supported app build calls them, enforce the force-update
gate (MUL-139). Until then, sign-in v2 (MUL-134 `enforce`) closes the unauthenticated hole:
either the endpoints require the learner JWT, or they are removed.

**Alongside:**
- **Read replica.** Add a Cloud SQL read replica and set `DB_ANALYTICS_HOST`/`_USER`/`_PASSWORD`.
  Both the Insights MySQL tabs and `analytics:export-facts` already read through the `analytics`
  connection, so nothing else changes. Today that connection falls back to the primary.
- **Retention on the old tables** (MUL-153). They keep everything forever. Until step C, a
  monthly job could delete rows older than 13 months in small batches. This is a monolith-owned
  table, so it is a proposal for its owner.

## 4. Gates for step C

All of these, at the same time:

1. **Parity.** `analytics:parity --days 14` reports every gating concept within tolerance for
   14 days in a row: active learners, time in app, quiz opened, quiz completed, recording played.
2. **Collector and models healthy for 14 days.** The Health tab shows no stale source, and
   `analytics:models` exits 0 every night.
3. **Old builds below 5 %.** Builds that don't send the new events must make up under 5 % of
   app sessions for 7 days. Measure this with `student_sessions.app_version` against the first
   release with the SDK.
4. **Readers moved** (step B), and the quiz before/after measurement finished or re-based.
5. **Sign-in v2 identity link live** (`identities` populated). Learner-level joins (funnels to
   payments, retention by sign-up week) don't depend on phone numbers.

If parity fails, find out why before going further:
- an ad blocker or a network rule dropping `/e`;
- opted-out learners: their analytics events never arrive, while the old pipeline has no
  opt-out, so a small, steady gap is expected and should be read against the opt-out rate;
- a bridge mapping bug in the SDK;
- a session-definition difference.

Fix the cause, then restart the 14-day count.

## 5. Not retired by this work

Nothing. This branch adds the parity check and this plan only. It doesn't change:
- the app's activity calls;
- the monolith's endpoints or tables;
- the existing Insights tabs.
