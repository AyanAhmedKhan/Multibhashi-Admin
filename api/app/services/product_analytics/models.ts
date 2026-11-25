import { istDayLabel, istDayOf } from '#helpers/ist'
import {
  ACTIVE,
  DWELL_CAP_S,
  DWELL_EDGES,
  FUNNELS,
  HEALTH_EVENTS,
  VALUE_EVENTS,
  featureCase,
  funnelEvents,
  sqlList,
  type FunnelDef,
} from '#services/product_analytics/catalog'
import type { Refs, Warehouse } from '#services/product_analytics/warehouse'

/**
 * The nightly SQL models (MUL-151), built from events_raw (and the facts for the purchase
 * funnel's server steps). `analytics:models --date D` rebuilds D's partitions, so re-running a
 * day gives the same tables:
 *   m_identity_links, m_user_firsts  merged with min/max (idempotent by construction);
 *   m_sessions, m_screen_daily, m_feature_daily, m_health_daily  delete D + insert, one transaction;
 *   m_funnel_steps   the run start days a funnel's window still reaches (D − window − 1 … D);
 *   m_retention_weekly  the last 26 cohort weeks.
 * Behavioural models leave out rows with opted_out = TRUE (only essential events arrive from
 * learners who opted out); m_health_daily keeps them (aggregate counts of essential events).
 * Every SQL builder is a pure function of the table names, checked as text in the unit tests.
 */

/** The run date parameter, as a DATE. */
const D = 'CAST(@run_date AS DATE)'
/** Client time when present (ordering inside a session), else when the collector got it. */
const TS = 'COALESCE(e.event_ts, e.received_at)'
/** The screen a screen_viewed names (the prop), else the context's current screen. */
const SCREEN = "COALESCE(JSON_VALUE(e.props, '$.screen'), e.screen)"
const BEHAVIOURAL = 'IFNULL(e.opted_out, FALSE) = FALSE'
export const RETENTION_WEEKS = 26

/**
 * The day's behavioural events with the person resolved: the signed-in user_id, else the user
 * the anonymous_id was later identified as, else 'anon:<anonymous_id>'.
 */
function dayEvents(r: Refs) {
  return `SELECT
      COALESCE(e.session_id, CONCAT('nosession:', IFNULL(e.anonymous_id, 'unknown'))) AS sid,
      COALESCE(e.user_id, l.user_id) AS uid,
      COALESCE(e.user_id, l.user_id, CONCAT('anon:', IFNULL(e.anonymous_id, 'unknown'))) AS person,
      e.anonymous_id,
      e.event_name,
      ${TS} AS ts,
      IF(e.event_name = 'screen_viewed', ${SCREEN}, NULL) AS screen_name,
      e.platform, e.app_version, e.os, e.browser, e.country, e.utm_source
    FROM ${r.t('events_raw')} e
    LEFT JOIN ${r.t('m_identity_links')} l ON l.anonymous_id = e.anonymous_id
    WHERE e.event_date = ${D} AND ${BEHAVIOURAL}`
}

const replacePartition = (table: string, column: string, insert: string) => `BEGIN TRANSACTION;
DELETE FROM ${table} WHERE ${column} = ${D};
${insert};
COMMIT TRANSACTION;`

// ------------------------------------------------------------------ helpers (merged)

export function identityLinksSql(r: Refs) {
  return `MERGE ${r.t('m_identity_links')} T
USING (
  SELECT
    anonymous_id,
    ARRAY_AGG(user_id ORDER BY last_at DESC, user_id LIMIT 1)[OFFSET(0)] AS user_id,
    MIN(first_at) AS first_seen_at,
    MAX(last_at) AS last_seen_at
  FROM (
    SELECT e.anonymous_id, e.user_id, MIN(${TS}) AS first_at, MAX(${TS}) AS last_at
    FROM ${r.t('events_raw')} e
    WHERE e.event_date = ${D} AND e.anonymous_id IS NOT NULL AND e.user_id IS NOT NULL
    GROUP BY e.anonymous_id, e.user_id
  )
  GROUP BY anonymous_id
) S
ON T.anonymous_id = S.anonymous_id
WHEN MATCHED THEN UPDATE SET
  user_id = IF(T.last_seen_at IS NULL OR S.last_seen_at >= T.last_seen_at, S.user_id, T.user_id),
  first_seen_at = LEAST(IFNULL(T.first_seen_at, S.first_seen_at), S.first_seen_at),
  last_seen_at = GREATEST(IFNULL(T.last_seen_at, S.last_seen_at), S.last_seen_at),
  modelled_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
  INSERT (anonymous_id, user_id, first_seen_at, last_seen_at, modelled_at)
  VALUES (S.anonymous_id, S.user_id, S.first_seen_at, S.last_seen_at, CURRENT_TIMESTAMP())`
}

export function userFirstsSql(r: Refs) {
  const earlier = `(T.first_seen_date IS NULL OR ${D} < T.first_seen_date)`
  const newFeature = '(S.first_feature_at IS NOT NULL AND (T.first_feature_at IS NULL OR S.first_feature_at < T.first_feature_at))'
  return `MERGE ${r.t('m_user_firsts')} T
USING (
  WITH ev AS (
    ${dayEvents(r)}
  ),
  base AS (
    SELECT uid, ARRAY_AGG(STRUCT(platform, utm_source) ORDER BY ts LIMIT 1)[OFFSET(0)] AS ctx
    FROM ev WHERE uid IS NOT NULL GROUP BY uid
  ),
  feat AS (
    SELECT uid, ARRAY_AGG(STRUCT(feature, ts) ORDER BY ts, feature LIMIT 1)[OFFSET(0)] AS ff
    FROM (SELECT uid, ts, ${featureCase()} AS feature FROM ev WHERE uid IS NOT NULL)
    WHERE feature IS NOT NULL GROUP BY uid
  ),
  val AS (
    SELECT uid, MIN(ts) AS first_value_at FROM ev
    WHERE uid IS NOT NULL AND event_name IN (${sqlList(VALUE_EVENTS)}) GROUP BY uid
  )
  SELECT base.uid AS user_id, base.ctx.platform AS platform, base.ctx.utm_source AS utm_source,
    feat.ff.feature AS first_feature, feat.ff.ts AS first_feature_at, val.first_value_at
  FROM base LEFT JOIN feat USING (uid) LEFT JOIN val USING (uid)
) S
ON T.user_id = S.user_id
WHEN MATCHED THEN UPDATE SET
  first_seen_date = LEAST(IFNULL(T.first_seen_date, ${D}), ${D}),
  last_seen_date = GREATEST(IFNULL(T.last_seen_date, ${D}), ${D}),
  first_platform = IF(${earlier}, S.platform, T.first_platform),
  first_utm_source = IF(${earlier}, S.utm_source, T.first_utm_source),
  first_feature = IF(${newFeature}, S.first_feature, T.first_feature),
  first_feature_at = IF(${newFeature}, S.first_feature_at, T.first_feature_at),
  first_value_at = LEAST(IFNULL(T.first_value_at, S.first_value_at), IFNULL(S.first_value_at, T.first_value_at)),
  modelled_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
  INSERT (user_id, first_seen_date, last_seen_date, first_platform, first_utm_source, first_feature, first_feature_at, first_value_at, modelled_at)
  VALUES (S.user_id, ${D}, ${D}, S.platform, S.utm_source, S.first_feature, S.first_feature_at, S.first_value_at, CURRENT_TIMESTAMP())`
}

// ------------------------------------------------------------------ daily partitions

export function sessionsSql(r: Refs) {
  return replacePartition(
    r.t('m_sessions'),
    'session_date',
    `INSERT INTO ${r.t('m_sessions')} (session_date, session_id, person, user_id, anonymous_id, started_at, ended_at, duration_s, events, screen_views,
  entry_screen, exit_screen, platform, app_version, os, browser, country, utm_source, modelled_at)
WITH ev AS (
  ${dayEvents(r)}
),
s AS (
  SELECT
    sid,
    ARRAY_AGG(uid IGNORE NULLS ORDER BY ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS user_id,
    ANY_VALUE(anonymous_id) AS anonymous_id,
    MIN(ts) AS started_at,
    MAX(ts) AS ended_at,
    COUNT(*) AS events,
    COUNTIF(screen_name IS NOT NULL) AS screen_views,
    ARRAY_AGG(screen_name IGNORE NULLS ORDER BY ts LIMIT 1)[SAFE_OFFSET(0)] AS entry_screen,
    ARRAY_AGG(screen_name IGNORE NULLS ORDER BY ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS exit_screen,
    ARRAY_AGG(STRUCT(platform, app_version, os, browser, country, utm_source) ORDER BY ts LIMIT 1)[OFFSET(0)] AS ctx
  FROM ev
  GROUP BY sid
)
SELECT
  ${D}, sid, COALESCE(user_id, CONCAT('anon:', IFNULL(anonymous_id, sid))), user_id, anonymous_id, started_at, ended_at,
  TIMESTAMP_DIFF(ended_at, started_at, SECOND), events, screen_views, entry_screen, exit_screen,
  ctx.platform, ctx.app_version, ctx.os, ctx.browser, ctx.country, ctx.utm_source, CURRENT_TIMESTAMP()
FROM s`
  )
}

/** COUNTIF per dwell bucket, as an ARRAY<INT64> literal. */
export function dwellHistogram(column = 'dwell_s') {
  const parts = DWELL_EDGES.slice(0, -1).map((lo, i) => {
    const hi = DWELL_EDGES[i + 1]
    return i === DWELL_EDGES.length - 2 ? `COUNTIF(${column} >= ${lo})` : `COUNTIF(${column} >= ${lo} AND ${column} < ${hi})`
  })
  return `[${parts.join(', ')}]`
}

export function screenDailySql(r: Refs) {
  return replacePartition(
    r.t('m_screen_daily'),
    'event_date',
    `INSERT INTO ${r.t('m_screen_daily')} (event_date, screen, views, users, users_hll, median_dwell_s, dwell_hist, exits, prev_top, next_top, modelled_at)
WITH ev AS (
  ${dayEvents(r)}
),
session_end AS (SELECT sid, MAX(ts) AS last_ts FROM ev GROUP BY sid),
views AS (
  SELECT sid, person, screen_name AS screen, ts,
    LAG(screen_name) OVER w AS prev_screen,
    LEAD(screen_name) OVER w AS next_screen,
    LEAD(ts) OVER w AS next_ts
  FROM ev
  WHERE screen_name IS NOT NULL
  WINDOW w AS (PARTITION BY sid ORDER BY ts, screen_name)
),
dwell AS (
  SELECT v.*, LEAST(${DWELL_CAP_S}, GREATEST(0, TIMESTAMP_DIFF(COALESCE(v.next_ts, se.last_ts), v.ts, SECOND))) AS dwell_s
  FROM views v JOIN session_end se USING (sid)
),
prev_top AS (
  SELECT screen, ARRAY_AGG(STRUCT(prev AS screen, n AS views) ORDER BY n DESC, prev LIMIT 5) AS top
  FROM (SELECT screen, IFNULL(prev_screen, '(entry)') AS prev, COUNT(*) AS n FROM dwell GROUP BY screen, prev)
  GROUP BY screen
),
next_top AS (
  SELECT screen, ARRAY_AGG(STRUCT(nxt AS screen, n AS views) ORDER BY n DESC, nxt LIMIT 5) AS top
  FROM (SELECT screen, IFNULL(next_screen, '(exit)') AS nxt, COUNT(*) AS n FROM dwell GROUP BY screen, nxt)
  GROUP BY screen
),
agg AS (
  SELECT screen, COUNT(*) AS views, COUNT(DISTINCT person) AS users, HLL_COUNT.INIT(person) AS users_hll,
    CAST(APPROX_QUANTILES(dwell_s, 2)[OFFSET(1)] AS FLOAT64) AS median_dwell_s,
    ${dwellHistogram()} AS dwell_hist,
    COUNTIF(next_screen IS NULL) AS exits
  FROM dwell
  GROUP BY screen
)
SELECT ${D}, a.screen, a.views, a.users, a.users_hll, a.median_dwell_s, a.dwell_hist, a.exits, p.top, n.top, CURRENT_TIMESTAMP()
FROM agg a LEFT JOIN prev_top p USING (screen) LEFT JOIN next_top n USING (screen)`
  )
}

export function featureDailySql(r: Refs) {
  return replacePartition(
    r.t('m_feature_daily'),
    'event_date',
    `INSERT INTO ${r.t('m_feature_daily')} (event_date, feature, users, users_hll, uses, sessions, modelled_at)
WITH ev AS (
  ${dayEvents(r)}
),
f AS (SELECT person, sid, ${featureCase()} AS feature FROM ev)
SELECT ${D}, feature, COUNT(DISTINCT person), HLL_COUNT.INIT(person), COUNT(*), COUNT(DISTINCT sid), CURRENT_TIMESTAMP()
FROM f WHERE feature IS NOT NULL GROUP BY feature
UNION ALL
SELECT ${D}, '${ACTIVE}', COUNT(DISTINCT person), HLL_COUNT.INIT(person), COUNT(*), COUNT(DISTINCT sid), CURRENT_TIMESTAMP()
FROM ev
HAVING COUNT(*) > 0`
  )
}

export function healthDailySql(r: Refs) {
  const prop = (name: string) => `JSON_VALUE(e.props, '$.${name}')`
  return replacePartition(
    r.t('m_health_daily'),
    'event_date',
    `INSERT INTO ${r.t('m_health_daily')} (event_date, kind, name, screen, app_version, platform, events, users, p50, p75, p95, poor, modelled_at)
WITH m AS (
  SELECT
    CASE e.event_name WHEN 'app_error' THEN 'error' WHEN 'api_slow' THEN 'api_slow' ELSE 'web_vital' END AS kind,
    IFNULL(CASE e.event_name WHEN 'app_error' THEN ${prop('type')} WHEN 'api_slow' THEN ${prop('endpoint_group')} ELSE ${prop('name')} END, 'unknown') AS name,
    CASE e.event_name WHEN 'api_slow' THEN SAFE_CAST(${prop('ms')} AS FLOAT64) WHEN 'web_vital' THEN SAFE_CAST(${prop('value')} AS FLOAT64) END AS v,
    ${prop('rating')} AS rating,
    IFNULL(COALESCE(${prop('screen')}, e.screen), '(none)') AS screen,
    IFNULL(e.app_version, '(unknown)') AS app_version,
    IFNULL(e.platform, '(unknown)') AS platform,
    COALESCE(e.user_id, CONCAT('anon:', IFNULL(e.anonymous_id, 'unknown'))) AS person
  FROM ${r.t('events_raw')} e
  WHERE e.event_date = ${D} AND e.event_name IN (${sqlList(HEALTH_EVENTS)})
)
SELECT ${D}, kind, name, screen, app_version, platform, COUNT(*), COUNT(DISTINCT person),
  APPROX_QUANTILES(v, 100)[SAFE_OFFSET(50)], APPROX_QUANTILES(v, 100)[SAFE_OFFSET(75)], APPROX_QUANTILES(v, 100)[SAFE_OFFSET(95)],
  COUNTIF(rating = 'poor'), CURRENT_TIMESTAMP()
FROM m
GROUP BY kind, name, screen, app_version, platform`
  )
}

// ------------------------------------------------------------------ funnels

/** The step index of an event row `e` for this funnel (app steps only), or NULL. */
export function stepCase(f: FunnelDef) {
  const whens = f.steps.flatMap((s, i) => {
    if (!s.events?.length) return []
    const cond = [`e.event_name IN (${sqlList(s.events)})`, ...(s.where ? [`(${s.where})`] : [])].join(' AND ')
    return [`WHEN ${cond} THEN ${i}`]
  })
  return `CASE\n        ${whens.join('\n        ')}\n      END`
}

/** The purchase funnel's server steps, as event rows of the app's user_id (via identities). */
function serverSteps(r: Refs, f: FunnelDef, from: string, until: string) {
  return f.steps.flatMap((s, i) => {
    if (!s.server) return []
    const [table, ts, where] =
      s.server === 'payment_captured'
        ? [r.t('fact_payments'), 'x.captured_at', 'x.captured']
        : [r.t('fact_bookings'), 'x.created_at', "x.paid AND IFNULL(x.booking_status, 'booked') = 'booked'"]
    return [
      `SELECT i.appspot_id AS person, i.appspot_id AS uid, '' AS run_scope, ${ts} AS ts, ${i} AS step,
        CAST(NULL AS STRING) AS platform, CAST(NULL AS STRING) AS utm_source, CAST(NULL AS STRING) AS app_version
      FROM ${table} x JOIN ${r.t('identities')} i ON i.td_user_id = x.td_user_id
      WHERE ${where} AND i.appspot_id IS NOT NULL
        AND ${ts} >= TIMESTAMP(${from}, 'Asia/Kolkata') AND ${ts} < TIMESTAMP(${until}, 'Asia/Kolkata')`,
    ]
  })
}

/**
 * One funnel's runs for start days [run_date − window − 1, run_date] (DESIGN §7, funnel.ts):
 * events are replicated per candidate start day (step-0 events of that day, later steps up to
 * window + 1 days after it); then, per (person, scope, start day), in (ts, step) order, level by
 * level: s_k = the latest start that reached step k so far (running MAX), and a step-k event
 * counts when s_{k−1} exists and the event is within the window of it — exactly the greedy pass
 * of orderedFunnel(). t_k tracks the latest step-k event, for the time between steps.
 */
export function funnelSql(r: Refs, f: FunnelDef) {
  const n = f.steps.length
  const windowMs = f.windowDays * 86_400_000
  const firstStart = `DATE_SUB(${D}, INTERVAL ${f.windowDays + 1} DAY)`
  const readUntil = `DATE_ADD(${D}, INTERVAL ${f.windowDays + 2} DAY)`
  const scope = f.scopeProp ? `IFNULL(JSON_VALUE(e.props, '$.${f.scopeProp.replace(/[^a-z_]/g, '')}'), '')` : "''"
  const w = 'WINDOW w AS (PARTITION BY person, run_scope, start_date ORDER BY ts, step ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
  const levels: string[] = [`l0 AS (SELECT *, IF(step = 0, ts, NULL) AS v0 FROM runs)`, `l0s AS (SELECT *, MAX(v0) OVER w AS s0, MAX(v0) OVER w AS t0 FROM l0 ${w})`]
  for (let k = 1; k < n; k++) {
    levels.push(
      `l${k} AS (SELECT *, IF(step = ${k} AND s${k - 1} IS NOT NULL AND TIMESTAMP_DIFF(ts, s${k - 1}, MILLISECOND) <= ${windowMs}, s${k - 1}, NULL) AS v${k},
    IF(step = ${k} AND s${k - 1} IS NOT NULL AND TIMESTAMP_DIFF(ts, s${k - 1}, MILLISECOND) <= ${windowMs}, TIMESTAMP_DIFF(ts, t${k - 1}, SECOND), NULL) AS g${k}
  FROM l${k - 1}s)`
    )
    if (k < n - 1) levels.push(`l${k}s AS (SELECT *, MAX(v${k}) OVER w AS s${k}, MAX(IF(v${k} IS NOT NULL, ts, NULL)) OVER w AS t${k} FROM l${k} ${w})`)
  }
  const last = `l${n - 1}`
  const reached = Array.from({ length: n }, (_, k) => `WHEN COUNTIF(v${k} IS NOT NULL) > 0 THEN ${k + 1}`).reverse().join(' ')
  const at = Array.from({ length: n }, (_, k) => `MIN(IF(v${k} IS NOT NULL, ts, NULL)) AS a${k}`).join(', ')
  const gaps = Array.from({ length: n - 1 }, (_, i) => `ARRAY_AGG(g${i + 1} IGNORE NULLS ORDER BY ts LIMIT 1)[SAFE_OFFSET(0)] AS g${i + 1}`).join(', ')
  const server = serverSteps(r, f, firstStart, readUntil)
  return `INSERT INTO ${r.t('m_funnel_steps')} (funnel, start_date, person, user_id, run_scope, steps_reached, step_at, step_gap_s, platform, channel, app_version, modelled_at)
WITH ev AS (
  SELECT
    COALESCE(e.user_id, l.user_id, CONCAT('anon:', IFNULL(e.anonymous_id, 'unknown'))) AS person,
    COALESCE(e.user_id, l.user_id) AS uid,
    ${scope} AS run_scope,
    ${TS} AS ts,
    ${stepCase(f)} AS step,
    e.platform, e.utm_source, e.app_version
  FROM ${r.t('events_raw')} e
  LEFT JOIN ${r.t('m_identity_links')} l ON l.anonymous_id = e.anonymous_id
  WHERE e.event_date BETWEEN DATE_SUB(${firstStart}, INTERVAL 1 DAY) AND ${readUntil}
    AND e.event_name IN (${sqlList(funnelEvents(f))})
    AND ${BEHAVIOURAL}${server.map((s) => `\n  UNION ALL\n  ${s}`).join('')}
),
steps AS (SELECT * FROM ev WHERE step IS NOT NULL),
starts AS (
  SELECT person, run_scope, DATE(ts, 'Asia/Kolkata') AS start_date,
    ARRAY_AGG(STRUCT(platform, utm_source, app_version) ORDER BY ts LIMIT 1)[OFFSET(0)] AS ctx
  FROM steps
  WHERE step = 0 AND DATE(ts, 'Asia/Kolkata') BETWEEN ${firstStart} AND ${D}
  GROUP BY person, run_scope, start_date
),
runs AS (
  SELECT s.start_date, e.person, e.uid, e.run_scope, e.ts, e.step
  FROM starts s
  JOIN steps e ON e.person = s.person AND e.run_scope = s.run_scope
  WHERE (e.step = 0 AND DATE(e.ts, 'Asia/Kolkata') = s.start_date)
     OR (e.step > 0 AND e.ts >= TIMESTAMP(s.start_date, 'Asia/Kolkata')
         AND e.ts < TIMESTAMP(DATE_ADD(s.start_date, INTERVAL ${f.windowDays + 1} DAY), 'Asia/Kolkata'))
),
${levels.join(',\n')},
agg AS (
  SELECT start_date, person, run_scope,
    ARRAY_AGG(uid IGNORE NULLS ORDER BY ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS user_id,
    CASE ${reached} ELSE 0 END AS steps_reached,
    ${at}${gaps ? `,\n    ${gaps}` : ''}
  FROM ${last}
  GROUP BY start_date, person, run_scope
)
SELECT '${f.key}', a.start_date, a.person, a.user_id, a.run_scope, a.steps_reached,
  ARRAY(SELECT x FROM UNNEST([${Array.from({ length: n }, (_, k) => `a.a${k}`).join(', ')}]) AS x WITH OFFSET o WHERE x IS NOT NULL ORDER BY o),
  ${n > 1 ? `ARRAY(SELECT x FROM UNNEST([${Array.from({ length: n - 1 }, (_, k) => `a.g${k + 1}`).join(', ')}]) AS x WITH OFFSET o WHERE x IS NOT NULL ORDER BY o)` : 'CAST([] AS ARRAY<INT64>)'},
  s.ctx.platform, s.ctx.utm_source, s.ctx.app_version, CURRENT_TIMESTAMP()
FROM agg a JOIN starts s USING (person, run_scope, start_date)`
}

export function funnelsSql(r: Refs) {
  const parts = FUNNELS.map(
    (f) => `DELETE FROM ${r.t('m_funnel_steps')} WHERE funnel = '${f.key}' AND start_date BETWEEN DATE_SUB(${D}, INTERVAL ${f.windowDays + 1} DAY) AND ${D};
${funnelSql(r, f)};`
  )
  return `BEGIN TRANSACTION;\n${parts.join('\n')}\nCOMMIT TRANSACTION;`
}

// ------------------------------------------------------------------ retention

export function retentionSql(r: Refs) {
  const firstWeek = `DATE_TRUNC(DATE_SUB(${D}, INTERVAL ${RETENTION_WEEKS - 1} WEEK), WEEK(MONDAY))`
  return `BEGIN TRANSACTION;
DELETE FROM ${r.t('m_retention_weekly')} WHERE cohort_week >= ${firstWeek};
INSERT INTO ${r.t('m_retention_weekly')} (cohort_week, basis, channel, first_feature, week_offset, cohort_users, active_users, modelled_at)
WITH launch AS (
  SELECT DATE_TRUNC(MIN(first_seen_date), WEEK(MONDAY)) AS week FROM ${r.t('m_user_firsts')}
),
signup AS (
  SELECT i.appspot_id AS user_id, MIN(u.created_date) AS signup_date,
    ARRAY_AGG(u.utm_source IGNORE NULLS ORDER BY u.created_date LIMIT 1)[SAFE_OFFSET(0)] AS utm_source
  FROM ${r.t('identities')} i JOIN ${r.t('fact_users')} u ON u.td_user_id = i.td_user_id
  WHERE u.verified AND i.appspot_id IS NOT NULL
  GROUP BY i.appspot_id
),
cohort AS (
  SELECT f.user_id,
    DATE_TRUNC(COALESCE(s.signup_date, f.first_seen_date), WEEK(MONDAY)) AS cohort_week,
    IF(s.signup_date IS NOT NULL, 'signup', 'first_seen') AS basis,
    COALESCE(s.utm_source, f.first_utm_source, '(none)') AS channel,
    IFNULL(f.first_feature, '(none)') AS first_feature
  FROM ${r.t('m_user_firsts')} f LEFT JOIN signup s USING (user_id)
),
eligible AS (
  SELECT c.* FROM cohort c CROSS JOIN launch
  WHERE c.cohort_week >= ${firstWeek} AND c.cohort_week >= launch.week AND c.cohort_week <= ${D}
),
activity AS (
  SELECT DISTINCT user_id, DATE_TRUNC(session_date, WEEK(MONDAY)) AS week
  FROM ${r.t('m_sessions')}
  WHERE session_date BETWEEN ${firstWeek} AND ${D} AND user_id IS NOT NULL
),
sizes AS (
  SELECT cohort_week, basis, channel, first_feature, COUNT(*) AS cohort_users
  FROM eligible GROUP BY cohort_week, basis, channel, first_feature
),
active AS (
  SELECT e.cohort_week, e.basis, e.channel, e.first_feature, DIV(DATE_DIFF(a.week, e.cohort_week, DAY), 7) AS week_offset,
    COUNT(DISTINCT e.user_id) AS active_users
  FROM eligible e JOIN activity a ON a.user_id = e.user_id AND a.week >= e.cohort_week
  GROUP BY cohort_week, basis, channel, first_feature, week_offset
)
SELECT s.cohort_week, s.basis, s.channel, s.first_feature, o, s.cohort_users, IFNULL(a.active_users, 0), CURRENT_TIMESTAMP()
FROM sizes s
CROSS JOIN UNNEST(GENERATE_ARRAY(0, DIV(DATE_DIFF(DATE_TRUNC(${D}, WEEK(MONDAY)), s.cohort_week, DAY), 7))) AS o
LEFT JOIN active a
  ON a.cohort_week = s.cohort_week AND a.basis = s.basis AND a.channel = s.channel AND a.first_feature = s.first_feature AND a.week_offset = o;
COMMIT TRANSACTION;`
}

// ------------------------------------------------------------------ checks and the run

/** Row counts for the day: events in, sessions and screens out. A day with events but no sessions failed. */
export function checkSql(r: Refs) {
  return `SELECT
  (SELECT COUNT(*) FROM ${r.t('events_raw')} e WHERE e.event_date = ${D} AND ${BEHAVIOURAL}) AS events,
  (SELECT COUNT(*) FROM ${r.t('m_sessions')} WHERE session_date = ${D}) AS sessions,
  (SELECT COUNT(*) FROM ${r.t('m_screen_daily')} WHERE event_date = ${D}) AS screens,
  (SELECT COUNT(*) FROM ${r.t('m_feature_daily')} WHERE event_date = ${D}) AS features`
}

export type ModelStep = 'identity_links' | 'user_firsts' | 'sessions' | 'screen_daily' | 'feature_daily' | 'health_daily' | 'funnel_steps' | 'retention_weekly'

/** In dependency order: the links resolve people for everything after them. */
export const MODEL_STEPS: { step: ModelStep; table: string; sql: (r: Refs) => string }[] = [
  { step: 'identity_links', table: 'm_identity_links', sql: identityLinksSql },
  { step: 'user_firsts', table: 'm_user_firsts', sql: userFirstsSql },
  { step: 'sessions', table: 'm_sessions', sql: sessionsSql },
  { step: 'screen_daily', table: 'm_screen_daily', sql: screenDailySql },
  { step: 'feature_daily', table: 'm_feature_daily', sql: featureDailySql },
  { step: 'health_daily', table: 'm_health_daily', sql: healthDailySql },
  { step: 'funnel_steps', table: 'm_funnel_steps', sql: funnelsSql },
  { step: 'retention_weekly', table: 'm_retention_weekly', sql: retentionSql },
]

export interface ModelRunResult {
  date: string
  ok: boolean
  steps: { step: ModelStep; ms: number; error?: string }[]
  check?: { events: number; sessions: number; screens: number; features: number }
  warning?: string
}

/** Yesterday in IST: the last complete day, what the nightly run models. */
export const yesterdayIst = (now = Date.now()) => istDayLabel(istDayOf(now) - 1)

export async function runModels(opts: { date: string; warehouse: Warehouse; refs: Refs; only?: ModelStep[]; log?: (line: string) => void }): Promise<ModelRunResult> {
  const log = opts.log ?? (() => {})
  const steps = MODEL_STEPS.filter((s) => !opts.only?.length || opts.only.includes(s.step))
  const result: ModelRunResult = { date: opts.date, ok: true, steps: [] }
  for (const s of steps) {
    const started = Date.now()
    try {
      await opts.warehouse.query(s.sql(opts.refs), { run_date: opts.date })
      result.steps.push({ step: s.step, ms: Date.now() - started })
      log(`${opts.date} ${s.table}: done (${Date.now() - started} ms)`)
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 300)
      result.steps.push({ step: s.step, ms: Date.now() - started, error: message })
      result.ok = false
      log(`${opts.date} ${s.table}: FAILED ${message}`)
      // Later models read the earlier ones: stop rather than build on a stale table.
      return result
    }
  }
  if (!opts.only?.length) {
    const [row] = await opts.warehouse.query(checkSql(opts.refs), { run_date: opts.date })
    const n = (v: unknown) => Number((v as { value?: unknown })?.value ?? v ?? 0)
    result.check = { events: n(row?.events), sessions: n(row?.sessions), screens: n(row?.screens), features: n(row?.features) }
    if (result.check.events > 0 && result.check.sessions === 0) {
      result.ok = false
      result.warning = `${opts.date}: ${result.check.events} events but no sessions were modelled`
    } else if (result.check.events === 0) {
      result.warning = `${opts.date}: no events in events_raw (collector not live yet, or nothing arrived)`
    }
  }
  return result
}
