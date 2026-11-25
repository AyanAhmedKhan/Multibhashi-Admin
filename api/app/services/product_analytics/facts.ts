import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { istDayLabel, istDayOf } from '#helpers/ist'
import { FACT_TABLES } from '#services/product_analytics/ddl'
import type { Refs, Warehouse } from '#services/product_analytics/warehouse'

/**
 * Business facts (MUL-149): the server truth the funnels end in (verified sign-ups, bookings,
 * captured payments, class attendance, quiz attempts, AI tutor classes) and the identity link,
 * exported from the MySQL read replica (`analytics` connection) into BigQuery, keyed by the
 * teachers-dashboard users.id (td_user_id). Phones, e-mails, names and free text never leave
 * MySQL: the queries select ids, dates, statuses and amounts only.
 *
 * Idempotent per date range. Each table's rows are written to a local NDJSON file, loaded into
 * a staging copy of the table (one load job), then swapped in by one transaction: delete the
 * target's rows in the range (by the fact's date, the same column the export filters on) and
 * any row whose key is in the batch, insert the batch. Re-running a range gives the same table.
 * `full` replaces the whole table. identities (learner_accounts) is always replaced whole.
 */

export type FactTable = (typeof FACT_TABLES)[number]

export interface FactSpec {
  key: string
  /** The IST date column a range delete uses (the export's date filter), or null. */
  dateColumn: string | null
  /** range: rows in the date range (plus re-exported keys); keys: only re-exported keys; full: everything. */
  mode: 'range' | 'keys' | 'full'
  /** BigQuery columns, in DDL order. */
  columns: string[]
}

export const FACT_SPECS: Record<FactTable, FactSpec> = {
  fact_users: {
    key: 'td_user_id',
    dateColumn: 'created_date',
    mode: 'range',
    columns: ['td_user_id', 'created_at', 'created_date', 'verified', 'verified_at', 'country_code', 'utm_source', 'utm_medium', 'utm_campaign', 'lead_source', 'exported_at'],
  },
  fact_bookings: {
    key: 'booking_id',
    dateColumn: 'created_date',
    mode: 'range',
    columns: [
      'booking_id', 'td_user_id', 'created_at', 'created_date', 'course_id', 'course_type', 'booking_type', 'booking_status', 'state', 'booking_entry',
      'paid', 'amount', 'currency', 'expires_at', 'utm_source', 'utm_medium', 'utm_campaign', 'exported_at',
    ],
  },
  fact_payments: {
    key: 'payment_id',
    dateColumn: 'created_date',
    mode: 'range',
    columns: [
      'payment_id', 'td_user_id', 'course_booking_id', 'created_at', 'captured_at', 'created_date', 'amount', 'currency', 'status', 'captured', 'method',
      'gateway_verified', 'gateway_ref_hash', 'exported_at',
    ],
  },
  fact_class_attendance: {
    key: 'attendance_key',
    dateColumn: 'activity_date',
    mode: 'range',
    columns: ['attendance_key', 'td_user_id', 'class_type', 'class_id', 'source', 'occurred_at', 'activity_date', 'class_slot_at', 'exported_at'],
  },
  fact_quiz_attempts: {
    key: 'attempt_key',
    dateColumn: 'activity_date',
    mode: 'range',
    columns: [
      'attempt_key', 'context', 'log_id', 'td_user_id', 'quiz_id', 'started_at', 'ended_at', 'activity_date', 'finished', 'attempt_number', 'total_questions',
      'answered', 'correct', 'incorrect', 'timeouts', 'score_pct', 'exported_at',
    ],
  },
  fact_tutor_sessions: {
    key: 'chat_id',
    dateColumn: null,
    // A chat row is reused across classes: rows changed in the range are re-exported by key.
    mode: 'keys',
    columns: [
      'chat_id', 'td_user_id', 'quiz_id', 'quiz_question_id', 'status', 'created_at', 'started_at', 'ended_at', 'updated_at', 'activity_date', 'minutes',
      'language', 'learner_turns', 'tutor_turns', 'exported_at',
    ],
  },
  identities: {
    key: 'learner_account_id',
    dateColumn: null,
    mode: 'full',
    columns: ['learner_account_id', 'appspot_id', 'td_user_id', 'status', 'created_at', 'exported_at'],
  },
}

// ------------------------------------------------------------------ value helpers

/** Epoch milliseconds → ISO, only when plausible (2001–2096); the app writes 0 and seconds too. */
export function msToIso(v: unknown): string | null {
  const ms = Number(v)
  return Number.isFinite(ms) && ms > 1e12 && ms < 4e12 ? new Date(ms).toISOString() : null
}

/**
 * MySQL DATETIME as the monolith stores it (IST wall-clock, read as 'YYYY-MM-DD HH:MM:SS' by
 * DATE_FORMAT, so the process time zone never matters) → ISO. Zero dates → null.
 */
export function istWallToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m || Number(m[1]) < 2000) return null
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** The IST date of an ISO instant. */
export const istDateOf = (iso: string | null) => (iso ? istDayLabel(istDayOf(Date.parse(iso))) : null)

export const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

export const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) === 1 || v === true || v === 'true')

const PHONE = /\+?\d{10,}/
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/

/** A short label (status, UTM value, currency): trimmed, capped, null when empty or personal-looking. */
export function label(v: unknown, max = 100): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().slice(0, max)
  if (!s || PHONE.test(s) || EMAIL.test(s)) return null
  return s
}

/** NUMERIC as a string (exact in a load job); null when not a number. */
export const amount = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(2) : null
}

// ------------------------------------------------------------------ row builders (MySQL row → BigQuery row)

export interface LeadRow {
  utm_source?: unknown
  utm_medium?: unknown
  utm_campaign?: unknown
  source?: unknown
}

export function userFact(u: { id: unknown; created_at: unknown; country_code?: unknown }, firstSessionMs: unknown, lead: LeadRow | undefined, exportedAt: string) {
  const createdAt = istWallToIso(u.created_at)
  const verifiedAt = msToIso(firstSessionMs)
  const country = label(u.country_code, 2)
  return {
    td_user_id: int(u.id),
    created_at: createdAt,
    created_date: istDateOf(createdAt),
    verified: verifiedAt !== null,
    verified_at: verifiedAt,
    country_code: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    utm_source: label(lead?.utm_source),
    utm_medium: label(lead?.utm_medium),
    utm_campaign: label(lead?.utm_campaign),
    lead_source: label(lead?.source, 64),
    exported_at: exportedAt,
  }
}

const PAID_TYPES = new Set(['paid_new', 'paid_renewal'])

export function bookingFact(b: Record<string, unknown>, exportedAt: string) {
  const createdAt = istWallToIso(b.created_at)
  const type = label(b.booking_type, 32)
  const rate = Number(b.rate ?? 0)
  return {
    booking_id: int(b.id),
    td_user_id: int(b.user_id),
    created_at: createdAt,
    created_date: istDateOf(createdAt),
    course_id: int(b.course_id),
    course_type: label(b.course_type, 40),
    booking_type: type,
    booking_status: label(b.booking_status, 32),
    state: label(b.state, 32),
    booking_entry: label(b.booking_entry, 32),
    paid: type ? PAID_TYPES.has(type) : Number.isFinite(rate) && rate > 0,
    amount: amount(b.rate),
    currency: label(b.currency, 8)?.toUpperCase() ?? null,
    expires_at: msToIso(b.expiry_date),
    utm_source: label(b.utm_source),
    utm_medium: label(b.utm_medium),
    utm_campaign: label(b.utm_campaign),
    exported_at: exportedAt,
  }
}

/** How far before its transaction a booking may be and still mark the capture time. */
export const CAPTURE_SLACK_MS = 10 * 60_000

export function paymentFact(t: Record<string, unknown>, exportedAt: string) {
  const createdAt = istWallToIso(t.created_at)
  const bookingAt = istWallToIso(t.booking_created_at)
  // The monolith inserts the booking, then the transaction, both after the Razorpay capture:
  // the earlier of the two is closest to the capture (and keeps payment before booking).
  let capturedAt = createdAt
  if (createdAt && bookingAt) {
    const gap = Date.parse(createdAt) - Date.parse(bookingAt)
    if (gap > 0 && gap <= CAPTURE_SLACK_MS) capturedAt = bookingAt
  }
  const status = label(t.payment_status, 32)
  return {
    payment_id: int(t.id),
    td_user_id: int(t.user_id),
    course_booking_id: int(t.course_booking_id),
    created_at: createdAt,
    captured_at: capturedAt,
    created_date: istDateOf(createdAt),
    amount: amount(t.amount),
    currency: label(t.currency, 8)?.toUpperCase() ?? 'INR',
    status,
    captured: status === 'success',
    method: label(t.payment_method, 32),
    gateway_verified: bool(t.gateway_verified) === true,
    gateway_ref_hash: label(t.gateway_ref_hash, 16),
    exported_at: exportedAt,
  }
}

export type AttendanceSource = 'webinar_attendance' | 'webinar_join' | 'session_join'

export function attendanceFact(kind: AttendanceSource, r: Record<string, unknown>, exportedAt: string) {
  const occurredAt = istWallToIso(r.created_at)
  return {
    attendance_key: `${kind}:${int(r.id)}`,
    td_user_id: int(r.user_id),
    class_type: kind === 'session_join' ? 'session' : 'webinar',
    class_id: int(r.class_id),
    source: kind === 'webinar_attendance' ? 'attendance' : 'join_log',
    occurred_at: occurredAt,
    activity_date: istDateOf(occurredAt),
    class_slot_at: msToIso(r.slot),
    exported_at: exportedAt,
  }
}

export function quizAttemptFact(context: 'course' | 'webinar' | 'session', r: Record<string, unknown>, exportedAt: string) {
  const createdAt = istWallToIso(r.created_at)
  const total = int(r.total_questions)
  const correct = int(r.total_correct_answer)
  return {
    attempt_key: `${context}:${int(r.id)}`,
    context,
    log_id: int(r.id),
    td_user_id: int(r.user_id),
    quiz_id: int(r.quiz_id),
    started_at: msToIso(r.quiz_start_timestamp) ?? createdAt,
    ended_at: msToIso(r.quiz_end_timestamp),
    activity_date: istDateOf(createdAt),
    finished: bool(r.is_quiz_finised) === true,
    attempt_number: int(r.attempt),
    total_questions: total,
    answered: int(r.total_question_attempt),
    correct,
    incorrect: int(r.total_incorrect_answer),
    timeouts: int(r.total_timeout),
    score_pct: total && correct !== null ? Math.round((correct / total) * 1000) / 10 : null,
    exported_at: exportedAt,
  }
}

export function tutorSessionFact(c: Record<string, unknown>, extra: { language?: unknown; learner?: unknown; tutor?: unknown }, exportedAt: string) {
  const createdAt = istWallToIso(c.created_at)
  const startedAt = msToIso(c.chat_start_timestamp)
  return {
    chat_id: int(c.id),
    td_user_id: int(c.user_id),
    quiz_id: int(c.quiz_id),
    quiz_question_id: int(c.quiz_question_id),
    status: label(c.status, 16),
    created_at: createdAt,
    started_at: startedAt,
    ended_at: msToIso(c.chat_end_timestamp),
    updated_at: istWallToIso(c.updated_at),
    activity_date: istDateOf(startedAt ?? createdAt),
    minutes: int(c.time_spent),
    language: label(extra.language, 16),
    learner_turns: int(extra.learner) ?? 0,
    tutor_turns: int(extra.tutor) ?? 0,
    exported_at: exportedAt,
  }
}

export function identityFact(r: Record<string, unknown>, exportedAt: string) {
  return {
    learner_account_id: int(r.id),
    appspot_id: label(r.appspot_id, 64),
    td_user_id: int(r.td_user_id),
    status: label(r.status, 16),
    created_at: istWallToIso(r.created_at),
    exported_at: exportedAt,
  }
}

// ------------------------------------------------------------------ the swap into BigQuery

export interface FactRange {
  /** First IST day, YYYY-MM-DD (inclusive). */
  from: string
  /** Last IST day, YYYY-MM-DD (inclusive). */
  to: string
  /** Replace whole tables instead of a range. */
  full: boolean
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * The command's range: --from/--to (IST days, inclusive), else the last `days` days ending
 * --to (default today). Throws a readable message for a bad or future range.
 */
export function resolveRange(opts: { from?: string; to?: string; days?: number; full?: boolean }, today: string): FactRange {
  const to = opts.to ?? today
  const days = Math.min(400, Math.max(1, Math.floor(opts.days ?? 7)))
  const from = opts.from ?? istDayLabel(istDayOf(Date.parse(`${to}T12:00:00+05:30`)) - days + 1)
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw new Error(`--from ${from} / --to ${to}: expected YYYY-MM-DD, from on or before to`)
  if (to > today) throw new Error(`--to ${to} is in the future (today is ${today} IST)`)
  return { from, to, full: !!opts.full }
}

export const stageName = (table: FactTable) => `_stage_${table}`

/** An empty staging copy of the table (same schema), dropped after the swap, else expiring in a day. */
export function stageSql(refs: Refs, table: FactTable) {
  return `CREATE OR REPLACE TABLE ${refs.t(stageName(table))} LIKE ${refs.t(table)}
OPTIONS (expiration_timestamp = TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 1 DAY))`
}

/** Delete what the batch replaces and insert the batch, in one transaction. */
export function swapSql(refs: Refs, table: FactTable, range: FactRange) {
  const spec = FACT_SPECS[table]
  const target = refs.t(table)
  const stage = refs.t(stageName(table))
  const byKey = `${spec.key} IN (SELECT ${spec.key} FROM ${stage})`
  let where: string
  let params: Record<string, string> = {}
  if (range.full || spec.mode === 'full') where = 'TRUE'
  else if (spec.mode === 'range' && spec.dateColumn) {
    where = `(${spec.dateColumn} BETWEEN CAST(@from_day AS DATE) AND CAST(@to_day AS DATE)) OR ${byKey}`
    params = { from_day: range.from, to_day: range.to }
  } else where = byKey
  const cols = spec.columns.join(', ')
  const sql = `BEGIN TRANSACTION;
DELETE FROM ${target} WHERE ${where};
INSERT INTO ${target} (${cols})
SELECT ${cols} FROM ${stage};
COMMIT TRANSACTION;`
  return { sql, params }
}

export const dropStageSql = (refs: Refs, table: FactTable) => `DROP TABLE IF EXISTS ${refs.t(stageName(table))}`

// ------------------------------------------------------------------ the export

/** Rows of one fact table, in pages, or why the table is skipped here. */
export type FactRows = AsyncIterable<Record<string, unknown>[]> | { skipped: string }

export interface FactSource {
  rows(table: FactTable, range: FactRange, exportedAt: string): Promise<FactRows>
}

export interface FactResult {
  table: FactTable
  status: 'loaded' | 'skipped' | 'failed' | 'counted'
  rows: number
  detail?: string
}

export interface ExportOptions {
  range: FactRange
  tables?: FactTable[]
  source: FactSource
  /** Without a warehouse (dry run) rows are read and counted, nothing is loaded. */
  warehouse?: Warehouse
  refs?: Refs
  log?: (line: string) => void
  now?: Date
  /** Learners removed with analytics:forget-user (MUL-153): never exported again. */
  suppress?: Suppression
}

export interface Suppression {
  tdUserIds: Set<number>
  appspotIds: Set<string>
}

/** Drops forgotten learners' rows: by td_user_id, and identities also by appspot_id. */
export async function* withoutForgotten(pages: AsyncIterable<Record<string, unknown>[]>, suppress: Suppression): AsyncGenerator<Record<string, unknown>[]> {
  for await (const page of pages) {
    yield page.filter((row) => {
      const td = row.td_user_id
      if (typeof td === 'number' && suppress.tdUserIds.has(td)) return false
      const appspot = row.appspot_id
      return !(typeof appspot === 'string' && suppress.appspotIds.has(appspot))
    })
  }
}

/** Writes pages of rows as NDJSON (only the spec's columns, in order); returns the row count. */
export async function writeNdjson(pages: AsyncIterable<Record<string, unknown>[]>, columns: string[], file: string) {
  const out = createWriteStream(file, { encoding: 'utf8' })
  let count = 0
  try {
    for await (const page of pages) {
      for (const row of page) {
        const picked: Record<string, unknown> = {}
        for (const c of columns) picked[c] = row[c] ?? null
        if (!out.write(`${JSON.stringify(picked)}\n`)) await once(out, 'drain')
        count++
      }
    }
  } finally {
    out.end()
    await once(out, 'close')
  }
  return count
}

export async function exportFacts(opts: ExportOptions): Promise<FactResult[]> {
  const exportedAt = (opts.now ?? new Date()).toISOString()
  const tables = opts.tables?.length ? opts.tables : [...FACT_TABLES]
  const log = opts.log ?? (() => {})
  const dir = await mkdtemp(join(tmpdir(), 'mb-facts-'))
  const results: FactResult[] = []
  try {
    for (const table of tables) {
      const spec = FACT_SPECS[table]
      try {
        const rows = await opts.source.rows(table, opts.range, exportedAt)
        if ('skipped' in rows) {
          results.push({ table, status: 'skipped', rows: 0, detail: rows.skipped })
          log(`${table}: skipped (${rows.skipped})`)
          continue
        }
        const file = join(dir, `${table}.ndjson`)
        const suppress = opts.suppress
        const kept = suppress && (suppress.tdUserIds.size || suppress.appspotIds.size) ? withoutForgotten(rows, suppress) : rows
        const count = await writeNdjson(kept, spec.columns, file)
        if (!opts.warehouse || !opts.refs) {
          results.push({ table, status: 'counted', rows: count })
          log(`${table}: ${count} rows read (dry run, nothing loaded)`)
          continue
        }
        await opts.warehouse.query(stageSql(opts.refs, table))
        try {
          if (count) await opts.warehouse.load(stageName(table), file, 'WRITE_TRUNCATE')
          const swap = swapSql(opts.refs, table, opts.range)
          await opts.warehouse.query(swap.sql, swap.params)
        } finally {
          await opts.warehouse.query(dropStageSql(opts.refs, table)).catch(() => {})
        }
        results.push({ table, status: 'loaded', rows: count })
        log(`${table}: ${count} rows loaded`)
      } catch (error) {
        const detail = String((error as Error)?.message ?? error).slice(0, 300)
        results.push({ table, status: 'failed', rows: 0, detail })
        log(`${table}: FAILED ${detail}`)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return results
}
