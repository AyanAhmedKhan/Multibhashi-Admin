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
