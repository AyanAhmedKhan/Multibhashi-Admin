import type { Database } from '@adonisjs/lucid/database'
import { createHash } from 'node:crypto'
import { DEFAULT_COST_MODEL } from '#services/analytics/cost_model'
import { estimate, type AnswerFacts } from '#services/analytics/quiz_allocation'
import { markingPath, sentencesFrom } from '#services/analytics/quiz_analytics'

/**
 * LOCAL ONLY (console:seed-demo): Speaking/Writing answers across the three delivery tables
 * and all three marking paths, the app's quiz_* events for the last week (an app release
 * "shipped" then), evidence-cache rows, and a few days of provider rows so the Quizzes cost
 * section shows billed, usage-priced and estimated days side by side. Answer texts are
 * synthetic. Also the whole provider bill (several GCP projects with credits, two OpenAI
 * projects/keys) and a few of Finance's monthly bills. Everything is keyed to the demo
 * learners / quizzes / "demo" scopes and notes, and removed by --remove.
 */

export const DEMO_PROVIDER_SCOPE = 'demo-'
const DEMO_INVOICE_NOTE = 'demo (console:seed-demo)'
const SQ_BASE = 9_600_000
const STATUS_KEY = 'quiz_provider_sync'

const WORDS = 'i like to learn english every day because it helps me at work and with my friends we speak about food travel family music and books my name is ravi i work in a bank i live in bangalore with my parents'.split(' ')

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Opts {
  firstUser: number
  lastUser: number
  users: { id: number; createdAt: number; engagement: number }[]
  quizzes: { quizId: number; name: string }[]
  now: number
  days: number
}

export async function removeQuizDemo(db: Database, opts: Pick<Opts, 'firstUser' | 'lastUser' | 'quizzes'>) {
  const tables = [
    ['user_quiz_logs', 'user_quiz_log_details', 'user_quiz_log_id'],
    ['webinar_class_quiz_logs', 'webinar_class_quiz_log_details', 'webinar_class_quiz_log_id'],
    ['session_call_quiz_logs', 'session_call_quiz_log_details', 'session_call_quiz_log_id'],
  ] as const
  const exists = async (t: string) =>
    Number((await db.from('information_schema.tables').whereRaw('table_schema = DATABASE()').where('table_name', t).count('* as n'))[0]?.n ?? 0) > 0
  for (const [logs, details, fk] of tables) {
    if (!(await exists(logs)) || !(await exists(details))) continue
    const ids = (await db.from(logs).whereBetween('user_id', [opts.firstUser, opts.lastUser]).select('id')).map((r) => r.id)
    for (let i = 0; i < ids.length; i += 500) await db.from(details).whereIn(fk, ids.slice(i, i + 500)).delete()
    await db.from(logs).whereBetween('user_id', [opts.firstUser, opts.lastUser]).delete()
  }
  if (await exists('quiz_ai_evaluation_cache')) await db.from('quiz_ai_evaluation_cache').whereBetween('quiz_question_id', [SQ_BASE, SQ_BASE + 9999]).delete()
  if (await exists('quizzes')) await db.from('quizzes').whereIn('id', opts.quizzes.map((q) => q.quizId)).delete()
  await db.from('quiz_questions').whereBetween('id', [SQ_BASE, SQ_BASE + 9999]).delete()
  if (await exists('console_ai_provider_daily')) {
    await db
      .from('console_ai_provider_daily')
      .where((q) => q.where('scope', 'like', `${DEMO_PROVIDER_SCOPE}%`).orWhere('item', 'like', '%(demo)%'))
      .delete()
    await db.from('console_cost_invoices').where('note', DEMO_INVOICE_NOTE).delete()
    const status = await db.from('console_settings').where('key', STATUS_KEY).first()
    const value = status ? (typeof status.value === 'string' ? JSON.parse(status.value) : status.value) : null
    if (value && (value.openai?.demo || value.google?.demo)) await db.from('console_settings').where('key', STATUS_KEY).delete()
  }
}

export async function seedQuizDemo(db: Database, opts: Opts) {
  const random = rng(20261029)
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
  const pick = <T>(items: T[], weights?: number[]) => {
    if (!weights) return items[Math.floor(random() * items.length)]
    let r = random() * weights.reduce((a, b) => a + b, 0)
    for (let i = 0; i < items.length; i++) if ((r -= weights[i]) <= 0) return items[i]
    return items[items.length - 1]
  }
  const sentence = (words: number) => {
    const out: string[] = []
    for (let i = 0; i < words; i++) out.push(pick(WORDS))
    return out.join(' ')
  }
  const text = (words: number) => {
    const parts: string[] = []
    let left = words
    while (left > 0) {
      const n = Math.min(left, int(6, 14))
      parts.push(`${sentence(n)}.`)
      left -= n
    }
    return parts.join(' ').replace(/(^|\. )([a-z])/g, (_m, p, c) => p + c.toUpperCase())
  }
  const insert = async (table: string, rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += 500) await db.table(table).multiInsert(rows.slice(i, i + 500))
  }
  const day = 86_400_000
  const istMidnight = (ms: number) => ms - ((ms + 19_800_000) % day)
  const todayStart = istMidnight(opts.now)

  // --- quiz names and one Speaking + one Writing question per demo quiz
  await insert('quizzes', opts.quizzes.map((q) => ({ id: q.quizId, name: `${q.name} quiz`, created_at: new Date(), updated_at: new Date() })))
  const questions = opts.quizzes.map((q, i) => ({ quizId: q.quizId, sq: SQ_BASE + i * 2, wq: SQ_BASE + i * 2 + 1 }))
  await insert(
    'quiz_questions',
    questions.flatMap((q) => [
      { id: q.sq, quiz_id: q.quizId, type_code: 'SQ', sub_type_code: null, created_at: new Date(), updated_at: new Date() },
      { id: q.wq, quiz_id: q.quizId, type_code: 'WQ', sub_type_code: null, created_at: new Date(), updated_at: new Date() },
    ])
  )

  const events: Record<string, unknown>[] = []
  const cache: Record<string, unknown>[] = []
  const facts: AnswerFacts[] = []
  let answers = 0
  const takers = opts.users.filter((u) => random() < 0.25 + u.engagement * 0.5)
  for (const u of takers) {
    const attempts = int(1, 2 + Math.round(u.engagement * 6))
    for (let a = 0; a < attempts; a++) {
      const daysAgo = Math.floor(Math.pow(random(), 1.3) * opts.days)
      const start = Math.max(u.createdAt, todayStart - daysAgo * day + int(7, 22) * 3_600_000 + int(0, 3599) * 1000)
      if (start > opts.now - 10 * 60_000) continue
      const q = pick(questions)
      const context = pick(['course', 'webinar', 'session'] as const, [75, 15, 10])
      const [logTable, detailTable, fk, extra] =
        context === 'course'
          ? (['user_quiz_logs', 'user_quiz_log_details', 'user_quiz_log_id', { type: 'course_lesson' }] as const)
          : context === 'webinar'
            ? (['webinar_class_quiz_logs', 'webinar_class_quiz_log_details', 'webinar_class_quiz_log_id', { webinar_class_id: 7000 + int(1, 40) }] as const)
            : (['session_call_quiz_logs', 'session_call_quiz_log_details', 'session_call_quiz_log_id', { session_call_id: 8000 + int(1, 60) }] as const)
      const [logId] = await db.table(logTable).insert({
        user_id: u.id,
        quiz_id: q.quizId,
        ...extra,
        quiz_start_timestamp: start,
        quiz_end_timestamp: start + 8 * 60_000,
        total_questions: 2,
        is_quiz_finised: 1,
        attempt: 1,
        created_at: new Date(start),
        updated_at: new Date(start),
      })
      const rows: Record<string, unknown>[] = []
      let t = start + int(5, 40) * 1000
      for (const type of random() < 0.85 ? (['SQ', 'WQ'] as const) : (['SQ'] as const)) {
        const questionId = type === 'SQ' ? q.sq : q.wq
        const noSpeech = type === 'SQ' && random() < 0.04
        const words = noSpeech ? 0 : type === 'SQ' ? int(12, 110) : int(35, 190)
        const answerText = words ? text(words) : ''
        const taken = type === 'SQ' ? Math.min(60, Math.max(5, Math.round(words / 2.3 + int(3, 12)))) : int(60, 420)
        const qStart = t
        const qEnd = t + taken * 1000
        t = qEnd + int(10, 60) * 1000
        // LSRW marking only on the user_ table (the backend writes it only there), switched on ~30 days ago
        const lsrw = context === 'course'
        const scoringVersion = !lsrw || daysAgo > 30 ? null : daysAgo > 12 || random() < 0.15 ? 2 : 3
        const promptVersion = scoringVersion === 3 ? 'english-evidence-v4' : scoringVersion === 2 ? 'english-v1.4' : null
        const path = markingPath(scoringVersion, promptVersion)
        const failed = words > 0 && random() < (path === 'evidence' ? 0.045 : path === 'counted' ? 0.02 : 0.012)
        const retried = path === 'evidence' && !failed && random() < 0.12
        const reason = failed ? pick(['request_timeout', 'invalid_evidence', 'provider_error', 'evaluation_deadline'], [4, 3, 2, 1]) : null
        const quality = Math.pow(random(), 0.6)
        const relevance = failed || !words ? null : Math.round(Math.min(10, Math.max(0, quality * 10 + (random() - 0.5) * 3)) * 10) / 10
        const grammar = failed || !words ? null : Math.round(Math.min(10, Math.max(0, quality * 8.5 + random() * 2)) * 10) / 10
        const evidence = path === 'evidence'
        const evaluationJson = !lsrw || path === 'legacy' ? null : failed ? { reason, diagnostics: [{ stage: 'assessment_1', reason }] } : evidence ? { evidence_review: { diagnostics: retried ? [{ stage: 'assessment_1', reason: 'invalid_evidence' }, { stage: 'review_2', reason: 'invalid_review' }] : [] }, verification: { validated: true } } : { grammar: {}, relevance: {} }
        rows.push({
          [fk]: logId,
          quiz_question_id: questionId,
          question_start_timestamp: qStart,
          question_end_timestamp: qEnd,
          is_correct: relevance !== null && grammar !== null && relevance >= 5 && grammar >= 2.5 ? 1 : 0,
          relevance_score: relevance,
          grammar_score: grammar,
          answer: answerText || null,
          finished_on_time: random() < 0.92 ? 1 : 0,
          time_taken: taken,
          pronunciation_score: type === 'SQ' && words ? Math.round((3 + random() * 6.5) * 10) / 10 : 0,
          audio_quality_score: type === 'SQ' && words ? Math.round((5 + random() * 5) * 10) / 10 : 0,
          ...(lsrw
            ? {
                scoring_version: scoringVersion,
                prompt_version: promptVersion,
                model_name: scoringVersion ? 'gpt-4o-mini-2024-07-18' : null,
                evaluation_status: scoringVersion ? (failed ? 'failed' : 'ok') : null,
                final_percentage: scoringVersion && !failed && relevance !== null && grammar !== null ? Math.round(((relevance + grammar) / 2) * 1000) / 100 : null,
                evaluation_json: evaluationJson ? JSON.stringify(evaluationJson) : null,
              }
            : {}),
          created_at: new Date(qEnd),
          updated_at: new Date(qEnd),
        })
        if (evidence && !failed) {
          cache.push({
            context_hash: createHash('sha256').update(`${logId}:${questionId}:${detailTable}`).digest('hex'),
            quiz_question_id: questionId,
            evaluation_json: JSON.stringify({ evidence_review: { diagnostics: retried ? [{ stage: 'assessment_1' }] : [] } }),
            created_at: new Date(qEnd),
            updated_at: new Date(qEnd),
          })
        }

        // --- app events: only from the release a week ago
        const recordedSeconds = type === 'SQ' && words ? Math.min(58, Math.round((words / 2.3) * (0.85 + random() * 0.4) * 100) / 100) : null
        // A failed upload ends that answer's events early (return), never the answer itself.
        if (daysAgo <= 6) (() => {
          const attribution =
            context === 'course'
              ? { context_type: 'course_lesson', user_quiz_log_id: logId }
              : context === 'webinar'
                ? { context_type: 'WEBINAR', webinar_class_id: (extra as { webinar_class_id: number }).webinar_class_id }
                : { context_type: 'SESSION', session_call_id: (extra as { session_call_id: number }).session_call_id }
          const ev = (event_type: string, at: number, metadata: Record<string, unknown> = {}, duration_sec: number | null = null) =>
            events.push({
              user_id: u.id,
              event_type,
              resource_type: 'quiz_question',
              resource_id: String(questionId),
              duration_sec,
              ...attribution,
              metadata: JSON.stringify({ quiz_id: q.quizId, question_id: questionId, question_type: type, ...metadata }),
              created_at_ms: at,
              created_at: new Date(at),
              updated_at: new Date(at),
            })
          ev('quiz_question_shown', qStart)
          const timedOut = random() < 0.05
          let submittedAt = qEnd
          if (type === 'SQ') {
            if (random() < 0.035) ev('quiz_record_failed', qStart + 2000, { error: pick(['NotAllowedError', 'NotReadableError', 'NotFoundError', 'other'], [5, 2, 1, 1]) })
            if (random() < 0.15 && recordedSeconds) {
              ev('quiz_record_started', qStart + 3000)
              const first = Math.round(recordedSeconds * 0.5 * 100) / 100
              ev('quiz_record_stopped', qStart + 3000 + first * 1000, { seconds: first, reason: 'user' }, Math.round(first))
              ev('quiz_record_deleted', qStart + 5000 + first * 1000, { seconds: first }, Math.round(first))
            }
            ev('quiz_record_started', qEnd - (recordedSeconds ?? 3) * 1000 - 1500)
            const stopReason = timedOut ? 'timeout' : recordedSeconds && recordedSeconds >= 58 ? 'cap' : pick(['user', 'blur'], [30, 1])
            ev('quiz_record_stopped', qEnd - 1000, { seconds: recordedSeconds ?? 0.6, reason: stopReason }, Math.round(recordedSeconds ?? 1))
            ev('quiz_answer_submitted', qEnd, { timed_out: timedOut, seconds: recordedSeconds ?? 0.6 })
            const sttMs = int(900, 4200)
            const sttFailed = random() < 0.012
            ev('quiz_stt_result', qEnd + sttMs, { ms: sttMs, outcome: sttFailed ? 'failed' : words ? 'ok' : 'no_speech', ...(sttFailed ? { http_status: 500 } : {}) })
            submittedAt = qEnd + sttMs
            if (sttFailed) {
              ev('quiz_submit_failed', submittedAt + 50, { stage: 'stt', error: 'Request failed with status code 500' })
              return
            }
          } else {
            if (random() < 0.04) ev('quiz_paste_blocked', qStart + int(10, 60) * 1000)
            ev('quiz_answer_submitted', qEnd, { timed_out: timedOut, words, chars: answerText.length })
          }
          if (timedOut) ev('quiz_question_timeout', qEnd - 200, { had_answer: words > 0 })
          if (words) {
            const evalMs = path === 'evidence' ? int(9000, 32000) * (retried ? 1.6 : 1) : int(1800, 5200)
            ev('quiz_eval_result', submittedAt + evalMs, { ms: Math.round(evalMs), outcome: failed ? 'failed' : 'ok', ...(failed ? { http_status: 200 } : {}) })
            if (failed && random() < 0.5) ev('quiz_submit_failed', submittedAt + evalMs + 20, { stage: 'eval', error: 'This answer could not be assessed' })
            ev('quiz_feedback_shown', submittedAt + evalMs + 300, { ms: Math.round(submittedAt + evalMs + 300 - qEnd) })
          }
        })()

        facts.push({
          key: `${context}:${logId}:${questionId}`,
          type,
          day: new Date(qEnd + 19_800_000).toISOString().slice(0, 10),
          path,
          words,
          sentences: sentencesFrom(words, (answerText.match(/[.?!]/g) ?? []).length),
          attempts: retried ? 2 : 1,
          recordedSeconds: daysAgo <= 6 ? recordedSeconds : null,
        })
        answers++
      }
      await insert(detailTable, rows)
    }
  }
  await insert('student_activity_events', events)
  await insert('quiz_ai_evaluation_cache', cache)

  // --- the whole provider bill, as the sync would store it. OpenAI: the quiz project/key
  // (gpt-4o-mini, near what the answers should cost) and a small study-material project
  // (gpt-3.5-turbo) for 30 days, one day usage-only (as if the Costs API had failed). GCP:
  // the export "enabled" 12 days ago — the app project (speech-to-text, storage and Firebase
  // with credits), a web project (Compute with a sustained-use discount, Cloud SQL, egress) and
  // an account-level tax line. No rows for the tutor's Gemini project: billing is off there.
  const model = DEFAULT_COST_MODEL
  const rates = {
    speechPerSecondInr: (0.016 / 60) * model.usdToInr,
    inputPerTokenInr: (0.15 / 1e6) * model.usdToInr,
    outputPerTokenInr: (0.6 / 1e6) * model.usdToInr,
  }
  const label = (offset: number) => new Date(todayStart - offset * day + 19_800_000).toISOString().slice(0, 10)
  const syncedAt = new Date(opts.now - 30 * 60_000)
  const provider: Record<string, unknown>[] = []
  const GCP_DAYS = 12
  const OPENAI_DAYS = 30
  for (let offset = 1; offset <= OPENAI_DAYS; offset++) {
    const d = label(offset)
    const onDay = facts.filter((f) => f.day === d)
    const est = onDay.map((f) => estimate(f, rates))
    const seconds = est.reduce((s, e) => s + e.speechSeconds, 0)
    const input = est.reduce((s, e) => s + e.tokens.input, 0)
    const output = est.reduce((s, e) => s + e.tokens.output, 0)
    const calls = est.reduce((s, e) => s + e.tokens.calls, 0)
    const drift = 0.92 + random() * 0.2
    const cached = Math.round(input * 0.18)
    const row = (p: string, scope: string, item: string, unit: string, quantity: number, costUsd: number, source: string, creditsUsd = 0) =>
      provider.push({
        day: d,
        provider: p,
        scope,
        item,
        unit,
        quantity: Math.round(quantity * 10_000) / 10_000,
        cost_usd: Math.round(costUsd * 1e6) / 1e6,
        credits_usd: Math.round(creditsUsd * 1e6) / 1e6,
        source,
        synced_at: syncedAt,
      })
    if (offset <= GCP_DAYS) {
      const app = 'demo-multibhashi-android-app'
      const web = 'demo-multibhashi-web'
      const billedSeconds = Math.round(seconds * drift)
      row('google', app, 'Speech service (demo) / Recognition', 'seconds', billedSeconds, (billedSeconds / 60) * 0.016, 'gcp_billing_export')
      row('google', app, 'Storage service (demo) / Standard Storage Mumbai', 'byte-seconds', 2.6e14, 0.21, 'gcp_billing_export', -0.05)
      row('google', app, 'Firebase service (demo) / Cloud Functions invocations', 'requests', 41_000 + int(0, 8000), 0.016, 'gcp_billing_export', -0.016)
      const core = 0.9 + random() * 0.15
      row('google', web, 'Compute service (demo) / N2 Instance Core running in Mumbai', 'seconds', 172_800, core, 'gcp_billing_export', -core * 0.2)
      row('google', web, 'Compute service (demo) / N2 Instance Ram running in Mumbai', 'byte-seconds', 7.4e14, core * 0.45, 'gcp_billing_export', -core * 0.09)
      row('google', web, 'Cloud SQL service (demo) / Cloud SQL for MySQL: Zonal - vCPU in Mumbai', 'seconds', 86_400, 1.12, 'gcp_billing_export')
      row('google', web, 'Networking service (demo) / Network Internet Data Transfer Out from Mumbai', 'bytes', 3.1e10 + int(0, 5e9), 0.28 + random() * 0.08, 'gcp_billing_export')
      row('google', 'no-project', 'Invoice (demo) / Tax', 'none', 0, 0.42 + random() * 0.05, 'gcp_billing_export')
    }
    const quizKey = 'demo-proj_quiz/demo-key_quiz'
    const smKey = 'demo-proj_studymaterial/demo-key_sm'
    const inputTokens = Math.round((input - cached) * drift)
    const outputTokens = Math.round(output * drift)
    const smIn = int(20_000, 60_000)
    const smOut = int(4000, 9000)
    row('openai', quizKey, 'gpt-4o-mini-2024-07-18', 'input_tokens', inputTokens, 0, 'openai_usage_api')
    row('openai', quizKey, 'gpt-4o-mini-2024-07-18', 'cached_input_tokens', cached, 0, 'openai_usage_api')
    row('openai', quizKey, 'gpt-4o-mini-2024-07-18', 'output_tokens', outputTokens, 0, 'openai_usage_api')
    row('openai', quizKey, 'gpt-4o-mini-2024-07-18', 'requests', Math.round(calls * drift), 0, 'openai_usage_api')
    row('openai', smKey, 'gpt-3.5-turbo-0125', 'input_tokens', smIn, 0, 'openai_usage_api')
    row('openai', smKey, 'gpt-3.5-turbo-0125', 'output_tokens', smOut, 0, 'openai_usage_api')
    row('openai', smKey, 'gpt-3.5-turbo-0125', 'requests', int(20, 60), 0, 'openai_usage_api')
    if (offset !== 5) {
      row('openai', quizKey, 'gpt-4o-mini-2024-07-18, input', 'tokens', inputTokens, (inputTokens * 0.15) / 1e6, 'openai_costs_api')
      row('openai', quizKey, 'gpt-4o-mini-2024-07-18, cached input', 'tokens', cached, (cached * 0.075) / 1e6, 'openai_costs_api')
      row('openai', quizKey, 'gpt-4o-mini-2024-07-18, output', 'tokens', outputTokens, (outputTokens * 0.6) / 1e6, 'openai_costs_api')
      row('openai', smKey, 'gpt-3.5-turbo-0125, input', 'tokens', smIn, (smIn * 0.5) / 1e6, 'openai_costs_api')
      row('openai', smKey, 'gpt-3.5-turbo-0125, output', 'tokens', smOut, (smOut * 1.5) / 1e6, 'openai_costs_api')
    }
  }
  await insert('console_ai_provider_daily', provider)
  const run = (dataThrough: string, rows: number, days: number, extra = {}) => ({ at: syncedAt.toISOString(), ok: true, error: null, rows, days, dataThrough, demo: true, ...extra })
  await db
    .insertQuery()
    .table('console_settings')
    .insert({
      key: STATUS_KEY,
      value: JSON.stringify({
        openai: run(syncedAt.toISOString(), provider.filter((p) => p.provider === 'openai').length, OPENAI_DAYS, { costsByKey: true }),
        // The export is complete through the end of yesterday (IST), plus a little of today
        google: run(new Date(todayStart + 40 * 60_000).toISOString(), provider.filter((p) => p.provider === 'google').length, GCP_DAYS),
      }),
      updated_by: null,
      updated_at: new Date(),
    })
    .knexQuery.onConflict('key')
    .merge()

  // --- Finance's monthly bills for providers without a billing API (only where none was entered)
  const thisMonth = new Date(opts.now + 19_800_000).toISOString().slice(0, 7)
  const lastMonth = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7)
  for (const [month, name, amount] of [
    [lastMonth, 'sarvam', 3150],
    [lastMonth, 'livekit', 420],
    [thisMonth, 'sarvam', 2890],
  ] as const) {
    const existing = await db.from('console_cost_invoices').where('month', month).where('provider', name).first()
    if (!existing) {
      await db.table('console_cost_invoices').insert({ month, provider: name, amount_inr: amount, note: DEMO_INVOICE_NOTE, entered_by: 0, created_at: new Date(), updated_at: new Date() })
    }
  }

  return { answers, events: events.length, providerRows: provider.length }
}
