# Per-class AI usage: payload and table (v1)

_Updated 2026-10-23 with the agent implementation's details (final usage call, how each quantity is counted)._

Approved by the user on 2026-10-23: make the console's AI cost exact, Sarvam STT and TTS
included. Three parts, three owners:

| Part | Owner | What |
|---|---|---|
| Agent | observability session (`agent/class-telemetry.js`) | Accumulate usage per LiveKit job; send it with every `aitutor/session/save` |
| Tutor API | tutor session (`api/`) | Validate `usage`, upsert into `ai_tutor_session_usage` (migration in `tutor_api_schema`) |
| Console | admin session (`multibhashi-admin`) | Price each row with the rate card; exact cost per class, per provider, per day; estimate only for classes without rows |

Prices never travel with usage: the agent reports **quantities**, the console's rate card
holds **prices**, so a price change never needs an agent release.

## 1. Payload: `usage` on `POST aitutor/session/save`

```json
{
  "session_id": 123,
  "status": "paused",
  "usage": {
    "v": 1,
    "job_id": "AJ_nHsUA8pN3kJt",
    "engine": "sarvam",
    "language": "kn-IN",
    "explain_language": "en-IN",
    "items": [
      { "kind": "stt", "provider": "sarvam", "model": "saaras:v3-realtime", "unit": "audio_seconds", "quantity": 312.4 },
      { "kind": "tts", "provider": "sarvam", "model": "bulbul:v3", "unit": "characters", "quantity": 5321 },
      { "kind": "llm", "provider": "google", "model": "gemini-3.1-flash-lite", "unit": "input_tokens", "quantity": 40345 },
      { "kind": "llm", "provider": "google", "model": "gemini-3.1-flash-lite", "unit": "cached_input_tokens", "quantity": 80000 },
      { "kind": "llm", "provider": "google", "model": "gemini-3.1-flash-lite", "unit": "output_tokens", "quantity": 2900 },
      { "kind": "memory", "provider": "google", "model": "gemini-3.5-flash", "unit": "input_tokens", "quantity": 9000 },
      { "kind": "memory", "provider": "google", "model": "gemini-3.5-flash", "unit": "output_tokens", "quantity": 800 },
      { "kind": "transport", "provider": "livekit", "model": "", "unit": "participant_seconds", "quantity": 3010 }
    ]
  }
}
```

**Semantics**

- **Cumulative per job.** `quantity` is the running total for this LiveKit job (one agent run
  of one class). Send the whole `usage` object on *every* `session/save`, not just the last.
  The API keeps the larger value (`GREATEST`), so retries, duplicates and out-of-order
  saves never double count.
- **A job ≠ a class.** A resumed class or a break continuation is a new job with its own
  `job_id` (`ctx.job.id`) on the same `session_id`. The console sums jobs per class.
- `usage` is optional. Saves without it behave exactly as today; a bad `usage` is dropped
  with a warning (it must never fail the save that carries minutes, memory and status).
- **Final usage call.** The end-of-class reflection and the last seconds in the room happen
  *after* the last `session/save`, so the agent also calls the agent-only
  `POST aitutor/session/usage` `{ session_id, usage }` after the reflection. Same validation
  and GREATEST upsert; it never changes status or minutes.
- `usage` is null outside a LiveKit job (tools, tests); `language` / `explain_language` may be
  absent.
- `engine`: `sarvam` | `global` | `gemini` (the engine actually built, after overrides).
  `language` is the taught language; `explain_language` is the language the tutor explains in.

## 2. Canonical items

`kind`: `stt` | `tts` | `llm` | `realtime` | `memory` | `transport`.
`model` is `""` when not applicable (never null: it is part of the unique key).

| What | kind | provider | model (example) | unit | Notes |
|---|---|---|---|---|---|
| Sarvam speech-to-text | stt | sarvam | `saaras:v3-realtime` | `audio_seconds` | Counted as audio is **sent**: base64-decoded bytes ÷ 32 000 (16 kHz s16 mono), silence padding on Stop included. (Sarvam's own end-of-socket report arrives after the last save and never on a dropped socket.) |
| Sarvam text-to-speech | tts | sarvam | `bulbul:v3` | `characters` | Text pushed into the class's TTS stream. A barge-in can count text pushed but never synthesised (slight overcount); inner retries are not counted |
| Gemini text LLM (class) | llm | google | `gemini-3.1-flash-lite` | `input_tokens` | Prompt tokens **not** served from cache (`promptTokens − promptCachedTokens`) |
|  | llm | google | same | `cached_input_tokens` | `promptCachedTokens` |
|  | llm | google | same | `output_tokens` | `totalTokens − promptTokens`, so **thinking tokens are included** (the plugin's `completionTokens` drops them) |
| Gemini TTS (global engine) | tts | google | `gemini-3.8-flash-lite-tts` | `characters` | Text sent |
|  | tts | google | same | `output_audio_seconds` | Seconds of audio returned (billing is per audio token; the console converts). A failed chunk that is skipped still counts its characters |
| Gemini native audio (gemini engine) | realtime | google | `gemini-2.5-flash-native-audio-preview-12-2025` (from the session; the realtime metrics don't name it) | `input_audio_tokens`, `input_text_tokens`, `cached_input_tokens`, `output_audio_tokens`, `output_text_tokens` | Input audio/text **exclude** cached tokens (their own line). Without a modality split the totals go to `input_text_tokens` / `output_text_tokens` |
| Memory model | memory | google | `gemini-3.1-flash-lite` (running-notes summaries) and `TUTOR_MEMORY_MODEL`, default `gemini-3.5-flash` (reflection) | `input_tokens`, `cached_input_tokens`, `output_tokens` | From `usageMetadata` (thoughts included in output). A call that times out reports nothing although Google may bill it (small undercount) |
| LiveKit | transport | livekit | `""` | `participant_seconds` | The agent from class start + every remote participant's connected intervals (reconnects handled), counted until the final usage call (reflection time included: the agent is still in the room) |

A new provider or model needs no schema change: add an item; the console flags it as
"unpriced" until Finance adds its price.

**Validation (API)**: `v` = 1; `job_id` 1–64 chars; `engine` in the enum; `language`,
`explain_language` ≤ 16; `items` ≤ 50; `kind` in the enum; `provider` ≤ 32, `model` ≤ 64,
`unit` ≤ 32 (`[a-z0-9_.:-]`); `quantity` finite, 0 ≤ q ≤ 1e10. The session must exist (the
existing `session_id` check) and the call must carry `AGENT_API_SECRET` (it is an agent-only
route already).

## 3. Table (tutor API migration)

```sql
CREATE TABLE ai_tutor_session_usage (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ai_tutor_chat_id INT UNSIGNED  NOT NULL,
  user_id          INT UNSIGNED  NOT NULL,
  job_id           VARCHAR(64)   NOT NULL,
  engine           VARCHAR(16)   NOT NULL,
  language         VARCHAR(16)   NULL,
  explain_language VARCHAR(16)   NULL,
  kind             VARCHAR(16)   NOT NULL,
  provider         VARCHAR(32)   NOT NULL,
  model            VARCHAR(64)   NOT NULL DEFAULT '',
  unit             VARCHAR(32)   NOT NULL,
  quantity         DECIMAL(18,3) NOT NULL,
  created_at       DATETIME      NOT NULL,
  updated_at       DATETIME      NOT NULL,
  UNIQUE KEY uq_usage (ai_tutor_chat_id, job_id, kind, provider, model, unit),
  KEY idx_usage_created (created_at),
  KEY idx_usage_chat (ai_tutor_chat_id)
) CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Upsert per item:
`INSERT … ON DUPLICATE KEY UPDATE quantity = GREATEST(quantity, VALUES(quantity)), updated_at = VALUES(updated_at)`.
`created_at` is the first time the job reported (the console buckets cost by it, IST).
Additive only; nothing else changes. Learner erasure doesn't need to touch it (no content,
only counts).

## 4. What the console does with it

- Exact cost per class = Σ quantity × the rate-card price for (provider, model, unit).
  Model can be a wildcard in the rate card (e.g. any `sarvam` `audio_seconds`).
- Cost & margin page: coverage (share of minutes with recorded usage), cost by provider
  (**Sarvam STT, Sarvam TTS**, Gemini LLM, cached input, memory model, Gemini TTS, native
  audio, LiveKit), by engine and language, per day, most expensive classes, cost per class
  (average, median, p90). Classes without rows are estimated from the per-minute assumptions
  and labelled.
- Calibration: measured usage per class minute next to the assumptions, one click to adopt.
- Reconciliation: Finance enters each month's actual Sarvam / Google / LiveKit bill (Sarvam
  has no usage API, only an organisation-wide balance); the console shows computed vs billed.
- Class page: the usage and cost of that class.
