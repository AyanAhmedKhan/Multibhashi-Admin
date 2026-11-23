# Product analytics in the console (MUL-125)

The console side of product analytics: the BigQuery warehouse, the nightly business facts and
SQL models, the Insights pages that read them, the weekly digest, deletion and the
consolidation with the older activity pipeline.

The design is `design/product-analytics/DESIGN.md`, and the binding contracts are in
`design/IMPLEMENTATION-CONTRACTS.md` §0 and §5. The app SDK and the collector (`/e`, a Vercel
Function that writes `events_raw`) are built in the learner app repo.

```
app (web, Android, iOS) ── POST /e ──► collector ── insertAll ──► events_raw / events_dev
                                                                         │
MySQL read replica ── analytics:export-facts ──► fact_* , identities     │
                                                         │               │
                              analytics:models ◄─────────┴───────────────┘
                                     │
                                     ▼
                          m_* model tables ──► Insights (product tabs), weekly digest
```

## 1. Warehouse (MUL-148)

**Dataset.** `product_analytics` in **asia-south1**, in the GCP project named by
`GCP_ANALYTICS_PROJECT`. The DDL is plain SQL in `api/analytics/bigquery/`, applied in file
order. Every statement is idempotent.

| Table | What | Partition / cluster | Retention |
|---|---|---|---|
| `events_raw` | every accepted event (contract §5.4), written by the collector | `event_date` / `event_name, user_id` | 395 days |
| `events_dev` | the same schema, for debug and staging streams | `event_date` / `event_name, user_id` | 30 days |
| `fact_*`, `identities` | business facts from MySQL (§2) | month of the fact date / `td_user_id` | kept |
| `m_sessions`, `m_funnel_steps` | person-level models (§3) | day | 395 days |
| other `m_*` | aggregates (§3) | day or none | kept |

`analytics:bq-setup` also runs `ALTER TABLE … SET OPTIONS (partition_expiration_days = …)` on
both event tables. The retention then holds even if the collector created a table first.

```bash
node ace analytics:bq-setup              # prints the plan and the SQL; changes nothing
node ace analytics:bq-setup --plan-only  # the plan only
node ace analytics:bq-setup --apply      # creates or updates the objects
```

**Settings.** These are in `.env.example` and `deploy/.env.production.example`. All are
optional; without them the product tabs say "Product analytics isn't connected yet".

| Variable | Meaning |
|---|---|
| `GCP_ANALYTICS_PROJECT` | the GCP project that holds the dataset and runs the console's jobs |
| `GCP_ANALYTICS_DATASET` | default `product_analytics` |
| `GCP_ANALYTICS_CREDENTIALS_JSON` or `GCP_ANALYTICS_CREDENTIALS_FILE` | the console's service-account key: the JSON (raw or base64), or a path to the key file |

**One-time steps outside the repo.**
1. Pick the project: the one with the billing export, or a new one (decision MUL-142).
2. Create two service accounts:
   - **collector writer**, used by the Vercel Function (`GCP_ANALYTICS_SA_KEY` there): *BigQuery Data Editor* on the dataset only. It needs `insertAll` and no jobs.
   - **console**, used by this API: *BigQuery Data Editor* on the dataset and *BigQuery Job User* on the project. It loads the facts, runs the models and deletes on request.

   *BigQuery Data Editor* is granted on the dataset, which exists only after the first `--apply`. For that first run, grant the console account *BigQuery Data Editor* on the project temporarily (it needs `bigquery.datasets.create`), or have an owner create the dataset first.
3. Run `analytics:bq-setup --apply` once, then after any deploy that changes `api/analytics/bigquery/`.
4. Add a budget alert on the project, scoped to BigQuery (MUL-148).

## 2. Business facts (MUL-149)

`analytics:export-facts` reads the MySQL `analytics` connection (the read replica when
`DB_ANALYTICS_HOST` is set) and loads BigQuery. It is keyed by the teachers-dashboard
`users.id` (`td_user_id`). The queries select ids, dates, statuses, counts and amounts only:
never a phone, e-mail, name, quiz answer or tutor message.

| Table | Source | Notes |
|---|---|---|
| `fact_users` | `users`, `student_sessions`, `direct_leads` | `verified` = an app session exists (an OTP request alone creates a `users` row); `verified_at` = the first session; UTM and lead source from the first CRM lead |
| `fact_bookings` | `course_bookings` | `paid` = `booking_type` `paid_new`/`paid_renewal` (untyped old rows: a positive rate); `amount` = `rate` (rupees) |
| `fact_payments` | `transactions` (+ its booking) | written only after a Razorpay capture (`payment_status = 'success'`); `captured_at` = the earlier of the booking and the transaction, which the monolith inserts in that order; `gateway_verified` and a hash, never the payment id |
| `fact_class_attendance` | `webinar_class_attendances` (marked present), `webinar_class_user_logs` and `session_call_user_logs` (Join taps) | `class_slot_at` from `webinar_classes` / `session_calls` |
| `fact_quiz_attempts` | `user_quiz_logs`, `webinar_class_quiz_logs`, `session_call_quiz_logs` | the logs the quiz pages read; no answer text |
| `fact_tutor_sessions` | `ai_tutor_chats` (+ turn counts, language) | a chat row is reused across classes, so it is re-exported whenever it changes |
| `identities` | `learner_accounts` (sign-in v2) | skipped until that table exists |

**Idempotent per date range.** Each table's rows go to a staging copy (one load job) and are
swapped in by one transaction. The transaction deletes the target's rows whose date is in the
range, plus any row whose key is in the batch, then inserts the batch. Re-running a range gives
the same table, and a row deleted in MySQL disappears. `--full` replaces whole tables, and
`identities` is always replaced whole.

```bash
node ace analytics:export-facts                    # the last 7 IST days (nightly)
node ace analytics:export-facts --from 2026-11-01 --to 2026-11-07
node ace analytics:export-facts --full             # once, to fill the history in (off-peak)
node ace analytics:export-facts --only fact_users,identities
node ace analytics:export-facts --dry-run          # read and count only: no BigQuery needed
```

**Until sign-in v2 lands, `identities` is empty**, so nothing links the app's `user_id` (the
appspot `_id`) to `td_user_id`. Today `users` holds no appspot id, so the only possible link
would be the phone number, and appspot data isn't readable from here. The models fall back
where they can (§3); the purchase funnel's server steps and sign-up-week cohorts fill in once
`learner_accounts` exists.

## 3. Models (MUL-151)

`analytics:models [--date D | --from A --to B] [--only …] [--print]` builds the model tables for
an IST day; the default is yesterday. The SQL is generated in
`api/app/services/product_analytics/models.ts`, and the definitions (features, funnels) are in
`catalog.ts`. `--print` shows the exact SQL without BigQuery.

| Model | Grain | What |
|---|---|---|
| `m_identity_links` (helper) | anonymous_id | the user an anonymous id was later identified as (latest wins), so pre-login steps join the learner |
| `m_user_firsts` (helper) | learner | first/last seen, first platform and channel, first feature, first value (tutor class, class joined or quiz started) |
| `m_sessions` | session × day | start, end, duration, events, screens, entry/exit screen, platform, version |
| `m_screen_daily` | day × screen | views, people (count and HLL sketch), median dwell and a dwell histogram, exits, top 5 previous/next screens |
| `m_feature_daily` | day × feature | people (count and HLL), uses, sessions; `_active` = everyone, the adoption denominator |
| `m_funnel_steps` | funnel × run start day × person | furthest step, when each step was reached, seconds between steps, platform / channel / version of the start |
| `m_retention_weekly` | cohort week × basis × channel × first feature × week | cohort size and actives; additive, so filters sum |
| `m_health_daily` | day × kind × name × screen × version × platform | errors, slow API calls, web vitals: count, people, p50/p75/p95, poor |

**Idempotent per day.** The helpers merge with min/max. Daily tables replace the day's
partition in one transaction. Funnels rewrite the start days their window still reaches
(D − window − 1 … D), and retention rewrites the last 26 cohort weeks. Re-running a day gives
the same tables. To backfill, run oldest first (`--from … --to …`).

**Funnels** follow `funnel.ts` exactly:
- A step counts only after the step before it, within the funnel's window of the run's start.
- The latest start is kept.
- Over a date range, a learner counts at their furthest run.

In SQL, events are replicated per candidate start day, then levels of running `MAX()` window
functions reproduce the greedy pass. A unit test runs that algorithm against `orderedFunnel()`
on 400 random event sets.

| Funnel | Steps | Window |
|---|---|---|
| `signup` | landing_viewed → auth_identifier_submitted → otp_requested → otp_verified → signup_completed → tutor_session_started / join_opened / quiz_started | 7 days |
| `ai_tutor` | tutor_entry_viewed → tutor_language_selected → tutor_lesson_opened → tutor_session_started → tutor_first_turn → tutor_session_ended (minutes ≥ 5) | 1 day |
| `live_class` | next_class_viewed → join_clicked → join_opened, scoped by `class_type` (the events carry no class id) | 1 day |
| `quiz` | quiz_opened → quiz_started → quiz_question_answered (q_index 0) → quiz_completed | 1 day |
| `purchase` | plans_viewed → plan_selected → checkout_opened → **server** payment captured → **server** booking created (paid, booked) | 3 days |

**Opt-out.** Behavioural models (sessions, screens, features, funnels, retention) leave out
rows with `opted_out = TRUE`. `m_health_daily` keeps them, because they are essential events
counted in aggregate (§5).

**Quality.** After a full run the command counts the day's events, sessions, screens and
features. It fails when there are events but no sessions, and warns when there are no events.
Each model row carries `modelled_at`. The Health tab flags a model older than 26 hours.
