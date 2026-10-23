import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import { CONSOLE_GRANT_SOURCE } from '#services/tutor/minutes_service'

const ZONE = 'Asia/Kolkata'

/**
 * Headline numbers for the Overview and AI Tutor dashboards. Days are IST days; the
 * shared database stores local (IST) wall-clock times, so DATE(created_at) is an IST day.
 */
class OverviewService {
  async tutor() {
    const today = DateTime.now().setZone(ZONE).startOf('day')
    const since14 = today.minus({ days: 13 })
    const since7 = today.minus({ days: 6 }).toJSDate()

    const [todayRow, weekRow, statuses, daily, freeToday, consoleWeek, topics] = await Promise.all([
      db
        .from('ai_tutor_chats')
        .where('created_at', '>=', today.toJSDate())
        .count('* as classes')
        .countDistinct('user_id as learners')
        .sum('time_spent as minutes')
        .first(),
      db
        .from('ai_tutor_chats')
        .where('created_at', '>=', since7)
        .count('* as classes')
        .countDistinct('user_id as learners')
        .sum('time_spent as minutes')
        .first(),
      db
        .from('ai_tutor_chats')
        .where('created_at', '>=', since7)
        .groupBy('status')
        .select('status')
        .count('* as total'),
      db
        .from('ai_tutor_chats')
        .where('created_at', '>=', since14.toJSDate())
        .groupByRaw('DATE(created_at)')
        .select(db.raw('DATE_FORMAT(created_at, "%Y-%m-%d") as day'))
        .count('* as classes')
        .countDistinct('user_id as learners')
        .sum('time_spent as minutes'),
      db.from('ai_tutor_grants').where('created_at', '>=', today.toJSDate()).count('* as total').sum('minutes as minutes').first(),
      db
        .from('ai_tutor_time_logs')
        .where('source', CONSOLE_GRANT_SOURCE)
        .where('created_at', '>=', since7)
        .count('* as total')
        .sum('minutes_added as minutes')
        .first(),
      db
        .from('ai_tutor_chats')
        .where('created_at', '>=', since7)
        .groupBy('lesson_topic')
        .select('lesson_topic')
        .count('* as total')
        .orderBy('total', 'desc')
        .limit(6),
    ])

    const series = Array.from({ length: 14 }, (_, i) => {
      const day = since14.plus({ days: i }).toFormat('yyyy-MM-dd')
      const row = daily.find((d) => d.day === day)
      return {
        day,
        classes: Number(row?.classes ?? 0),
        learners: Number(row?.learners ?? 0),
        minutes: Number(row?.minutes ?? 0),
      }
    })
    const n = (v: unknown) => Number(v ?? 0)
    return {
      today: { classes: n(todayRow?.classes), learners: n(todayRow?.learners), minutes: n(todayRow?.minutes) },
      week: { classes: n(weekRow?.classes), learners: n(weekRow?.learners), minutes: n(weekRow?.minutes) },
      statuses: statuses.map((s) => ({ status: s.status ?? 'unknown', total: n(s.total) })),
      freeGrantsToday: { grants: n(freeToday?.total), minutes: n(freeToday?.minutes) },
      consoleGrantsWeek: { grants: n(consoleWeek?.total), minutes: n(consoleWeek?.minutes) },
      topTopics: topics.map((t) => ({ topic: t.lesson_topic ?? '—', total: n(t.total) })),
      series,
    }
  }
}

export default new OverviewService()
