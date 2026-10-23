import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import AiTutorLearnerMemory from '#models/ai_tutor_learner_memory'
import AiTutorSessionSummary from '#models/ai_tutor_session_summary'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import type { Actor } from '#services/actor'

const PROFILE_SCOPE = 'profile'

class LearnerMemoryService {
  async get(userId: number) {
    const profile = await AiTutorLearnerMemory.query()
      .where('user_id', userId)
      .where('scope', PROFILE_SCOPE)
      .first()
    const summaries = await AiTutorSessionSummary.query()
      .where('user_id', userId)
      .orderBy('updated_at', 'desc')
      .limit(50)
    return {
      profile: profile
        ? {
            memory: profile.memory,
            version: profile.version,
            erasedVersion: profile.erasedVersion,
            erasedAt: profile.erasedAt,
            updatedAt: profile.updatedAt,
          }
        : null,
      summaries: summaries.map((s) => ({
        id: s.id,
        classId: s.aiTutorChatId,
        quizId: s.quizId,
        language: s.language,
        summary: s.summary,
        details: s.details,
        updatedAt: s.updatedAt ?? s.createdAt,
      })),
    }
  }

  /**
   * "Forget everything" on the learner's behalf (a privacy request). The same steps the
   * tutor API runs for an in-class erase (memory_service.saveFromAgent, `erase`), in one
   * transaction under the learner's `users` row lock: every class summary deleted, the
   * profile emptied with version + 1, and that version written as the erase tombstone so
   * a class that loaded the old profile can't write it back when it ends.
   */
  async erase(actor: Actor, userId: number, reason: string) {
    return db.transaction(async (trx) => {
      const learner = await trx.from('users').where('id', userId).forUpdate().first()
      if (!learner) throw new ApiException(404, 'Learner not found')
      const memory = await AiTutorLearnerMemory.query({ client: trx })
        .where('user_id', userId)
        .where('scope', PROFILE_SCOPE)
        .first()
      const deleted = await AiTutorSessionSummary.query({ client: trx }).where('user_id', userId).delete()
      const next = (memory?.version ?? 0) + 1
      const tombstone = { erasedVersion: next, erasedAt: DateTime.now() }
      if (memory) {
        memory.useTransaction(trx)
        memory.memory = {}
        memory.version = next
        memory.merge(tombstone)
        await memory.save()
      } else {
        await AiTutorLearnerMemory.create(
          { userId, scope: PROFILE_SCOPE, memory: {}, version: next, ...tombstone },
          { client: trx }
        )
      }
      const result = { version: next, summariesDeleted: Number(deleted[0] ?? 0) }
      await auditService.record(
        { actor, action: 'tutor.memory.erased', targetType: 'learner', targetId: userId, reason, metadata: result },
        trx
      )
      return result
    })
  }
}

export default new LearnerMemoryService()
