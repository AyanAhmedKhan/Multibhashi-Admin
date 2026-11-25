import db from '@adonisjs/lucid/services/db'
import { DAY_MS, istDayLabel, istDaySql, istDayStart } from '#helpers/ist'
import type { Refs, Warehouse } from '#services/product_analytics/warehouse'

/**
 * Parity between the old activity pipeline (MySQL: student_sessions and student_activity_events,
 * written by the monolith's /activity/* endpoints) and the new product events (BigQuery), for the
 * concepts both carry (MUL-155, docs/ANALYTICS_CONSOLIDATION.md). Daily counts side by side, the
 * difference, and how many days in a row the gating concepts have matched: the old writes are
 * retired only after two weeks within tolerance. Read-only on both sides.
 */

export type Measure = 'learners' | 'sessions' | 'minutes'

export interface Concept {
  key: string
  label: string
  /** MySQL side: activity event types (student_activity_events) or a student_sessions measure. */
  mysql: { events: string[] } | { sessions: Measure }
  /** BigQuery side: event names (events_raw) or an m_sessions measure. */
  bigquery: { events: string[] } | { sessions: Measure }
  /** Allowed difference, in % of the MySQL figure. */
  tolerance: number
  /** Whether retiring the old writes waits for this concept to match. */
  gates: boolean
  note?: string
}

const QUIZ_TELEMETRY = [
  'quiz_question_shown',
  'quiz_record_started',
  'quiz_record_failed',
  'quiz_record_stopped',
  'quiz_answer_submitted',
  'quiz_stt_result',
  'quiz_eval_result',
  'quiz_submit_failed',
  'quiz_feedback_shown',
  'quiz_question_timeout',
]

export const CONCEPTS: Concept[] = [
  { key: 'active_learners', label: 'Active learners per day', mysql: { sessions: 'learners' }, bigquery: { sessions: 'learners' }, tolerance: 10, gates: true, note: 'signed-in learners with an app session' },
  {
    key: 'sessions',
    label: 'App sessions per day',
    mysql: { sessions: 'sessions' },
    bigquery: { sessions: 'sessions' },
    tolerance: 25,
    gates: false,
    note: 'old: app open to close; new: a new session after 30 min idle, split at midnight',
  },
  {
    key: 'app_minutes',
    label: 'Time in app (minutes)',
    mysql: { sessions: 'minutes' },
    bigquery: { sessions: 'minutes' },
    tolerance: 25,
    gates: true,
    note: 'old: heartbeat active seconds; new: first to last event of each session',
  },
  { key: 'quiz_opened', label: 'Quizzes opened', mysql: { events: ['quiz_start'] }, bigquery: { events: ['quiz_opened'] }, tolerance: 10, gates: true },
  { key: 'quiz_completed', label: 'Quizzes completed', mysql: { events: ['quiz_completed'] }, bigquery: { events: ['quiz_completed'] }, tolerance: 10, gates: true },
  { key: 'recording_played', label: 'Recordings played', mysql: { events: ['video_play'] }, bigquery: { events: ['recording_played'] }, tolerance: 10, gates: true },
  ...QUIZ_TELEMETRY.map((name) => ({ key: name, label: name.replace(/_/g, ' '), mysql: { events: [name] }, bigquery: { events: [name] }, tolerance: 10, gates: false })),
]

/** Daily figures per concept on one side: concept → IST day → value. */
export type Side = Map<string, Map<string, number>>

export interface ParityRange {
  from: string
  to: string
}

const dayNo = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
export const daysOf = (range: ParityRange) => Array.from({ length: dayNo(range.to) - dayNo(range.from) + 1 }, (_, i) => istDayLabel(dayNo(range.from) + i))

const eventNames = (side: 'mysql' | 'bigquery') => [...new Set(CONCEPTS.flatMap((c) => ('events' in c[side] ? c[side].events : [])))]

// ------------------------------------------------------------------ queries

export const mysqlEventsSql = () => `SELECT ${istDaySql('created_at_ms')} AS day, event_type, COUNT(*) AS n
FROM student_activity_events
WHERE event_type IN (${eventNames('mysql').map(() => '?').join(', ')}) AND created_at_ms >= ? AND created_at_ms < ?
GROUP BY day, event_type`

export const mysqlSessionsSql = () => `SELECT ${istDaySql('started_at')} AS day, COUNT(DISTINCT user_id) AS learners, COUNT(*) AS sessions, SUM(active_seconds) AS seconds
FROM student_sessions
WHERE started_at >= ? AND started_at < ?
GROUP BY day`

export const bigqueryEventsSql = (r: Refs) => `SELECT event_date AS day, event_name, COUNT(*) AS n
FROM ${r.t('events_raw')}
WHERE event_date BETWEEN CAST(@from_day AS DATE) AND CAST(@to_day AS DATE) AND event_name IN UNNEST(@names)
GROUP BY day, event_name`

export const bigquerySessionsSql = (r: Refs) => `SELECT session_date AS day, COUNT(DISTINCT user_id) AS learners, COUNTIF(user_id IS NOT NULL) AS sessions, SUM(IF(user_id IS NOT NULL, duration_s, 0)) AS seconds
FROM ${r.t('m_sessions')}
WHERE session_date BETWEEN CAST(@from_day AS DATE) AND CAST(@to_day AS DATE)
GROUP BY day`

// ------------------------------------------------------------------ turning rows into sides

type Row = Record<string, unknown>
const v = (x: unknown) => Number((x as { value?: unknown })?.value ?? x ?? 0)
/** A day as MySQL (a day number, possibly a DECIMAL string) or BigQuery (a DATE) returns it. */
export const dayOf = (x: unknown) => {
  const raw = String((x as { value?: unknown })?.value ?? x)
  return /^\d{1,6}(\.0+)?$/.test(raw) ? istDayLabel(Number(raw)) : raw.slice(0, 10)
}

/** Event counts and session measures → each concept's daily figures on that side. */
export function toSide(side: 'mysql' | 'bigquery', events: Row[], sessions: Row[]): Side {
  const out: Side = new Map()
  for (const c of CONCEPTS) {
    const def = c[side]
    const days = new Map<string, number>()
    if ('events' in def) {
      for (const r of events) {
        const name = String(r.event_type ?? r.event_name)
        if (def.events.includes(name)) days.set(dayOf(r.day), (days.get(dayOf(r.day)) ?? 0) + v(r.n))
      }
    } else {
      for (const r of sessions) {
        const value = def.sessions === 'learners' ? v(r.learners) : def.sessions === 'sessions' ? v(r.sessions) : Math.round(v(r.seconds) / 60)
        days.set(dayOf(r.day), value)
      }
    }
    out.set(c.key, days)
  }
  return out
}

// ------------------------------------------------------------------ comparison

export interface ParityDay {
  day: string
  mysql: number
  bigquery: number
  /** (bigquery − mysql) ÷ mysql, in %; null when MySQL has nothing that day. */
  diffPct: number | null
  ok: boolean
}

export interface ParityConcept {
  key: string
  label: string
  tolerance: number
  gates: boolean
  note?: string
  days: ParityDay[]
  /** Days with data on either side. */
  compared: number
  within: number
  /** Consecutive days within tolerance, counting back from the last day. */
  streak: number
  maxAbsDiffPct: number | null
}

/** Days needed in a row within tolerance before the old writes can go (MUL-155). */
export const REQUIRED_STREAK = 14

export function compare(mysql: Side, bigquery: Side, range: ParityRange): { concepts: ParityConcept[]; ready: boolean; blocking: string[] } {
  const days = daysOf(range)
  const concepts = CONCEPTS.map((c) => {
    const rows: ParityDay[] = []
    for (const day of days) {
      const m = mysql.get(c.key)?.get(day) ?? 0
      const b = bigquery.get(c.key)?.get(day) ?? 0
      if (!m && !b) continue
      const diffPct = m ? Math.round(((b - m) / m) * 1000) / 10 : null
      rows.push({ day, mysql: m, bigquery: b, diffPct, ok: diffPct !== null && Math.abs(diffPct) <= c.tolerance })
    }
    let streak = 0
    for (let i = days.length - 1; i >= 0; i--) {
      const row = rows.find((x) => x.day === days[i])
      if (!row || !row.ok) break
      streak++
    }
    const diffs = rows.map((x) => x.diffPct).filter((x): x is number => x !== null)
    return {
      key: c.key,
      label: c.label,
      tolerance: c.tolerance,
      gates: c.gates,
      note: c.note,
      days: rows,
      compared: rows.length,
      within: rows.filter((x) => x.ok).length,
      streak,
      maxAbsDiffPct: diffs.length ? Math.max(...diffs.map(Math.abs)) : null,
    }
  })
  const blocking = concepts.filter((c) => c.gates && c.streak < REQUIRED_STREAK).map((c) => c.key)
  return { concepts, ready: blocking.length === 0, blocking }
}

// ------------------------------------------------------------------ reading both sides

export async function readMysql(range: ParityRange): Promise<Side> {
  const conn = db.connection('analytics')
  const since = istDayStart(dayNo(range.from))
  const until = istDayStart(dayNo(range.to) + 1)
  const [events, sessions] = await Promise.all([
    conn.rawQuery(mysqlEventsSql(), [...eventNames('mysql'), since, until]),
    conn.rawQuery(mysqlSessionsSql(), [since, until]),
  ])
  return toSide('mysql', (events[0] ?? []) as Row[], (sessions[0] ?? []) as Row[])
}

export async function readBigQuery(range: ParityRange, warehouse: Warehouse, refs: Refs): Promise<Side> {
  const p = { from_day: range.from, to_day: range.to }
  const [events, sessions] = await Promise.all([
    warehouse.query(bigqueryEventsSql(refs), { ...p, names: eventNames('bigquery') }, { names: ['STRING'] }),
    warehouse.query(bigquerySessionsSql(refs), p),
  ])
  return toSide('bigquery', events, sessions)
}
