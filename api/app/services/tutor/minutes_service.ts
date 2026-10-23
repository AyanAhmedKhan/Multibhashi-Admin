import db from '@adonisjs/lucid/services/db'
import AiTutorChat from '#models/ai_tutor_chat'
import AiTutorTimeLog from '#models/ai_tutor_time_log'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import approvalService from '#services/approval_service'
import settingsService from '#services/settings_service'
import type { Actor } from '#services/actor'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/** ai_tutor_time_logs.source of console adjustments (CLI grants use `manual_grant`). */
export const CONSOLE_GRANT_SOURCE = 'console_grant'
export const CONSOLE_DEDUCT_SOURCE = 'console_deduct'

class MinutesService {
  /**
   * Add (positive) or remove (negative) minutes on one class (an ai_tutor_chats row).
   * A grant up to the direct limit runs at once; above it, it becomes an approval
   * request for a second person. Removing never needs approval (it can't cost money)
   * but can't take back minutes the learner already used.
   */
  async grant(actor: Actor, input: { chatId: number; minutes: number; reason: string }) {
    const settings = await settingsService.all()
    const minutes = Number(input.minutes)
    if (!Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > settings.grant_minutes_max) {
      throw new ApiException(422, `Minutes must be a whole number from -${settings.grant_minutes_max} to ${settings.grant_minutes_max}, not 0`)
    }
    const chat = await AiTutorChat.find(input.chatId)
    if (!chat) throw new ApiException(404, 'Class not found')

    if (minutes > settings.grant_minutes_direct_limit) {
      const request = await approvalService.request(actor, {
        action: 'tutor.minutes.grant',
        payload: { chat_id: chat.id, minutes, user_id: chat.userId },
        summary: `Grant ${minutes} min to learner #${chat.userId} on class #${chat.id} (${chat.lessonTopic ?? 'lesson'})`,
        reason: input.reason,
      })
      return { status: 'pending_approval' as const, approvalId: request.id }
    }
    const result = await db.transaction((trx) =>
      this.applyGrant(actor, { chat_id: chat.id, minutes }, input.reason, trx)
    )
    return { status: 'done' as const, ...result }
  }

  /**
   * The grant itself, mirroring the monolith's paid and manual grants
   * (PaymentController, GrantAiTutorMinutes) and the tutor API's start(): under the
   * learner's `users` row lock, append a ledger row and raise the class total; time
   * already spent is left alone, so the new minutes are all remaining.
   *
   * Those paths compute the next total as SUM(ledger of this lesson) + minutes. A class
   * the tutor API opened without a ledger row (its "no record" fallback) has a total but
   * no ledger, so the base here is the larger of the two: a grant never shrinks a class.
   *
   * A class that is live right now keeps its own timer (read when the room opened); the
   * new total applies when the learner next starts or resumes it.
   */
  async applyGrant(
    actor: Actor,
    payload: { chat_id: number; minutes: number },
    reason: string,
    trx: TransactionClientContract,
    approvalId?: number
  ) {
    const chatRow = await AiTutorChat.query({ client: trx }).where('id', payload.chat_id).first()
    if (!chatRow) throw new ApiException(404, 'Class not found')
    await trx.from('users').where('id', chatRow.userId).forUpdate().first()
    // Re-read under the lock: the learner's class may have saved meanwhile.
    const chat = (await AiTutorChat.query({ client: trx }).where('id', payload.chat_id).forUpdate().first())!

    const sumRows = await AiTutorTimeLog.query({ client: trx })
      .where('user_id', chat.userId)
      .where('quiz_question_id', chat.quizQuestionId ?? 0)
      .sum('minutes_added as total')
    const ledgerTotal = Number(sumRows[0]?.$extras.total) || 0
    const previousTotal = Math.max(ledgerTotal, chat.totalMinutes ?? 0)
    const newTotal = previousTotal + payload.minutes
    const timeSpent = chat.timeSpent ?? 0
    if (payload.minutes < 0 && newTotal < timeSpent) {
      throw new ApiException(
        409,
        `The learner already used ${timeSpent} min of this class: at most ${Math.max(0, previousTotal - timeSpent)} min can be removed.`,
        'MINUTES_USED'
      )
    }

    chat.useTransaction(trx)
    chat.totalMinutes = newTotal
    chat.remainingMinutes = Math.max(0, newTotal - timeSpent)
    await chat.save()

    const log = await AiTutorTimeLog.create(
      {
        userId: chat.userId,
        quizQuestionId: chat.quizQuestionId,
        aiTutorChatId: chat.id,
        source: payload.minutes > 0 ? CONSOLE_GRANT_SOURCE : CONSOLE_DEDUCT_SOURCE,
        minutesAdded: payload.minutes,
        previousTotal,
        newTotal,
      },
      { client: trx }
    )

    const result = {
      chat_id: chat.id,
      user_id: chat.userId,
      minutes: payload.minutes,
      previous_total: previousTotal,
      new_total: newTotal,
      remaining: chat.remainingMinutes,
      time_log_id: log.id,
    }
    await auditService.record(
      {
        actor,
        action: payload.minutes > 0 ? 'tutor.minutes.granted' : 'tutor.minutes.removed',
        targetType: 'learner',
        targetId: chat.userId,
        reason,
        metadata: { ...result, ...(approvalId ? { approval_id: approvalId } : {}) },
      },
      trx
    )
    return result
  }

  /** The minutes ledger: purchases, free classes, manual and console grants. */
  async ledger(filters: { userId?: number; source?: string; page: number; perPage: number }) {
    const query = db
      .from('ai_tutor_time_logs as l')
      .leftJoin('ai_tutor_chats as c', 'c.id', 'l.ai_tutor_chat_id')
      .select(
        'l.id',
        'l.user_id',
        'l.quiz_question_id',
        'l.ai_tutor_chat_id',
        'l.source',
        'l.minutes_added',
        'l.previous_total',
        'l.new_total',
        'l.created_at',
        'c.lesson_topic'
      )
      .orderBy('l.id', 'desc')
    if (filters.userId) query.where('l.user_id', filters.userId)
    if (filters.source) query.where('l.source', filters.source)
    const page = await query.paginate(filters.page, filters.perPage)
    const sources = await db.from('ai_tutor_time_logs').distinct('source').whereNotNull('source')
    return { ...page.toJSON(), sources: sources.map((s) => s.source as string) }
  }

  /** Grants made without a purchase (free class / fallback), with the daily-cap view. */
  async freeGrants(filters: { page: number; perPage: number }) {
    const page = await db
      .from('ai_tutor_grants')
      .select('id', 'user_id', 'ai_tutor_chat_id', 'source', 'minutes', 'created_at')
      .orderBy('id', 'desc')
      .paginate(filters.page, filters.perPage)
    const heavy = await db
      .from('ai_tutor_grants')
      .where('created_at', '>', new Date(Date.now() - 24 * 3600_000))
      .groupBy('user_id')
      .select('user_id')
      .count('* as grants')
      .orderBy('grants', 'desc')
      .limit(10)
    return {
      ...page.toJSON(),
      topLast24h: heavy.map((h) => ({ userId: h.user_id, grants: Number(h.grants) })),
    }
  }
}

export default new MinutesService()
