# Quiz observability in the admin console

Everything about quizzes that the owner needs to see — what it costs, how the AI
marking behaves, and what learners go through — lives in the admin console.
**The quiz backend (teachers-dashboard) is not changed.** The console reads what
the backend and the app already record, plus the AI providers' own usage and
billing data.

## 1. Sources

| Source | What it gives | How the console gets it |
|---|---|---|
| Answer tables the backend already writes: `user_quiz_log_details`, `session_call_quiz_log_details`, `webinar_class_quiz_log_details` (+ parent logs, `quiz_questions`) | Every Speaking (SQ) and Writing (WQ) answer: type, answer text / transcript (used only to count words, never shown or copied), relevance / grammar / pronunciation / audio-quality scores, `is_correct`, `finished_on_time`, `time_taken`, timestamps, and the LSRW columns when present (`scoring_version`, `prompt_version`, `model_name`, `evaluation_status`) | Read-only query on the analytics connection. LSRW columns may not exist in every environment: detect them (information_schema) and degrade, never fail |
| `quiz_ai_evaluation_cache` (evidence marking) | One row per accepted evidence assessment; `evaluation_json.evidence_review.diagnostics` shows retries | Read-only; optional (table may be absent) |
| `student_activity_events` (existing endpoint `POST /activity/events`, already used for `quiz_start` / `quiz_end`) | The learner's side: recording, uploads, failures, timeouts, waits (§2) | The app sends new `quiz_*` event types through the existing `ActivityTracking.trackEvent` — no backend change |
| OpenAI Usage API + Costs API | Actual tokens and actual USD per day, by model / project / API key | Synced by the console (§3) |
| GCP Cloud Billing export to BigQuery | Actual speech-to-text cost per day (project `multibhashi-android-app`, number 290914850291; billing account `016513-594D05-0EF1D5`) | Synced by the console (§3) |

Where quiz AI bills land today: speech-to-text → GCP project `multibhashi-android-app`
(the only caller in the code is the quiz Speaking upload); marking → the OpenAI key
the quiz backend uses (only quiz endpoints call it).

## 2. App events (React Native app → existing `/activity/events`)

Sent with `ActivityTracking.trackEvent` exactly like `quiz_start`:
`resource_type: "quiz_question"`, `resource_id: String(question.id)`, the usual
attribution fields (`context_type`, `user_quiz_log_id`, … from `buildAttribution()`),
and `metadata` holding ONLY the fields below plus `quiz_id`, `question_id`,
`question_type`. Never the learner's words or recording.

| `event_type` | `duration_sec` | `metadata` | When |
|---|---|---|---|
| `quiz_question_shown` | — | — | A question appears |
| `quiz_record_started` | — | — | Microphone open and recording |
| `quiz_record_failed` | — | `error`: `NotAllowedError`, `NotFoundError`, `NotReadableError`, `SecurityError`, `unsupported`, `other` | Recording could not start |
| `quiz_record_stopped` | recorded seconds (rounded) | `seconds` (2 dp), `reason`: `user`, `cap`, `timeout`, `blur`, `unmount` | Recording ended |
| `quiz_record_deleted` | recorded seconds | `seconds` | Learner deleted a recording |
| `quiz_answer_submitted` | — | `timed_out`, `seconds` (SQ), `words`, `chars` (WQ) | Submit, or timeout auto-submit |
| `quiz_stt_result` | — | `ms`, `outcome`: `ok`, `no_speech`, `failed`, `http_status` | Speech-to-text answered |
| `quiz_eval_result` | — | `ms`, `outcome`: `ok`, `failed`, `http_status` | Marking answered |
| `quiz_submit_failed` | — | `stage`: `convert`, `stt`, `eval`; `error` (≤ 60 chars, no learner text) | Submission could not complete |
| `quiz_feedback_shown` | — | `ms` (submit → feedback) | Feedback screen reached |
| `quiz_question_timeout` | — | `had_answer` | Question timer reached 0 |
| `quiz_paste_blocked` | — | — | Writing paste / large insert blocked |

Every event's metadata also carries the device under the app (RN #45):
- `os`: `ios`, `android` or `desktop`. `student_sessions.device` says only `web` for every
  browser, so iPhone Safari fixes are measured with `os:ios`.
- `in_app: true` inside an app's built-in browser (WhatsApp, Instagram…).

The recording events also come from pronunciation questions (`question_type` says which).

## 3. Provider usage sync (console-owned table)

`console_ai_provider_daily` — one row per (day, provider, account scope, line item):

| Column | Meaning |
|---|---|
| `day` | IST date |
| `provider` | `openai`, `google` |
| `scope` | OpenAI project id / API key id, or GCP project id |
| `item` | OpenAI model (e.g. `gpt-4o-mini-2024-07-18`); GCP service + SKU description |
| `unit`, `quantity` | e.g. `input_tokens`, `cached_input_tokens`, `output_tokens`, `requests`; GCP usage unit (`seconds`) |
| `cost_usd` | The provider's own cost figure (OpenAI Costs API; BigQuery `cost` + credits) |
| `source`, `synced_at` | `openai_usage_api`, `openai_costs_api`, `gcp_billing_export` |

Synced by an ace command (`quiz:sync-provider-usage --days N`, idempotent upsert for
the window) that a system cron runs daily, and by a "Refresh" action on the page
(recorded with `auditService.record`). Credentials (admin API env, all optional — the
page says "not connected" and falls back to estimates when absent):

| Env | For |
|---|---|
| `OPENAI_ADMIN_KEY` | OpenAI Usage + Costs API (an organisation Admin key, not a normal API key) |
| `OPENAI_QUIZ_PROJECT_ID` / `OPENAI_QUIZ_API_KEY_IDS` | Filter to the quiz backend's project / key ids (comma-separated) |
| `GCP_BILLING_CREDENTIALS_JSON` (or `GCP_BILLING_CREDENTIALS_FILE`) | Service account with BigQuery Data Viewer on the export dataset + BigQuery Job User |
| `GCP_BILLING_EXPORT_TABLE` | `project.dataset.gcp_billing_export_v1_…` |
| `GCP_SPEECH_PROJECT_ID` | `multibhashi-android-app` |

## 4. Cost per answer: actual bills, allocated

The providers bill per day, not per answer, and the backend does not record each
call. So per-answer cost = each day's ACTUAL provider cost, spread over that day's
answers in proportion to an estimated weight:

- **Speaking speech-to-text** (GCP speech cost of the day) → SQ answers, weight =
  recorded seconds from `quiz_record_stopped` for that log + question when present,
  else transcript words ÷ 2.3 words/s, clamped to 1–58 s (Google bills each request
  rounded up to the second).
- **Marking** (OpenAI cost of the day, quiz scope) → SQ and WQ answers, weight =
  estimated tokens for the answer's marking path and length:
  - `legacy` (no LSRW columns / scoring_version null): 1 call ≈ 600 input + 150 output tokens
  - `counted` (scoring_version 2): ≈ 1,650 tokens
  - `evidence` (prompt_version `english-evidence-*`, scoring_version 3): 3 calls (grammar,
    independent review, content). Measured input per grammar call, offline from the
    current code (2026-10-29): 40 words ≈ 3,100 tokens, 100 words ≈ 5,760, 180 words ≈ 8,840
    (≈ 75 % of it is the JSON response schema, which grows with the answer); content
    call ≈ 1,300–2,800. Output ≈ 200–220 tokens per answer sentence per grammar call.
    Retries in the cache diagnostics add calls.

When a day has no provider data (not connected, or the export has not arrived), the
console shows an ESTIMATE = the weights × the rate card prices, labelled as such. A
measured figure is never shown for a day that was only estimated.

Rate card lines (cost_model.ts): `openai|gpt-4o-mini|input_tokens` $0.15/1M,
`cached_input_tokens` $0.075/1M, `output_tokens` $0.60/1M; `google|speech-v2-standard|audio_seconds`
$0.016 per 60 s; `google|speech-v1-standard|audio_seconds` $0.024 per 60 s (V1 fallback;
last known, not re-checked). Checked 2026-10-29: https://developers.openai.com/api/docs/pricing,
https://cloud.google.com/speech-to-text/pricing.

## 5. What the console shows

- **Cost** (Cost page, Quizzes): actual quiz AI spend per day (speech-to-text vs marking,
  provider-sourced), cost per Speaking answer and per Writing answer (mean, median, p95),
  by marking path, most expensive quizzes and learners; data freshness per provider.
- **Quality and volume** (Insights, Quizzes): SQ/WQ answers per day, marking path mix,
  marking failures (`evaluation_status = failed` / scores null), timeouts, no-speech,
  score distributions.
- **Learner experience** (Insights, Quizzes): recording start failures by error type,
  recording length, deletes and re-records, no-speech rate, upload/marking failures,
  submit → feedback wait (median, p95), paste blocks.

## 6. Limits (stated plainly)

- Per-answer cost is allocated from real daily bills, not measured per call: the backend
  does not record individual calls. Daily and monthly totals are exact; a single answer's
  figure is an estimate weighted by its length and marking path.
- If the quiz OpenAI key is shared with anything else, its usage is in the quiz figure
  unless `OPENAI_QUIZ_API_KEY_IDS` narrows it.
- GCP billing export data starts from when it was enabled (2026-10-29) and lags by hours
  to a day.
- App events exist only from the app release that sends them.

## 7. Before/after tracking for the quiz fixes

Every quiz change is judged the same way: the same metric definitions, over windows on each
side of the moment the change reached learners. Nothing here changes the quiz backend.

### Release log (`console_quiz_releases`)

One row per change that can move a quiz number: a phase of the Speaking & Writing brief, an
app fix, the telemetry release, or a confounder (a navigation change, a bulk assignment, a
scoring change). Each row has the time it reached learners (`deployed_at`, entered in IST),
whether that time is an estimate (a merge or commit time), the app version that carries it,
and the metrics it should move (`expects`: metric + up/down/flat). Insights → Quizzes shows
the log; `analytics.releases.manage` (Super Admin, Platform Admin) edits it; every write is
audited, and a delete asks for a reason. `quiz:seed-releases` adds the changes made before the
log existed, with estimated times (2026-10-28 → 2026-11-16) and RN #45 as "not live yet".

### Daily metrics (`console_quiz_daily_metrics`)

`quiz:daily-metrics` computes every metric per IST day and segment and stores it as
(num, den), plus bucket counts for a distribution. A window is SUM(num) / SUM(den), never a
mean of daily rates, and a percentile comes from the merged buckets. The catalog, with how
each metric is computed and which brief phase it is evidence for, is `METRICS` in
`app/services/analytics/quiz_metrics.ts` (definition version 1):

| Source | Metrics (examples) | From |
|---|---|---|
| Answer tables | Speaking/Writing answers; past the timer; no speech; empty; under 10 words; short but marked relevant; marking failures; pass rate; words, time and score distributions; evidence-path share and retries | 2026-09-01 (backfill) |
| Attempts (parent logs) | attempts; finished; finished with Speaking/Writing; left after a timeout | 2026-09-01 |
| App events (§2) | recording start failures (by error); submit failures (by stage); speech-to-text heard nothing or failed; marking failed; submit → feedback wait; timeouts; stuck after a timeout; re-recordings; recording length; paste blocks | the RN #45 release |
| Bills (§3–4) | speech-to-text and marking ₹ per day; ₹ per Speaking answer, per marked answer, per answer, per finished attempt; billed seconds per Speaking answer; OpenAI requests and tokens per marked answer | 2026-09-01; `basis` says actual, usage or estimated |

"Stuck after a timeout": an SQ/WQ timeout with no feedback for that question within 10 minutes
and no other question shown within 30 minutes, in the same attempt.

Segments: `all`; `context:course|webinar|session`; `device:web|ios|android|unknown` (the activity
session's device); `app:<version>` (from PR #44 on); for events also `os:ios|android|desktop`
and `in_app:yes`; `error:<code>` and `stage:<stage>` on the failure counts. An answer or attempt
gets the device of its learner's latest `quiz_start` of that quiz at most 6 h before it
(`quiz_start` carries no attempt id); unmatched is `device:unknown`.

Not everything should go down: answers that are given enough time (phases 2–3) are longer, so
₹ per Speaking answer and billed seconds per answer are expected to rise. Those metrics are
marked `better: context`.

### Freezing

A day is final 3 days after it ends (attempts can finish the next day); a cost day waits for
the provider's bill and is frozen as an estimate only after 21 days. A run replaces the window's
non-final rows and leaves final rows as they are, so the "before" a fix is judged against never
moves. `--force` rewrites final rows too, only after fixing a definition bug; a changed definition
is a new `DEFINITION_VERSION`, stored beside the old rows.

### Running it

- Once after deploying: `node ace quiz:seed-releases`, then `node ace quiz:daily-metrics --backfill`
  (2026-09-01 → today, 4 days at a time; off-peak, it reads the live answer tables).
- Daily at 03:45 IST, after the provider sync: `node ace quiz:daily-metrics` (the last 7 days).
- `GET /api/insights/quiz-metrics` (status + catalog) and `/api/insights/quiz-metrics/series`
  (one metric's rows for a segment and window); cost metrics need `analytics.cost.read`.

### Limits

- The answer tables have no created_at index; the loaders find a window by binary search on the
  primary key, which assumes ids grow with time (true in production, not in the local demo data).
- Device for answers before RN #45 is only as good as the `quiz_start` match; `os` exists only
  from RN #45.
- The 2026-11-16 web fixes (MUL-89–107) shipped before the app events, so their before/after
  rests on the answer tables only.
