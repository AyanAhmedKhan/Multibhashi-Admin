import db from '@adonisjs/lucid/services/db'
import { DAY_MS, istDayStart } from '#helpers/ist'
import {
  attendanceFact,
  bookingFact,
  identityFact,
  paymentFact,
  quizAttemptFact,
  tutorSessionFact,
  userFact,
  type AttendanceSource,
  type FactRange,
  type FactRows,
  type FactSource,
  type FactTable,
  type LeadRow,
} from '#services/product_analytics/facts'

/**
 * Reads the business facts from MySQL through the `analytics` connection (the read replica
 * when DB_ANALYTICS_HOST is set; see MUL-155 for creating one). Tables and columns are
 * detected in information_schema first: monolith tables missing here are skipped, optional
 * columns read as NULL. Only ids, dates, statuses, counts and amounts are selected, never a
 * phone, e-mail, name, answer or message. Pages of PAGE rows by id (keyset), so a full
 * export never holds a whole table in memory.
 */

export const PAGE = 5000
const conn = () => db.connection('analytics')

/** Tables (and the optional columns) each fact reads. */
const SOURCE_TABLES = [
  'users',
  'student_sessions',
  'direct_leads',
  'course_bookings',
  'transactions',
  'webinar_class_attendances',
  'webinar_class_user_logs',
  'webinar_classes',
  'session_call_user_logs',
  'session_calls',
  'user_quiz_logs',
  'webinar_class_quiz_logs',
  'session_call_quiz_logs',
  'ai_tutor_chats',
  'ai_tutor_chat_details',
  'ai_tutor_session_summaries',
  'learner_accounts',
]

export type Schema = Map<string, Set<string>>
const has = (schema: Schema, table: string, column?: string) => (column ? !!schema.get(table)?.has(column) : schema.has(table))
const col = (schema: Schema, table: string, alias: string, column: string, as = column) =>
  has(schema, table, column) ? `${alias}.${column} AS ${as}` : `NULL AS ${as}`
/** A DATETIME read as IST wall-clock text (see facts.ts istWallToIso). */
const wall = (expr: string, as: string) => `DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i:%s') AS ${as}`

// ------------------------------------------------------------------ range bounds

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
const wallOfDay = (n: number) => `${new Date(n * DAY_MS).toISOString().slice(0, 10)} 00:00:00`

/** The range as DATETIME text bounds (IST wall-clock) and epoch-ms bounds; until is exclusive. */
export function bounds(range: FactRange) {
  const first = dayNumber(range.from)
  const last = dayNumber(range.to)
  return { since: wallOfDay(first), until: wallOfDay(last + 1), sinceMs: istDayStart(first), untilMs: istDayStart(last + 1) }
}

// ------------------------------------------------------------------ SQL (exported for tests)

const ranged = (range: FactRange, column: string) => (range.full ? '' : ` AND ${column} >= ? AND ${column} < ?`)

export function usersSql(schema: Schema, range: FactRange) {
  return `SELECT u.id, ${wall('u.created_at', 'created_at')}, ${col(schema, 'users', 'u', 'country_code')}
FROM users u
WHERE u.id > ?${ranged(range, 'u.created_at')}
ORDER BY u.id
LIMIT ${PAGE}`
}

/** Users whose FIRST app session falls in the range (verified later than their sign-up day). */
export const verifiedInRangeSql = `SELECT s.user_id, MIN(s.started_at) AS first_ms
FROM student_sessions s
WHERE s.user_id IN (SELECT DISTINCT r.user_id FROM student_sessions r WHERE r.started_at >= ? AND r.started_at < ?)
GROUP BY s.user_id
HAVING MIN(s.started_at) >= ?`

export const firstSessionSql = (n: number) =>
  `SELECT user_id, MIN(started_at) AS first_ms FROM student_sessions WHERE user_id IN (${placeholders(n)}) GROUP BY user_id`

export function leadsSql(schema: Schema, n: number) {
  const pick = ['utm_source', 'utm_medium', 'utm_campaign', 'source'].map((c) => col(schema, 'direct_leads', 'l', c)).join(', ')
  return `SELECT l.user_id, ${pick} FROM direct_leads l WHERE l.user_id IN (${placeholders(n)}) ORDER BY l.id`
}

export const usersByIdSql = (schema: Schema, n: number) =>
  `SELECT u.id, ${wall('u.created_at', 'created_at')}, ${col(schema, 'users', 'u', 'country_code')} FROM users u WHERE u.id IN (${placeholders(n)})`

export function bookingsSql(schema: Schema, range: FactRange) {
  const c = (name: string) => col(schema, 'course_bookings', 'b', name)
  return `SELECT b.id, b.user_id, ${wall('b.created_at', 'created_at')}, ${[
    'course_id', 'course_type', 'booking_type', 'booking_status', 'state', 'booking_entry', 'rate', 'currency', 'expiry_date', 'utm_source', 'utm_medium', 'utm_campaign',
  ]
    .map(c)
    .join(', ')}
FROM course_bookings b
WHERE b.id > ?${ranged(range, 'b.created_at')}
ORDER BY b.id
LIMIT ${PAGE}`
}

export function paymentsSql(schema: Schema, range: FactRange) {
  const joinBooking = has(schema, 'course_bookings') && has(schema, 'transactions', 'course_booking_id')
  const ref = has(schema, 'transactions', 'razorpay_id')
  return `SELECT t.id, t.user_id, ${col(schema, 'transactions', 't', 'course_booking_id')}, ${wall('t.created_at', 'created_at')},
  ${joinBooking ? wall('b.created_at', 'booking_created_at') : 'NULL AS booking_created_at'},
  ${col(schema, 'transactions', 't', 'amount')}, ${joinBooking && has(schema, 'course_bookings', 'currency') ? 'b.currency' : 'NULL'} AS currency,
  ${col(schema, 'transactions', 't', 'payment_status')}, ${col(schema, 'transactions', 't', 'payment_method')},
  ${ref ? "t.razorpay_id REGEXP '^pay_[A-Za-z0-9]{14}$'" : '0'} AS gateway_verified,
  ${ref ? 'LEFT(SHA2(t.razorpay_id, 256), 16)' : 'NULL'} AS gateway_ref_hash
FROM transactions t${joinBooking ? '\nLEFT JOIN course_bookings b ON b.id = t.course_booking_id' : ''}
WHERE t.id > ?${ranged(range, 't.created_at')}
ORDER BY t.id
LIMIT ${PAGE}`
}

export const ATTENDANCE_SOURCES: { kind: AttendanceSource; table: string; classColumn: string; classTable: string }[] = [
  { kind: 'webinar_attendance', table: 'webinar_class_attendances', classColumn: 'webinar_class_id', classTable: 'webinar_classes' },
  { kind: 'webinar_join', table: 'webinar_class_user_logs', classColumn: 'webinar_class_id', classTable: 'webinar_classes' },
  { kind: 'session_join', table: 'session_call_user_logs', classColumn: 'session_call_id', classTable: 'session_calls' },
]

export function attendanceSql(schema: Schema, source: (typeof ATTENDANCE_SOURCES)[number], range: FactRange) {
  const slot = has(schema, source.classTable, 'slot')
  return `SELECT a.id, a.user_id, a.${source.classColumn} AS class_id, ${wall('a.created_at', 'created_at')}, ${slot ? 'c.slot' : 'NULL'} AS slot
FROM ${source.table} a${slot ? `\nLEFT JOIN ${source.classTable} c ON c.id = a.${source.classColumn}` : ''}
WHERE a.id > ?${ranged(range, 'a.created_at')}
ORDER BY a.id
LIMIT ${PAGE}`
}

export const QUIZ_LOGS: { context: 'course' | 'webinar' | 'session'; table: string }[] = [
  { context: 'course', table: 'user_quiz_logs' },
  { context: 'webinar', table: 'webinar_class_quiz_logs' },
  { context: 'session', table: 'session_call_quiz_logs' },
]

export function quizLogsSql(schema: Schema, table: string, range: FactRange) {
  const c = (name: string) => col(schema, table, 'q', name)
  return `SELECT q.id, q.user_id, q.quiz_id, ${wall('q.created_at', 'created_at')}, ${[
    'quiz_start_timestamp', 'quiz_end_timestamp', 'is_quiz_finised', 'attempt', 'total_questions', 'total_question_attempt', 'total_correct_answer', 'total_incorrect_answer', 'total_timeout',
  ]
    .map(c)
    .join(', ')}
FROM ${table} q
WHERE q.id > ?${ranged(range, 'q.created_at')}
ORDER BY q.id
LIMIT ${PAGE}`
}

/** Chats created or changed in the range (a chat row is reused across classes). */
export function tutorChatsSql(schema: Schema, range: FactRange) {
  const c = (name: string) => col(schema, 'ai_tutor_chats', 'c', name)
  const updated = has(schema, 'ai_tutor_chats', 'updated_at')
  const changed = range.full ? '' : updated ? ' AND ((c.created_at >= ? AND c.created_at < ?) OR (c.updated_at >= ? AND c.updated_at < ?))' : ' AND c.created_at >= ? AND c.created_at < ?'
  const sql = `SELECT c.id, c.user_id, ${['quiz_id', 'quiz_question_id', 'status', 'chat_start_timestamp', 'chat_end_timestamp', 'time_spent'].map(c).join(', ')},
  ${wall('c.created_at', 'created_at')}, ${updated ? wall('c.updated_at', 'updated_at') : 'NULL AS updated_at'}
FROM ai_tutor_chats c
WHERE c.id > ?${changed}
ORDER BY c.id
LIMIT ${PAGE}`
  const bind = (after: number, since: string, until: string) => (range.full ? [after] : updated ? [after, since, until, since, until] : [after, since, until])
  return { sql, bind }
}

export const turnsSql = (n: number) =>
  `SELECT ai_tutor_chat_id AS chat_id, SUM(chat_from = 'user') AS learner, SUM(chat_from = 'ai') AS tutor
FROM ai_tutor_chat_details WHERE ai_tutor_chat_id IN (${placeholders(n)}) GROUP BY ai_tutor_chat_id`

export const languagesSql = (n: number) =>
  `SELECT ai_tutor_chat_id AS chat_id, language FROM ai_tutor_session_summaries WHERE ai_tutor_chat_id IN (${placeholders(n)})`

/** learner_accounts' appspot column: appspot_user_id (identity service migration), else appspot_id (contract name). */
export function identitiesSql(schema: Schema) {
  const appspot = has(schema, 'learner_accounts', 'appspot_user_id') ? 'appspot_user_id' : has(schema, 'learner_accounts', 'appspot_id') ? 'appspot_id' : null
  if (!appspot) return null
  return `SELECT a.id, a.${appspot} AS appspot_id, ${col(schema, 'learner_accounts', 'a', 'td_user_id')}, ${col(schema, 'learner_accounts', 'a', 'status')}, ${wall('a.created_at', 'created_at')}
FROM learner_accounts a
WHERE a.id > ?
ORDER BY a.id
LIMIT ${PAGE}`
}

function placeholders(n: number) {
  return Array.from({ length: Math.max(1, n) }, () => '?').join(', ')
}

// ------------------------------------------------------------------ reading

type Row = Record<string, unknown>

async function raw(sql: string, bindings: unknown[]): Promise<Row[]> {
  const result = await conn().rawQuery(sql, bindings as never[])
  return (result[0] ?? []) as Row[]
}

/** Pages by id: fetch(after) returns up to PAGE rows with id > after. */
async function* keyset(fetch: (after: number) => Promise<Row[]>, start = 0): AsyncGenerator<Row[]> {
  let after = start
  for (;;) {
    const rows = await fetch(after)
    if (!rows.length) return
    yield rows
    after = Number(rows[rows.length - 1].id)
    if (rows.length < PAGE) return
  }
}

const byChunks = <T>(items: T[], size = 1000) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

export class MysqlFactSource implements FactSource {
  #schema: Schema | null = null

  async schema(): Promise<Schema> {
    if (this.#schema) return this.#schema
    const rows = await conn()
      .from('information_schema.columns')
      .whereRaw('table_schema = DATABASE()')
      .whereIn('table_name', SOURCE_TABLES)
      .select('table_name as t', 'column_name as c')
    const schema: Schema = new Map()
    for (const r of rows as { t: string; c: string }[]) {
      const t = String(r.t)
      if (!schema.has(t)) schema.set(t, new Set())
      schema.get(t)!.add(String(r.c).toLowerCase())
    }
    this.#schema = schema
    return schema
  }

  /**
   * The first id whose created_at is on or after `since` (minus a day of slack), for log tables
   * whose ids grow with created_at; a binary search on the primary key instead of a scan of an
   * unindexed created_at. null when the newest row is older.
   */
  async firstIdSince(table: string, since: string): Promise<number | null> {
    const from = new Date(Date.parse(`${since.replace(' ', 'T')}+05:30`) - DAY_MS)
    const bounds = await conn().from(table).min('id as lo').max('id as hi').first()
    let lo = Number(bounds?.lo ?? 0)
    let hi = Number(bounds?.hi ?? 0)
    if (!hi) return null
    const at = async (id: number) => {
      const row = await conn().from(table).where('id', '>=', id).orderBy('id', 'asc').select('id', 'created_at').first()
      return row ? { id: Number(row.id), created: row.created_at ? new Date(row.created_at) : null } : null
    }
    const newest = await at(hi)
    if (!newest?.created || newest.created < from) return null
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const row = await at(mid)
      if (row?.created && row.created >= from) hi = mid
      else lo = Math.min((row?.id ?? mid) + 1, hi)
    }
    return lo
  }

  /** Where a ranged scan of a log table starts (keyset "after" value). */
  private async startAfter(table: string, range: FactRange) {
    if (range.full) return 0
    const first = await this.firstIdSince(table, bounds(range).since)
    return first === null ? null : first - 1
  }

  async rows(table: FactTable, range: FactRange, exportedAt: string): Promise<FactRows> {
    const schema = await this.schema()
    switch (table) {
      case 'fact_users':
        return has(schema, 'users') ? this.users(schema, range, exportedAt) : { skipped: 'no users table' }
      // Small tables, and manual bookings carry back-dated created_at: scanned from the first id.
      case 'fact_bookings':
        if (!has(schema, 'course_bookings')) return { skipped: 'no course_bookings table' }
        return this.paged(bookingsSql(schema, range), range, (r) => bookingFact(r, exportedAt))
      case 'fact_payments':
        if (!has(schema, 'transactions')) return { skipped: 'no transactions table' }
        return this.paged(paymentsSql(schema, range), range, (r) => paymentFact(r, exportedAt))
      case 'fact_class_attendance':
        return this.attendance(schema, range, exportedAt)
      case 'fact_quiz_attempts':
        return this.quizAttempts(schema, range, exportedAt)
      case 'fact_tutor_sessions':
        return has(schema, 'ai_tutor_chats') ? this.tutorSessions(schema, range, exportedAt) : { skipped: 'no ai_tutor_chats table' }
      case 'identities': {
        if (!has(schema, 'learner_accounts')) return { skipped: 'learner_accounts does not exist yet (sign-in v2 not deployed)' }
        const sql = identitiesSql(schema)
        if (!sql) return { skipped: 'learner_accounts has no appspot id column' }
        return (async function* () {
          for await (const page of keyset((after) => raw(sql, [after]))) yield page.map((r) => identityFact(r, exportedAt))
        })()
      }
      default:
        throw new Error(`Unknown fact table ${String(table)}`)
    }
  }

  /** One query paged by id from the first row; ranged on created_at unless full. */
  private paged(sql: string, range: FactRange, map: (r: Row) => Row): FactRows {
    const { since, until } = bounds(range)
    return (async function* () {
      for await (const page of keyset((after) => raw(sql, range.full ? [after] : [after, since, until]))) yield page.map(map)
    })()
  }

  private users(schema: Schema, range: FactRange, exportedAt: string): FactRows {
    const self = this
    const { since, until, sinceMs, untilMs } = bounds(range)
    const hasSessions = has(schema, 'student_sessions')
    const hasLeads = has(schema, 'direct_leads')
    async function enrich(users: Row[], known?: Map<number, number>) {
      const ids = users.map((u) => Number(u.id))
      const first = new Map<number, number>(known)
      const leads = new Map<number, LeadRow>()
      if (hasSessions && !known) {
        for (const r of await raw(firstSessionSql(ids.length), ids)) first.set(Number(r.user_id), Number(r.first_ms))
      }
      if (hasLeads) {
        for (const r of await raw(leadsSql(schema, ids.length), ids)) {
          const id = Number(r.user_id)
          if (!leads.has(id)) leads.set(id, r as LeadRow)
        }
      }
      return users.map((u) => userFact(u as { id: unknown; created_at: unknown; country_code?: unknown }, first.get(Number(u.id)) ?? null, leads.get(Number(u.id)), exportedAt))
    }
    return (async function* () {
      // From the first id: users ids need not follow created_at (imports, back-fills).
      const sql = usersSql(schema, range)
      for await (const page of keyset((after) => raw(sql, range.full ? [after] : [after, since, until]))) yield await enrich(page)
      // Signed up before the range, first signed in during it: verified changed.
      if (!range.full && hasSessions) {
        const verified = await raw(verifiedInRangeSql, [sinceMs, untilMs, sinceMs])
        for (const chunk of byChunks(verified)) {
          const firstMs = new Map(chunk.map((r) => [Number(r.user_id), Number(r.first_ms)]))
          const users = (await raw(usersByIdSql(schema, chunk.length), [...firstMs.keys()])).filter((u) => {
            const created = String(u.created_at ?? '')
            return !(created >= since && created < until)
          })
          if (users.length) yield await enrich(users, firstMs)
        }
      }
    })()
  }

  private attendance(schema: Schema, range: FactRange, exportedAt: string): FactRows {
    const sources = ATTENDANCE_SOURCES.filter((s) => has(schema, s.table))
    if (!sources.length) return { skipped: 'no attendance or join-log tables' }
    const self = this
    const { since, until } = bounds(range)
    return (async function* () {
      for (const source of sources) {
        const start = await self.startAfter(source.table, range)
        if (start === null) continue
        const sql = attendanceSql(schema, source, range)
        for await (const page of keyset((after) => raw(sql, range.full ? [after] : [after, since, until]), start)) {
          yield page.map((r) => attendanceFact(source.kind, r, exportedAt))
        }
      }
    })()
  }

  private quizAttempts(schema: Schema, range: FactRange, exportedAt: string): FactRows {
    const logs = QUIZ_LOGS.filter((l) => has(schema, l.table))
    if (!logs.length) return { skipped: 'no quiz log tables' }
    const self = this
    const { since, until } = bounds(range)
    return (async function* () {
      for (const log of logs) {
        const start = await self.startAfter(log.table, range)
        if (start === null) continue
        const sql = quizLogsSql(schema, log.table, range)
        for await (const page of keyset((after) => raw(sql, range.full ? [after] : [after, since, until]), start)) {
          yield page.map((r) => quizAttemptFact(log.context, r, exportedAt))
        }
      }
    })()
  }

  private tutorSessions(schema: Schema, range: FactRange, exportedAt: string): FactRows {
    const { since, until } = bounds(range)
    const { sql, bind } = tutorChatsSql(schema, range)
    const hasDetails = has(schema, 'ai_tutor_chat_details', 'chat_from')
    const hasSummaries = has(schema, 'ai_tutor_session_summaries', 'language')
    return (async function* () {
      for await (const page of keyset((after) => raw(sql, bind(after, since, until)))) {
        const ids = page.map((c) => Number(c.id))
        const turns = new Map<number, Row>()
        const languages = new Map<number, unknown>()
        if (hasDetails) for (const r of await raw(turnsSql(ids.length), ids)) turns.set(Number(r.chat_id), r)
        if (hasSummaries) for (const r of await raw(languagesSql(ids.length), ids)) languages.set(Number(r.chat_id), r.language)
        yield page.map((c) => {
          const t = turns.get(Number(c.id))
          return tutorSessionFact(c, { language: languages.get(Number(c.id)), learner: t?.learner, tutor: t?.tutor }, exportedAt)
        })
      }
    })()
  }
}
