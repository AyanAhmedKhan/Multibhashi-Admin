import db from '@adonisjs/lucid/services/db'
import AiTutorChat from '#models/ai_tutor_chat'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import { maskName } from '#helpers/mask'
import type { Actor } from '#services/actor'

export interface ClassFilters {
  status?: string
  userId?: number
  q?: string
  from?: Date
  to?: Date
  page: number
  perPage: number
}

const like = (text: string) => `%${text.replace(/[%_\\]/g, '\\$&')}%`

class ClassesService {
  async list(filters: ClassFilters, revealNames: boolean) {
    const query = db
      .from('ai_tutor_chats as c')
      .leftJoin('users as u', 'u.id', 'c.user_id')
      .select(
        'c.id',
        'c.user_id',
        'c.quiz_id',
        'c.quiz_question_id',
        'c.status',
        'c.total_minutes',
        'c.remaining_minutes',
        'c.time_spent',
        'c.lesson_topic',
        'c.room_name',
        'c.parent_session_id',
        'c.created_at',
        'c.updated_at',
        'u.name as learner_name'
      )
      .orderBy('c.id', 'desc')
    if (filters.status) query.where('c.status', filters.status)
    if (filters.userId) query.where('c.user_id', filters.userId)
    if (filters.from) query.where('c.created_at', '>=', filters.from)
    if (filters.to) query.where('c.created_at', '<', filters.to)
    if (filters.q) {
      const q = filters.q.trim()
      query.where((w) => {
        w.whereILike('c.lesson_topic', like(q)).orWhereILike('c.room_name', like(q))
        if (/^\d+$/.test(q)) w.orWhere('c.id', Number(q))
      })
    }
    const page = await query.paginate(filters.page, filters.perPage)
    const json = page.toJSON()
    return {
      ...json,
      data: json.data.map((row) => ({
        ...row,
        learner_name: revealNames ? row.learner_name : maskName(row.learner_name),
      })),
    }
  }

  async get(id: number) {
    const chat = await AiTutorChat.find(id)
    if (!chat) throw new ApiException(404, 'Class not found')
    const [counts, ledger, grants, summary] = await Promise.all([
      db
        .from('ai_tutor_chat_details')
        .where('ai_tutor_chat_id', id)
        .select('chat_from')
        .count('* as total')
        .groupBy('chat_from'),
      db
        .from('ai_tutor_time_logs')
        .where('user_id', chat.userId)
        .where('quiz_question_id', chat.quizQuestionId ?? 0)
        .orderBy('id', 'desc')
        .select('id', 'source', 'minutes_added', 'previous_total', 'new_total', 'ai_tutor_chat_id', 'created_at'),
      db.from('ai_tutor_grants').where('ai_tutor_chat_id', id).orderBy('id', 'desc'),
      db.from('ai_tutor_session_summaries').where('ai_tutor_chat_id', id).select('summary', 'language', 'updated_at').first(),
    ])
    return {
      id: chat.id,
      userId: chat.userId,
      quizId: chat.quizId,
      quizQuestionId: chat.quizQuestionId,
      status: chat.status,
      totalMinutes: chat.totalMinutes,
      remainingMinutes: chat.remainingMinutes,
      timeSpent: chat.timeSpent,
      topic: chat.lessonTopic,
      roomName: chat.roomName,
      parentSessionId: chat.parentSessionId,
      historyStartDetailId: chat.historyStartDetailId,
      startedAt: chat.chatStartTimestamp ? new Date(Number(chat.chatStartTimestamp)) : null,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      lessonChars: chat.lessonContent?.length ?? 0,
      messages: Object.fromEntries(counts.map((c) => [c.chat_from, Number(c.total)])),
      ledger,
      grants,
      hasSummary: !!summary,
      summaryLanguage: summary?.language ?? null,
    }
  }

  /**
   * The whole transcript, including what came before a learner's "reset" (the tutor only
   * reads details after history_start_detail_id; support sees both, with the divider).
   * A sensitive read: the reason is audited.
   */
  async transcript(actor: Actor, id: number, reason: string) {
    const chat = await AiTutorChat.find(id)
    if (!chat) throw new ApiException(404, 'Class not found')
    const messages = await db
      .from('ai_tutor_chat_details')
      .where('ai_tutor_chat_id', id)
      .orderBy('id', 'asc')
      .limit(2000)
      .select('id', 'chat', 'chat_from', 'chat_type', 'created_at')
    const summary = await db
      .from('ai_tutor_session_summaries')
      .where('ai_tutor_chat_id', id)
      .select('summary', 'details', 'language', 'updated_at')
      .first()
    await auditService.record({
      actor,
      action: 'tutor.transcript.viewed',
      targetType: 'class',
      targetId: id,
      reason,
      metadata: { user_id: chat.userId, messages: messages.length },
    })
    return {
      classId: id,
      resetAfterId: chat.historyStartDetailId,
      messages,
      summary: summary
        ? { ...summary, details: typeof summary.details === 'string' ? JSON.parse(summary.details) : summary.details }
        : null,
    }
  }
}

export default new ClassesService()
