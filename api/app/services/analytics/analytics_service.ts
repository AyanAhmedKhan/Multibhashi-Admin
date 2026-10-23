import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import {
  DAY_MS,
  istDayLabel,
  istDayOf,
  istDaySql,
  istDayStart,
  istHourSql,
  istWeekdaySql,
} from '#helpers/ist'

/**
 * Insights. Aggregates only (no names, phones or emails), from:
 * - the monolith's activity tracking (student_sessions: app open, 30 s heartbeat;
 *   student_learning_segments: engaged/idle time per screen; student_activity_events);
 * - users (sign-ups) and the AI tutor tables.
 * Queries run on the `analytics` connection (a read replica when configured) and are
 * cached briefly: these pages are looked at, not polled per second.
 */

const CACHE_MS = 120_000
const LIVE_HEARTBEAT_MS = 90_000
const MAX_INTERVALS = 300_000

const conn = () => db.connection('analytics')
const n = (v: unknown) => Number(v ?? 0)

const PAID_SOURCES = ['single_purchase', 'extend', 'package', 'purchase']
const COMP_SOURCES = ['manual_grant', 'console_grant', 'console_ai_pro']

function pctChange(now: number, before: number) {
  if (!before) return now ? null : 0
  return Math.round(((now - before) / before) * 1000) / 10
}

class AnalyticsService {
  #cache = new Map<string, { at: number; value: unknown }>()

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
    const value = await fn()
    this.#cache.set(key, { at: Date.now(), value })
    if (this.#cache.size > 200) this.#cache.delete(this.#cache.keys().next().value!)
    return value
  }

  private range(days: number) {
    const today = istDayOf(Date.now())
    const firstDay = today - days + 1
    return { today, firstDay, since: istDayStart(firstDay), prevSince: istDayStart(firstDay - days) }
  }

  /** Who uses MultiBhashi: active users, growth, concurrency, devices, retention, when. */
  users(days: number) {
    return this.cached(`users:${days}`, async () => {
      const { today, firstDay, since, prevSince } = this.range(days)
      const now = Date.now()
      const day = istDaySql('started_at')

      const [totalUsers, signups, signupsPrev, dauRows, activeNow, wau, mau, dauToday, periodActive, prevActive, devices, versions, heat] =
        await Promise.all([
          conn().from('users').count('* as total').first(),
          conn()
            .from('users')
            .where('created_at', '>=', new Date(since))
            .groupByRaw('DATE(created_at)')
            .select(conn().raw('DATE_FORMAT(created_at, "%Y-%m-%d") as day'))
            .count('* as total'),
          conn().from('users').where('created_at', '>=', new Date(prevSince)).where('created_at', '<', new Date(since)).count('* as total').first(),
          conn()
            .from('student_sessions')
            .where('started_at', '>=', since)
            .groupByRaw(day)
            .select(conn().raw(`${day} as day`))
            .countDistinct('user_id as users')
            .count('* as sessions')
            .sum('active_seconds as seconds'),
          conn().from('student_sessions').whereNull('ended_at').where('last_heartbeat', '>', now - LIVE_HEARTBEAT_MS).countDistinct('user_id as users').first(),
          conn().from('student_sessions').where('started_at', '>=', istDayStart(today - 6)).countDistinct('user_id as users').first(),
          conn().from('student_sessions').where('started_at', '>=', istDayStart(today - 29)).countDistinct('user_id as users').first(),
          conn().from('student_sessions').where('started_at', '>=', istDayStart(today)).countDistinct('user_id as users').first(),
          conn().from('student_sessions').where('started_at', '>=', since).countDistinct('user_id as users').first(),
          conn().from('student_sessions').where('started_at', '>=', prevSince).where('started_at', '<', since).countDistinct('user_id as users').first(),
          conn().from('student_sessions').where('started_at', '>=', since).groupBy('device').select('device').countDistinct('user_id as users').count('* as sessions'),
          conn()
            .from('student_sessions')
            .where('started_at', '>=', since)
            .whereNotNull('app_version')
            .groupBy('app_version')
            .select('app_version')
            .countDistinct('user_id as users')
            .orderBy('users', 'desc')
            .limit(8),
          conn()
            .from('student_sessions')
            .where('started_at', '>=', since)
            .groupByRaw(`${istWeekdaySql('started_at')}, ${istHourSql('started_at')}`)
            .select(conn().raw(`${istWeekdaySql('started_at')} as weekday, ${istHourSql('started_at')} as hour`))
            .count('* as sessions'),
        ])

      const series = Array.from({ length: days }, (_, i) => {
        const d = firstDay + i
        const row = dauRows.find((r) => n(r.day) === d)
        const label = istDayLabel(d)
        return {
          day: label,
          activeUsers: n(row?.users),
          sessions: n(row?.sessions),
          appMinutes: Math.round(n(row?.seconds) / 60),
          signups: n(signups.find((s) => s.day === label)?.total),
        }
      })

      return {
        totals: {
          users: n(totalUsers?.total),
          signups: series.reduce((s, d) => s + d.signups, 0),
          signupsChange: pctChange(series.reduce((s, d) => s + d.signups, 0), n(signupsPrev?.total)),
          activeNow: n(activeNow?.users),
          dau: n(dauToday?.users),
          wau: n(wau?.users),
          mau: n(mau?.users),
          // Average daily actives over the last 7 days ÷ monthly actives.
          stickiness: n(mau?.users)
            ? Math.round((series.slice(-7).reduce((sum, x) => sum + x.activeUsers, 0) / 7 / n(mau?.users)) * 1000) / 10
            : 0,
          periodActive: n(periodActive?.users),
          periodActiveChange: pctChange(n(periodActive?.users), n(prevActive?.users)),
        },
        series,
        concurrency: await this.concurrency(Math.min(days, 30)),
        devices: devices.map((d) => ({ device: d.device ?? 'unknown', users: n(d.users), sessions: n(d.sessions) })),
        appVersions: versions.map((v) => ({ version: v.app_version, users: n(v.users) })),
        heatmap: heat.map((h) => ({ weekday: n(h.weekday), hour: n(h.hour), sessions: n(h.sessions) })),
        retention: await this.retention(),
      }
    })
  }

  /**
   * Peak concurrent users per IST day (exact, by sweeping session intervals) and today's
   * curve in 15-minute steps. A session counts from start to its end or last heartbeat.
   */
  private async concurrency(days: number) {
    const { firstDay, since } = this.range(days)
    const rows = await conn()
      .from('student_sessions')
      .where((q) => q.where('ended_at', '>=', since).orWhere('last_heartbeat', '>=', since).orWhereNull('ended_at'))
      .where('started_at', '<', Date.now())
      .select('user_id', 'started_at', conn().raw('COALESCE(ended_at, last_heartbeat) as stop'))
      .limit(MAX_INTERVALS)
    const today = istDayOf(Date.now())
    const peaks: { day: string; peak: number; at: string | null }[] = []
    const events: [number, number][] = []
    for (const r of rows) {
      events.push([Math.max(n(r.started_at), since), 1], [Math.max(n(r.stop), n(r.started_at)), -1])
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const perDay = new Map<number, { peak: number; at: number }>()
    let level = 0
    for (const [t, delta] of events) {
      level += delta
      const d = istDayOf(t)
      const best = perDay.get(d)
      if (!best || level > best.peak) perDay.set(d, { peak: level, at: t })
    }
    for (let d = firstDay; d <= today; d++) {
      const p = perDay.get(d)
      peaks.push({ day: istDayLabel(d), peak: p?.peak ?? 0, at: p ? new Date(p.at).toISOString() : null })
    }
    // Today's curve: concurrent sessions at each 15-minute mark so far (one more sweep).
    const start = istDayStart(today)
    const curve: { time: string; users: number }[] = []
    let running = 0
    let i = 0
    for (let t = start; t <= Math.min(Date.now(), start + DAY_MS); t += 15 * 60_000) {
      while (i < events.length && events[i][0] <= t) running += events[i++][1]
      curve.push({ time: new Date(t).toISOString(), users: running })
    }
    return { peaks, today: curve, truncated: rows.length >= MAX_INTERVALS }
  }

  /**
   * Weekly sign-up cohorts (last 8 Monday-start weeks): share who opened the app in each
   * later week. Day 0 (1970-01-01) was a Thursday, so week = floor((day + 3) / 7).
   */
  private async retention() {
    const weeks = 8
    const weekOf = (day: number) => Math.floor((day + 3) / 7)
    const weekStart = (week: number) => istDayStart(week * 7 - 3)
    const thisWeek = weekOf(istDayOf(Date.now()))
    const firstWeek = thisWeek - weeks + 1
    const cohortUsers = await conn()
      .from('users')
      .where('created_at', '>=', new Date(weekStart(firstWeek)))
      .select('id', 'created_at')
    if (!cohortUsers.length) return []
    const cohortOf = new Map<number, number>()
    for (const u of cohortUsers) {
      cohortOf.set(u.id, weekOf(istDayOf(new Date(u.created_at).getTime())))
    }
    const activity = await conn()
      .from('student_sessions')
      .whereIn('user_id', [...cohortOf.keys()])
      .where('started_at', '>=', weekStart(firstWeek))
      .select(conn().raw(`DISTINCT user_id, FLOOR((${istDaySql('started_at')} + 3) / 7) as week`))
    const activeIn = new Map<string, Set<number>>()
    for (const a of activity) {
      const cohort = cohortOf.get(a.user_id)
      if (cohort === undefined) continue
      const offset = n(a.week) - cohort
      if (offset < 0) continue
      const key = `${cohort}:${offset}`
      if (!activeIn.has(key)) activeIn.set(key, new Set())
      activeIn.get(key)!.add(a.user_id)
    }
    return Array.from({ length: weeks }, (_, i) => {
      const cohort = firstWeek + i
      const size = [...cohortOf.values()].filter((c) => c === cohort).length
      const maxOffset = thisWeek - cohort
      return {
        week: istDayLabel(cohort * 7 - 3),
        users: size,
        // Week 0 = the sign-up week; null = that week hasn't happened yet.
        weeks: Array.from({ length: weeks }, (_, k) =>
          k > maxOffset || !size ? null : Math.round(((activeIn.get(`${cohort}:${k}`)?.size ?? 0) / size) * 1000) / 10
        ),
      }
    })
  }

  /** What learners use: screens, content, events, the learning funnel, data freshness. */
  engagement(days: number) {
    return this.cached(`engagement:${days}`, async () => {
      const { firstDay, since } = this.range(days)
      const day = istDaySql('started_at')
      const [screens, resources, events, daily, funnel, freshness, stuck] = await Promise.all([
        conn()
          .from('student_learning_segments')
          .where('started_at', '>=', since)
          .groupBy('screen_type')
          .select('screen_type')
          .count('* as visits')
          .countDistinct('user_id as users')
          .sum('active_seconds as active')
          .sum('idle_seconds as idle')
          .sum('inactivity_timeouts as timeouts'),
        conn()
          .from('student_learning_segments')
          .where('started_at', '>=', since)
          .whereNotNull('resource_id')
          .groupBy('screen_type', 'resource_type', 'resource_id')
          .select('screen_type', 'resource_type', 'resource_id')
          .count('* as visits')
          .countDistinct('user_id as users')
          .sum('active_seconds as active')
          .orderBy('visits', 'desc')
          .limit(15),
        conn()
          .from('student_activity_events')
          .where('created_at_ms', '>=', since)
          .groupBy('event_type')
          .select('event_type')
          .count('* as total')
          .countDistinct('user_id as users')
          .orderBy('total', 'desc'),
        conn()
          .from('student_learning_segments')
          .where('started_at', '>=', since)
          .groupByRaw(day)
          .select(conn().raw(`${day} as day`))
          .countDistinct('user_id as users')
          .sum('active_seconds as active'),
        conn()
          .from('student_activity_events')
          .where('created_at_ms', '>=', since)
          .whereIn('event_type', ['app_open', 'lessons_open', 'pdf_open', 'quiz_start', 'quiz_end', 'ai_tutor_message'])
          .distinct('user_id', 'event_type'),
        conn().from('student_daily_activity').max('activity_date as last').first(),
        conn()
          .from('student_learning_segments')
          .where('status', 'active')
          .where('last_heartbeat', '<', Date.now() - 15 * 60_000)
          .count('* as total')
          .first(),
      ])
      // A funnel step counts learners who also did every earlier step, so it never grows.
      const did = (types: string[]) => new Set(funnel.filter((f) => types.includes(f.event_type)).map((f) => f.user_id as number))
      const steps: [string, string[]][] = [
        ['Opened the app', ['app_open']],
        ['Opened a lesson', ['lessons_open', 'pdf_open']],
        ['Started a quiz', ['quiz_start']],
        ['Finished a quiz', ['quiz_end']],
        ['Talked to the AI tutor', ['ai_tutor_message']],
      ]
      let cohort: Set<number> | null = null
      const funnelSteps = steps.map(([step, types]) => {
        const users = did(types)
        cohort = cohort ? new Set([...cohort].filter((u) => users.has(u))) : users
        return { step, users: cohort.size }
      })
      return {
        screens: screens
          .map((s) => {
            const active = n(s.active)
            const idle = n(s.idle)
            return {
              screen: s.screen_type,
              visits: n(s.visits),
              users: n(s.users),
              engagedMinutes: Math.round(active / 60),
              avgEngagedMinutes: n(s.visits) ? Math.round((active / 60 / n(s.visits)) * 10) / 10 : 0,
              idleShare: active + idle ? Math.round((idle / (active + idle)) * 1000) / 10 : 0,
              timeouts: n(s.timeouts),
            }
          })
          .sort((a, b) => b.visits - a.visits),
        topContent: resources.map((r) => ({
          screen: r.screen_type,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          visits: n(r.visits),
          users: n(r.users),
          engagedMinutes: Math.round(n(r.active) / 60),
        })),
        events: events.map((e) => ({ event: e.event_type, total: n(e.total), users: n(e.users) })),
        engagedSeries: Array.from({ length: days }, (_, i) => {
          const d = firstDay + i
          const row = daily.find((r) => n(r.day) === d)
          return {
            day: istDayLabel(d),
            learners: n(row?.users),
            minutesPerLearner: n(row?.users) ? Math.round((n(row?.active) / 60 / n(row?.users)) * 10) / 10 : 0,
          }
        }),
        funnel: funnelSteps,
        freshness: {
          lastRollupDay: freshness?.last ? DateTime.fromJSDate(new Date(freshness.last)).toISODate() : null,
          stuckSegments: n(stuck?.total),
        },
      }
    })
  }

  /** AI tutor usage, quality signals and the free/paid/comp mix. */
  tutor(days: number) {
    return this.cached(`tutor:${days}`, async () => {
      const since = new Date(this.range(days).since)
      const [base, perClass, returning, languages, sources, hours, peak] = await Promise.all([
        conn()
          .from('ai_tutor_chats')
          .where('created_at', '>=', since)
          .count('* as classes')
          .countDistinct('user_id as learners')
          .sum('time_spent as minutes')
          .avg('time_spent as avg_minutes')
          .first(),
        conn()
          .from('ai_tutor_chat_details as d')
          .join('ai_tutor_chats as c', 'c.id', 'd.ai_tutor_chat_id')
          .where('c.created_at', '>=', since)
          .groupBy('d.chat_from')
          .select('d.chat_from')
          .count('* as messages')
          .countDistinct('d.ai_tutor_chat_id as classes'),
        conn()
          .from(conn().from('ai_tutor_chats').where('created_at', '>=', since).groupBy('user_id').select('user_id').count('* as classes').as('t'))
          .select(conn().raw('SUM(CASE WHEN classes >= 2 THEN 1 ELSE 0 END) as returning, COUNT(*) as learners'))
          .first(),
        conn()
          .from('ai_tutor_session_summaries as s')
          .join('ai_tutor_chats as c', 'c.id', 's.ai_tutor_chat_id')
          .where('c.created_at', '>=', since)
          .groupBy('s.language')
          .select('s.language')
          .count('* as classes')
          .sum('c.time_spent as minutes')
          .orderBy('classes', 'desc'),
        conn().from('ai_tutor_time_logs').where('created_at', '>=', since).groupBy('source').select('source').sum('minutes_added as minutes').count('* as rows'),
        conn()
          .from('ai_tutor_chats')
          .where('created_at', '>=', since)
          .groupByRaw('HOUR(created_at)')
          .select(conn().raw('HOUR(created_at) as hour'))
          .count('* as classes'),
        conn()
          .from('ai_tutor_chats')
          .where('created_at', '>=', since)
          .whereNotNull('chat_start_timestamp')
          .select('chat_start_timestamp', 'time_spent', 'updated_at'),
      ])
      // Peak concurrent classes: each class from its start for the minutes it used.
      const ev: [number, number][] = []
      for (const c of peak) {
        const start = n(c.chat_start_timestamp)
        ev.push([start, 1], [start + Math.max(1, n(c.time_spent)) * 60_000, -1])
      }
      ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      let level = 0
      let peakClasses = 0
      for (const [, d] of ev) peakClasses = Math.max(peakClasses, (level += d))

      const learnerMsgs = perClass.find((p) => p.chat_from === 'user')
      const tutorMsgs = perClass.find((p) => p.chat_from === 'ai')
      const category = (source: string | null) =>
        source === 'free' ? 'free' : PAID_SOURCES.includes(source ?? '') ? 'paid' : COMP_SOURCES.includes(source ?? '') ? 'complimentary' : source?.startsWith('console_') ? 'adjustments' : 'other'
      const mix = new Map<string, number>()
      for (const s of sources) mix.set(category(s.source), (mix.get(category(s.source)) ?? 0) + n(s.minutes))
      return {
        classes: n(base?.classes),
        learners: n(base?.learners),
        minutesUsed: n(base?.minutes),
        avgClassMinutes: Math.round(n(base?.avg_minutes) * 10) / 10,
        learnerTurnsPerClass: n(learnerMsgs?.classes) ? Math.round((n(learnerMsgs?.messages) / n(learnerMsgs?.classes)) * 10) / 10 : 0,
        tutorTurnsPerClass: n(tutorMsgs?.classes) ? Math.round((n(tutorMsgs?.messages) / n(tutorMsgs?.classes)) * 10) / 10 : 0,
        returningShare: n(returning?.learners) ? Math.round((n(returning?.returning) / n(returning?.learners)) * 1000) / 10 : 0,
        peakConcurrentClasses: peakClasses,
        languages: languages.map((l) => ({ language: l.language ?? 'unknown', classes: n(l.classes), minutes: n(l.minutes) })),
        minutesMix: [...mix.entries()].map(([kind, minutes]) => ({ kind, minutes })),
        sources: sources.map((s) => ({ source: s.source, minutes: n(s.minutes), rows: n(s.rows) })),
        byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, classes: n(hours.find((x) => n(x.hour) === h)?.classes) })),
      }
    })
  }

  /** Week-over-week changes worth a sentence on the Insights page. */
  async highlights() {
    const [u7, t7, t14] = await Promise.all([this.users(7), this.tutor(7), this.tutor(14)])
    const items: { tone: 'up' | 'down' | 'flat' | 'warn'; text: string }[] = []
    if (u7.totals.periodActiveChange !== null && Math.abs(u7.totals.periodActiveChange) >= 10) {
      items.push({
        tone: u7.totals.periodActiveChange > 0 ? 'up' : 'down',
        text: `Active learners ${u7.totals.periodActiveChange > 0 ? 'up' : 'down'} ${Math.abs(u7.totals.periodActiveChange)}% vs the previous 7 days (${u7.totals.periodActive.toLocaleString('en-IN')}).`,
      })
    }
    if (u7.totals.signupsChange !== null && Math.abs(u7.totals.signupsChange) >= 10) {
      items.push({
        tone: u7.totals.signupsChange > 0 ? 'up' : 'down',
        text: `Sign-ups ${u7.totals.signupsChange > 0 ? 'up' : 'down'} ${Math.abs(u7.totals.signupsChange)}% week over week.`,
      })
    }
    const prevClasses = t14.classes - t7.classes
    const classChange = pctChange(t7.classes, prevClasses)
    if (classChange !== null && Math.abs(classChange) >= 10) {
      items.push({ tone: classChange > 0 ? 'up' : 'down', text: `AI tutor classes ${classChange > 0 ? 'up' : 'down'} ${Math.abs(classChange)}% week over week.` })
    }
    const engagement = await this.engagement(7)
    if (engagement.freshness.stuckSegments > 50) {
      items.push({ tone: 'warn', text: `${engagement.freshness.stuckSegments} learning sessions look stuck open: check the activity sweeper cron.` })
    }
    const yesterday = istDayLabel(istDayOf(Date.now()) - 1)
    if (engagement.freshness.lastRollupDay && engagement.freshness.lastRollupDay < yesterday) {
      items.push({ tone: 'warn', text: `The daily activity rollup last ran for ${engagement.freshness.lastRollupDay}: the 02:00 IST cron may be failing.` })
    }
    const topIdle = engagement.screens.find((s) => s.visits >= 20 && s.idleShare >= 30)
    if (topIdle) {
      items.push({ tone: 'warn', text: `Learners are idle ${topIdle.idleShare}% of the time on “${topIdle.screen}” screens: worth a UX look.` })
    }
    return items
  }

  /** How staff use the console (from the audit log). */
  staff(days: number) {
    return this.cached(`staff:${days}`, async () => {
      const since = new Date(this.range(days).since)
      const [byActor, byAction, denied] = await Promise.all([
        db.from('console_audit_logs').where('created_at', '>=', since).whereNotNull('actor_id').groupBy('actor_id', 'actor_email').select('actor_id', 'actor_email').count('* as actions').orderBy('actions', 'desc').limit(10),
        db.from('console_audit_logs').where('created_at', '>=', since).groupBy('action').select('action').count('* as total').orderBy('total', 'desc').limit(12),
        db.from('console_audit_logs').where('created_at', '>=', since).where('outcome', 'denied').count('* as total').first(),
      ])
      return {
        topStaff: byActor.map((a) => ({ id: a.actor_id, email: a.actor_email, actions: n(a.actions) })),
        topActions: byAction.map((a) => ({ action: a.action, total: n(a.total) })),
        denied: n(denied?.total),
      }
    })
  }

  clearCache() {
    this.#cache.clear()
  }
}

export default new AnalyticsService()
