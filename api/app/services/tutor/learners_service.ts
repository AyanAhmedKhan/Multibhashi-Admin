import db from '@adonisjs/lucid/services/db'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import learnerMemoryService from '#services/tutor/memory_service'
import { maskEmail, maskName, maskPhone } from '#helpers/mask'
import { tableExists, withoutSecrets } from '#helpers/schema'
import type { Actor } from '#services/actor'

interface LearnerRow {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  created_at: Date | null
}

const like = (text: string) => `%${text.replace(/[%_\\]/g, '\\$&')}%`

function plain(row: LearnerRow) {
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, createdAt: row.created_at, masked: false }
}

function masked(row: LearnerRow) {
  return {
    id: row.id,
    name: maskName(row.name),
    email: maskEmail(row.email),
    phone: maskPhone(row.phone),
    createdAt: row.created_at,
    masked: true,
  }
}

class LearnersService {
  /**
   * Finds learners by id, phone (full or last digits), name or email. Staff with
   * `learners.pii.read` see names and contact details; everyone else sees them masked.
   */
  async search(q: string, page: number, perPage: number, showPii: boolean) {
    const term = q.trim()
    const query = db.from('users').select('id', 'name', 'email', 'phone', 'created_at').orderBy('id', 'desc')
    if (term) {
      const digits = term.replace(/\D/g, '')
      query.where((w) => {
        if (/^\d+$/.test(term)) w.orWhere('id', Number(term))
        if (digits.length >= 4) w.orWhere('phone', 'like', `%${digits}`)
        if (!/^\d+$/.test(term)) w.orWhereILike('name', like(term)).orWhereILike('email', like(term))
      })
    } else {
      // Without a term, list learners who used the tutor most recently.
      query.whereIn('id', db.from('ai_tutor_chats').select('user_id').where('created_at', '>', new Date(Date.now() - 30 * 86400_000)))
    }
    const result = await query.paginate(page, perPage)
    const json = result.toJSON()
    const ids = json.data.map((r) => r.id)
    const stats = ids.length
      ? await db
          .from('ai_tutor_chats')
          .whereIn('user_id', ids)
          .groupBy('user_id')
          .select('user_id')
          .count('* as classes')
          .sum('time_spent as minutes_used')
          .max('created_at as last_class_at')
      : []
    return {
      ...json,
      data: json.data.map((row) => {
        const s = stats.find((x) => x.user_id === row.id)
        return {
          ...(showPii ? plain(row as LearnerRow) : masked(row as LearnerRow)),
          classes: Number(s?.classes ?? 0),
          minutesUsed: Number(s?.minutes_used ?? 0),
          lastClassAt: s?.last_class_at ?? null,
        }
      }),
    }
  }

  async get(id: number, actor: Actor) {
    const showPii = actor.permissions.has('learners.pii.read')
    const row = (await db.from('users').where('id', id).select('id', 'name', 'email', 'phone', 'created_at').first()) as
      | LearnerRow
      | undefined
    if (!row) throw new ApiException(404, 'Learner not found')
    const [classes, totals, grantsToday, memory] = await Promise.all([
      db
        .from('ai_tutor_chats')
        .where('user_id', id)
        .orderBy('id', 'desc')
        .limit(100)
        .select('id', 'quiz_id', 'quiz_question_id', 'status', 'lesson_topic', 'total_minutes', 'remaining_minutes', 'time_spent', 'created_at', 'updated_at'),
      db
        .from('ai_tutor_chats')
        .where('user_id', id)
        .count('* as classes')
        .sum('time_spent as minutes_used')
        .sum('remaining_minutes as minutes_left')
        .first(),
      db
        .from('ai_tutor_grants')
        .where('user_id', id)
        .where('created_at', '>', new Date(Date.now() - 24 * 3600_000))
        .count('* as total')
        .first(),
      db.from('ai_tutor_learner_memories').where('user_id', id).where('scope', 'profile').select('version', 'erased_at', 'updated_at').first(),
    ])
    if (showPii) {
      // Opening a full profile is a personal-data read: recorded, no reason asked.
      await auditService.record({ actor, action: 'learners.profile.viewed', targetType: 'learner', targetId: id })
    }
    return {
      learner: showPii ? plain(row) : masked(row),
      profile: showPii ? await this.profile(id) : null,
      stats: {
        classes: Number(totals?.classes ?? 0),
        minutesUsed: Number(totals?.minutes_used ?? 0),
        minutesLeft: Number(totals?.minutes_left ?? 0),
        freeGrantsLast24h: Number(grantsToday?.total ?? 0),
      },
      memory: memory ? { version: memory.version, erasedAt: memory.erased_at, updatedAt: memory.updated_at } : null,
      classes,
    }
  }

  /**
   * Everything the platform knows about a learner that helps staff serve them: the
   * account row and profile row (secret-looking columns removed), languages, app
   * activity, bookings and subscriptions. Monolith tables that don't exist in this
   * database are simply skipped.
   */
  private async profile(id: number) {
    const since30 = Date.now() - 30 * 86400_000
    const [account, details, sourceLangs, targetLangs, sessions, devices, segments, bookings, subscriptions] = await Promise.all([
      db.from('users').where('id', id).first(),
      (await tableExists('user_profiles')) ? db.from('user_profiles').where('user_id', id).orderBy('id', 'desc').first() : null,
      (await tableExists('user_source_languages')) ? db.from('user_source_languages').where('user_id', id).limit(20) : [],
      (await tableExists('user_target_languages')) ? db.from('user_target_languages').where('user_id', id).limit(20) : [],
      (await tableExists('student_sessions'))
        ? db.from('student_sessions').where('user_id', id).select(db.raw('MAX(last_heartbeat) as last_seen'), db.raw(`SUM(CASE WHEN started_at >= ${since30} THEN 1 ELSE 0 END) as sessions_30d`), db.raw(`SUM(CASE WHEN started_at >= ${since30} THEN active_seconds ELSE 0 END) as app_seconds_30d`)).first()
        : null,
      (await tableExists('student_sessions'))
        ? db.from('student_sessions').where('user_id', id).groupBy('device', 'app_version').select('device', 'app_version').max('last_heartbeat as last_seen').orderBy('last_seen', 'desc').limit(5)
        : [],
      (await tableExists('student_learning_segments'))
        ? db.from('student_learning_segments').where('user_id', id).where('started_at', '>=', since30).groupBy('screen_type').select('screen_type').sum('active_seconds as active').count('* as visits').orderBy('active', 'desc')
        : [],
      (await tableExists('course_bookings'))
        ? db.from('course_bookings').where('user_id', id).orderBy('id', 'desc').limit(20)
        : [],
      (await tableExists('user_subscriptions'))
        ? db.from('user_subscriptions').where('user_id', id).orderBy('id', 'desc').limit(20)
        : [],
    ])
    const lastSeen = Number(sessions?.last_seen) || null
    return {
      account: withoutSecrets(account),
      details: withoutSecrets(details),
      languages: {
        speaks: sourceLangs.map((l: Record<string, unknown>) => withoutSecrets(l)),
        learns: targetLangs.map((l: Record<string, unknown>) => withoutSecrets(l)),
      },
      activity: {
        lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
        sessions30d: Number(sessions?.sessions_30d ?? 0),
        appMinutes30d: Math.round(Number(sessions?.app_seconds_30d ?? 0) / 60),
        devices: devices.map((d: Record<string, unknown>) => ({ device: d.device, appVersion: d.app_version, lastSeen: Number(d.last_seen) ? new Date(Number(d.last_seen)).toISOString() : null })),
        screens30d: segments.map((s: Record<string, unknown>) => ({ screen: s.screen_type, visits: Number(s.visits), minutes: Math.round(Number(s.active) / 60) })),
      },
      bookings: bookings.map((b: Record<string, unknown>) => withoutSecrets(b)),
      subscriptions: subscriptions.map((b: Record<string, unknown>) => withoutSecrets(b)),
    }
  }

  async reveal(actor: Actor, id: number, reason: string) {
    const row = await db.from('users').where('id', id).select('id', 'name', 'email', 'phone').first()
    if (!row) throw new ApiException(404, 'Learner not found')
    await auditService.record({ actor, action: 'learners.pii.revealed', targetType: 'learner', targetId: id, reason })
    return { id: row.id, name: row.name, email: row.email, phone: row.phone }
  }

  /**
   * Everything the AI tutor holds about one learner, for a data access request (DPDP
   * Act 2023, s.11): contact, classes, transcripts, minutes, memory.
   */
  async export(actor: Actor, id: number, reason: string) {
    const learner = await db.from('users').where('id', id).select('id', 'name', 'email', 'phone', 'created_at').first()
    if (!learner) throw new ApiException(404, 'Learner not found')
    const classes = await db.from('ai_tutor_chats').where('user_id', id).orderBy('id')
      .select('id', 'quiz_id', 'quiz_question_id', 'status', 'lesson_topic', 'total_minutes', 'remaining_minutes', 'time_spent', 'created_at', 'updated_at')
    const classIds = classes.map((c) => c.id)
    const [messages, ledger, grants, memory] = await Promise.all([
      classIds.length
        ? db.from('ai_tutor_chat_details').whereIn('ai_tutor_chat_id', classIds).orderBy('id').select('ai_tutor_chat_id', 'chat_from', 'chat', 'created_at')
        : [],
      db.from('ai_tutor_time_logs').where('user_id', id).orderBy('id').select('source', 'minutes_added', 'new_total', 'quiz_question_id', 'created_at'),
      db.from('ai_tutor_grants').where('user_id', id).orderBy('id').select('source', 'minutes', 'ai_tutor_chat_id', 'created_at'),
      learnerMemoryService.get(id),
    ])
    await auditService.record({
      actor,
      action: 'learners.exported',
      targetType: 'learner',
      targetId: id,
      reason,
      metadata: { classes: classes.length, messages: messages.length },
    })
    return {
      exportedAt: new Date().toISOString(),
      scope: 'AI tutor data held by MultiBhashi',
      learner,
      classes: classes.map((c) => ({ ...c, messages: messages.filter((m) => m.ai_tutor_chat_id === c.id) })),
      minutesLedger: ledger,
      freeGrants: grants,
      memory,
    }
  }
}

export default new LearnersService()
