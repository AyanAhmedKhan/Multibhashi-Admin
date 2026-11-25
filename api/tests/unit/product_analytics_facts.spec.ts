import { test } from '@japa/runner'
import { FACT_TABLES, columnsOf, loadDdlFiles, setupPlan } from '#services/product_analytics/ddl'
import {
  FACT_SPECS,
  attendanceFact,
  bookingFact,
  exportFacts,
  istWallToIso,
  label,
  msToIso,
  paymentFact,
  quizAttemptFact,
  resolveRange,
  swapSql,
  tutorSessionFact,
  userFact,
  type FactRange,
  type FactSource,
  type FactTable,
} from '#services/product_analytics/facts'
import {
  bounds,
  attendanceSql,
  ATTENDANCE_SOURCES,
  bookingsSql,
  identitiesSql,
  leadsSql,
  paymentsSql,
  quizLogsSql,
  tutorChatsSql,
  usersSql,
  verifiedInRangeSql,
  type Schema,
} from '#services/product_analytics/facts_mysql'
import { Refs } from '#services/product_analytics/warehouse'
import { FakeWarehouse } from '#tests/unit/helpers/fake_warehouse'

const refs = new Refs('test-project-123', 'product_analytics')
const RANGE: FactRange = { from: '2026-11-18', to: '2026-11-24', full: false }
const AT = '2026-11-25T00:00:00.000Z'

const schemaOf = (tables: Record<string, string[]>): Schema => new Map(Object.entries(tables).map(([t, cols]) => [t, new Set(cols)]))

/** A monolith schema that also holds personal columns: none of them may be selected. */
const SCHEMA = schemaOf({
  users: ['id', 'created_at', 'country_code', 'phone', 'email', 'name', 'password'],
  student_sessions: ['id', 'user_id', 'started_at'],
  direct_leads: ['id', 'user_id', 'utm_source', 'utm_medium', 'utm_campaign', 'source', 'phone', 'email', 'name'],
  course_bookings: ['id', 'user_id', 'created_at', 'course_id', 'course_type', 'booking_type', 'booking_status', 'state', 'booking_entry', 'rate', 'currency', 'expiry_date', 'utm_source'],
  transactions: ['id', 'user_id', 'course_booking_id', 'created_at', 'amount', 'payment_status', 'payment_method', 'razorpay_id'],
  webinar_class_attendances: ['id', 'user_id', 'webinar_class_id', 'created_at'],
  webinar_classes: ['id', 'slot'],
  webinar_class_user_logs: ['id', 'user_id', 'webinar_class_id', 'created_at'],
  session_call_user_logs: ['id', 'user_id', 'session_call_id', 'created_at'],
  user_quiz_logs: ['id', 'user_id', 'quiz_id', 'created_at', 'quiz_start_timestamp', 'is_quiz_finised', 'total_questions', 'total_correct_answer'],
  ai_tutor_chats: ['id', 'user_id', 'quiz_id', 'status', 'chat_start_timestamp', 'time_spent', 'created_at', 'updated_at'],
  learner_accounts: ['id', 'appspot_user_id', 'td_user_id', 'status', 'created_at', 'phone_e164', 'name'],
})

const PERSONAL = /\b(phone|phone_e164|email|name|password|answer|razorpay_id\s+AS)\b|\bu\.name|\bl\.phone/i

async function ddlColumns(table: string) {
  const statement = setupPlan(await loadDdlFiles(), { project: 'test-project-123', dataset: 'product_analytics', location: 'asia-south1' }).find(
    (s) => s.kind === 'table' && s.object.endsWith(`.${table}`)
  )!
  return columnsOf(statement.sql).map((c) => c.name)
}

test.group('Business facts: definitions (MUL-149)', () => {
  test('each fact writes exactly its DDL columns, in order, with the contract keys', async ({ assert }) => {
    for (const table of FACT_TABLES) assert.deepEqual(FACT_SPECS[table].columns, await ddlColumns(table), table)
    assert.equal(FACT_SPECS.fact_users.key, 'td_user_id')
    assert.equal(FACT_SPECS.identities.mode, 'full')
  })

  test('DATETIMEs are read as IST wall-clock; zero dates and bad epochs are null', ({ assert }) => {
    assert.equal(istWallToIso('2026-11-24 05:30:00'), '2026-11-24T00:00:00.000Z')
    assert.isNull(istWallToIso('0000-00-00 00:00:00'))
    assert.isNull(istWallToIso(null))
    assert.equal(msToIso(1764000000000), new Date(1764000000000).toISOString())
    assert.isNull(msToIso(0))
    assert.isNull(msToIso(1764000000)) // seconds, not ms
  })

  test('labels drop anything that looks like a phone number or an e-mail', ({ assert }) => {
    assert.equal(label(' google '), 'google')
    assert.isNull(label('+919876543210'))
    assert.isNull(label('someone@example.com'))
    assert.isNull(label(''))
  })

  test('users: verified means an app session exists; country and first lead UTM', ({ assert }) => {
    const verified = userFact({ id: 7, created_at: '2026-11-20 23:30:00', country_code: 'in' }, 1763700000000, { utm_source: 'google', source: 'website' }, AT)
    assert.deepInclude(verified, { td_user_id: 7, created_date: '2026-11-20', verified: true, country_code: 'IN', utm_source: 'google', lead_source: 'website', exported_at: AT })
    const otpOnly = userFact({ id: 8, created_at: '2026-11-20 10:00:00', country_code: '' }, null, undefined, AT)
    assert.deepInclude(otpOnly, { verified: false, verified_at: null, country_code: null, utm_source: null })
  })

  test('bookings: paid by booking type, else by a positive rate on untyped rows', ({ assert }) => {
    assert.isTrue(bookingFact({ id: 1, user_id: 2, booking_type: 'paid_new', rate: 999 }, AT).paid)
    assert.isFalse(bookingFact({ id: 1, user_id: 2, booking_type: 'free', rate: 999 }, AT).paid)
    assert.isTrue(bookingFact({ id: 1, user_id: 2, booking_type: null, rate: '499.00' }, AT).paid)
    assert.deepInclude(bookingFact({ id: 1, user_id: 2, rate: 499, currency: 'inr', expiry_date: 1764000000000 }, AT), { amount: '499.00', currency: 'INR' })
  })

  test('payments: captured_at is the booking time just before the transaction, never a far older booking', ({ assert }) => {
    const p = paymentFact({ id: 3, user_id: 2, created_at: '2026-11-24 10:00:05', booking_created_at: '2026-11-24 10:00:01', payment_status: 'success', amount: 499, gateway_verified: 1, gateway_ref_hash: 'abc' }, AT)
    assert.deepInclude(p, { captured: true, captured_at: '2026-11-24T04:30:01.000Z', created_date: '2026-11-24', currency: 'INR', gateway_verified: true })
    const old = paymentFact({ id: 4, created_at: '2026-11-24 10:00:05', booking_created_at: '2026-10-01 10:00:00', payment_status: 'success' }, AT)
    assert.equal(old.captured_at, old.created_at)
    assert.isFalse(paymentFact({ id: 5, created_at: '2026-11-24 10:00:05', payment_status: 'failed' }, AT).captured)
  })

  test('attendance, quiz attempts and tutor sessions', ({ assert }) => {
    assert.deepInclude(attendanceFact('session_join', { id: 9, user_id: 2, class_id: 44, created_at: '2026-11-24 18:00:00', slot: 1764000000000 }, AT), {
      attendance_key: 'session_join:9',
      class_type: 'session',
      source: 'join_log',
      activity_date: '2026-11-24',
    })
    assert.equal(attendanceFact('webinar_attendance', { id: 1, created_at: '2026-11-24 18:00:00' }, AT).source, 'attendance')
    const q = quizAttemptFact('course', { id: 5, user_id: 2, quiz_id: 3, created_at: '2026-11-24 09:00:00', quiz_start_timestamp: 0, total_questions: 8, total_correct_answer: 6, is_quiz_finised: 1 }, AT)
    assert.deepInclude(q, { attempt_key: 'course:5', finished: true, score_pct: 75, started_at: '2026-11-24T03:30:00.000Z', activity_date: '2026-11-24' })
    const t = tutorSessionFact({ id: 11, user_id: 2, chat_start_timestamp: Date.parse('2026-11-24T06:00:00Z'), time_spent: 12, created_at: '2026-11-01 10:00:00' }, { language: 'hi', learner: 9, tutor: 10 }, AT)
    assert.deepInclude(t, { chat_id: 11, minutes: 12, language: 'hi', learner_turns: 9, tutor_turns: 10, activity_date: '2026-11-24' })
  })

  test('range: the last 7 days by default; future and reversed ranges are refused', ({ assert }) => {
    assert.deepEqual(resolveRange({}, '2026-11-24'), { from: '2026-11-18', to: '2026-11-24', full: false })
    assert.deepEqual(resolveRange({ from: '2026-11-01', to: '2026-11-02', full: true }, '2026-11-24'), { from: '2026-11-01', to: '2026-11-02', full: true })
    assert.throws(() => resolveRange({ to: '2026-11-25' }, '2026-11-24'), /future/)
    assert.throws(() => resolveRange({ from: '2026-11-03', to: '2026-11-02' }, '2026-11-24'), /from on or before/)
    assert.throws(() => resolveRange({ from: '2026-13-01' }, '2026-11-24'), /YYYY-MM-DD/)
  })

  test('bounds: IST wall-clock text for DATETIMEs and epoch ms for the activity tables', ({ assert }) => {
    const b = bounds(RANGE)
    assert.equal(b.since, '2026-11-18 00:00:00')
    assert.equal(b.until, '2026-11-25 00:00:00')
    assert.equal(new Date(b.sinceMs).toISOString(), '2026-11-17T18:30:00.000Z')
    assert.equal(b.untilMs - b.sinceMs, 7 * 86_400_000)
  })
})

test.group('Business facts: MySQL queries (MUL-149)', () => {
  const all = (range: FactRange) => [
    usersSql(SCHEMA, range),
    leadsSql(SCHEMA, 3),
    bookingsSql(SCHEMA, range),
    paymentsSql(SCHEMA, range),
    ...ATTENDANCE_SOURCES.map((s) => attendanceSql(SCHEMA, s, range)),
    quizLogsSql(SCHEMA, 'user_quiz_logs', range),
    tutorChatsSql(SCHEMA, range).sql,
    identitiesSql(SCHEMA)!,
    verifiedInRangeSql,
  ]

  test('no query selects a phone, e-mail, name, password, answer or the raw payment id', ({ assert }) => {
    for (const sql of [...all(RANGE), ...all({ ...RANGE, full: true })]) assert.notMatch(sql, PERSONAL, sql)
  })

  test('ranged queries filter on created_at; full ones do not; all page by id', ({ assert }) => {
    assert.include(usersSql(SCHEMA, RANGE), 'WHERE u.id > ? AND u.created_at >= ? AND u.created_at < ?')
    assert.include(usersSql(SCHEMA, { ...RANGE, full: true }), 'WHERE u.id > ?\nORDER BY u.id')
    for (const sql of all(RANGE).slice(2, 8)) assert.match(sql, /ORDER BY [a-z]\.id\nLIMIT 5000$/)
  })

  test('payments keep only a verdict and a hash of the Razorpay id', ({ assert }) => {
    const sql = paymentsSql(SCHEMA, RANGE)
    assert.include(sql, "t.razorpay_id REGEXP '^pay_[A-Za-z0-9]{14}$' AS gateway_verified")
    assert.include(sql, 'LEFT(SHA2(t.razorpay_id, 256), 16) AS gateway_ref_hash')
    assert.include(sql, 'LEFT JOIN course_bookings b ON b.id = t.course_booking_id')
  })

  test('missing optional columns read as NULL instead of failing', ({ assert }) => {
    const bare = schemaOf({ users: ['id', 'created_at'], transactions: ['id', 'user_id', 'created_at'] })
    assert.include(usersSql(bare, RANGE), 'NULL AS country_code')
    const p = paymentsSql(bare, RANGE)
    assert.include(p, 'NULL AS booking_created_at')
    assert.include(p, '0 AS gateway_verified')
    assert.notInclude(p, 'JOIN')
  })

  test('identities: appspot_user_id, else appspot_id, else nothing', ({ assert }) => {
    assert.include(identitiesSql(SCHEMA)!, 'a.appspot_user_id AS appspot_id')
    assert.include(identitiesSql(schemaOf({ learner_accounts: ['id', 'appspot_id', 'created_at'] }))!, 'a.appspot_id AS appspot_id')
    assert.isNull(identitiesSql(schemaOf({ learner_accounts: ['id', 'created_at'] })))
  })

  test('tutor chats: created or changed in the range, with matching bindings', ({ assert }) => {
    const q = tutorChatsSql(SCHEMA, RANGE)
    assert.include(q.sql, '(c.updated_at >= ? AND c.updated_at < ?)')
    assert.lengthOf(q.bind(0, 'a', 'b'), 5)
    assert.equal((q.sql.match(/\?/g) ?? []).length, 5)
    const noUpdated = tutorChatsSql(schemaOf({ ai_tutor_chats: ['id', 'user_id', 'created_at'] }), RANGE)
    assert.equal((noUpdated.sql.match(/\?/g) ?? []).length, noUpdated.bind(0, 'a', 'b').length)
  })
})

/** A source that serves fixed rows, or a skip, per table. */
function source(rows: Partial<Record<FactTable, Record<string, unknown>[] | { skipped: string } | Error>>): FactSource {
  return {
    async rows(table) {
      const r = rows[table]
      if (r instanceof Error) throw r
      if (!r) return { skipped: 'not in this test' }
      if (!Array.isArray(r)) return r
      return (async function* () {
        yield r
      })()
    },
  }
}

test.group('Business facts: loading into BigQuery (MUL-149)', () => {
  const user = userFact({ id: 7, created_at: '2026-11-20 10:00:00' }, 1763700000000, undefined, AT)

  test('a range: stage, load, one transaction (delete the range and re-exported keys, insert), drop the stage', async ({ assert }) => {
    const bq = new FakeWarehouse()
    const results = await exportFacts({ range: RANGE, tables: ['fact_users'], source: source({ fact_users: [{ ...user, extra: 'dropped' }] }), warehouse: bq, refs, now: new Date(AT) })
    assert.deepEqual(results, [{ table: 'fact_users', status: 'loaded', rows: 1 }])
    assert.lengthOf(bq.queries, 3)
    assert.include(bq.sql[0], 'CREATE OR REPLACE TABLE `test-project-123.product_analytics._stage_fact_users` LIKE `test-project-123.product_analytics.fact_users`')
    assert.deepEqual(bq.loads, [{ table: '_stage_fact_users', write: 'WRITE_TRUNCATE', rows: [user] }])
    assert.include(bq.sql[1], 'BEGIN TRANSACTION;')
    assert.include(bq.sql[1], 'DELETE FROM `test-project-123.product_analytics.fact_users` WHERE (created_date BETWEEN CAST(@from_day AS DATE) AND CAST(@to_day AS DATE)) OR td_user_id IN (SELECT td_user_id FROM `test-project-123.product_analytics._stage_fact_users`);')
    assert.include(bq.sql[1], 'COMMIT TRANSACTION;')
    assert.deepEqual(bq.queries[1].params, { from_day: '2026-11-18', to_day: '2026-11-24' })
    assert.equal(bq.sql[2], 'DROP TABLE IF EXISTS `test-project-123.product_analytics._stage_fact_users`')
  })

  test('re-running the same range sends exactly the same work (idempotent)', async ({ assert }) => {
    const run = async () => {
      const bq = new FakeWarehouse()
      await exportFacts({ range: RANGE, source: source({ fact_users: [user], fact_payments: [] }), warehouse: bq, refs, now: new Date(AT) })
      return { queries: bq.queries, loads: bq.loads }
    }
    assert.deepEqual(await run(), await run())
  })

  test('an empty range still clears it (rows deleted in MySQL disappear), without a load job', async ({ assert }) => {
    const bq = new FakeWarehouse()
    await exportFacts({ range: RANGE, tables: ['fact_bookings'], source: source({ fact_bookings: [] }), warehouse: bq, refs })
    assert.lengthOf(bq.loads, 0)
    assert.include(bq.sql[1], 'DELETE FROM `test-project-123.product_analytics.fact_bookings` WHERE (created_date BETWEEN')
  })

  test('--full and identities replace the whole table; tutor sessions replace by key only', async ({ assert }) => {
    const full = swapSql(refs, 'fact_quiz_attempts', { ...RANGE, full: true })
    assert.include(full.sql, 'WHERE TRUE;')
    assert.deepEqual(full.params, {})
    assert.include(swapSql(refs, 'identities', RANGE).sql, 'WHERE TRUE;')
    const keys = swapSql(refs, 'fact_tutor_sessions', RANGE)
    assert.include(keys.sql, 'WHERE chat_id IN (SELECT chat_id FROM `test-project-123.product_analytics._stage_fact_tutor_sessions`);')
    assert.notInclude(keys.sql, 'BETWEEN')
  })

  test('a missing source table is skipped; a failing table is reported and the others still load', async ({ assert }) => {
    const bq = new FakeWarehouse((sql) => {
      if (sql.includes('BEGIN TRANSACTION') && sql.includes('fact_bookings')) throw new Error('Quota exceeded')
      return []
    })
    const results = await exportFacts({
      range: RANGE,
      tables: ['identities', 'fact_bookings', 'fact_users'],
      source: source({ identities: { skipped: 'learner_accounts does not exist yet' }, fact_bookings: [bookingFact({ id: 1, user_id: 2 }, AT)], fact_users: [user] }),
      warehouse: bq,
      refs,
    })
    assert.deepEqual(
      results.map((r) => [r.table, r.status]),
      [
        ['identities', 'skipped'],
        ['fact_bookings', 'failed'],
        ['fact_users', 'loaded'],
      ]
    )
    assert.match(results[1].detail!, /Quota exceeded/)
    // The failed table's stage is still dropped.
    assert.include(bq.sql, 'DROP TABLE IF EXISTS `test-project-123.product_analytics._stage_fact_bookings`')
  })

  test('a source error never touches BigQuery for that table', async ({ assert }) => {
    const bq = new FakeWarehouse()
    const results = await exportFacts({ range: RANGE, tables: ['fact_payments'], source: source({ fact_payments: new Error('MySQL gone away') }), warehouse: bq, refs })
    assert.equal(results[0].status, 'failed')
    assert.lengthOf(bq.queries, 0)
  })

  test('a dry run reads and counts without a warehouse', async ({ assert }) => {
    const results = await exportFacts({ range: RANGE, tables: ['fact_users'], source: source({ fact_users: [user, user] }) })
    assert.deepEqual(results, [{ table: 'fact_users', status: 'counted', rows: 2 }])
  })
})
