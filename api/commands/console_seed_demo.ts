import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { assertLocalDevDatabase } from '#helpers/dev_guard'

/**
 * LOCAL ONLY: synthetic demo data so every Insights and AI Pro screen can be seen and
 * tested on the Docker database. Deterministic (seeded PRNG). Demo learners are ids
 * 5001–5400 (phones 70000xxxxx); demo courses 9001–9003. Never touches learners
 * 1001–1003 or any real row. `--remove` deletes exactly what it created.
 */
const FIRST_USER = 5001
const USERS = 400
const DAYS = 60
const COURSES = [
  { id: 9001, name: 'Kannada for Beginners (demo)', language: 'kn-IN' },
  { id: 9002, name: 'Spanish Essentials (demo)', language: 'es-ES' },
  { id: 9003, name: 'Hindi Speaking (demo)', language: 'hi-IN' },
]
const LEVELS = ['A1.1', 'A1.2']
const LESSONS_PER_LEVEL = 10

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export default class ConsoleSeedDemo extends BaseCommand {
  static commandName = 'console:seed-demo'
  static description = 'LOCAL ONLY: add (or --remove) synthetic demo learners, activity and courses'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Delete the demo data instead of creating it' })
  declare remove: boolean

  async run() {
    const { default: env } = await import('#start/env')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    assertLocalDevDatabase(env)

    const lastUser = FIRST_USER + USERS - 1
    const courseIds = COURSES.map((c) => c.id)
    // Per-class AI usage (docs/AI_USAGE_SPEC.md) only once the tutor API's migration made the table.
    const usageTable =
      Number(
        (
          await db
            .from('information_schema.tables')
            .whereRaw('table_schema = DATABASE()')
            .where('table_name', 'ai_tutor_session_usage')
            .count('* as total')
        )[0]?.total ?? 0
      ) > 0
    const removeAll = async () => {
      const chats = await db.from('ai_tutor_chats').whereBetween('user_id', [FIRST_USER, lastUser]).select('id')
      const chatIds = chats.map((c) => c.id)
      for (let i = 0; i < chatIds.length; i += 500) {
        await db.from('ai_tutor_chat_details').whereIn('ai_tutor_chat_id', chatIds.slice(i, i + 500)).delete()
      }
      for (const table of [
        'ai_tutor_session_summaries',
        'ai_tutor_time_logs',
        'ai_tutor_grants',
        'ai_tutor_learner_memories',
        'ai_tutor_chats',
        'student_activity_events',
        'student_learning_segments',
        'student_sessions',
        'student_daily_activity',
        'course_lesson_package_bookings',
        'course_lesson_subscriptions',
        'console_ai_pro_grants',
        'direct_leads',
        ...(usageTable ? ['ai_tutor_session_usage'] : []),
      ]) {
        await db.from(table).whereBetween('user_id', [FIRST_USER, lastUser]).delete()
      }
      const quizIds = (await db.from('course_lessons').whereIn('course_id', courseIds).select('quiz_id')).map((q) => q.quiz_id)
      if (quizIds.length) await db.from('quiz_questions').whereIn('quiz_id', quizIds).delete()
      await db.from('course_lessons').whereIn('course_id', courseIds).delete()
      await db.from('course_lesson_packages').whereIn('course_id', courseIds).delete()
      await db.from('courses').whereIn('id', courseIds).delete()
      await db.from('users').whereBetween('id', [FIRST_USER, lastUser]).delete()
    }

    if (this.remove) {
      await removeAll()
      this.logger.success('Demo data removed')
      return
    }
    await removeAll()

    const random = rng(20261023)
    const pick = <T>(items: T[], weights?: number[]) => {
      if (!weights) return items[Math.floor(random() * items.length)]
      const total = weights.reduce((a, b) => a + b, 0)
      let r = random() * total
      for (let i = 0; i < items.length; i++) if ((r -= weights[i]) <= 0) return items[i]
      return items[items.length - 1]
    }
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
    const now = Date.now()
    const insert = async (table: string, rows: Record<string, unknown>[]) => {
      for (let i = 0; i < rows.length; i += 500) await db.table(table).multiInsert(rows.slice(i, i + 500))
    }

    // --- courses, lessons, PDF learn cards, AI packages
    const lessons: { id: number; course: (typeof COURSES)[number]; quizId: number; name: string; cards: number[] }[] = []
    let lessonId = 90_000
    let quizId = 900_000
    let cardId = 9_000_000
    let otherQuestionId = 9_500_000
    for (const course of COURSES) {
      await db.table('courses').insert({ id: course.id, title: course.name, slug: `demo-${course.id}`, created_at: new Date(), updated_at: new Date() })
      await db.table('course_lesson_packages').insert({
        course_id: course.id,
        name: 'Premium',
        status: 'active',
        sort_order: 1,
        mrp: 1999,
        selling_price: 999,
        duration_days: 30,
        total_quizzes: 20,
        has_ai_tutor: 1,
        ai_chat_type: 'voice',
        ai_chat_duration: 30,
        created_at: new Date(),
        updated_at: new Date(),
      })
      for (const level of LEVELS) {
        for (let n = 1; n <= LESSONS_PER_LEVEL; n++) {
          lessonId++
          quizId++
          const name = `${course.name.split(' ')[0]} ${level} · Lesson ${n}`
          await db.table('course_lessons').insert({
            id: lessonId,
            course_id: course.id,
            name,
            quiz_id: quizId,
            category: 'lesson',
            course_level: level,
            lesson_number: n,
            lesson_order: n,
            is_deleted: 0,
            created_at: new Date(),
            updated_at: new Date(),
          })
          const cards: number[] = []
          for (let c = 0; c < (n % 4 === 0 ? 2 : 1); c++) {
            cardId++
            cards.push(cardId)
            await db.table('quiz_questions').insert({ id: cardId, quiz_id: quizId, type_code: 'LEARN_CARD', sub_type_code: 'PDF', created_at: new Date(), updated_at: new Date() })
          }
          await db.table('quiz_questions').insert({ id: ++otherQuestionId, quiz_id: quizId, type_code: 'MCQ', sub_type_code: null, created_at: new Date(), updated_at: new Date() })
          lessons.push({ id: lessonId, course, quizId, name, cards })
        }
      }
    }

    // --- learners: sign-ups grow over the last 70 days
    const users: { id: number; createdAt: number; engagement: number; course: (typeof COURSES)[number] }[] = []
    for (let i = 0; i < USERS; i++) {
      const ageDays = Math.floor(Math.pow(random(), 1.6) * 70)
      users.push({
        id: FIRST_USER + i,
        createdAt: now - ageDays * 86_400_000 - int(0, 86_399) * 1000,
        engagement: Math.pow(random(), 1.8),
        course: pick(COURSES, [5, 2, 3]),
      })
    }
    // Like production, a third sign up by phone and keep the app's placeholder name "User"
    // with no email; some of those have a CRM enquiry that carries their real name.
    const placeholder = (id: number) => id % 3 === 0
    await insert(
      'users',
      users.map((u) => ({
        id: u.id,
        phone: `70000${String(u.id).padStart(5, '0')}`,
        name: placeholder(u.id) ? 'User' : `Demo Learner ${u.id - FIRST_USER + 1}`,
        email: placeholder(u.id) ? null : `demo${u.id}@example.test`,
        created_at: new Date(u.createdAt),
        updated_at: new Date(u.createdAt),
      }))
    )
    await insert(
      'direct_leads',
      users
        .filter((u) => placeholder(u.id) && u.id % 2 === 0)
        .map((u) => ({
          user_id: u.id,
          name: `Enquiry Name ${u.id - FIRST_USER + 1}`,
          phone: `70000${String(u.id).padStart(5, '0')}`,
          created_at: new Date(u.createdAt),
          updated_at: new Date(u.createdAt),
        }))
    )

    // --- app sessions, screen visits, events
    const sessions: Record<string, unknown>[] = []
    const segments: Record<string, unknown>[] = []
    const events: Record<string, unknown>[] = []
    const hourWeights = [1, 0.5, 0.3, 0.2, 0.2, 0.5, 2, 5, 6, 4, 3, 3, 3, 3, 3, 3, 4, 5, 7, 9, 10, 8, 5, 2]
    const screens = ['lesson', 'pdf', 'quiz', 'quiz_feedback', 'video', 'ai_tutor']
    const screenWeights = [5, 6, 5, 3, 2, 2]
    let seq = 0
    const istMidnight = (ms: number) => ms - ((ms + 19_800_000) % 86_400_000)
    for (const u of users) {
      for (let d = DAYS; d >= 0; d--) {
        const dayStart = istMidnight(now) - d * 86_400_000
        if (dayStart < u.createdAt - 86_400_000) continue
        const weekend = new Date(dayStart + 19_800_000).getUTCDay() % 6 === 0
        const sinceSignup = (dayStart - u.createdAt) / 86_400_000
        const p = u.engagement * (sinceSignup < 7 ? 0.9 : 0.55) * (weekend ? 0.7 : 1)
        if (random() > p) continue
        const count = int(1, u.engagement > 0.6 ? 3 : 2)
        for (let s = 0; s < count; s++) {
          const start = dayStart + pick([...Array(24).keys()], hourWeights) * 3_600_000 + int(0, 3599) * 1000
          if (start > now) continue
          const length = int(3, 45) * 60_000
          const live = d === 0 && start + length > now
          const end = live ? null : start + length
          seq++
          const sessionUuid = `demo-s-${seq}`
          sessions.push({
            uuid: sessionUuid,
            user_id: u.id,
            device: pick(['android', 'web', 'ios'], [6, 3, 1]),
            app_version: pick(['4.4.0', '4.3.1', '4.2.0'], [6, 3, 1]),
            started_at: start,
            last_heartbeat: live ? now - int(0, 25) * 1000 : start + length,
            ended_at: end,
            active_seconds: Math.round((live ? now - start : length) / 1000),
            created_at: new Date(start),
            updated_at: new Date(start),
          })
          events.push({ user_id: u.id, event_type: 'app_open', created_at_ms: start, created_at: new Date(start) })
          let t = start + 20_000
          const lesson = pick(lessons.filter((l) => l.course === u.course))
          for (let g = int(1, 4); g > 0 && t < (end ?? now); g--) {
            const screen = pick(screens, screenWeights)
            const visit = int(1, 12) * 60_000
            const idleShare = screen === 'pdf' ? random() * 0.45 : screen === 'video' ? random() * 0.2 : random() * 0.15
            const total = Math.min(visit, (end ?? now) - t)
            if (total <= 0) break
            seq++
            segments.push({
              uuid: `demo-g-${seq}`,
              user_id: u.id,
              screen_type: screen,
              resource_type: screen === 'video' ? 'recording' : screen.startsWith('quiz') || screen === 'ai_tutor' ? 'quiz' : 'course_lesson',
              resource_id: String(screen === 'pdf' || screen === 'lesson' ? lesson.id : lesson.quizId),
              context_type: 'course_lesson',
              course_lesson_id: lesson.id,
              started_at: t,
              last_heartbeat: t + total,
              ended_at: live && g === 1 ? null : t + total,
              active_seconds: Math.round((total * (1 - idleShare)) / 1000),
              idle_seconds: Math.round((total * idleShare) / 1000),
              status: live && g === 1 ? 'active' : 'ended',
              inactivity_prompts: idleShare > 0.3 ? 1 : 0,
              inactivity_timeouts: idleShare > 0.4 ? 1 : 0,
              end_reason: 'navigated_away',
              created_at: new Date(t),
              updated_at: new Date(t),
            })
            const type = { lesson: 'lessons_open', pdf: 'pdf_open', quiz: 'quiz_start', quiz_feedback: 'quiz_end', video: 'video_play', ai_tutor: 'ai_tutor_message' }[screen]!
            events.push({ user_id: u.id, event_type: type, resource_id: String(lesson.quizId), created_at_ms: t, created_at: new Date(t) })
            if (screen === 'quiz' && random() < 0.7) events.push({ user_id: u.id, event_type: 'quiz_end', created_at_ms: t + total, created_at: new Date(t + total) })
            t += total + 10_000
          }
        }
      }
    }
    await insert('student_sessions', sessions)
    await insert('student_learning_segments', segments)
    await insert('student_activity_events', events)

    // --- daily rollup up to yesterday (what the 02:00 IST cron produces)
    await db.rawQuery(
      `INSERT INTO student_daily_activity (user_id, activity_date, app_minutes, sessions_count, created_at, updated_at)
       SELECT user_id, DATE(FROM_UNIXTIME(0) + INTERVAL FLOOR((started_at + 19800000) / 86400000) DAY), ROUND(SUM(active_seconds) / 60), COUNT(*), NOW(), NOW()
       FROM student_sessions WHERE user_id BETWEEN ? AND ? AND started_at < ?
       GROUP BY user_id, DATE(FROM_UNIXTIME(0) + INTERVAL FLOOR((started_at + 19800000) / 86400000) DAY)`,
      [FIRST_USER, lastUser, istMidnight(now)]
    )

    // --- AI tutor classes for a share of learners
    let classes = 0
    for (const u of users.filter(() => random() < 0.28)) {
      const mine = lessons.filter((l) => l.course === u.course).slice(0, int(1, 6))
      for (const lesson of mine) {
        const card = lesson.cards[0]
        const startedAt = Math.max(u.createdAt, now - int(0, DAYS) * 86_400_000) + int(0, 50_000) * 1000
        if (startedAt > now) continue
        const total = 30
        const spent = Math.min(total, int(2, 30))
        const [chatId] = await db.table('ai_tutor_chats').insert({
          user_id: u.id,
          quiz_id: lesson.quizId,
          quiz_question_id: card,
          room_name: `tutor-${lesson.quizId}-${startedAt}`,
          status: spent >= 28 ? 'completed' : 'paused',
          total_minutes: total,
          remaining_minutes: total - spent,
          time_spent: spent,
          lesson_topic: lesson.name,
          chat_start_timestamp: startedAt,
          created_at: new Date(startedAt),
          updated_at: new Date(startedAt + spent * 60_000),
        })
        const paid = random() < 0.3
        await db.table('ai_tutor_time_logs').insert({
          user_id: u.id,
          quiz_question_id: card,
          ai_tutor_chat_id: chatId,
          source: paid ? 'single_purchase' : 'free',
          minutes_added: total,
          previous_total: 0,
          new_total: total,
          created_at: new Date(startedAt),
          updated_at: new Date(startedAt),
        })
        if (!paid) {
          await db.table('ai_tutor_grants').insert({ user_id: u.id, ai_tutor_chat_id: chatId, source: 'free', minutes: total, created_at: new Date(startedAt) })
        }
        const turns = Math.max(2, Math.round(spent * 1.6))
        const details = []
        for (let k = 0; k < turns; k++) {
          details.push({
            ai_tutor_chat_id: chatId,
            chat: k % 2 ? 'Demo learner reply' : 'Demo tutor line',
            chat_from: k % 2 ? 'user' : 'ai',
            chat_type: 'voice',
            created_at: new Date(startedAt + k * 20_000),
            updated_at: new Date(startedAt + k * 20_000),
          })
        }
        await insert('ai_tutor_chat_details', details)
        await db.table('ai_tutor_session_summaries').insert({
          ai_tutor_chat_id: chatId,
          user_id: u.id,
          quiz_id: lesson.quizId,
          language: u.course.language,
          summary: 'Demo class summary',
          created_at: new Date(startedAt),
          updated_at: new Date(startedAt),
        })
        // ~85 % of classes report usage (the rest stand for older classes, estimated).
        if (usageTable && random() < 0.85) {
          const foreign = !u.course.language.endsWith('-IN')
          const noise = () => 0.75 + random() * 0.5
          const seconds = spent * 60
          const items: [string, string, string, string, number][] = [
            // The agent streams the whole class to Sarvam, plus ~20 s around it (measured 2026-10-23)
            ['stt', 'sarvam', 'saaras:v3-realtime', 'audio_seconds', seconds + 20 * noise()],
            ['llm', 'google', 'gemini-3.1-flash-lite', 'input_tokens', spent * 8000 * noise()],
            ['llm', 'google', 'gemini-3.1-flash-lite', 'cached_input_tokens', spent * 12000 * noise()],
            ['llm', 'google', 'gemini-3.1-flash-lite', 'output_tokens', spent * 300 * noise()],
            ['memory', 'google', 'gemini-3.5-flash', 'input_tokens', 9000 * noise()],
            ['memory', 'google', 'gemini-3.5-flash', 'output_tokens', 800 * noise()],
            ['transport', 'livekit', '', 'participant_seconds', seconds * 2],
            ...(foreign
              ? ([
                  ['tts', 'google', 'gemini-3.8-flash-lite-tts', 'characters', spent * 420 * noise()],
                  ['tts', 'google', 'gemini-3.8-flash-lite-tts', 'output_audio_seconds', seconds * 0.5 * noise()],
                ] as [string, string, string, string, number][])
              : ([['tts', 'sarvam', 'bulbul:v3', 'characters', spent * 450 * noise()]] as [string, string, string, string, number][])),
          ]
          await insert(
            'ai_tutor_session_usage',
            items.map(([kind, provider, model, unit, quantity]) => ({
              ai_tutor_chat_id: chatId,
              user_id: u.id,
              job_id: `demo-job-${chatId}`,
              engine: foreign ? 'global' : 'sarvam',
              language: u.course.language,
              explain_language: 'en-IN',
              kind,
              provider,
              model,
              unit,
              quantity: Math.round(quantity * 1000) / 1000,
              created_at: new Date(startedAt),
              updated_at: new Date(startedAt),
            }))
          )
        }
        classes++
      }
    }

    this.logger.success(
      `Demo data: ${USERS} learners, ${sessions.length} app sessions, ${segments.length} screen visits, ${events.length} events, ${classes} AI tutor classes, ${lessons.length} lessons`
    )
  }
}
