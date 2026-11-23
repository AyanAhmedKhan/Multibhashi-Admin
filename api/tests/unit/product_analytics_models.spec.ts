import { test } from '@japa/runner'
import { orderedFunnel, type FunnelStep } from '#services/analytics/funnel'
import { DAY_MS, IST_OFFSET_MS, istDayOf, istDayStart } from '#helpers/ist'
import { DWELL_EDGES, FEATURES, FUNNELS, FUNNEL_BY_KEY, MAX_WINDOW_DAYS, featureCase } from '#services/product_analytics/catalog'
import {
  MODEL_STEPS,
  checkSql,
  dwellHistogram,
  featureDailySql,
  funnelSql,
  funnelsSql,
  healthDailySql,
  identityLinksSql,
  retentionSql,
  runModels,
  screenDailySql,
  sessionsSql,
  stepCase,
  userFirstsSql,
  yesterdayIst,
} from '#services/product_analytics/models'
import { Refs } from '#services/product_analytics/warehouse'
import { FakeWarehouse } from '#tests/unit/helpers/fake_warehouse'

const r = new Refs('test-project-123', 'product_analytics')
const T = (name: string) => `\`test-project-123.product_analytics.${name}\``

/**
 * The funnel SQL's algorithm, transcribed CTE by CTE (models.ts funnelSql): `starts` (person,
 * IST day of a step-0 event in [fromDay, toDay]); `runs` (that day's step-0 events and later
 * steps before day + window + 1); then per run, in (ts, step) order, level k:
 *   v_k = step = k and s_{k-1} exists and ts - s_{k-1} <= window ? s_{k-1} : null   (v_0 = ts of step 0)
 *   s_k = running MAX(v_k) up to and including the row;  t_k = running MAX(ts where v_k)
 *   g_k = ts - t_{k-1} where v_k (the time between steps)
 * steps_reached = 1 + the highest k with any v_k. A person's funnel = their best run.
 */
type Ev = { person: string; ts: number; step: number }
function sqlReference(events: Ev[], n: number, windowDays: number, fromDay: number, toDay: number) {
  const windowMs = windowDays * DAY_MS
  const starts = new Map<string, { person: string; day: number }>()
  for (const e of events) {
    const day = istDayOf(e.ts)
    if (e.step === 0 && day >= fromDay && day <= toDay) starts.set(`${e.person}|${day}`, { person: e.person, day })
  }
  const runs: { person: string; day: number; reached: number; gaps: (number | null)[] }[] = []
  for (const { person, day } of starts.values()) {
    const rows = events
      .filter((e) => e.person === person)
      .filter((e) => (e.step === 0 ? istDayOf(e.ts) === day : e.ts >= istDayStart(day) && e.ts < istDayStart(day + windowDays + 1)))
      .sort((a, b) => a.ts - b.ts || a.step - b.step)
    const s: (number | null)[] = new Array(n).fill(null)
    const t: (number | null)[] = new Array(n).fill(null)
    const valid: boolean[] = new Array(n).fill(false)
    const gaps: (number | null)[] = new Array(n).fill(null)
    for (const row of rows) {
      // Window MAX(...) over rows up to the current one: levels are evaluated on the row in order.
      let v: number | null = null
      if (row.step === 0) v = row.ts
      else {
        const from = s[row.step - 1]
        if (from !== null && row.ts - from <= windowMs) v = from
      }
      if (v === null) continue
      if (row.step > 0 && gaps[row.step] === null) gaps[row.step] = (row.ts - t[row.step - 1]!) / 1000
      valid[row.step] = true
      s[row.step] = s[row.step] === null ? v : Math.max(s[row.step]!, v)
      t[row.step] = t[row.step] === null ? row.ts : Math.max(t[row.step]!, row.ts)
    }
    runs.push({ person, day, reached: valid.lastIndexOf(true) + 1, gaps })
  }
  const best = new Map<string, number>()
  for (const run of runs) best.set(run.person, Math.max(best.get(run.person) ?? 0, run.reached))
  return { runs, counts: Array.from({ length: n }, (_, k) => [...best.values()].filter((b) => b > k).length) }
}

/** A seeded PRNG, so a failure can be replayed. */
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const STEPS4: FunnelStep[] = ['a', 'b', 'c', 'd'].map((t, i) => ({ step: `step ${i}`, types: [t] }))
const day0 = istDayOf(Date.parse('2026-11-02T12:00:00+05:30'))
const at = (day: number, hour = 12) => istDayStart(day0 + day) + hour * 3_600_000

test.group('Funnel SQL semantics = funnel.ts (MUL-151)', () => {
  test('the funnel.ts cases give the same counts through the SQL algorithm', ({ assert }) => {
    const cases: [Ev[], number[], number][] = [
      [[0, 1, 2, 3].map((step, i) => ({ person: '1', ts: at(i === 3 ? 2 : i), step })), [1, 1, 1, 1], 7],
      [[{ person: '1', ts: at(0), step: 2 }, { person: '1', ts: at(0, 13), step: 3 }, { person: '1', ts: at(1), step: 0 }, { person: '1', ts: at(2), step: 1 }], [1, 1, 0, 0], 7],
      [[{ person: '1', ts: at(0), step: 0 }, { person: '1', ts: at(8), step: 1 }], [1, 0, 0, 0], 7],
      [[{ person: '1', ts: at(0), step: 0 }, { person: '1', ts: at(6), step: 0 }, { person: '1', ts: at(7), step: 1 }, { person: '1', ts: at(12), step: 2 }], [1, 1, 1, 0], 7],
      [[{ person: '1', ts: at(0), step: 1 }, { person: '1', ts: at(0), step: 0 }], [1, 1, 0, 0], 7],
    ]
    for (const [events, expected, windowDays] of cases) {
      assert.deepEqual(sqlReference(events, 4, windowDays, day0 - 1, day0 + 30).counts, expected)
    }
  })

  test('on 400 random event sets, the per-start-day SQL algorithm equals orderedFunnel()', ({ assert }) => {
    const random = rng(20261124)
    const deepest = [0, 0, 0, 0]
    for (let iteration = 0; iteration < 400; iteration++) {
      const windowDays = 1 + Math.floor(random() * 3)
      const fromDay = day0
      const toDay = day0 + 4
      const events: Ev[] = []
      const people = 1 + Math.floor(random() * 4)
      for (let p = 0; p < people; p++) {
        const count = Math.floor(random() * 14)
        for (let i = 0; i < count; i++) {
          const step = Math.floor(random() * 4)
          // Starts only inside the range (the SQL's start days); later steps up to the window after it.
          const span = step === 0 ? 5 : 5 + windowDays + 1
          events.push({ person: String(p), step, ts: istDayStart(fromDay) + Math.floor(random() * span * 24) * 3_600_000 })
        }
      }
      const expected = orderedFunnel(
        events.map((e) => ({ userId: Number(e.person), type: 'abcd'[e.step], at: e.ts })),
        STEPS4,
        windowDays * DAY_MS
      ).map((s) => s.users)
      assert.deepEqual(sqlReference(events, 4, windowDays, fromDay, toDay).counts, expected, `iteration ${iteration}`)
      expected.forEach((n, k) => (deepest[k] += n))
    }
    // Not vacuous: plenty of runs reach every step, and fewer reach each later one.
    assert.isAtLeast(deepest[3], 10)
    assert.isAbove(deepest[0], deepest[3])
  })

  test('time between steps runs from the latest previous step, so a repeated step does not inflate it', ({ assert }) => {
    const minute = 60_000
    const events: Ev[] = [
      { person: 'x', ts: at(0), step: 0 },
      { person: 'x', ts: at(0) + 5 * minute, step: 1 }, // otp requested
      { person: 'x', ts: at(0) + 30 * minute, step: 1 }, // requested again
      { person: 'x', ts: at(0) + 31 * minute, step: 2 }, // verified a minute later
    ]
    const { runs } = sqlReference(events, 3, 1, day0, day0)
    assert.deepEqual(runs[0].gaps.slice(1), [300, 60])
    assert.equal(runs[0].reached, 3)
  })

  test('the funnel SQL encodes exactly that algorithm', ({ assert }) => {
    const sql = funnelSql(r, FUNNEL_BY_KEY.get('signup')!)
    const w = 'PARTITION BY person, run_scope, start_date ORDER BY ts, step ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW'
    assert.include(sql, `WINDOW w AS (${w})`)
    assert.include(sql, 'l0 AS (SELECT *, IF(step = 0, ts, NULL) AS v0 FROM runs)')
    assert.include(sql, 'IF(step = 1 AND s0 IS NOT NULL AND TIMESTAMP_DIFF(ts, s0, MILLISECOND) <= 604800000, s0, NULL) AS v1')
    assert.include(sql, 'MAX(v4) OVER w AS s4, MAX(IF(v4 IS NOT NULL, ts, NULL)) OVER w AS t4')
    assert.include(sql, 'TIMESTAMP_DIFF(ts, t4, SECOND), NULL) AS g5')
    assert.include(sql, "WHERE step = 0 AND DATE(ts, 'Asia/Kolkata') BETWEEN DATE_SUB(CAST(@run_date AS DATE), INTERVAL 8 DAY) AND CAST(@run_date AS DATE)")
    assert.include(sql, "(e.step = 0 AND DATE(e.ts, 'Asia/Kolkata') = s.start_date)")
    assert.include(sql, "e.ts < TIMESTAMP(DATE_ADD(s.start_date, INTERVAL 8 DAY), 'Asia/Kolkata')")
    assert.include(sql, 'CASE WHEN COUNTIF(v5 IS NOT NULL) > 0 THEN 6 WHEN COUNTIF(v4 IS NOT NULL) > 0 THEN 5')
    assert.include(sql, 'IFNULL(e.opted_out, FALSE) = FALSE')
    // The pre-login steps join the learner through the identity links.
    assert.include(sql, `LEFT JOIN ${T('m_identity_links')} l ON l.anonymous_id = e.anonymous_id`)
  })
})

test.group('Funnel definitions (DESIGN §7)', () => {
  test('the five funnels, their windows and steps', ({ assert }) => {
    assert.deepEqual(
      FUNNELS.map((f) => [f.key, f.windowDays, f.steps.length]),
      [
        ['signup', 7, 6],
        ['ai_tutor', 1, 6],
        ['live_class', 1, 3],
        ['quiz', 1, 4],
        ['purchase', 3, 5],
      ]
    )
    assert.equal(MAX_WINDOW_DAYS, 7)
    for (const f of FUNNELS) {
      const names = f.steps.flatMap((s) => s.events ?? [])
      assert.equal(new Set(names).size, names.length, `${f.key}: an event may map to one step only`)
    }
  })

  test('step mapping, conditions, scope and server steps', ({ assert }) => {
    const signup = stepCase(FUNNEL_BY_KEY.get('signup')!)
    assert.include(signup, "WHEN e.event_name IN ('landing_viewed') THEN 0")
    assert.include(signup, "WHEN e.event_name IN ('tutor_session_started', 'join_opened', 'quiz_started') THEN 5")
    assert.include(stepCase(FUNNEL_BY_KEY.get('ai_tutor')!), "WHEN e.event_name IN ('tutor_session_ended') AND (SAFE_CAST(JSON_VALUE(e.props, '$.minutes') AS FLOAT64) >= 5) THEN 5")
    assert.include(stepCase(FUNNEL_BY_KEY.get('quiz')!), "(SAFE_CAST(JSON_VALUE(e.props, '$.q_index') AS INT64) = 0) THEN 2")
    assert.include(funnelSql(r, FUNNEL_BY_KEY.get('live_class')!), "IFNULL(JSON_VALUE(e.props, '$.class_type'), '') AS run_scope")
    const purchase = funnelSql(r, FUNNEL_BY_KEY.get('purchase')!)
    assert.notInclude(stepCase(FUNNEL_BY_KEY.get('purchase')!), 'THEN 3')
    assert.include(purchase, `FROM ${T('fact_payments')} x JOIN ${T('identities')} i ON i.td_user_id = x.td_user_id`)
    assert.include(purchase, 'x.captured_at AS ts, 3 AS step')
    assert.include(purchase, `FROM ${T('fact_bookings')} x JOIN ${T('identities')} i`)
    assert.include(purchase, "x.paid AND IFNULL(x.booking_status, 'booked') = 'booked'")
    // A 3-day window.
    assert.include(purchase, 'TIMESTAMP_DIFF(ts, s0, MILLISECOND) <= 259200000')
  })

  test('each nightly run rewrites the start days its window still reaches, in one transaction', ({ assert }) => {
    const sql = funnelsSql(r)
    assert.match(sql, /^BEGIN TRANSACTION;/)
    assert.match(sql, /COMMIT TRANSACTION;$/)
    for (const f of FUNNELS) {
      assert.include(sql, `DELETE FROM ${T('m_funnel_steps')} WHERE funnel = '${f.key}' AND start_date BETWEEN DATE_SUB(CAST(@run_date AS DATE), INTERVAL ${f.windowDays + 1} DAY) AND CAST(@run_date AS DATE);`)
    }
  })
})

test.group('Daily models (MUL-151)', () => {
  test('every model reads the run date parameter and fully-qualified tables', ({ assert }) => {
    for (const s of MODEL_STEPS) {
      const sql = s.sql(r)
      assert.include(sql, 'CAST(@run_date AS DATE)', s.step)
      assert.include(sql, T(s.table), s.step)
      assert.notMatch(sql, /\{\{|undefined|NaN/, s.step)
    }
  })

  test('daily tables are replaced partition by partition, atomically', ({ assert }) => {
    for (const [sql, table, column] of [
      [sessionsSql(r), 'm_sessions', 'session_date'],
      [screenDailySql(r), 'm_screen_daily', 'event_date'],
      [featureDailySql(r), 'm_feature_daily', 'event_date'],
      [healthDailySql(r), 'm_health_daily', 'event_date'],
    ] as const) {
      assert.match(sql, new RegExp(`^BEGIN TRANSACTION;\nDELETE FROM \`test-project-123\\.product_analytics\\.${table}\` WHERE ${column} = CAST\\(@run_date AS DATE\\);\nINSERT INTO`))
      assert.match(sql, /;\nCOMMIT TRANSACTION;$/)
    }
  })

  test('behavioural models leave opted-out rows out; health keeps them (essential events)', ({ assert }) => {
    for (const sql of [sessionsSql(r), screenDailySql(r), featureDailySql(r), userFirstsSql(r), ...FUNNELS.map((f) => funnelSql(r, f))]) {
      assert.include(sql, 'IFNULL(e.opted_out, FALSE) = FALSE')
    }
    assert.notInclude(healthDailySql(r), 'opted_out')
    assert.include(healthDailySql(r), "e.event_name IN ('app_error', 'api_slow', 'web_vital')")
  })

  test('the helpers merge with min/max, so re-running a day changes nothing', ({ assert }) => {
    const links = identityLinksSql(r)
    assert.include(links, 'user_id = IF(T.last_seen_at IS NULL OR S.last_seen_at >= T.last_seen_at, S.user_id, T.user_id)')
    assert.include(links, 'first_seen_at = LEAST(IFNULL(T.first_seen_at, S.first_seen_at), S.first_seen_at)')
    const firsts = userFirstsSql(r)
    assert.include(firsts, 'first_seen_date = LEAST(IFNULL(T.first_seen_date, CAST(@run_date AS DATE)), CAST(@run_date AS DATE))')
    assert.include(firsts, 'first_feature = IF((S.first_feature_at IS NOT NULL AND (T.first_feature_at IS NULL OR S.first_feature_at < T.first_feature_at)), S.first_feature, T.first_feature)')
    assert.include(firsts, "event_name IN ('tutor_session_started', 'join_opened', 'quiz_started')")
  })

  test('screens: dwell to the next screen or the session end, capped, in mergeable buckets', ({ assert }) => {
    const sql = screenDailySql(r)
    assert.include(sql, 'LEAST(1800, GREATEST(0, TIMESTAMP_DIFF(COALESCE(v.next_ts, se.last_ts), v.ts, SECOND))) AS dwell_s')
    assert.include(sql, 'COUNTIF(next_screen IS NULL) AS exits')
    assert.include(sql, 'HLL_COUNT.INIT(person) AS users_hll')
    assert.include(sql, "IFNULL(prev_screen, '(entry)')")
    const hist = dwellHistogram()
    assert.equal(hist.split('COUNTIF').length - 1, DWELL_EDGES.length - 1)
    assert.include(hist, 'COUNTIF(dwell_s >= 0 AND dwell_s < 5)')
    assert.include(hist, 'COUNTIF(dwell_s >= 600)]')
  })

  test('features: every feature mapped, chat by screen, and the _active denominator', ({ assert }) => {
    const c = featureCase()
    for (const f of FEATURES) assert.include(c, `THEN '${f.key}'`)
    assert.include(c, "(event_name = 'screen_viewed' AND screen_name IN ('Chats', 'Chat'))")
    assert.include(featureDailySql(r), "'_active'")
  })

  test('retention: 26 Monday-start cohort weeks, sign-up week when identities link the learner', ({ assert }) => {
    const sql = retentionSql(r)
    assert.include(sql, 'DATE_SUB(CAST(@run_date AS DATE), INTERVAL 25 WEEK), WEEK(MONDAY)')
    assert.include(sql, "IF(s.signup_date IS NOT NULL, 'signup', 'first_seen') AS basis")
    assert.include(sql, `FROM ${T('identities')} i JOIN ${T('fact_users')} u ON u.td_user_id = i.td_user_id`)
    assert.include(sql, 'WHERE u.verified AND i.appspot_id IS NOT NULL')
    assert.include(sql, 'c.cohort_week >= launch.week')
  })
})

test.group('analytics:models runner (MUL-151)', () => {
  test('runs every model in dependency order with the date, then checks the row counts', async ({ assert }) => {
    const bq = new FakeWarehouse((sql) => (sql.includes('AS features') ? [{ events: 120, sessions: 9, screens: 4, features: 3 }] : []))
    const result = await runModels({ date: '2026-11-23', warehouse: bq, refs: r })
    assert.isTrue(result.ok)
    assert.deepEqual(result.steps.map((s) => s.step), ['identity_links', 'user_firsts', 'sessions', 'screen_daily', 'feature_daily', 'health_daily', 'funnel_steps', 'retention_weekly'])
    assert.lengthOf(bq.queries, 9)
    for (const q of bq.queries) assert.deepEqual(q.params, { run_date: '2026-11-23' })
    assert.equal(bq.sql[8], checkSql(r))
    assert.deepEqual(result.check, { events: 120, sessions: 9, screens: 4, features: 3 })
  })

  test('stops at the first failure: later models read the earlier ones', async ({ assert }) => {
    const bq = new FakeWarehouse((sql) => {
      if (sql.includes(T('m_sessions')) && sql.startsWith('BEGIN')) throw new Error('Resources exceeded')
      return []
    })
    const result = await runModels({ date: '2026-11-23', warehouse: bq, refs: r })
    assert.isFalse(result.ok)
    assert.deepEqual(result.steps.map((s) => [s.step, !!s.error]), [
      ['identity_links', false],
      ['user_firsts', false],
      ['sessions', true],
    ])
  })

  test('events without sessions fail the check; a day without events is only a warning', async ({ assert }) => {
    const broken = await runModels({ date: '2026-11-23', warehouse: new FakeWarehouse((sql) => (sql.includes('AS features') ? [{ events: 50, sessions: 0, screens: 0, features: 0 }] : [])), refs: r })
    assert.isFalse(broken.ok)
    assert.match(broken.warning!, /50 events but no sessions/)
    const quiet = await runModels({ date: '2026-11-23', warehouse: new FakeWarehouse((sql) => (sql.includes('AS features') ? [{ events: 0, sessions: 0, screens: 0, features: 0 }] : [])), refs: r })
    assert.isTrue(quiet.ok)
    assert.match(quiet.warning!, /no events/)
  })

  test('--only runs just the named models, without the day check', async ({ assert }) => {
    const bq = new FakeWarehouse()
    const result = await runModels({ date: '2026-11-23', warehouse: bq, refs: r, only: ['funnel_steps'] })
    assert.lengthOf(bq.queries, 1)
    assert.isUndefined(result.check)
  })

  test('the default day is yesterday in IST', ({ assert }) => {
    // 2026-11-24 00:10 IST is still 2026-11-23 18:40 UTC.
    assert.equal(yesterdayIst(Date.parse('2026-11-23T18:40:00Z')), '2026-11-23')
    assert.equal(yesterdayIst(Date.parse('2026-11-23T18:20:00Z')), '2026-11-22')
    assert.isAbove(IST_OFFSET_MS, 0)
  })
})
