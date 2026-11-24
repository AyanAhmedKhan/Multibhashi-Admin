import ApiException from '#exceptions/api_exception'
import { histQuantile } from '#services/analytics/quiz_metrics'
import { ACTIVE, DWELL_EDGES, FEATURES, FUNNELS, FUNNEL_BY_KEY } from '#services/product_analytics/catalog'
import { publicStatus, readWarehouseConfig, type WarehouseConfig } from '#services/product_analytics/config'
import { yesterdayIst } from '#services/product_analytics/models'
import * as Q from '#services/product_analytics/insights_sql'
import { bigQueryWarehouse, bqMessage, isNotFound, num, numOrNull, refsOf, str, type QueryParams, type Refs, type Warehouse } from '#services/product_analytics/warehouse'

/**
 * Insights → product analytics (MUL-152): Overview, Screens, Features, Funnels (with drop-off
 * lists), Retention and Health, read from the modelled BigQuery tables and cached for ten
 * minutes (the models change once a night). Without the GCP_ANALYTICS_* settings every page
 * answers { connected: false, missing } and the console says "not connected yet"; before the
 * tables exist, { ready: false }. Aggregates only, except the drop-off learner list, which the
 * controller requests only for staff who may see learners.
 */

const CACHE_MS = 10 * 60_000
/** A source older than this (hours) is flagged stale on the Health tab and in the digest. */
export const STALE_HOURS = 26

export type NotConnected = { connected: false; missing: string[]; problem: string | null; location: string }
export type NotReady = { connected: true; ready: false; message: string }
export type Ready<T> = { connected: true; ready: true; range: Q.DayRange } & T
export type Answer<T> = NotConnected | NotReady | Ready<T>

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null)
export function change(now: number, before: number): number | null {
  if (!before) return now ? null : 0
  return Math.round(((now - before) / before) * 1000) / 10
}
const day = (v: unknown) => (str(v) ?? '').slice(0, 10)

export interface Deps {
  config?: WarehouseConfig
  warehouse?: Warehouse
  /** "Yesterday" for tests. */
  today?: () => string
}

export class ProductInsights {
  #cache = new Map<string, { at: number; value: unknown }>()
  #deps: Deps

  constructor(deps: Deps = {}) {
    this.#deps = deps
  }

  clearCache() {
    this.#cache.clear()
  }

  /** The last modelled day: yesterday in IST. */
  lastDay() {
    return this.#deps.today?.() ?? yesterdayIst()
  }

  range(days: number, to = this.lastDay()) {
    return Q.dayRange(days, to)
  }

  private async open(): Promise<{ config: WarehouseConfig; refs: Refs | null; client: Warehouse | null }> {
    const config = this.#deps.config ?? (await readWarehouseConfig())
    if (!config.connected) return { config, refs: null, client: null }
    return { config, refs: refsOf(config), client: this.#deps.warehouse ?? (await bigQueryWarehouse(config)) }
  }

  /**
   * Runs a page's queries with the range parameters; caches the result. Missing settings and
   * missing tables are states the page shows, not errors.
   */
  private async answer<T>(key: string, range: Q.DayRange | null, build: (run: (sql: string, extra?: QueryParams) => Promise<Record<string, unknown>[]>, r: Refs) => Promise<T>): Promise<Answer<T>> {
    const { config, refs, client } = await this.open()
    if (!client || !refs) return { connected: false, ...publicStatus(config) } as NotConnected
    const cacheKey = `${key}:${range ? `${range.from}:${range.to}` : ''}`
    const hit = this.#cache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Answer<T>
    const params = range ? Q.rangeParams(range) : {}
    try {
      const value = await build((sql, extra) => client.query(sql, { ...params, ...extra }), refs)
      const result = { connected: true as const, ready: true as const, range: range!, ...value } as Ready<T>
      this.#cache.set(cacheKey, { at: Date.now(), value: result })
      if (this.#cache.size > 300) this.#cache.delete(this.#cache.keys().next().value!)
      return result
    } catch (error) {
      if (isNotFound(error)) {
        return { connected: true, ready: false, message: 'The product analytics tables are not there yet: run analytics:bq-setup --apply, then analytics:export-facts and analytics:models.' }
      }
      throw new ApiException(502, `BigQuery: ${bqMessage(error)}`, 'BIGQUERY_FAILED')
    }
  }

  /** Connection and freshness: when events last arrived, facts were exported, models were built. */
  status() {
    return this.answer('status', null, async (run, r) => {
      const now = Date.now()
      const rows = await run(Q.freshnessSql(r))
      return {
        sources: rows.map((row) => {
          const at = str(row.at)
          const hours = at ? Math.round(((now - Date.parse(at)) / 3_600_000) * 10) / 10 : null
          return { source: String(row.source), at, hours, stale: hours === null || hours > STALE_HOURS }
        }),
      }
    })
  }

  overview(range: Q.DayRange) {
    return this.answer('overview', range, async (run, r) => {
      const [daily, totals, signups, activation, weekly, weeklySignups, platforms] = await Promise.all([
        run(Q.activeDailySql(r)),
        run(Q.activeTotalsSql(r)),
        run(Q.signupsDailySql(r)),
        run(Q.activationSql(r)),
        run(Q.weeklyTrendSql(r)),
        run(Q.weeklySignupsSql(r)),
        run(Q.platformsSql(r)),
      ])
      const t = totals[0] ?? {}
      const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000)
      const series = Array.from({ length: range.days }, (_, i) => {
        const label = new Date((dayNo(range.from) + i) * 86_400_000).toISOString().slice(0, 10)
        const row = daily.find((d) => day(d.day) === label)
        const s = signups.find((x) => day(x.day) === label)
        return {
          day: label,
          activeLearners: num(row?.dau),
          visitors: num(row?.visitors),
          sessions: num(row?.sessions),
          minutes: Math.round(num(row?.seconds) / 60),
          signups: num(s?.signups),
        }
      })
      const newVerified = series.reduce((sum, d) => sum + d.signups, 0)
      const prevVerified = signups.filter((x) => day(x.day) <= range.prevTo).reduce((sum, x) => sum + num(x.signups), 0)
      const mau = num(t.mau)
      const last7 = series.slice(-7)
      const a = activation[0] ?? {}
      return {
        totals: {
          dau: num(t.dau),
          wau: num(t.wau),
          mau,
          // Average daily actives over the last 7 days ÷ monthly actives (same as Users & growth).
          stickiness: mau && last7.length ? Math.round((last7.reduce((s, d) => s + d.activeLearners, 0) / last7.length / mau) * 1000) / 10 : 0,
          periodActive: num(t.period_active),
          prevActive: num(t.prev_active),
          periodActiveChange: change(num(t.period_active), num(t.prev_active)),
          sessions: num(t.sessions),
          prevSessions: num(t.prev_sessions),
          sessionsChange: change(num(t.sessions), num(t.prev_sessions)),
          avgSessionMinutes: num(t.sessions) ? Math.round((num(t.seconds) / 60 / num(t.sessions)) * 10) / 10 : 0,
          newVerified,
          prevVerified,
          newVerifiedChange: change(newVerified, prevVerified),
          activation: { cohort: num(a.cohort), activated: num(a.activated), rate: pct(num(a.activated), num(a.cohort)), bySignup: num(a.by_signup) },
        },
        series,
        weekly: weekly.map((w) => ({
          week: day(w.week),
          activeLearners: num(w.active),
          sessions: num(w.sessions),
          signups: num(weeklySignups.find((s) => day(s.week) === day(w.week))?.signups),
        })),
        platforms: platforms.map((p) => ({ platform: String(str(p.platform)), people: num(p.people), sessions: num(p.sessions) })),
      }
    })
  }

  screens(range: Q.DayRange) {
    return this.answer('screens', range, async (run, r) => {
      const [rows, users, dwell, paths] = await Promise.all([run(Q.screensSql(r)), run(Q.screenUsersSql(r)), run(Q.dwellSql(r)), run(Q.pathsSql(r))])
      const hist = new Map<string, number[]>()
      for (const d of dwell) {
        const screen = String(d.screen)
        if (!hist.has(screen)) hist.set(screen, new Array(DWELL_EDGES.length - 1).fill(0))
        const b = num(d.bucket)
        if (b >= 0 && b < DWELL_EDGES.length - 1) hist.get(screen)![b] += num(d.n)
      }
      const top = (screen: string, direction: 'in' | 'out') =>
        paths
          .filter((p) => p.screen === screen && p.direction === direction)
          .map((p) => ({ screen: String(p.other), views: num(p.n) }))
          .sort((a, b) => b.views - a.views)
          .slice(0, 5)
      const screens = rows
        .filter((s) => num(s.views) > 0)
        .map((s) => {
          const screen = String(s.screen)
          const views = num(s.views)
          const median = histQuantile(hist.get(screen) ?? [], DWELL_EDGES, 50)
          return {
            screen,
            views,
            prevViews: num(s.prev_views),
            viewsChange: change(views, num(s.prev_views)),
            users: num(users.find((u) => u.screen === screen)?.users),
            medianSeconds: median === null ? null : Math.round(median),
            exits: num(s.exits),
            exitRate: pct(num(s.exits), views),
            into: top(screen, 'in'),
            outOf: top(screen, 'out'),
          }
        })
      return { screens }
    })
  }

  features(range: Q.DayRange) {
    return this.answer('features', range, async (run, r) => {
      const [rows, daily, matrix] = await Promise.all([run(Q.featuresSql(r)), run(Q.featureDailySeriesSql(r)), run(Q.featureRetentionSql(r))])
      const active = rows.find((f) => f.feature === ACTIVE)
      const wau = num(active?.users_7d)
      const features = FEATURES.map((def) => {
        const row = rows.find((f) => f.feature === def.key)
        const users = num(row?.users)
        return {
          key: def.key,
          label: def.label,
          users,
          prevUsers: num(row?.prev_users),
          usersChange: change(users, num(row?.prev_users)),
          users7d: num(row?.users_7d),
          adoption: pct(num(row?.users_7d), wau),
          uses: num(row?.uses),
          usesPerUser: users ? Math.round((num(row?.uses) / users) * 10) / 10 : 0,
          series: daily.filter((d) => d.feature === def.key).map((d) => ({ day: day(d.day), users: num(d.users) })),
        }
      })
      const retention = [...new Set(matrix.map((m) => String(m.first_feature)))].map((feature) => {
        const cell = (offset: number) => {
          const m = matrix.find((x) => x.first_feature === feature && num(x.week_offset) === offset)
          return m ? { cohort: num(m.cohort), rate: pct(num(m.active), num(m.cohort)) } : null
        }
        return { feature, label: FEATURES.find((f) => f.key === feature)?.label ?? feature, week1: cell(1), week2: cell(2), week4: cell(4) }
      })
      return { wau, features, retention }
    })
  }

  funnels(range: Q.DayRange, breakdown: Q.Breakdown | null = null, funnelKey: string | null = null) {
    const maxSteps = Math.max(...FUNNELS.map((f) => f.steps.length))
    return this.answer(`funnels:${breakdown ?? ''}:${funnelKey ?? ''}`, range, async (run, r) => {
      const [current, previous, segmented] = await Promise.all([
        run(Q.funnelStepsSql(r, null, maxSteps)),
        run(Q.funnelStepsPrevSql(r, maxSteps)),
        breakdown ? run(Q.funnelStepsSql(r, breakdown, maxSteps)) : Promise.resolve([]),
      ])
      const stepsOf = (rows: Record<string, unknown>[], funnel: string, segment = 'all') => {
        const def = FUNNEL_BY_KEY.get(funnel)!
        return def.steps.map((s, k) => {
          const row = rows.find((x) => x.funnel === funnel && x.segment === segment && num(x.step) === k)
          return { label: s.label, users: num(row?.users), medianGapSeconds: numOrNull(row?.median_gap_s) }
        })
      }
      const funnels = FUNNELS.map((f) => {
        const steps = stepsOf(current, f.key)
        const prev = stepsOf(previous, f.key)
        const first = steps[0]?.users ?? 0
        const lastUsers = steps[steps.length - 1]?.users ?? 0
        const prevConversion = pct(prev[prev.length - 1]?.users ?? 0, prev[0]?.users ?? 0)
        return {
          key: f.key,
          label: f.label,
          windowDays: f.windowDays,
          steps: steps.map((s, k) => ({
            ...s,
            fromPrevious: k === 0 ? null : pct(s.users, steps[k - 1].users),
            fromFirst: pct(s.users, first),
            dropped: k === 0 ? 0 : steps[k - 1].users - s.users,
          })),
          conversion: pct(lastUsers, first),
          conversionBefore: prevConversion,
          startedBefore: prev[0]?.users ?? 0,
          /** People per step in the period before. */
          previous: prev.map((s) => s.users),
        }
      })
      const segments =
        breakdown && funnelKey && FUNNEL_BY_KEY.has(funnelKey)
          ? [...new Set(segmented.filter((x) => x.funnel === funnelKey).map((x) => String(x.segment)))]
              .map((segment) => {
                const steps = stepsOf(segmented, funnelKey, segment)
                return { segment, steps: steps.map((s) => s.users), conversion: pct(steps[steps.length - 1].users, steps[0].users) }
              })
              .sort((a, b) => b.steps[0] - a.steps[0])
              .slice(0, 12)
          : []
      return { funnels, breakdown, segments }
    })
  }

  /**
   * Who stopped after a step (1-based `step`: reached it, never the next). Segments always;
   * the learner list only with includeLearners (teachers-dashboard ids, never contact details).
   */
  dropoffs(range: Q.DayRange, funnelKey: string, step: number, includeLearners: boolean) {
    const def = FUNNEL_BY_KEY.get(funnelKey)
    if (!def) throw new ApiException(422, 'Unknown funnel', 'VALIDATION_FAILED')
    if (step < 1 || step >= def.steps.length) throw new ApiException(422, `Pick a step between 1 and ${def.steps.length - 1}`, 'VALIDATION_FAILED')
    return this.answer(`dropoffs:${funnelKey}:${step}:${includeLearners}`, range, async (run, r) => {
      const extra = { funnel: funnelKey, reached: step }
      const [segments, learners] = await Promise.all([
        run(Q.dropoffSegmentsSql(r), extra),
        includeLearners ? run(Q.dropoffLearnersSql(r), extra) : Promise.resolve(null),
      ])
      const by = (dimension: string) =>
        segments
          .filter((s) => s.dimension === dimension)
          .map((s) => ({ value: String(s.value), people: num(s.people) }))
          .sort((a, b) => b.people - a.people)
          .slice(0, 8)
      return {
        funnel: funnelKey,
        step,
        stoppedAfter: def.steps[step - 1].label,
        nextStep: def.steps[step].label,
        total: by('platform').reduce((s, x) => s + x.people, 0),
        byPlatform: by('platform'),
        byVersion: by('app_version'),
        byChannel: by('channel'),
        learners: learners
          ? learners.map((l) => ({
              tdUserId: numOrNull(l.td_user_id),
              signedIn: l.signed_in === true,
              platform: str(l.platform),
              appVersion: str(l.app_version),
              channel: str(l.channel),
              startDate: day(l.start_date),
              lastStepAt: str(l.last_step_at),
            }))
          : null,
      }
    })
  }

  retention(range: Q.DayRange, filter: Q.RetentionFilter) {
    const key = `retention:${filter.basis ?? ''}:${filter.channel ?? ''}:${filter.feature ?? ''}`
    return this.answer(key, range, async (run, r) => {
      const extra: QueryParams = {}
      if (filter.basis) extra.basis = filter.basis
      if (filter.channel) extra.channel = filter.channel
      if (filter.feature) extra.feature = filter.feature
      const [rows, options] = await Promise.all([run(Q.retentionSql(r, filter), extra), run(Q.retentionOptionsSql(r))])
      const weeks = [...new Set(rows.map((x) => day(x.cohort_week)))].sort()
      const cohorts = weeks.map((week) => {
        const of = rows.filter((x) => day(x.cohort_week) === week)
        const size = num(of.find((x) => num(x.week_offset) === 0)?.cohort ?? of[0]?.cohort)
        const maxOffset = Math.max(...of.map((x) => num(x.week_offset)))
        return {
          week,
          users: size,
          weeks: Array.from({ length: 12 }, (_, k) => (k > maxOffset ? null : pct(num(of.find((x) => num(x.week_offset) === k)?.active), size) ?? 0)),
        }
      })
      const choices = (dimension: string) =>
        options
          .filter((o) => o.dimension === dimension)
          .map((o) => ({ value: String(o.value), people: num(o.people) }))
          .sort((a, b) => b.people - a.people)
      return { filter, cohorts, channels: choices('channel').slice(0, 30), features: choices('first_feature'), bases: choices('basis') }
    })
  }

  health(range: Q.DayRange) {
    return this.answer('health', range, async (run, r) => {
      const q = Q.healthSql(r)
      const [errorsDaily, errorsByType, errorsByScreen, errorsByVersion, slowApis, vitals, slowScreens, freshness] = await Promise.all([
        run(q.errorsDaily),
        run(q.errorsByType),
        run(q.errorsByScreen),
        run(q.errorsByVersion),
        run(q.slowApis),
        run(q.vitals),
        run(q.slowScreens),
        run(Q.freshnessSql(r)),
      ])
      const now = Date.now()
      const round = (v: unknown, digits = 0) => {
        const n = numOrNull(v)
        return n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits
      }
      return {
        errorsDaily: errorsDaily.map((e) => ({ day: day(e.day), events: num(e.events) })),
        errorsByType: errorsByType.map((e) => ({ type: String(e.name), events: num(e.events), screens: num(e.screens) })),
        errorsByScreen: errorsByScreen.map((e) => ({ screen: String(e.screen), events: num(e.events) })),
        errorsByVersion: errorsByVersion.map((e) => ({ appVersion: String(e.app_version), platform: String(e.platform), events: num(e.events) })),
        slowApis: slowApis.map((a) => ({ endpoint: String(a.endpoint), events: num(a.events), p50: round(a.p50), p95: round(a.p95) })),
        vitals: vitals.map((v) => ({ name: String(v.name), events: num(v.events), p75: round(v.p75, v.name === 'CLS' ? 3 : 0), poorShare: round(num(v.poor_share) * 100, 1) })),
        slowScreens: slowScreens.map((s) => ({ screen: String(s.screen), appVersion: String(s.app_version), events: num(s.events), p75: round(s.p75), poorShare: round(num(s.poor_share) * 100, 1) })),
        freshness: freshness.map((row) => {
          const at = str(row.at)
          const hours = at ? Math.round(((now - Date.parse(at)) / 3_600_000) * 10) / 10 : null
          return { source: String(row.source), at, hours, stale: hours === null || hours > STALE_HOURS }
        }),
      }
    })
  }
}

export default new ProductInsights()
