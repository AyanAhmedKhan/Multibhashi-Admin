import db from '@adonisjs/lucid/services/db'
import { istDayLabel, istDayOf, istDayStart } from '#helpers/ist'

/**
 * Quizzes, read-only from what the quiz backend (teachers-dashboard, unchanged) and the app
 * already record (docs/QUIZ_OBSERVABILITY.md §1–2):
 * - every Speaking (SQ) and Writing (WQ) answer in the three detail tables
 *   (user_ / webinar_class_ / session_call_quiz_log_details) joined to its parent log and
 *   quiz_questions. The answer text is NEVER selected: word, sentence-mark and character
 *   counts are computed inside MySQL and only the numbers leave the database;
 * - the LSRW columns (scoring_version, prompt_version, model_name, evaluation_status,
 *   evaluation_json) where the environment has them — detected in information_schema, so a
 *   database without them degrades to "legacy" marking instead of failing. Only the
 *   diagnostics' stage names and a failure's reason code are read out of evaluation_json;
 * - quiz_ai_evaluation_cache (evidence marking), when the table exists;
 * - the app's quiz_* events in student_activity_events (learner experience).
 * Queries run on the `analytics` connection and are cached briefly.
 */

const CACHE_MS = 120_000
const SCHEMA_MS = 60_000
const conn = () => db.connection('analytics')
const n = (v: unknown) => Number(v ?? 0)

export type AnswerType = 'SQ' | 'WQ'
export type MarkingPath = 'legacy' | 'counted' | 'evidence'
export type Context = 'course' | 'webinar' | 'session'

export const DETAIL_TABLES: { context: Context; details: string; logs: string; fk: string; label: string }[] = [
  { context: 'course', details: 'user_quiz_log_details', logs: 'user_quiz_logs', fk: 'user_quiz_log_id', label: 'Courses, assignments, study material' },
  { context: 'webinar', details: 'webinar_class_quiz_log_details', logs: 'webinar_class_quiz_logs', fk: 'webinar_class_quiz_log_id', label: 'Live classes' },
  { context: 'session', details: 'session_call_quiz_log_details', logs: 'session_call_quiz_logs', fk: 'session_call_quiz_log_id', label: '1:1 sessions' },
]

/** Event types the app sends (spec §2), plus the older quiz_start / quiz_end. */
export const QUIZ_EVENTS = [
  'quiz_question_shown',
  'quiz_record_started',
  'quiz_record_failed',
  'quiz_record_stopped',
  'quiz_record_deleted',
  'quiz_answer_submitted',
  'quiz_stt_result',
  'quiz_eval_result',
  'quiz_submit_failed',
  'quiz_feedback_shown',
  'quiz_question_timeout',
  'quiz_paste_blocked',
] as const

/** One SQ/WQ answer, as numbers only (no learner text). */
export interface AnswerRow {
  key: string
  context: Context
  id: number
  logId: number
  userId: number
  quizId: number
  questionId: number
  type: AnswerType
  /** IST day the answer was submitted (question end time, else the row's created_at). */
  day: string
  startMs: number | null
  endMs: number | null
  words: number
  sentences: number
  chars: number
  relevance: number | null
  grammar: number | null
  pronunciation: number | null
  finalPercentage: number | null
  isCorrect: boolean | null
  onTime: boolean | null
  timeTaken: number | null
  path: MarkingPath
  scoringVersion: number | null
  promptVersion: string | null
  model: string | null
  evaluationStatus: string | null
  /** Evidence marking: how many full attempts (grammar, review, content) ran. */
  attempts: number
  /** A failed marking's reason code (e.g. request_timeout), never learner text. */
  failReason: string | null
  /** Marking failed: evaluation_status = failed, or no score came back for a non-empty answer. */
  failed: boolean
}

export interface QuizSchema {
  tables: Set<string>
  columns: Map<string, Set<string>>
  has: (table: string, column?: string) => boolean
}

/** The marking path an answer took (spec §4). */
export function markingPath(scoringVersion: number | null, promptVersion: string | null): MarkingPath {
  if ((promptVersion ?? '').startsWith('english-evidence') || scoringVersion === 3) return 'evidence'
  if (scoringVersion === 2) return 'counted'
  return 'legacy'
}

/** Evidence marking attempts from the diagnostics' stage names (assessment_2 → 2 attempts). */
export function attemptsFrom(stages: string[]) {
  let attempts = 1
  for (const stage of stages) {
    const m = /_(\d+)$/.exec(stage)
    if (m) attempts = Math.max(attempts, Number(m[1]))
  }
  return Math.min(attempts, 5)
}

/** Sentences from the counted marks: unpunctuated transcripts fall back to ~15 words a sentence. */
export function sentencesFrom(words: number, marks: number) {
  if (words <= 0) return 0
  const counted = Math.max(1, Math.min(words, marks))
  return counted <= 1 && words > 25 ? Math.ceil(words / 15) : counted
}

const stagesOf = (raw: unknown): string[] => {
  if (raw === null || raw === undefined) return []
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 32)) : []
}

/** A reason code, or "other" for anything that doesn't look like one. */
const reasonCode = (raw: unknown) => {
  if (raw === null || raw === undefined || raw === 'null') return null
  const s = String(raw)
  return /^[a-z][a-z0-9_]{0,47}$/.test(s) ? s : 'other'
}

const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const boolOrNull = (v: unknown) => (v === null || v === undefined ? null : v === true || v === 1 || v === '1' || v === 'true')

/** SQL: the answer collapsed to single spaces (inside MySQL; the text never leaves it). */
const normalized = (col: string) =>
  `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), CHAR(13 USING utf8mb4), ' '), CHAR(10 USING utf8mb4), ' '), CHAR(9 USING utf8mb4), ' '), '    ', ' '), '  ', ' '), '  ', ' '))`
export const wordsSql = (col: string) => {
  const t = normalized(col)
  return `CASE WHEN CHAR_LENGTH(${t}) = 0 THEN 0 ELSE CHAR_LENGTH(${t}) - CHAR_LENGTH(REPLACE(${t}, ' ', '')) + 1 END`
}
export const marksSql = (col: string) => {
  const t = normalized(col)
  // CHAR(63) is "?": a literal question mark would read as a query binding.
  return `CHAR_LENGTH(${t}) - CHAR_LENGTH(REPLACE(REPLACE(REPLACE(${t}, '.', ''), CHAR(63 USING utf8mb4), ''), '!', ''))`
}
const json = (col: string, path: string) => `CASE WHEN JSON_VALID(${col}) THEN JSON_EXTRACT(${col}, '${path}') END`
const jsonText = (col: string, path: string) => `CASE WHEN JSON_VALID(${col}) THEN JSON_UNQUOTE(JSON_EXTRACT(${col}, '${path}')) END`

export function summary(values: number[]) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const pick = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null)
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : null,
    median: pick(50),
    p95: pick(95),
  }
}

/** Ten buckets over 0–10 (a 10 lands in the last). */
function histogram(values: (number | null)[], max = 10) {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ from: (i * max) / 10, to: ((i + 1) * max) / 10, answers: 0 }))
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue
    const i = Math.min(9, Math.max(0, Math.floor((v / max) * 10)))
    buckets[i].answers++
  }
  return buckets
}

export interface QuizEvent {
  type: string
  userId: number
  logId: number | null
  questionId: number | null
  at: number
  durationSec: number | null
  error: string | null
  reason: string | null
  outcome: string | null
  stage: string | null
  ms: number | null
  seconds: number | null
  timedOut: boolean | null
  hadAnswer: boolean | null
  questionType: string | null
}

class QuizAnalytics {
  #cache = new Map<string, { at: number; value: unknown }>()
  #schema: { at: number; value: QuizSchema } | null = null

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
    const value = await fn()
    this.#cache.set(key, { at: Date.now(), value })
    if (this.#cache.size > 50) this.#cache.delete(this.#cache.keys().next().value!)
    return value
  }

  clearCache() {
    this.#cache.clear()
    this.#schema = null
  }

  /** Which quiz tables and optional columns this database has. */
  async schema(): Promise<QuizSchema> {
    if (this.#schema && Date.now() - this.#schema.at < SCHEMA_MS) return this.#schema.value
    const names = [
      ...DETAIL_TABLES.flatMap((t) => [t.details, t.logs]),
      'quiz_questions',
      'quizzes',
      'quiz_ai_evaluation_cache',
      'student_activity_events',
      'course_lessons',
    ]
    const rows = await conn()
      .from('information_schema.columns')
      .whereRaw('table_schema = DATABASE()')
      .whereIn('table_name', names)
      .select('table_name as t', 'column_name as c')
    const columns = new Map<string, Set<string>>()
    for (const r of rows as { t: string; c: string }[]) {
      const t = String(r.t)
      if (!columns.has(t)) columns.set(t, new Set())
      columns.get(t)!.add(String(r.c).toLowerCase())
    }
    const tables = new Set(columns.keys())
    const value: QuizSchema = { tables, columns, has: (t, c) => (c ? !!columns.get(t)?.has(c) : tables.has(t)) }
    this.#schema = { at: Date.now(), value }
    return value
  }

  /** Every SQ/WQ answer since `sinceMs` (numbers only), across the three delivery tables. */
  answers(days: number): Promise<{ rows: AnswerRow[]; sources: { context: Context; label: string; present: boolean; lsrw: boolean }[] }> {
    return this.cached(`answers:${days}`, async () => {
      const schema = await this.schema()
      const since = new Date(istDayStart(istDayOf(Date.now()) - days + 1))
      const out: AnswerRow[] = []
      const sources = []
      for (const t of DETAIL_TABLES) {
        const present = schema.has(t.details) && schema.has(t.logs) && schema.has('quiz_questions') && schema.has(t.details, t.fk) && schema.has(t.details, 'answer')
        const has = (c: string) => schema.has(t.details, c)
        const lsrw = present && has('scoring_version')
        sources.push({ context: t.context, label: t.label, present, lsrw })
        if (!present) continue
        const opt = (c: string, alias = c) => (has(c) ? `d.${c} AS ${alias}` : `NULL AS ${alias}`)
        const select = [
          'd.id AS id',
          `d.${t.fk} AS log_id`,
          'l.user_id AS user_id',
          'l.quiz_id AS quiz_id',
          'd.quiz_question_id AS question_id',
          'q.type_code AS type_code',
          opt('question_start_timestamp', 'start_ms'),
          opt('question_end_timestamp', 'end_ms'),
          `DATE_FORMAT(d.created_at, '%Y-%m-%d') AS created_day`,
          `${wordsSql('d.answer')} AS words`,
          `${marksSql('d.answer')} AS marks`,
          `CHAR_LENGTH(TRIM(COALESCE(d.answer, ''))) AS chars`,
          opt('relevance_score'),
          opt('grammar_score'),
          opt('pronunciation_score'),
          opt('final_percentage'),
          opt('is_correct'),
          opt('finished_on_time'),
          opt('time_taken'),
          opt('scoring_version'),
          opt('prompt_version'),
          opt('model_name'),
          opt('evaluation_status'),
          has('evaluation_json') ? `${json('d.evaluation_json', '$.evidence_review.diagnostics[*].stage')} AS review_stages` : 'NULL AS review_stages',
          has('evaluation_json') ? `${json('d.evaluation_json', '$.diagnostics[*].stage')} AS fail_stages` : 'NULL AS fail_stages',
          has('evaluation_json') ? `${jsonText('d.evaluation_json', '$.reason')} AS fail_reason` : 'NULL AS fail_reason',
        ]
        const firstId = await this.firstIdSince(t.details, since)
        if (firstId === null) continue
        const rows = await conn().rawQuery(
          `SELECT ${select.join(', ')}
           FROM ${t.details} d
           JOIN ${t.logs} l ON l.id = d.${t.fk}
           JOIN quiz_questions q ON q.id = d.quiz_question_id
           WHERE d.id >= ? AND q.type_code IN ('SQ', 'WQ') AND d.created_at >= ?`,
          [firstId, since]
        )
        for (const r of rows[0] as Record<string, unknown>[]) {
          const endMs = numOrNull(r.end_ms)
          const startMs = numOrNull(r.start_ms)
          const validEnd = endMs !== null && endMs > 1e12 ? endMs : null
          const words = n(r.words)
          const scoringVersion = numOrNull(r.scoring_version)
          const promptVersion = (r.prompt_version as string) ?? null
          const path = markingPath(scoringVersion, promptVersion)
          const stages = [...stagesOf(r.review_stages), ...stagesOf(r.fail_stages)]
          const status = (r.evaluation_status as string) ?? null
          const relevance = numOrNull(r.relevance_score)
          const grammar = numOrNull(r.grammar_score)
          out.push({
            key: `${t.context}:${n(r.id)}`,
            context: t.context,
            id: n(r.id),
            logId: n(r.log_id),
            userId: n(r.user_id),
            quizId: n(r.quiz_id),
            questionId: n(r.question_id),
            type: r.type_code === 'SQ' ? 'SQ' : 'WQ',
            day: validEnd ? istDayLabel(istDayOf(validEnd)) : String(r.created_day),
            startMs: startMs !== null && startMs > 1e12 ? startMs : null,
            endMs: validEnd,
            words,
            sentences: sentencesFrom(words, n(r.marks)),
            chars: n(r.chars),
            relevance,
            grammar,
            pronunciation: numOrNull(r.pronunciation_score),
            finalPercentage: numOrNull(r.final_percentage),
            isCorrect: boolOrNull(r.is_correct),
            onTime: boolOrNull(r.finished_on_time),
            timeTaken: numOrNull(r.time_taken),
            path,
            scoringVersion,
            promptVersion,
            model: (r.model_name as string) ?? null,
            evaluationStatus: status,
            attempts: path === 'evidence' ? attemptsFrom(stages) : 1,
            failReason: status === 'failed' ? (reasonCode(r.fail_reason) ?? 'unknown') : null,
            failed: status === 'failed' || (words > 0 && relevance === null && grammar === null),
          })
        }
      }
      return { rows: out, sources }
    })
  }

  /** The app's quiz events since the window start (numbers and codes from metadata only). */
  events(days: number): Promise<{ available: boolean; firstSeenAt: number | null; rows: QuizEvent[]; counts: { type: string; day: string; events: number }[] }> {
    return this.cached(`events:${days}`, async () => {
      const schema = await this.schema()
      if (!schema.has('student_activity_events')) return { available: false, firstSeenAt: null, rows: [], counts: [] }
      const sinceMs = istDayStart(istDayOf(Date.now()) - days + 1)
      const has = (c: string) => schema.has('student_activity_events', c)
      const meta = has('metadata')
      const m = (path: string, alias: string) => (meta ? `${jsonText('metadata', `$.${path}`)} AS ${alias}` : `NULL AS ${alias}`)
      const first = await conn().from('student_activity_events').whereIn('event_type', [...QUIZ_EVENTS]).min('created_at_ms as first').first()
      const counts = await conn()
        .from('student_activity_events')
        .whereIn('event_type', [...QUIZ_EVENTS])
        .where('created_at_ms', '>=', sinceMs)
        .groupByRaw('event_type, FLOOR((created_at_ms + 19800000) / 86400000)')
        .select('event_type', conn().raw('FLOOR((created_at_ms + 19800000) / 86400000) AS d'))
        .count('* as events')
      const detailed = QUIZ_EVENTS.filter((e) => !['quiz_question_shown', 'quiz_paste_blocked'].includes(e))
      const rows = await conn().rawQuery(
        `SELECT event_type, user_id, ${has('user_quiz_log_id') ? 'user_quiz_log_id' : 'NULL'} AS log_id, resource_id, created_at_ms, duration_sec,
           ${m('error', 'm_error')}, ${m('reason', 'm_reason')}, ${m('outcome', 'm_outcome')}, ${m('stage', 'm_stage')},
           ${m('ms', 'm_ms')}, ${m('seconds', 'm_seconds')}, ${m('timed_out', 'm_timed_out')}, ${m('had_answer', 'm_had_answer')},
           ${m('question_id', 'm_question_id')}, ${m('question_type', 'm_question_type')}
         FROM student_activity_events
         WHERE event_type IN (${detailed.map(() => '?').join(', ')}) AND created_at_ms >= ?`,
        [...detailed, sinceMs]
      )
      const text = (v: unknown, max = 60) => (v === null || v === undefined || v === 'null' ? null : String(v).slice(0, max))
      return {
        available: true,
        firstSeenAt: first?.first ? n(first.first) : null,
        counts: (counts as Record<string, unknown>[]).map((c) => ({ type: String(c.event_type), day: istDayLabel(n(c.d)), events: n(c.events) })),
        rows: (rows[0] as Record<string, unknown>[]).map((r) => ({
          type: String(r.event_type),
          userId: n(r.user_id),
          logId: numOrNull(r.log_id),
          questionId: numOrNull(r.m_question_id) ?? numOrNull(r.resource_id),
          at: n(r.created_at_ms),
          durationSec: numOrNull(r.duration_sec),
          error: text(r.m_error),
          reason: text(r.m_reason, 24),
          outcome: text(r.m_outcome, 24),
          stage: text(r.m_stage, 24),
          ms: numOrNull(r.m_ms),
          seconds: numOrNull(r.m_seconds),
          timedOut: r.m_timed_out === null || r.m_timed_out === undefined ? null : boolOrNull(r.m_timed_out),
          hadAnswer: r.m_had_answer === null || r.m_had_answer === undefined ? null : boolOrNull(r.m_had_answer),
          questionType: text(r.m_question_type, 8),
        })),
      }
    })
  }

  /** Evidence assessments accepted per day and how many needed a retry (cache table, optional). */
  /**
   * Smallest id created on or after `since`. The answer tables have no index on
   * created_at (production: 626k rows / 1.2 GB), so a created_at filter alone scans the
   * whole table on the live database. Ids grow with time, so a binary search on the
   * primary key finds the window's start in ~20 index lookups. A day of margin covers
   * rows written slightly out of order; the query still filters on created_at.
   */
  private async firstIdSince(table: string, since: Date): Promise<number | null> {
    const from = new Date(since.getTime() - 86_400_000)
    const bounds = await conn().from(table).min('id as lo').max('id as hi').first()
    let lo = n(bounds?.lo)
    let hi = n(bounds?.hi)
    if (!hi) return null
    const firstFrom = (id: number) => conn().from(table).where('id', '>=', id).orderBy('id', 'asc').select('id', 'created_at').first()
    const newest = await firstFrom(hi)
    if (!newest?.created_at || new Date(newest.created_at) < from) return null
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const row = await firstFrom(mid)
      if (row?.created_at && new Date(row.created_at) >= from) hi = mid
      else lo = Math.min(n(row?.id ?? mid) + 1, hi)
    }
    return lo
  }

  async evaluationCache(days: number) {
    const schema = await this.schema()
    if (!schema.has('quiz_ai_evaluation_cache') || !schema.has('quiz_ai_evaluation_cache', 'evaluation_json')) return null
    // Production: 1.2 GB with no created_at index and no numeric id, so a date filter
    // would scan every evaluation blob. Skip it unless created_at is indexed.
    const indexed = await conn().rawQuery(
      `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quiz_ai_evaluation_cache' AND COLUMN_NAME = 'created_at' AND SEQ_IN_INDEX = 1 LIMIT 1`
    )
    if (!(indexed[0] as unknown[]).length) return null
    const since = new Date(istDayStart(istDayOf(Date.now()) - days + 1))
    const retried = `CASE WHEN JSON_VALID(evaluation_json) AND JSON_LENGTH(JSON_EXTRACT(evaluation_json, '$.evidence_review.diagnostics')) > 0 THEN 1 ELSE 0 END`
    const rows = await conn()
      .from('quiz_ai_evaluation_cache')
      .where('created_at', '>=', since)
      .select(conn().raw('COUNT(*) AS assessments'), conn().raw(`SUM(${retried}) AS retried`))
      .first()
    return { assessments: n(rows?.assessments), retried: n(rows?.retried) }
  }

  /** Quiz names (quizzes.name; lesson names as a fallback). */
  async quizNames(ids: number[]) {
    const names = new Map<number, string>()
    if (!ids.length) return names
    const schema = await this.schema()
    if (schema.has('quizzes', 'name')) {
      for (const r of await conn().from('quizzes').whereIn('id', ids).select('id', 'name')) if (r.name) names.set(n(r.id), String(r.name))
    }
    const missing = ids.filter((id) => !names.has(id))
    if (missing.length && schema.has('course_lessons', 'quiz_id')) {
      for (const r of await conn().from('course_lessons').whereIn('quiz_id', missing).select('quiz_id', 'name')) {
        if (r.name && !names.has(n(r.quiz_id))) names.set(n(r.quiz_id), String(r.name))
      }
    }
    return names
  }

  /**
   * The recorded length of each Speaking answer, from the app's quiz_record_stopped events:
   * the last recording stopped for that question by that learner (same attempt when the event
   * carries user_quiz_log_id) before the answer was submitted.
   */
  recordedSeconds(answers: AnswerRow[], events: QuizEvent[]) {
    const stops = new Map<string, QuizEvent[]>()
    for (const e of events) {
      if (e.type !== 'quiz_record_stopped' || e.questionId === null) continue
      const secs = e.seconds ?? e.durationSec
      if (secs === null || !(secs > 0)) continue
      const key = `${e.userId}|${e.questionId}`
      if (!stops.has(key)) stops.set(key, [])
      stops.get(key)!.push(e)
    }
    for (const list of stops.values()) list.sort((a, b) => a.at - b.at)
    const out = new Map<string, number>()
    for (const a of answers) {
      if (a.type !== 'SQ') continue
      const list = stops.get(`${a.userId}|${a.questionId}`)
      if (!list) continue
      const sameLog = a.context === 'course' ? list.filter((e) => e.logId === a.logId) : []
      const candidates = sameLog.length ? sameLog : list.filter((e) => e.logId === null || a.context !== 'course')
      const inWindow = candidates.filter((e) => (a.endMs ? e.at <= a.endMs + 120_000 : true) && (a.startMs ? e.at >= a.startMs - 60_000 : true))
      const pick = (a.endMs || a.startMs ? inWindow : sameLog).at(-1)
      if (pick) out.set(a.key, (pick.seconds ?? pick.durationSec)!)
    }
    return out
  }

  /** Quality, volume and learner experience (Insights → Quizzes). Aggregates only. */
  insights(days: number) {
    return this.cached(`insights:${days}`, async () => {
      const today = istDayOf(Date.now())
      const firstDay = today - days + 1
      const [{ rows: answers, sources }, ev, cache] = await Promise.all([this.answers(days), this.events(days), this.evaluationCache(days)])
      const sq = answers.filter((a) => a.type === 'SQ')
      const wq = answers.filter((a) => a.type === 'WQ')
      const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null)

      const dayRows = new Map<string, { sq: number; wq: number; failed: number; late: number; noSpeech: number }>()
      for (const a of answers) {
        const d = dayRows.get(a.day) ?? { sq: 0, wq: 0, failed: 0, late: 0, noSpeech: 0 }
        dayRows.set(a.day, d)
        if (a.type === 'SQ') d.sq++
        else d.wq++
        if (a.failed) d.failed++
        if (a.onTime === false) d.late++
        if (a.type === 'SQ' && a.words === 0) d.noSpeech++
      }
      const paths = (['legacy', 'counted', 'evidence'] as MarkingPath[]).map((path) => ({
        path,
        sq: sq.filter((a) => a.path === path).length,
        wq: wq.filter((a) => a.path === path).length,
        failed: answers.filter((a) => a.path === path && a.failed).length,
      }))
      const reasons = new Map<string, number>()
      for (const a of answers) if (a.failed) reasons.set(a.failReason ?? 'no score returned', (reasons.get(a.failReason ?? 'no score returned') ?? 0) + 1)
      const evidence = answers.filter((a) => a.path === 'evidence')
      const quizzes = new Set(answers.map((a) => a.quizId))
      const learners = new Set(answers.map((a) => a.userId))

      const scoreBlock = (list: AnswerRow[]) => ({
        relevance: histogram(list.map((a) => a.relevance)),
        grammar: histogram(list.map((a) => a.grammar)),
        pronunciation: histogram(list.filter((a) => a.type === 'SQ').map((a) => a.pronunciation)),
        final: histogram(list.map((a) => a.finalPercentage), 100),
        means: {
          relevance: summary(list.flatMap((a) => (a.relevance === null ? [] : [a.relevance]))).mean,
          grammar: summary(list.flatMap((a) => (a.grammar === null ? [] : [a.grammar]))).mean,
          pronunciation: summary(list.flatMap((a) => (a.type === 'SQ' && a.pronunciation !== null ? [a.pronunciation] : []))).mean,
          final: summary(list.flatMap((a) => (a.finalPercentage === null ? [] : [a.finalPercentage]))).mean,
        },
        correctShare: share(list.filter((a) => a.isCorrect).length, list.filter((a) => a.isCorrect !== null).length),
      })

      return {
        days,
        sources: {
          tables: sources,
          lsrw: sources.some((s) => s.lsrw),
          evaluationCache: cache !== null,
        },
        empty: !sources.some((s) => s.present) ? 'no_tables' : answers.length ? null : 'no_answers',
        totals: {
          answers: answers.length,
          sq: sq.length,
          wq: wq.length,
          learners: learners.size,
          quizzes: quizzes.size,
          failed: answers.filter((a) => a.failed).length,
          failedShare: share(answers.filter((a) => a.failed).length, answers.length),
          late: answers.filter((a) => a.onTime === false).length,
          lateShare: share(answers.filter((a) => a.onTime === false).length, answers.filter((a) => a.onTime !== null).length),
          noSpeech: sq.filter((a) => a.words === 0).length,
          noSpeechShare: share(sq.filter((a) => a.words === 0).length, sq.length),
          emptyWriting: wq.filter((a) => a.words === 0).length,
        },
        series: Array.from({ length: days }, (_, i) => {
          const day = istDayLabel(firstDay + i)
          const d = dayRows.get(day) ?? { sq: 0, wq: 0, failed: 0, late: 0, noSpeech: 0 }
          return { day, ...d, answers: d.sq + d.wq }
        }),
        paths,
        failures: [...reasons.entries()].map(([reason, answers]) => ({ reason, answers })).sort((a, b) => b.answers - a.answers),
        retries: {
          evidenceAnswers: evidence.length,
          retried: evidence.filter((a) => a.attempts > 1).length,
          retriedShare: share(evidence.filter((a) => a.attempts > 1).length, evidence.length),
          cache,
        },
        scores: { sq: scoreBlock(sq), wq: scoreBlock(wq) },
        length: {
          sqWords: summary(sq.filter((a) => a.words > 0).map((a) => a.words)),
          wqWords: summary(wq.filter((a) => a.words > 0).map((a) => a.words)),
          sqSeconds: summary(sq.flatMap((a) => (a.timeTaken && a.timeTaken > 0 ? [a.timeTaken] : []))),
          wqSeconds: summary(wq.flatMap((a) => (a.timeTaken && a.timeTaken > 0 ? [a.timeTaken] : []))),
        },
        experience: this.experience(ev, firstDay, days),
      }
    })
  }

  private experience(ev: Awaited<ReturnType<QuizAnalytics['events']>>, firstDay: number, days: number) {
    const count = (type: string) => ev.counts.filter((c) => c.type === type).reduce((s, c) => s + c.events, 0)
    const of = (type: string) => ev.rows.filter((e) => e.type === type)
    const tally = (list: QuizEvent[], field: keyof QuizEvent) => {
      const m = new Map<string, number>()
      for (const e of list) {
        const k = String(e[field] ?? 'unknown')
        m.set(k, (m.get(k) ?? 0) + 1)
      }
      return [...m.entries()].map(([key, events]) => ({ key, events })).sort((a, b) => b.events - a.events)
    }
    const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null)
    const stops = of('quiz_record_stopped')
    const perQuestion = new Map<string, number>()
    for (const e of stops) {
      const k = `${e.userId}|${e.logId ?? '-'}|${e.questionId ?? '-'}`
      perQuestion.set(k, (perQuestion.get(k) ?? 0) + 1)
    }
    const stt = of('quiz_stt_result')
    const evals = of('quiz_eval_result')
    const timeouts = of('quiz_question_timeout')
    const submitted = of('quiz_answer_submitted')
    const quizEventsInPeriod = ev.counts.reduce((s, c) => s + c.events, 0)
    return {
      available: ev.available,
      firstSeenAt: ev.firstSeenAt,
      empty: !ev.available ? 'no_table' : ev.firstSeenAt === null ? 'no_events_yet' : quizEventsInPeriod ? null : 'none_in_period',
      counts: QUIZ_EVENTS.map((type) => ({ type, events: count(type) })),
      recording: {
        started: count('quiz_record_started'),
        failed: count('quiz_record_failed'),
        failedShare: share(count('quiz_record_failed'), count('quiz_record_started') + count('quiz_record_failed')),
        failures: tally(of('quiz_record_failed'), 'error'),
        stopped: stops.length,
        seconds: summary(stops.flatMap((e) => (e.seconds ?? e.durationSec) !== null ? [(e.seconds ?? e.durationSec)!] : [])),
        stopReasons: tally(stops, 'reason'),
        deleted: count('quiz_record_deleted'),
        rerecordedShare: share([...perQuestion.values()].filter((v) => v > 1).length, perQuestion.size),
      },
      stt: {
        results: stt.length,
        noSpeechShare: share(stt.filter((e) => e.outcome === 'no_speech').length, stt.length),
        failedShare: share(stt.filter((e) => e.outcome === 'failed').length, stt.length),
        ms: summary(stt.flatMap((e) => (e.ms !== null && e.outcome === 'ok' ? [e.ms] : []))),
      },
      marking: {
        results: evals.length,
        failedShare: share(evals.filter((e) => e.outcome === 'failed').length, evals.length),
        ms: summary(evals.flatMap((e) => (e.ms !== null && e.outcome === 'ok' ? [e.ms] : []))),
      },
      submitFailures: tally(of('quiz_submit_failed'), 'stage'),
      submitErrors: tally(of('quiz_submit_failed'), 'error').slice(0, 6),
      feedbackWait: summary(of('quiz_feedback_shown').flatMap((e) => (e.ms !== null ? [e.ms] : []))),
      submitted: { answers: submitted.length, timedOut: submitted.filter((e) => e.timedOut).length },
      timeouts: { events: timeouts.length, hadAnswerShare: share(timeouts.filter((e) => e.hadAnswer).length, timeouts.length) },
      pasteBlocked: count('quiz_paste_blocked'),
      questionsShown: count('quiz_question_shown'),
      series: Array.from({ length: days }, (_, i) => {
        const day = istDayLabel(firstDay + i)
        const on = (type: string) => ev.counts.filter((c) => c.day === day && c.type === type).reduce((s, c) => s + c.events, 0)
        return {
          day,
          shown: on('quiz_question_shown'),
          submitted: on('quiz_answer_submitted'),
          problems: on('quiz_record_failed') + on('quiz_submit_failed'),
        }
      }),
    }
  }
}

export default new QuizAnalytics()
