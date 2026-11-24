import { test } from '@japa/runner'
import { CONCEPTS, REQUIRED_STREAK, bigqueryEventsSql, bigquerySessionsSql, compare, dayOf, daysOf, mysqlEventsSql, mysqlSessionsSql, readBigQuery, toSide } from '#services/product_analytics/parity'
import { Refs } from '#services/product_analytics/warehouse'
import { FakeWarehouse } from '#tests/unit/helpers/fake_warehouse'

const r = new Refs('test-project-123', 'product_analytics')
const RANGE = { from: '2026-11-01', to: '2026-11-14' }

/** The same daily figures on both sides, with BigQuery scaled by `ratio`. */
function sides(ratio: (day: string) => number) {
  const days = daysOf(RANGE)
  const mysqlEvents = days.flatMap((day, i) => [
    { day: 20758 + i, event_type: 'quiz_start', n: 100 },
    { day: 20758 + i, event_type: 'quiz_completed', n: 50 },
  ])
  const mysqlSessions = days.map((_, i) => ({ day: `${20758 + i}`, learners: 200, sessions: 300, seconds: 60_000 }))
  const bqEvents = days.flatMap((day) => [
    { day: { value: day }, event_name: 'quiz_opened', n: Math.round(100 * ratio(day)) },
    { day: { value: day }, event_name: 'quiz_completed', n: Math.round(50 * ratio(day)) },
  ])
  const bqSessions = days.map((day) => ({ day: { value: day }, learners: Math.round(200 * ratio(day)), sessions: 330, seconds: 66_000 }))
  return { mysql: toSide('mysql', mysqlEvents, mysqlSessions), bigquery: toSide('bigquery', bqEvents, bqSessions) }
}

test.group('analytics:parity (MUL-155)', () => {
  test('the overlapping concepts: old activity types against the bridged event names', ({ assert }) => {
    const byKey = new Map(CONCEPTS.map((c) => [c.key, c]))
    assert.deepEqual(byKey.get('quiz_opened')!.mysql, { events: ['quiz_start'] })
    assert.deepEqual(byKey.get('quiz_opened')!.bigquery, { events: ['quiz_opened'] })
    assert.deepEqual(byKey.get('recording_played')!.mysql, { events: ['video_play'] })
    assert.deepEqual(byKey.get('active_learners')!.mysql, { sessions: 'learners' })
    assert.isTrue(byKey.get('app_minutes')!.gates, 'time in app is what moves')
    assert.isFalse(byKey.get('sessions')!.gates, 'the two session definitions differ')
  })

  test('MySQL day numbers (numbers or DECIMAL strings) and BigQuery dates land on the same IST day', ({ assert }) => {
    assert.equal(dayOf(20758), '2026-11-01')
    assert.equal(dayOf('20758'), '2026-11-01')
    assert.equal(dayOf('20758.0'), '2026-11-01')
    assert.equal(dayOf({ value: '2026-11-01' }), '2026-11-01')
  })

  test('matching figures are within tolerance day after day; a concept without data is not compared', ({ assert }) => {
    const { mysql, bigquery } = sides(() => 1.04)
    const result = compare(mysql, bigquery, RANGE)
    const opened = result.concepts.find((c) => c.key === 'quiz_opened')!
    assert.equal(opened.compared, 14)
    assert.equal(opened.within, 14)
    assert.equal(opened.streak, 14)
    assert.equal(opened.maxAbsDiffPct, 4)
    // Minutes: 1,000 vs 1,100 (+10%), within ±25%; recordings: no data on either side, not compared.
    assert.equal(result.concepts.find((c) => c.key === 'app_minutes')!.maxAbsDiffPct, 10)
    assert.equal(result.concepts.find((c) => c.key === 'recording_played')!.compared, 0)
  })

  test('the streak counts back from the last day and breaks on a miss or a gap', ({ assert }) => {
    const { mysql, bigquery } = sides((day) => (day === '2026-11-10' ? 0.7 : 1))
    const result = compare(mysql, bigquery, RANGE)
    const learners = result.concepts.find((c) => c.key === 'active_learners')!
    assert.equal(learners.streak, 4) // 11–14 November
    assert.equal(learners.within, 13)
    assert.isFalse(result.ready)
    assert.include(result.blocking, 'active_learners')
    // recording_played gates too, and never had data: retirement can't be declared without it.
    assert.include(result.blocking, 'recording_played')
    assert.equal(REQUIRED_STREAK, 14)
  })

  test('a day with data on one side only is a 100% miss (or n/a when MySQL has none)', ({ assert }) => {
    const mysql = new Map([['quiz_completed', new Map([['2026-11-14', 10]])]])
    const bigquery = new Map([['quiz_completed', new Map([['2026-11-13', 10]])]])
    const c = compare(mysql, bigquery, RANGE).concepts.find((x) => x.key === 'quiz_completed')!
    assert.deepEqual(
      c.days.map((d) => [d.day, d.diffPct, d.ok]),
      [
        ['2026-11-13', null, false],
        ['2026-11-14', -100, false],
      ]
    )
  })

  test('queries: indexed MySQL filters, BigQuery partition filters and typed names', async ({ assert }) => {
    assert.include(mysqlEventsSql(), 'WHERE event_type IN (?')
    assert.include(mysqlEventsSql(), 'AND created_at_ms >= ? AND created_at_ms < ?')
    assert.include(mysqlSessionsSql(), 'WHERE started_at >= ? AND started_at < ?')
    assert.include(bigqueryEventsSql(r), 'WHERE event_date BETWEEN CAST(@from_day AS DATE) AND CAST(@to_day AS DATE) AND event_name IN UNNEST(@names)')
    assert.include(bigquerySessionsSql(r), 'COUNT(DISTINCT user_id) AS learners')
    const bq = new FakeWarehouse()
    await readBigQuery(RANGE, bq, r)
    assert.deepEqual(bq.queries[0].types, { names: ['STRING'] })
    assert.includeMembers(bq.queries[0].params!.names as string[], ['quiz_opened', 'quiz_completed', 'recording_played', 'quiz_question_shown'])
    assert.notInclude(bq.queries[0].params!.names as string[], 'quiz_start')
  })
})
