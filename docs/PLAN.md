# MultiBhashi Admin Console: the plan

One console for every MultiBhashi team: AI tutor, learners, sales, bookings, finance,
trainers, live classes, content, B2B and marketing. It replaces the staff admin inside the
`teachers-dashboard` monolith, module by module, without a big-bang cut-over.

**Status (2026-10-23):** Phase 1 is built and tested locally in `D:\MultiBhashi\multibhashi-admin`.
Nothing is deployed or pushed.

Contents

1. [Why a new console (and what must be fixed first)](#1-why-a-new-console-and-what-must-be-fixed-first)
2. [Architecture](#2-architecture)
3. [Panels: 14 modules, by phase](#3-panels-14-modules-by-phase)
4. [Roles: 13 roles, and how many admins](#4-roles-13-roles-and-how-many-admins)
5. [Powers: the permission model](#5-powers-the-permission-model)
6. [Security best practices (built in)](#6-security-best-practices-built-in)
7. [Insights: users, concurrency, screens, AI usage](#7-insights-users-concurrency-screens-ai-usage)
8. [AI cost and unit economics](#8-ai-cost-and-unit-economics)
9. [AI Pro without payment, and minutes up or down](#9-ai-pro-without-payment-and-minutes-up-or-down)
10. [What Phase 1 contains](#10-what-phase-1-contains)
11. [Roadmap](#11-roadmap)
12. [Operating the console](#12-operating-the-console)
13. [Decisions needed](#13-decisions-needed)

---

## 1. Why a new console (and what must be fixed first)

The current admin (`teachers.*` subdomain of the AdonisJS v4 monolith) has ~40 pages and
25 role slugs. It works, but its access control is cosmetic, and that cannot be patched
page by page. Verified in the code on 2026-10-23:

| # | Finding | Where | Impact |
|---|---|---|---|
| 1 | **Roles are checked only when a page renders.** None of the ~500 admin API routes check roles; they need only `auth:admin`. | `start/routes.js` groups ending at lines 259/491/1623 | Any staff login (including a trainer) can call any admin API, e.g. `POST /team/update/roles` to make themselves admin, create bookings, coupons, delete classes. |
| 2 | **Password reset takeover.** `resetPassword` finds the token by value only, then sets the password of whatever `email` the request names. | `Admin/AuthController.js` ~line 431 | Anyone who can get *any* reset token (their own) can reset *any* admin's password. |
| 3 | **Invited accounts start with the password `default`.** | `TeamController.js` line 61 | Until an invite is accepted, anyone who knows the email can sign in. |
| 4 | **AI tutor purchase isn't verified against the payment.** The booking only checks the Razorpay payment is captured; amount, re-use of the payment id and `minute_purchased` come from the client. | `PaymentController.js` ~line 514 | One cheap payment can be replayed or inflated into any number of minutes. |
| 5 | **Service-account keys are in git.** | `app/serviceAccount.json`, `app/googleSlideServiceAccount.json`, `config/gcp_service_account.json` | Anyone with repo access holds production Google credentials. |
| 6 | CSRF: shield skips `/api/*`, session cookie is `SameSite=None` and readable by JS (`httpOnly:false`); some GETs change data (`webinar/class/:id` deletes a class). | `config/shield.js`, `config/session.js` | Cross-site requests and XSS can act as a logged-in admin. |
| 7 | No MFA, no login rate limit or lockout, no audit log; open `/service/api/v1` and cron routes; reports downloadable by id without an owner check. | various | No way to know who did what; brute force is free. |

### Phase 0: fix in the monolith now (days, independent of the console)

These protect production while the console replaces the old admin. Each is a small,
reviewable change; none was made here (the monolith is live and this work stays local).

1. Route-level role checks on the admin API groups (a middleware that maps each route to
   the role list its page already uses), starting with `/team/*`, `/api/v1/role`, bookings,
   coupons, subscriptions, deletes.
2. Reset and signup: bind the token to the admin and type, expire it (1 h), ignore the
   `email` in the body.
3. Invites: random unusable password; refuse login for state 2.
4. AI tutor payment: verify `amount` against the price, store and reject re-used
   `razorpay_payment_id`, compute minutes on the server.
5. Rotate the three Google service-account keys, remove the files from git history, load
   them from the secret store.
6. Session cookie `httpOnly:true`, `SameSite=Lax`; turn state-changing GETs into POSTs;
   re-enable the cron token check.

---

## 2. Architecture

```
            Staff browser (admin.multibhashi.com)
                    │  HTTPS, one origin
            ┌───────┴────────┐
            │     nginx      │  serves web/dist, proxies /api → :3500
            └───────┬────────┘   (optional: office/VPN IP allowlist here too)
                    │
   ┌────────────────┴───────────────────┐
   │ Admin API  (AdonisJS 6, TypeScript) │  multibhashi-admin/api
   │  auth · RBAC · approvals · audit    │
   │  modules: tutor, learners, insights │
   └──┬──────────────┬──────────────┬───┘
      │              │              │
  MySQL primary   MySQL replica   LiveKit server API · Tutor API /health
  (console_* +    (Insights reads)  (live classes, end class)
   writes to the
   tables a module owns)
```

**Decisions and why**

| Decision | Choice | Why |
|---|---|---|
| Where it lives | A separate service and repo, not inside the monolith or the tutor API | Admin has a different risk profile: its own deploy, secrets, rate limits and network rules. A bug in the console can't take down learner-facing APIs, and vice versa. |
| Backend | AdonisJS 6 (TypeScript), same versions as the tutor API | The team already runs it; Lucid works on the shared MySQL; migrations tracked in `console_api_schema` so they never touch `adonis_schema` (monolith) or `tutor_api_schema` (tutor). |
| Frontend | React 18 + Vite + TypeScript + Tailwind v4, TanStack Query, Recharts | Fast to build lists/forms/charts; one static bundle; same stack family as the RN web app. |
| Same origin | nginx serves the SPA and proxies `/api` | First-party cookies with `SameSite=Strict`; no CORS surface at all. |
| Auth | Own server-side sessions + TOTP, not JWT | Instant revocation (leaver, lost laptop), session list per person, idle timeout. JWTs can't be revoked. |
| Data access | The console reads the shared DB directly; it **writes only through code that mirrors the owning system's rules** (e.g. the minutes ledger, the memory tombstone) | Avoids a distributed system on day one; each write path is documented next to the code it mirrors. When the monolith module is retired, the console becomes the owner. |
| Heavy reads | A second DB connection (`DB_ANALYTICS_*`) for Insights → a read replica | Dashboards never compete with learners' writes. |
| Migration from the old admin | Strangler pattern: one module at a time; the old page is switched off when the console's is live | No big-bang; each phase ships on its own. |

**Database access (production).** Give the console its own MySQL user:

- `SELECT` on platform tables;
- `INSERT, UPDATE` only on the tables its built modules write (today: `ai_tutor_chats`,
  `ai_tutor_time_logs`, `ai_tutor_learner_memories`, `ai_tutor_session_summaries` (delete),
  `course_lesson_package_bookings`, `course_lesson_subscriptions`, all `console_*`);
- `INSERT, SELECT` only on `console_audit_logs`, and `UPDATE` on `console_audit_head`,
  so not even the console itself can rewrite history;
- a read-only user on the replica for Insights.

---

## 3. Panels: 14 modules, by phase

The navigation is permission-aware: each person sees only the modules their roles allow.
Phase 1 is built; later phases are listed in the sidebar as "Coming next".

| # | Module | Screens | Replaces in the old admin | Phase |
|---|---|---|---|---|
| 1 | **Overview** | KPI tiles, classes per day, top lessons, pending approvals | home | **1 ✓** |
| 2 | **Insights** | Users & growth · Screens & content · AI tutor usage · Cost & margin | analytics (leads only) | **1 ✓** |
| 3 | **AI Tutor** | Live classes (end a class) · Classes (detail, transcript, minutes ±) · Minutes ledger · Free-grant abuse view | CLI `ai:grant-minutes` | **1 ✓** |
| 4 | **Learners** | Search (masked) · Profile · Reveal contact · AI Pro (give/extend/end) · Tutor memory (view/erase) · Data export | users, userprofile | **1 ✓** (edit/block in 2) |
| 5 | **Administration** | Approvals · Staff · Roles & permissions · Audit log · Security policy · System health · My account | team, dashboard_controls | **1 ✓** |
| 6 | CRM & Leads | Leads (own/team/all), assign/transfer, remarks, renewals, recordings, sources/statuses | leads, status, contactus | 2 |
| 7 | Bookings & Sales | Course/session/package/IELTS bookings, subscriptions, coupons, offers, invoices | bookings, coupon, offers, subscription, sessions_testing | 2 |
| 8 | Finance | Payments, refunds (raise → approve), invoices, trainer payouts (approve), exports | trainerpayment | 2 |
| 9 | Teachers | Profiles, onboarding, specialisations, availability/slots, pay rates (approval) | teachers, trainercalendar | 2 |
| 10 | Live Classes | 1:1 sessions & calls, webinars/batches, attendance, recordings, Zoom/100ms meetings, chat moderation | sessions, webinars, chats, notes | 2 |
| 11 | Reports | Scheduled exports, report inbox (owner-checked downloads) | reports | 2 |
| 12 | Content & Curriculum | Courses, levels, lessons, study material, quizzes/question bank, dictionary, AI tutor prompts/voices | courses, study_material, quizzes, editquiz, dictionary, classeshome | 3 |
| 13 | B2B & Institutes | Clients, managers, assignments, NSDC, offline institutes | b2b_clients, assignments, offline_classes | 3 |
| 14 | Marketing & Site | Blogs, home page/banners/promo bar, push & email campaigns (approval above N recipients), WordPress pages | blogs, notifications, wp_script, textformat | 3 |

The trainer-facing pages of the old admin (`profile`, `trainercalendar`, own sessions and
payouts) are not staff tools: they become a separate **Trainer Portal** (phase 3) with its
own login, so trainers never hold staff accounts.

---

## 4. Roles: 13 roles, and how many admins

Thirteen built-in roles cover every team. They are defined in code
(`api/app/rbac/roles.ts`), so they change only through review, never by a click. If a team
needs something different, a Super Admin creates a **custom role**, but only from permissions
they hold themselves.

| Role | What they do | Seats | Replaces old slugs |
|---|---|---|---|
| **Super Admin** | Owns the console: staff, roles, security policy, final approvals. Not a daily-ops account. | **2** (never 1, at most 3) | none: chosen by name |
| Platform Admin | Runs the business across modules; cannot change access or security | 1–2 | `admin`, `super_admin` |
| Operations Manager | Classes, schedules, trainers, AI tutor; escalations; approves big grants | 1 per ops team | `ops_manager`, `relationship_manager` |
| Support Agent | Finds learners, checks classes and minutes, small goodwill grants, chat moderation | per support team | `chat_admin` |
| Sales Manager | All leads, assignment, bookings, coupons, subscriptions; may give AI Pro (approval above limits) | 1 per sales team | `sales_manager`, `sales_admin` |
| Sales Agent | Own assigned leads; creates bookings for them | one per counsellor | `agent` |
| Finance | Payments, invoices, refunds and payouts (approves); cost rate card; can end comps | 1–2 | `finance`, `booking_admin` |
| Trainer Manager (HR) | Recruits and manages trainers; pay rates (with approval) | 1–2 | `hr`, `teacher_admin` |
| Content Manager | Courses, lessons, study material, quizzes, AI tutor teaching setup | 1 per language team | `curriculum_manager`, `course_manager`, `study_manager`, `quiz_manager`, `tech` |
| B2B Account Manager | Their institutional clients, batches, NSDC | per account manager | `b_to_b_sales_manager`, `project_manager` |
| Marketing | Blogs, site content, campaigns | 1–3 | `marketing`, `notification_admin`, `wp_manager`, `blogs_agent`, `offline_pages_agent` |
| Privacy Officer | DPDP data requests (access, erasure); reviews the audit log; sees PII | 1 (+ deputy) | none |
| Auditor (read-only) | Founders' analysts, auditors: everything non-personal, changes nothing | as needed, **time-boxed** | none |

`teacher` is not a staff role: trainers move to the Trainer Portal.

### How many admins

- **Super Admins: exactly 2.** One is a single point of failure (holiday, lost phone);
  more than 3 means nobody really owns access. Bootstrap the first from the CLI; the first
  adds the second directly; from then on a new Super Admin needs another Super Admin's
  approval.
- **Platform Admins: 1–2** (the COO/head of ops), not "everyone senior".
- Everyone else: one account per person, the narrowest role that fits the job. **No shared
  logins**, ever, because the audit log is only as good as the identities in it.
- A **break-glass** procedure (§12) instead of extra Super Admins "just in case".

### Separation of duties (enforced)

- Raising money movement and approving it are different people (refunds, payouts, big
  grants, complimentary AI Pro above limits, new Super Admins).
- Nobody can change their own roles, approve their own request, or reset their own access.
- Nobody can grant a permission they don't hold (no escalation through custom roles).
- The last active Super Admin can't be disabled or demoted.

---

## 5. Powers: the permission model

Permissions are strings `module.resource.action` in one catalog
(`api/app/rbac/permissions.ts`): 70 today, of which 26 are live in Phase 1. Unbuilt modules'
permissions already exist, so each module goes live without re-planning access.

Each permission has a **risk tier**, and the tier decides the controls:

| Risk | Example | Controls |
|---|---|---|
| read | `tutor.classes.read` | role check |
| sensitive | `tutor.transcripts.read`, `learners.pii.read`, `tutor.memory.read` | role check + **reason** + audited read |
| write | `tutor.live.terminate` | role check + reason + audit |
| critical | `tutor.minutes.grant`, `tutor.access.grant`, `tutor.memory.erase`, `console.staff.manage` | role check + reason + audit + **fresh MFA (step-up, 10 min)**, and an **approval** above thresholds |

Approval thresholds (Security policy page, defaults): minutes grant > 60 per grant;
complimentary AI Pro > 30 days or > 300 minutes; any new Super Admin. Phase 2 adds refunds,
payout batches, pay-rate changes, campaigns over N recipients and bulk deletes.

**Data scopes (phase 2).** CRM, bookings, classes and B2B permissions are *scoped*: a role
holds them for its own records, its team's, or all. For example, Sales Agent = own leads,
Sales Manager = all. This replaces the ad-hoc `if agent` filters in the monolith's controllers.

Enforcement is **server-side on every route** (`middleware.can([...])` in
`api/start/routes.ts`); the UI hiding a button is only a convenience. Permissions are
re-read on every request, so a role change applies at once.

---

## 6. Security best practices (built in)

**Identity and sign-in**

- Invite-only accounts; one-time setup link (48 h, hashed in DB) where the person sets
  their own password **and** enrols TOTP MFA. No admin ever knows anyone's password.
- MFA (TOTP, RFC 6238) mandatory for everyone, with replay protection and 10 single-use
  recovery codes (hashed).
- Passwords per NIST 800-63B: 12+ characters, common and personal ones refused, no forced
  rotation; hashed with scrypt.
- Lockout after 5 failures (15 min), per-IP rate limit, and the same error whether or not the
  email exists, with equal timing (no account enumeration).
- Optional IP allowlist (office/VPN) on top of MFA.

**Sessions**

- Server-side sessions (token hashed in DB), rotated after MFA (no fixation).
- 30-minute idle timeout and 12-hour maximum. **Auto-refreshing dashboards don't count as
  activity**, so an unattended screen still signs out.
- Revocable instantly: "sign out everywhere", disable a leaver, reset a lost phone.
- Cookie `HttpOnly`, `SameSite=Strict`, `Secure` in production.

**Requests**

- CSRF: same-origin check on every change, JSON-only bodies, plus a per-session token header.
- Security headers on every response (no framing, no sniffing, `no-store`, CSP, HSTS).
- 5xx errors never leak SQL, stacks or hosts; request bodies are redacted in logs.

**Accountability**

- Every write, every sensitive read and every refused attempt goes to the audit log, with
  who, when, IP, user agent, request id, and **why** (a reason is mandatory).
- The log is append-only and **hash-chained**. "Verify integrity" proves no row was edited
  or deleted, and the production DB grants stop even the console from rewriting it.

**Personal data (DPDP Act 2023)**

- Phone, email and name are masked by default; revealing them is a separate audited
  action that needs `learners.pii.read`.
- Insights are aggregates only.
- Erasure ("forget this learner's tutor memory") and access requests (JSON export) are
  built in, for the Privacy Officer.
- Purpose limitation: transcripts need a reason, every time.

**Operations**

- Secrets only in the server's secret store (APP_KEY signs sessions and encrypts MFA secrets).
- Dev-only commands refuse to run against anything but a local database.
- Backups of `console_*` follow the main DB policy.
- Quarterly access review and same-day offboarding (§12).

---

## 7. Insights: users, concurrency, screens, AI usage

Built on data the platform already collects: the app's **activity tracking**
(`student_sessions` with a 30 s heartbeat, `student_learning_segments` per screen with
engaged vs idle time, `student_activity_events`, the `student_daily_activity` rollup), plus
`users` and the AI tutor tables. Times are bucketed in IST, independent of the DB's time zone.

| Tab | Metrics |
|---|---|
| Users & growth | Online now (heartbeat < 90 s) · DAU / WAU / MAU · stickiness (avg DAU ÷ MAU) · sign-ups per day and change vs previous period · **peak concurrent learners per day** (exact, from session intervals) and today's concurrency curve (15 min) · weekday × hour heatmap · **retention by sign-up week** (8-week cohorts) · devices · app versions in use |
| Screens & content | **Most used screens** (visits, learners, engaged minutes, minutes per visit, idle share, idle timeouts) · **learning funnel** (app → lesson → quiz → finish → AI tutor; each step needs the previous ones) · most opened content · engaged minutes per learner per day · event counts · data health (rollup freshness, stuck screen visits) |
| AI tutor usage | Classes, learners, minutes taught, average class length · learner and tutor turns per class · share who come back · peak concurrent classes · languages taught · where minutes came from (free / paid / complimentary) · classes by hour |
| Cost & margin | See §8 (needs `analytics.cost.read`) |

A highlights strip turns week-over-week changes and data problems into sentences
("Active learners up 31.8%…", "the daily rollup last ran for…", "learners idle 30% on PDF
screens").

**Performance and privacy.** Queries run on the `analytics` connection (point it at a
read replica) and are cached for two minutes. Every chart has a table view. Nothing on these
pages identifies a learner.

**Next for Insights (phase 2).** Revenue and bookings (from `transactions`), lead conversion
by source/agent, trainer utilisation, CSV export (audited), scheduled email digest. Web
traffic (marketing site) belongs in GA4/Search Console; link out rather than rebuild it.

---

## 8. AI cost and unit economics

**Exact, approved 2026-10-23** (Sarvam STT and TTS included). The agent records what each
class actually used and the console prices it; see [`AI_USAGE_SPEC.md`](AI_USAGE_SPEC.md).

| Part | Owner | Status |
|---|---|---|
| Per-job usage accumulator, sent with every `session/save` + a final `session/usage` after the reflection | agent (`class-telemetry.js`) | **done** (verified on all three engines, 2026-10-23) |
| `ai_tutor_session_usage` table + `usage` field on `session/save` | tutor API | **done locally**; not yet on production |
| Pricing, Cost page, per-class cost, calibration, reconciliation | console | **done**; per-class cost matches the price list to ₹0.0001 on all three engines |

**What is recorded per class** (cumulative per LiveKit job, so retries never double count):
Sarvam STT audio seconds · Sarvam Bulbul characters · Gemini LLM input / cached input / output
tokens · Gemini TTS characters and audio seconds · Gemini native-audio audio/text tokens ·
memory-model tokens (running notes + end-of-class reflection) · LiveKit participant seconds.
Quantities only: prices live in the console, so a price change never needs an agent release.

**Price list** (editable by Finance, every change audited with before/after ₹ per minute):

| Service | Price | Source |
|---|---|---|
| Sarvam speech-to-text | ₹30 per audio hour, per second | [Sarvam](https://sarvam.ai/api-pricing) |
| Sarvam Bulbul v3 TTS | ₹30 per 10K characters (v2: ₹15) | [Sarvam](https://sarvam.ai/api-pricing) |
| Gemini 3.1 Flash-Lite | $0.25 in / $0.025 cached / $1.50 out per 1M tokens | third-party, confirm |
| Gemini 3.5 Flash (memory) | $1.50 in / $0.15 cached / $9.00 out per 1M tokens | third-party, confirm |
| Gemini Flash-Lite TTS | $0.50 per 1M text tokens; $9 per 1M audio tokens (introductory) | third-party, confirm |
| Gemini native audio | $3 audio in / $12 audio out per 1M tokens | third-party, confirm |
| LiveKit | $0.0005 per participant-minute (Ship); 0 if self-hosted | [LiveKit](https://livekit.io/pricing) |

**Cost & margin page**: coverage (share of minutes priced exactly), total / exact / estimated,
cost per minute, per class (average, median, p90), per learner, revenue from minutes sold and
margin, monthly run-rate; a **Sarvam card** (STT audio hours and ₹, TTS characters and ₹);
cost by provider and service; by engine (measured vs assumed ₹/min); per day; the 10 most
expensive classes; **calibration** (measured usage per class minute vs the assumptions, one
click to adopt); **reconciliation** (Finance enters each month's Sarvam / Google / LiveKit bill;
Sarvam has no usage API, only an organisation-wide balance); usage without a price is flagged
and counts ₹0 until priced. Each class page shows that class's usage and cost.

Classes with no usage record (older classes, a lost save) are **estimated** from minutes ×
per-minute assumptions per engine (≈ ₹2.4/min Sarvam, of which Bulbul TTS ₹1.35 and STT ₹0.50; ≈ ₹1.8/min global;
≈ ₹2.5/min native audio, with the default assumptions) and labelled as estimates everywhere.

---

## 9. AI Pro without payment, and minutes up or down

**Give AI Pro** (Learner page → AI Pro access) is the reviewed, audited UI version of the
monolith's `ai:grant-minutes` CLI, with the same three switches the app checks:

1. **AI plan**: a complimentary `course_lesson_package_bookings` row (`has_ai_tutor = 1`,
   price 0, copies the course's AI package) so the paywall after lesson 2 disappears;
2. **Lesson access**: `course_lesson_subscriptions` so lessons 5+ unlock;
3. **Minutes** on each lesson's PDF learn card: chat total = sum of the lesson's ledger +
   minutes, time already spent untouched, one ledger row each (`console_ai_pro`).

**Preview** shows exactly what will be written before anything is. Up to 30 days and 300
minutes it runs at once; beyond, it becomes an approval (Ops Manager, Finance or Super Admin;
never the requester). Every grant is recorded in `console_ai_pro_grants` with what it
created, so it can be **extended** or **ended** cleanly. Ending can also take back unused
granted minutes (never used ones). **Paid access is never shortened here**: that is a refund,
owned by Finance (phase 2).

**Minutes ±** on a class: add (approval above 60) or remove (never below what the learner
already used). A class that is live keeps its own timer; the change applies on the next start
or resume.

---

## 10. What Phase 1 contains

| Area | Built |
|---|---|
| API | 63 endpoints (`api/start/routes.ts`), each with a permission check; AdonisJS 6, Lucid, VineJS validation |
| Data | 10 new tables (`console_users`, `console_roles`, `console_role_permissions`, `console_user_roles`, `console_sessions`, `console_audit_logs` + `console_audit_head`, `console_approval_requests`, `console_settings`, `console_ai_pro_grants`); additive migrations only, tracked in `console_api_schema` |
| Web | 21 screens: sign-in + MFA, invite setup with QR and recovery codes, Overview, 4 Insights tabs, Live classes, Classes, Class detail, Minutes ledger, Learners, Learner (AI Pro, memory, export), Approvals, Staff, Staff member, Roles + matrix, Audit log, Security policy, System health, My account. Light and dark, phone to desktop |
| Commands | `console:bootstrap` (first Super Admin), `console:sync-roles`, and local-only `console:dev-schema`, `console:seed-demo [--remove]` |
| Tests | 20 unit (TOTP RFC 6238 vectors, masking, password policy, role invariants such as separation of duties) + 3 end-to-end HTTP flows (invite → MFA → grants → approvals → AI Pro → erase → disable → audit tamper detection; lockout without enumeration) + a browser tour of every page at desktop, phone width and dark mode |

How to run it locally: see [`../README.md`](../README.md).

---

## 11. Roadmap

Each phase ships on its own and switches the matching old pages off.

| Phase | Scope | Size |
|---|---|---|
| 0 | Monolith security fixes (§1) | days |
| 1 ✓ | Core (auth, MFA, RBAC, approvals, audit, security policy), AI Tutor, Learners, Insights, cost model, AI Pro | done (local) |
| 1.5 | Deploy behind nginx on `admin.multibhashi.com`, dedicated DB users + replica, email delivery for invites (SES), migrate staff accounts (§12); exact AI usage goes live with the agent + tutor API change (§8) | ~1–2 weeks |
| 2 | CRM & Leads, Bookings & Sales, Finance (refunds/payouts with approval), Teachers, Live Classes, Reports, Learners edit/block; data scopes; Insights revenue and funnel by source | ~6–8 weeks |
| 3 | Content & Curriculum (incl. AI tutor prompts/voices as versioned, approvable config the agent reads), B2B & Institutes, Marketing & Site, Trainer Portal | ~6 weeks |
| 4 | Retire the monolith admin; SSO (Google Workspace) for staff; anomaly alerts (free-class farming, refund spikes) | ~2 weeks |

---

## 12. Operating the console

- **Onboarding**: a manager asks; a Super Admin (or a Platform Admin for non-admin roles)
  invites with the narrowest role and a reason; the person finishes setup on their own device.
- **Offboarding**: disable the account the same day (all sessions end instantly). Never
  delete it: the audit log refers to it.
- **Lost phone / forgotten password**: another admin uses "Reset access" (new one-time link);
  the person re-enrols MFA.
- **Access review, quarterly**: each manager confirms their team's roles; remove what isn't
  used; Auditor accounts are time-boxed.
- **Approvals**: target a decision within one working day; requests expire after 48 h.
- **Break-glass**: if both Super Admins are unavailable, the CTO runs
  `node ace console:bootstrap` on the server only after removing the Super Admin role in the
  DB under a recorded incident. It refuses while an active Super Admin exists.
- **Audit**: the Privacy Officer runs "Verify integrity" monthly and after incidents.
- **Migrating accounts from the old admin**: for each person in `admins` with state 1, invite
  them to the console with the role mapped from their old slug (table in §4). Nobody is
  migrated into Super Admin. The old account is blocked once the matching module is live.

---

## 13. Decisions needed

1. **Phase 0**: who fixes the monolith findings, and when (findings 1–5 are urgent).
2. **The two Super Admins** (names).
3. ~~Exact AI cost~~: approved and working locally (§8); goes live when the tutor API migration reaches production.
4. **Approval thresholds**: keep the defaults (60 min; 30 days / 300 min AI Pro) or change them.
5. **Domain and network**: `admin.multibhashi.com`, and whether to require office/VPN IPs.
6. **Phase 2 order**: suggested CRM → Bookings/Finance → Teachers → Live Classes.
7. **Sarvam STT streams the whole class**, not just learner speech (SDK 1.4.7 keeps the room audio feed on): about ₹0.50 per class minute where ~₹0.18 would do. Fixing it is an agent change (raised by the observability session).
