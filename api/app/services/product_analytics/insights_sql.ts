import { istDayLabel } from '#helpers/ist'
import type { Refs } from '#services/product_analytics/warehouse'

/**
 * The Insights pages' queries (MUL-152). They read only the modelled tables (and the small
 * fact tables), never events_raw, so a page view costs cents (DESIGN §9). Distinct people over
 * a date range come from merging the daily HLL sketches, so a learner active on many days counts
 * once. Every builder is a pure function of the table names; parameters are always named
 * (@from_day, @to_day, @prev_from, @prev_to, …), never spliced into the SQL.
 */

export interface DayRange {
  /** First IST day of the period (inclusive). */
  from: string
  /** Last IST day of the period (inclusive): yesterday, the last modelled day. */
  to: string
  /** The same number of days just before it, for changes. */
  prevFrom: string
  prevTo: string
  days: number
}

const dayNo = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000)

export function dayRange(days: number, to: string): DayRange {
  const end = dayNo(to)
  return { from: istDayLabel(end - days + 1), to, prevFrom: istDayLabel(end - 2 * days + 1), prevTo: istDayLabel(end - days), days }
}

export const rangeParams = (r: DayRange) => ({ from_day: r.from, to_day: r.to, prev_from: r.prevFrom, prev_to: r.prevTo })

const FROM = 'CAST(@from_day AS DATE)'
const TO = 'CAST(@to_day AS DATE)'
const PREV_FROM = 'CAST(@prev_from AS DATE)'
const PREV_TO = 'CAST(@prev_to AS DATE)'

// ------------------------------------------------------------------ freshness

/** When each source last changed: events arriving, facts exported, models built. */
export function freshnessSql(r: Refs) {
  const recent = (column: string) => `${column} >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 3 DAY)`
  return [
    `SELECT 'events_raw' AS source, MAX(received_at) AS at FROM ${r.t('events_raw')} WHERE ${recent('event_date')}`,
    `SELECT 'fact_users', MAX(exported_at) FROM ${r.t('fact_users')}`,
    `SELECT 'identities', MAX(exported_at) FROM ${r.t('identities')}`,
    `SELECT 'm_sessions', MAX(modelled_at) FROM ${r.t('m_sessions')} WHERE ${recent('session_date')}`,
    `SELECT 'm_screen_daily', MAX(modelled_at) FROM ${r.t('m_screen_daily')} WHERE ${recent('event_date')}`,
    `SELECT 'm_feature_daily', MAX(modelled_at) FROM ${r.t('m_feature_daily')} WHERE ${recent('event_date')}`,
    `SELECT 'm_funnel_steps', MAX(modelled_at) FROM ${r.t('m_funnel_steps')} WHERE ${recent('start_date')}`,
    `SELECT 'm_retention_weekly', MAX(modelled_at) FROM ${r.t('m_retention_weekly')}`,
    `SELECT 'm_health_daily', MAX(modelled_at) FROM ${r.t('m_health_daily')} WHERE ${recent('event_date')}`,
  ].join('\nUNION ALL\n')
}

// ------------------------------------------------------------------ overview

export function activeDailySql(r: Refs) {
  return `SELECT session_date AS day, COUNT(DISTINCT user_id) AS dau, COUNT(DISTINCT person) AS visitors, COUNT(*) AS sessions, SUM(duration_s) AS seconds
FROM ${r.t('m_sessions')}
WHERE session_date BETWEEN ${FROM} AND ${TO}
GROUP BY day
ORDER BY day`
}

/** DAU on the last day, WAU and MAU ending on it, actives in the period and the one before. */
export function activeTotalsSql(r: Refs) {
  return `SELECT
  COUNT(DISTINCT IF(session_date = ${TO}, user_id, NULL)) AS dau,
  COUNT(DISTINCT IF(session_date >= DATE_SUB(${TO}, INTERVAL 6 DAY), user_id, NULL)) AS wau,
  COUNT(DISTINCT IF(session_date >= DATE_SUB(${TO}, INTERVAL 29 DAY), user_id, NULL)) AS mau,
  COUNT(DISTINCT IF(session_date BETWEEN ${FROM} AND ${TO}, user_id, NULL)) AS period_active,
  COUNT(DISTINCT IF(session_date BETWEEN ${PREV_FROM} AND ${PREV_TO}, user_id, NULL)) AS prev_active,
  COUNTIF(session_date BETWEEN ${FROM} AND ${TO}) AS sessions,
  COUNTIF(session_date BETWEEN ${PREV_FROM} AND ${PREV_TO}) AS prev_sessions,
  SUM(IF(session_date BETWEEN ${FROM} AND ${TO}, duration_s, 0)) AS seconds
FROM ${r.t('m_sessions')}
WHERE session_date BETWEEN LEAST(${PREV_FROM}, DATE_SUB(${TO}, INTERVAL 29 DAY)) AND ${TO}`
}

/** New verified learners per day (both periods). */
export function signupsDailySql(r: Refs) {
  return `SELECT created_date AS day, COUNT(*) AS signups
FROM ${r.t('fact_users')}
WHERE verified AND created_date BETWEEN ${PREV_FROM} AND ${TO}
GROUP BY day
ORDER BY day`
}

/**
 * Activation (DESIGN §7): first value (tutor class, class joined or quiz started) within 7 days
 * of signing up, for learners who signed up in a period as long as this one that ended 7 days
 * before it (so everyone had their 7 days). Sign-up: the verified account's created_at when
 * identities links the learner, else the day they were first seen.
 */
export function activationSql(r: Refs) {
  return `WITH signup AS (
  SELECT i.appspot_id AS user_id, MIN(u.created_at) AS start_at
  FROM ${r.t('identities')} i JOIN ${r.t('fact_users')} u ON u.td_user_id = i.td_user_id
  WHERE u.verified AND i.appspot_id IS NOT NULL
  GROUP BY i.appspot_id
),
base AS (
  SELECT f.user_id, COALESCE(s.start_at, TIMESTAMP(f.first_seen_date, 'Asia/Kolkata')) AS start_at, f.first_value_at, s.start_at IS NOT NULL AS by_signup
  FROM ${r.t('m_user_firsts')} f LEFT JOIN signup s USING (user_id)
)
SELECT COUNT(*) AS cohort,
  COUNTIF(first_value_at IS NOT NULL AND first_value_at <= TIMESTAMP_ADD(start_at, INTERVAL 7 DAY)) AS activated,
  COUNTIF(by_signup) AS by_signup
FROM base
WHERE DATE(start_at, 'Asia/Kolkata') BETWEEN DATE_SUB(${FROM}, INTERVAL 7 DAY) AND DATE_SUB(${TO}, INTERVAL 7 DAY)`
}

/** The 13-week trend: weekly active learners and sessions (Monday-start weeks). */
export function weeklyTrendSql(r: Refs) {
  return `SELECT DATE_TRUNC(session_date, WEEK(MONDAY)) AS week, COUNT(DISTINCT user_id) AS active, COUNT(*) AS sessions
FROM ${r.t('m_sessions')}
WHERE session_date BETWEEN DATE_SUB(DATE_TRUNC(${TO}, WEEK(MONDAY)), INTERVAL 12 WEEK) AND ${TO}
GROUP BY week
ORDER BY week`
}

export function weeklySignupsSql(r: Refs) {
  return `SELECT DATE_TRUNC(created_date, WEEK(MONDAY)) AS week, COUNT(*) AS signups
FROM ${r.t('fact_users')}
WHERE verified AND created_date BETWEEN DATE_SUB(DATE_TRUNC(${TO}, WEEK(MONDAY)), INTERVAL 12 WEEK) AND ${TO}
GROUP BY week`
}

export function platformsSql(r: Refs) {
  return `SELECT IFNULL(platform, '(unknown)') AS platform, COUNT(DISTINCT person) AS people, COUNT(*) AS sessions
FROM ${r.t('m_sessions')}
WHERE session_date BETWEEN ${FROM} AND ${TO}
GROUP BY platform
ORDER BY people DESC`
}

// ------------------------------------------------------------------ screens

export function screensSql(r: Refs) {
  return `SELECT screen,
  SUM(IF(event_date >= ${FROM}, views, 0)) AS views,
  SUM(IF(event_date >= ${FROM}, exits, 0)) AS exits,
  SUM(IF(event_date <= ${PREV_TO}, views, 0)) AS prev_views
FROM ${r.t('m_screen_daily')}
WHERE event_date BETWEEN ${PREV_FROM} AND ${TO}
GROUP BY screen
ORDER BY views DESC
LIMIT 80`
}

export function screenUsersSql(r: Refs) {
  return `SELECT screen, HLL_COUNT.MERGE(users_hll) AS users
FROM ${r.t('m_screen_daily')}
WHERE event_date BETWEEN ${FROM} AND ${TO}
GROUP BY screen`
}

/** The dwell histograms summed over the period (exact: buckets add up). */
export function dwellSql(r: Refs) {
  return `SELECT screen, bucket, SUM(n) AS n
FROM ${r.t('m_screen_daily')}, UNNEST(dwell_hist) AS n WITH OFFSET AS bucket
WHERE event_date BETWEEN ${FROM} AND ${TO}
GROUP BY screen, bucket`
}

/** Top paths in and out (each day's top 5, summed: approximate beyond the top few). */
export function pathsSql(r: Refs) {
  return `SELECT s.screen, 'in' AS direction, p.screen AS other, SUM(p.views) AS n
FROM ${r.t('m_screen_daily')} s, UNNEST(s.prev_top) AS p
WHERE s.event_date BETWEEN ${FROM} AND ${TO}
GROUP BY s.screen, other
UNION ALL
SELECT s.screen, 'out' AS direction, p.screen AS other, SUM(p.views) AS n
FROM ${r.t('m_screen_daily')} s, UNNEST(s.next_top) AS p
WHERE s.event_date BETWEEN ${FROM} AND ${TO}
GROUP BY s.screen, other`
}

// ------------------------------------------------------------------ features

/** People per feature in the period, in the last 7 days (adoption = ÷ _active) and the period before. */
export function featuresSql(r: Refs) {
  return `SELECT feature,
  HLL_COUNT.MERGE(IF(event_date >= ${FROM}, users_hll, NULL)) AS users,
  HLL_COUNT.MERGE(IF(event_date >= DATE_SUB(${TO}, INTERVAL 6 DAY), users_hll, NULL)) AS users_7d,
  HLL_COUNT.MERGE(IF(event_date <= ${PREV_TO}, users_hll, NULL)) AS prev_users,
  SUM(IF(event_date >= ${FROM}, uses, 0)) AS uses,
  SUM(IF(event_date >= ${FROM}, sessions, 0)) AS sessions
FROM ${r.t('m_feature_daily')}
WHERE event_date BETWEEN LEAST(${PREV_FROM}, DATE_SUB(${TO}, INTERVAL 6 DAY)) AND ${TO}
GROUP BY feature`
}

export function featureDailySeriesSql(r: Refs) {
  return `SELECT event_date AS day, feature, users
FROM ${r.t('m_feature_daily')}
WHERE event_date BETWEEN ${FROM} AND ${TO}
ORDER BY day`
}

/**
 * Feature × retention: of the learners whose first feature was F (cohorts of the last 12 weeks),
 * the share active again 1, 2 and 4 weeks later; only weeks that have fully happened.
 */
export function featureRetentionSql(r: Refs) {
  return `SELECT first_feature, week_offset, SUM(cohort_users) AS cohort, SUM(active_users) AS active
FROM ${r.t('m_retention_weekly')}
WHERE cohort_week BETWEEN DATE_SUB(DATE_TRUNC(${TO}, WEEK(MONDAY)), INTERVAL 12 WEEK) AND ${TO}
  AND week_offset IN (1, 2, 4)
  AND DATE_ADD(cohort_week, INTERVAL (week_offset + 1) * 7 DAY) <= DATE_ADD(${TO}, INTERVAL 1 DAY)
GROUP BY first_feature, week_offset`
}

// ------------------------------------------------------------------ funnels

export type Breakdown = 'platform' | 'channel' | 'app_version'
export const BREAKDOWNS: Breakdown[] = ['platform', 'channel', 'app_version']

/** Each person's furthest run over the run start days in the period (funnel.ts semantics). */
function bestRuns(r: Refs, extra = '') {
  return `best AS (
  SELECT funnel, person,
    ARRAY_AGG(STRUCT(steps_reached, step_at, step_gap_s, user_id, start_date, platform, channel, app_version) ORDER BY steps_reached DESC, start_date DESC LIMIT 1)[OFFSET(0)] AS b
  FROM ${r.t('m_funnel_steps')}
  WHERE start_date BETWEEN ${FROM} AND ${TO}${extra}
  GROUP BY funnel, person
)`
}

/**
 * People reaching each step (0-based k: steps_reached > k) and the median seconds from the
 * previous step, per funnel; with a breakdown, per segment of the best run's start. The period
 * before is computed the same way for the change.
 */
export function funnelStepsSql(r: Refs, breakdown: Breakdown | null, maxSteps: number) {
  const segment = breakdown ? `IFNULL(b.${breakdown}, '(unknown)')` : "'all'"
  return `WITH ${bestRuns(r)}
SELECT funnel, ${segment} AS segment, k AS step,
  COUNTIF(b.steps_reached > k) AS users,
  APPROX_QUANTILES(IF(k > 0 AND b.steps_reached > k, b.step_gap_s[SAFE_OFFSET(k - 1)], NULL), 2)[SAFE_OFFSET(1)] AS median_gap_s
FROM best CROSS JOIN UNNEST(GENERATE_ARRAY(0, ${Math.max(0, Math.floor(maxSteps) - 1)})) AS k
GROUP BY funnel, segment, step`
}

/** The same counts for the previous period (overall only). */
export function funnelStepsPrevSql(r: Refs, maxSteps: number) {
  return funnelStepsSql(r, null, maxSteps).replace(`WHERE start_date BETWEEN ${FROM} AND ${TO}`, `WHERE start_date BETWEEN ${PREV_FROM} AND ${PREV_TO}`)
}

/** Who stopped after a step (reached exactly @reached steps): by platform, version and channel. */
export function dropoffSegmentsSql(r: Refs) {
  return `WITH ${bestRuns(r, ' AND funnel = @funnel')}
SELECT 'platform' AS dimension, IFNULL(b.platform, '(unknown)') AS value, COUNT(*) AS people FROM best WHERE b.steps_reached = @reached GROUP BY value
UNION ALL
SELECT 'app_version', IFNULL(b.app_version, '(unknown)'), COUNT(*) FROM best WHERE b.steps_reached = @reached GROUP BY 2
UNION ALL
SELECT 'channel', IFNULL(b.channel, '(none)'), COUNT(*) FROM best WHERE b.steps_reached = @reached GROUP BY 2`
}

/**
 * The latest learners who stopped after a step, with the teachers-dashboard id when the
 * identity link exists (the console's learner page). Only for staff who may see learners.
 */
export function dropoffLearnersSql(r: Refs) {
  return `WITH ${bestRuns(r, ' AND funnel = @funnel')}
SELECT i.td_user_id, b.user_id IS NOT NULL AS signed_in, b.platform, b.app_version, b.channel, b.start_date,
  b.step_at[SAFE_OFFSET(b.steps_reached - 1)] AS last_step_at
FROM best
LEFT JOIN ${r.t('identities')} i ON i.appspot_id = b.user_id
WHERE b.steps_reached = @reached
ORDER BY last_step_at DESC
LIMIT 50`
}

// ------------------------------------------------------------------ retention

export interface RetentionFilter {
  basis?: string
  channel?: string
  feature?: string
}

export function retentionSql(r: Refs, filter: RetentionFilter) {
  const where = [`cohort_week BETWEEN DATE_SUB(DATE_TRUNC(${TO}, WEEK(MONDAY)), INTERVAL 11 WEEK) AND ${TO}`]
  if (filter.basis) where.push('basis = @basis')
  if (filter.channel) where.push('channel = @channel')
  if (filter.feature) where.push('first_feature = @feature')
  return `SELECT cohort_week, week_offset, SUM(cohort_users) AS cohort, SUM(active_users) AS active
FROM ${r.t('m_retention_weekly')}
WHERE ${where.join('\n  AND ')}
GROUP BY cohort_week, week_offset
ORDER BY cohort_week, week_offset`
}

/** The filter choices: channels and first features with their cohort sizes, and the bases present. */
export function retentionOptionsSql(r: Refs) {
  return `SELECT 'channel' AS dimension, channel AS value, SUM(cohort_users) AS people
FROM ${r.t('m_retention_weekly')} WHERE week_offset = 0 AND cohort_week >= DATE_SUB(${TO}, INTERVAL 12 WEEK) GROUP BY value
UNION ALL
SELECT 'first_feature', first_feature, SUM(cohort_users)
FROM ${r.t('m_retention_weekly')} WHERE week_offset = 0 AND cohort_week >= DATE_SUB(${TO}, INTERVAL 12 WEEK) GROUP BY 2
UNION ALL
SELECT 'basis', basis, SUM(cohort_users)
FROM ${r.t('m_retention_weekly')} WHERE week_offset = 0 AND cohort_week >= DATE_SUB(${TO}, INTERVAL 12 WEEK) GROUP BY 2`
}

// ------------------------------------------------------------------ health

const HEALTH = (r: Refs, kind: string) => `FROM ${r.t('m_health_daily')} WHERE kind = '${kind}' AND event_date BETWEEN ${FROM} AND ${TO}`

export function healthSql(r: Refs) {
  return {
    errorsDaily: `SELECT event_date AS day, SUM(events) AS events ${HEALTH(r, 'error')} GROUP BY day ORDER BY day`,
    errorsByType: `SELECT name, SUM(events) AS events, COUNT(DISTINCT screen) AS screens ${HEALTH(r, 'error')} GROUP BY name ORDER BY events DESC LIMIT 15`,
    errorsByScreen: `SELECT screen, SUM(events) AS events ${HEALTH(r, 'error')} GROUP BY screen ORDER BY events DESC LIMIT 15`,
    errorsByVersion: `SELECT app_version, platform, SUM(events) AS events ${HEALTH(r, 'error')} GROUP BY app_version, platform ORDER BY events DESC LIMIT 12`,
    // Daily percentiles can't be merged exactly: weighted by each day's count, labelled "≈".
    slowApis: `SELECT name AS endpoint, SUM(events) AS events, SAFE_DIVIDE(SUM(p50 * events), SUM(IF(p50 IS NULL, 0, events))) AS p50, SAFE_DIVIDE(SUM(p95 * events), SUM(IF(p95 IS NULL, 0, events))) AS p95 ${HEALTH(r, 'api_slow')} GROUP BY endpoint ORDER BY events DESC LIMIT 15`,
    vitals: `SELECT name, SUM(events) AS events, SAFE_DIVIDE(SUM(p75 * events), SUM(IF(p75 IS NULL, 0, events))) AS p75, SAFE_DIVIDE(SUM(poor), SUM(events)) AS poor_share ${HEALTH(r, 'web_vital')} GROUP BY name ORDER BY name`,
    slowScreens: `SELECT screen, app_version, SUM(events) AS events, SAFE_DIVIDE(SUM(p75 * events), SUM(IF(p75 IS NULL, 0, events))) AS p75, SAFE_DIVIDE(SUM(poor), SUM(events)) AS poor_share ${HEALTH(r, 'web_vital')} AND name = 'LCP' GROUP BY screen, app_version HAVING events >= 5 ORDER BY p75 DESC LIMIT 15`,
  }
}
