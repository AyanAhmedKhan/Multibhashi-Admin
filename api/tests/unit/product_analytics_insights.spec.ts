import { test } from '@japa/runner'
import { ProductInsights, change } from '#services/product_analytics/insights'
import * as Q from '#services/product_analytics/insights_sql'
import { readWarehouseConfig } from '#services/product_analytics/config'
import { Refs } from '#services/product_analytics/warehouse'
import { FakeWarehouse, TEST_CONFIG } from '#tests/unit/helpers/fake_warehouse'

const r = new Refs('test-project-123', 'product_analytics')
const RANGE = Q.dayRange(7, '2026-11-22')

/** A fake BigQuery answering by which query it is. */
function bq(answers: [RegExp | string, Record<string, unknown>[]][]) {
  return new FakeWarehouse((sql) => {
    for (const [match, rows] of answers) if (typeof match === 'string' ? sql.includes(match) : match.test(sql)) return rows
    return []
  })
}

const insightsOn = (warehouse: FakeWarehouse) => new ProductInsights({ config: TEST_CONFIG, warehouse, today: () => '2026-11-22' })

test.group('Product insights: states (MUL-152)', () => {
  test('without settings every page says "not connected" with the missing names only', async ({ assert }) => {
    const insights = new ProductInsights({ config: await readWarehouseConfig(() => undefined) })
    for (const answer of [await insights.status(), await insights.overview(RANGE), await insights.funnels(RANGE), await insights.health(RANGE)]) {
      assert.deepEqual(answer, {
        connected: false,
        missing: ['GCP_ANALYTICS_PROJECT', 'GCP_ANALYTICS_CREDENTIALS_JSON (or GCP_ANALYTICS_CREDENTIALS_FILE)'],
        problem: null,
        location: 'asia-south1',
      })
    }
  })

  test('missing tables are "not ready yet", other BigQuery errors a 502', async ({ assert }) => {
    const missing = new FakeWarehouse(() => {
      throw Object.assign(new Error('Not found: Table test-project-123:product_analytics.m_sessions was not found in location asia-south1'), { code: 404 })
    })
    const answer = await insightsOn(missing).overview(RANGE)
    assert.deepInclude(answer, { connected: true, ready: false })
    const broken = new FakeWarehouse(() => {
      throw new Error('Access Denied: User does not have bigquery.jobs.create permission')
    })
    await assert.rejects(() => insightsOn(broken).overview(RANGE), /BigQuery: Access Denied/)
  })

  test('answers are cached for the same range', async ({ assert }) => {
    const warehouse = bq([])
    const insights = insightsOn(warehouse)
    await insights.screens(RANGE)
    const after = warehouse.queries.length
    await insights.screens(RANGE)
    assert.equal(warehouse.queries.length, after)
    await insights.screens(Q.dayRange(14, '2026-11-22'))
    assert.isAbove(warehouse.queries.length, after)
  })
})

test.group('Product insights: pages (MUL-152)', () => {
  test('overview: daily series filled, totals, stickiness, activation and changes', async ({ assert }) => {
    const warehouse = bq([
      ['AS dau, COUNT(DISTINCT person) AS visitors', [{ day: { value: '2026-11-20' }, dau: 10, visitors: 14, sessions: 20, seconds: 1200 }]],
      ['AS period_active', [{ dau: 8, wau: 30, mau: 100, period_active: 30, prev_active: 25, sessions: 80, prev_sessions: 100, seconds: 48000 }]],
      ['AS signups', [{ day: { value: '2026-11-14' }, signups: 4 }, { day: { value: '2026-11-21' }, signups: 6 }]],
      ['AS activated', [{ cohort: 40, activated: 10, by_signup: 0 }]],
    ])
    const a = await insightsOn(warehouse).overview(RANGE)
    assert.isTrue(a.connected && a.ready)
    if (!a.connected || !a.ready) return
    assert.lengthOf(a.series, 7)
    assert.equal(a.series[0].day, '2026-11-16')
    assert.deepInclude(a.series[4], { day: '2026-11-20', activeLearners: 10, sessions: 20, minutes: 20 })
    assert.deepInclude(a.totals, { wau: 30, mau: 100, periodActiveChange: 20, sessionsChange: -20, avgSessionMinutes: 10, newVerified: 6, prevVerified: 4, newVerifiedChange: 50 })
    assert.deepEqual(a.totals.activation, { cohort: 40, activated: 10, rate: 25, bySignup: 0 })
    // (10 active on one day of 7) / 7 / 100 MAU
    assert.equal(a.totals.stickiness, 1.4)
    for (const q of warehouse.queries) assert.deepInclude(q.params!, { from_day: '2026-11-16', to_day: '2026-11-22', prev_from: '2026-11-09', prev_to: '2026-11-15' })
  })

  test('screens: users from merged sketches, median dwell from the summed histogram, paths', async ({ assert }) => {
    const warehouse = bq([
      ['LIMIT 80', [{ screen: 'Home', views: 100, exits: 25, prev_views: 80 }]],
      ['HLL_COUNT.MERGE(users_hll) AS users', [{ screen: 'Home', users: 40 }]],
      ['UNNEST(dwell_hist)', [0, 0, 50, 50].map((n, bucket) => ({ screen: 'Home', bucket, n }))],
      ["'in' AS direction", [{ screen: 'Home', direction: 'in', other: '(entry)', n: 60 }, { screen: 'Home', direction: 'out', other: 'Classes', n: 30 }]],
    ])
    const a = await insightsOn(warehouse).screens(RANGE)
    if (!a.connected || !a.ready) throw new Error('not ready')
    assert.deepInclude(a.screens[0], { screen: 'Home', views: 100, users: 40, exits: 25, exitRate: 25, viewsChange: 25, medianSeconds: 20 })
    assert.deepEqual(a.screens[0].into, [{ screen: '(entry)', views: 60 }])
    assert.deepEqual(a.screens[0].outOf, [{ screen: 'Classes', views: 30 }])
  })

  test('features: adoption is 7-day users over 7-day actives; the retention matrix by first feature', async ({ assert }) => {
    const warehouse = bq([
      [
        'AS users_7d',
        [
          { feature: '_active', users: 500, users_7d: 200, prev_users: 450 },
          { feature: 'ai_tutor', users: 120, users_7d: 50, prev_users: 100, uses: 360 },
        ],
      ],
      ['week_offset IN (1, 2, 4)', [{ first_feature: 'ai_tutor', week_offset: 1, cohort: 40, active: 10 }]],
    ])
    const a = await insightsOn(warehouse).features(RANGE)
    if (!a.connected || !a.ready) throw new Error('not ready')
    const tutor = a.features.find((f) => f.key === 'ai_tutor')!
    assert.deepInclude(tutor, { users: 120, prevUsers: 100, usersChange: 20, adoption: 25, usesPerUser: 3 })
    assert.equal(a.wau, 200)
    assert.deepEqual(a.retention, [{ feature: 'ai_tutor', label: 'AI tutor class', week1: { cohort: 40, rate: 25 }, week2: null, week4: null }])
  })

  test('funnels: people per step, step conversion, drop and the change against the period before', async ({ assert }) => {
    const steps = (segment: string, users: number[], prev = false) =>
      users.map((u, k) => ({ funnel: 'quiz', segment, step: k, users: u, median_gap_s: k ? 30 * k : null, prev }))
    const warehouse = new FakeWarehouse((sql) => {
      if (sql.includes("IFNULL(b.platform, '(unknown)') AS segment")) return [...steps('web', [60, 40, 20, 10]), ...steps('android', [40, 30, 20, 10])]
      if (sql.includes('CAST(@prev_from AS DATE)')) return steps('all', [80, 60, 40, 30])
      return steps('all', [100, 70, 40, 20])
    })
    const a = await insightsOn(warehouse).funnels(RANGE, 'platform', 'quiz')
    if (!a.connected || !a.ready) throw new Error('not ready')
    const quiz = a.funnels.find((f) => f.key === 'quiz')!
    assert.deepEqual(
      quiz.steps.map((s) => [s.users, s.fromPrevious, s.fromFirst, s.dropped, s.medianGapSeconds]),
      [
        [100, null, 100, 0, null],
        [70, 70, 70, 30, 30],
        [40, 57.1, 40, 30, 60],
        [20, 50, 20, 20, 90],
      ]
    )
    assert.equal(quiz.conversion, 20)
    assert.equal(quiz.conversionBefore, 37.5)
    assert.deepEqual(quiz.previous, [80, 60, 40, 30])
    assert.deepEqual(a.segments, [
      { segment: 'web', steps: [60, 40, 20, 10], conversion: 16.7 },
      { segment: 'android', steps: [40, 30, 20, 10], conversion: 25 },
    ])
    // The other funnels have no rows here: zeros, not errors.
    assert.equal(a.funnels.find((f) => f.key === 'signup')!.steps[0].users, 0)
  })

  test('drop-offs: segments for everyone, the learner list only when allowed', async ({ assert }) => {
    const answers: [string, Record<string, unknown>[]][] = [
      ["'platform' AS dimension", [{ dimension: 'platform', value: 'web', people: 7 }, { dimension: 'app_version', value: '1.0.0', people: 7 }]],
      ['i.td_user_id', [{ td_user_id: 42, signed_in: true, platform: 'web', start_date: { value: '2026-11-20' }, last_step_at: { value: '2026-11-20T10:00:00Z' } }]],
    ]
    const without = bq(answers)
    const a = await insightsOn(without).dropoffs(RANGE, 'signup', 3, false)
    if (!a.connected || !a.ready) throw new Error('not ready')
    assert.isNull(a.learners)
    assert.lengthOf(without.queries, 1)
    assert.deepInclude(a, { stoppedAfter: 'OTP requested', nextStep: 'OTP verified', total: 7 })
    assert.deepEqual(without.queries[0].params, { ...Q.rangeParams(RANGE), funnel: 'signup', reached: 3 })

    const withLearners = await insightsOn(bq(answers)).dropoffs(RANGE, 'signup', 3, true)
    if (!withLearners.connected || !withLearners.ready) throw new Error('not ready')
    assert.deepEqual(withLearners.learners, [{ tdUserId: 42, signedIn: true, platform: 'web', appVersion: null, channel: null, startDate: '2026-11-20', lastStepAt: '2026-11-20T10:00:00Z' }])
  })

  test('drop-offs refuse a step outside the funnel', async ({ assert }) => {
    const insights = insightsOn(bq([]))
    assert.throws(() => insights.dropoffs(RANGE, 'quiz', 4, false), /between 1 and 3/)
    assert.throws(() => insights.dropoffs(RANGE, 'nope', 1, false), /Unknown funnel/)
  })

  test('retention: cohorts as shares per week since sign-up, only the filters given', async ({ assert }) => {
    const warehouse = bq([
      [
        'GROUP BY cohort_week, week_offset',
        [
          { cohort_week: { value: '2026-11-09' }, week_offset: 0, cohort: 50, active: 50 },
          { cohort_week: { value: '2026-11-09' }, week_offset: 1, cohort: 50, active: 20 },
        ],
      ],
      ["'channel' AS dimension", [{ dimension: 'channel', value: 'google', people: 30 }, { dimension: 'basis', value: 'first_seen', people: 50 }]],
    ])
    const a = await insightsOn(warehouse).retention(RANGE, { channel: 'google' })
    if (!a.connected || !a.ready) throw new Error('not ready')
    assert.deepEqual(a.cohorts[0].weeks.slice(0, 3), [100, 40, null])
    assert.deepEqual(a.channels, [{ value: 'google', people: 30 }])
    const sql = warehouse.queries.find((q) => q.sql.includes('GROUP BY cohort_week, week_offset'))!
    assert.include(sql.sql, 'channel = @channel')
    assert.notInclude(sql.sql, 'first_feature = @feature')
    assert.equal(sql.params!.channel, 'google')
  })

  test('health: freshness flags anything older than 26 hours', async ({ assert }) => {
    const now = Date.now()
    const warehouse = bq([
      [
        "SELECT 'events_raw' AS source",
        [
          { source: 'events_raw', at: { value: new Date(now - 3_600_000).toISOString() } },
          { source: 'm_sessions', at: { value: new Date(now - 30 * 3_600_000).toISOString() } },
          { source: 'identities', at: null },
        ],
      ],
      ["kind = 'web_vital'", [{ name: 'LCP', events: 40, p75: 2512.4, poor_share: 0.125 }]],
    ])
    const a = await insightsOn(warehouse).health(RANGE)
    if (!a.connected || !a.ready) throw new Error('not ready')
    assert.deepEqual(a.freshness.map((f) => [f.source, f.stale]), [
      ['events_raw', false],
      ['m_sessions', true],
      ['identities', true],
    ])
    assert.deepInclude(a.vitals[0], { name: 'LCP', p75: 2512, poorShare: 12.5 })
  })
})

test.group('Product insights: SQL (MUL-152)', () => {
  const pages = () => [
    Q.activeDailySql(r),
    Q.activeTotalsSql(r),
    Q.signupsDailySql(r),
    Q.activationSql(r),
    Q.weeklyTrendSql(r),
    Q.platformsSql(r),
    Q.screensSql(r),
    Q.screenUsersSql(r),
    Q.dwellSql(r),
    Q.pathsSql(r),
    Q.featuresSql(r),
    Q.featureRetentionSql(r),
    Q.funnelStepsSql(r, 'channel', 6),
    Q.dropoffSegmentsSql(r),
    Q.dropoffLearnersSql(r),
    Q.retentionSql(r, { basis: 'signup', channel: 'x', feature: 'y' }),
    ...Object.values(Q.healthSql(r)),
  ]

  test('pages read the modelled tables, never the raw events (DESIGN §9)', ({ assert }) => {
    for (const sql of pages()) assert.notInclude(sql, 'events_raw', sql)
    assert.include(Q.freshnessSql(r), "event_date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 3 DAY)")
  })

  test('values are parameters, never spliced in', ({ assert }) => {
    const sql = Q.retentionSql(r, { basis: "x' OR TRUE --", channel: 'a', feature: 'b' })
    assert.notInclude(sql, "x' OR TRUE")
    assert.include(Q.dropoffSegmentsSql(r), 'funnel = @funnel')
    assert.include(Q.dropoffSegmentsSql(r), 'b.steps_reached = @reached')
  })

  test('funnels count each person once, at their furthest run in the period', ({ assert }) => {
    const sql = Q.funnelStepsSql(r, null, 6)
    assert.include(sql, 'ORDER BY steps_reached DESC, start_date DESC LIMIT 1)[OFFSET(0)] AS b')
    assert.include(sql, 'GROUP BY funnel, person')
    assert.include(sql, 'COUNTIF(b.steps_reached > k) AS users')
    assert.include(sql, 'GENERATE_ARRAY(0, 5)')
    assert.include(Q.funnelStepsPrevSql(r, 6), 'WHERE start_date BETWEEN CAST(@prev_from AS DATE) AND CAST(@prev_to AS DATE)')
  })

  test('the learner drop-off list carries teachers-dashboard ids only', ({ assert }) => {
    const sql = Q.dropoffLearnersSql(r)
    assert.include(sql, 'LEFT JOIN `test-project-123.product_analytics.identities` i ON i.appspot_id = b.user_id')
    assert.notMatch(sql, /SELECT[^;]*\bb\.user_id\s*,/)
    assert.include(sql, 'LIMIT 50')
  })

  test('ranges and changes', ({ assert }) => {
    assert.deepEqual(Q.dayRange(30, '2026-11-22'), { from: '2026-10-24', to: '2026-11-22', prevFrom: '2026-09-24', prevTo: '2026-10-23', days: 30 })
    assert.equal(change(120, 100), 20)
    assert.isNull(change(5, 0))
    assert.equal(change(0, 0), 0)
  })
})
