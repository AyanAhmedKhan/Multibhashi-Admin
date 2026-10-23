import db from '@adonisjs/lucid/services/db'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import learnerMemoryService from '#services/tutor/memory_service'
import { maskEmail, maskName, maskPhone } from '#helpers/mask'
import type { Actor } from '#services/actor'

interface LearnerRow {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  created_at: Date | null
}

const like = (text: string) => `%${text.replace(/[%_\\]/g, '\\$&')}%`

function masked(row: LearnerRow) {
  return {
    id: row.id,
    name: maskName(row.name),
    email: maskEmail(row.email),
    phone: maskPhone(row.phone),
    createdAt: row.created_at,
  }
}

class LearnersService {
  /**
   * Finds learners by id, phone (full or last digits), name or email. Results are always
   * masked; revealing one learner's contact details is a separate, audited call.
   */
  async search(q: string, page: number, perPage: number) {
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
          ...masked(row as LearnerRow),
          classes: Number(s?.classes ?? 0),
          minutesUsed: Number(s?.minutes_used ?? 0),
          lastClassAt: s?.last_class_at ?? null,
        }
      }),
    }
  }

  async get(id: number) {
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
    return {
      learner: masked(row),
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
