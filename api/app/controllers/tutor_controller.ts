import type { HttpContext } from '@adonisjs/core/http'
import classesService from '#services/tutor/classes_service'
import learnersService from '#services/tutor/learners_service'
import learnerMemoryService from '#services/tutor/memory_service'
import liveService from '#services/tutor/live_service'
import minutesService from '#services/tutor/minutes_service'
import overviewService from '#services/tutor/overview_service'
import auditService from '#services/audit_service'
import { grantValidator, listValidator, reasonValidator } from '#validators/console'

/** The AI Tutor module and the learner pages built on it. */
export default class TutorController {
  async overview() {
    return overviewService.tutor()
  }

  async live() {
    return liveService.list()
  }

  async endLive({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    await liveService.end(actor, params.room, reason)
    return { ok: true }
  }

  async classes({ request, actor }: HttpContext) {
    const f = await listValidator.validate(request.qs())
    return classesService.list(
      {
        status: f.status,
        userId: f.userId,
        q: f.q,
        from: f.from,
        to: f.to ? new Date(f.to.getTime() + 86400_000) : undefined,
        page: f.page ?? 1,
        perPage: f.perPage ?? 25,
      },
      actor.permissions.has('learners.pii.read')
    )
  }

  async showClass({ params }: HttpContext) {
    return classesService.get(Number(params.id))
  }

  async transcript({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    return classesService.transcript(actor, Number(params.id), reason)
  }

  async grant({ request, actor, params }: HttpContext) {
    const { minutes, reason } = await request.validateUsing(grantValidator)
    return minutesService.grant(actor, { chatId: Number(params.id), minutes, reason })
  }

  async ledger({ request }: HttpContext) {
    const f = await listValidator.validate(request.qs())
    return minutesService.ledger({ userId: f.userId, source: f.source, page: f.page ?? 1, perPage: f.perPage ?? 25 })
  }

  async freeGrants({ request }: HttpContext) {
    const f = await listValidator.validate(request.qs())
    return minutesService.freeGrants({ page: f.page ?? 1, perPage: f.perPage ?? 25 })
  }

  async learners({ request, actor }: HttpContext) {
    const f = await listValidator.validate(request.qs())
    return learnersService.search(f.q ?? '', f.page ?? 1, f.perPage ?? 25, actor.permissions.has('learners.pii.read'))
  }

  async learner({ params, actor }: HttpContext) {
    return learnersService.get(Number(params.id), actor)
  }

  async revealLearner({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    return learnersService.reveal(actor, Number(params.id), reason)
  }

  async memory({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    const memory = await learnerMemoryService.get(Number(params.id))
    await auditService.record({ actor, action: 'tutor.memory.viewed', targetType: 'learner', targetId: params.id, reason })
    return memory
  }

  async eraseMemory({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    return learnerMemoryService.erase(actor, Number(params.id), reason)
  }

  async exportLearner({ request, actor, params, response }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    const data = await learnersService.export(actor, Number(params.id), reason)
    response.header('Content-Disposition', `attachment; filename="learner-${Number(params.id)}-ai-tutor-data.json"`)
    return data
  }
}
