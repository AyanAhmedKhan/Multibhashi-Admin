import type { HttpContext } from '@adonisjs/core/http'
import ApiException from '#exceptions/api_exception'
import aiProService, { type AiProInput } from '#services/tutor/ai_pro_service'
import { aiProValidator, endGrantValidator, extendValidator, listValidator } from '#validators/console'

/** Complimentary AI Pro access: preview, grant, extend, end. */
export default class AiProController {
  async catalog({ request }: HttpContext) {
    const { courseId } = await listValidator.validate(request.qs())
    return aiProService.catalog(courseId)
  }

  async forLearner({ params }: HttpContext) {
    return aiProService.forLearner(Number(params.id))
  }

  private async input(ctx: HttpContext): Promise<AiProInput & { reason?: string }> {
    const body = await ctx.request.validateUsing(aiProValidator)
    return {
      ...body,
      user_id: Number(ctx.params.id),
      lesson_field: body.lesson_field ?? 'lesson_number',
      package_name: body.package_name ?? null,
    }
  }

  async preview(ctx: HttpContext) {
    const { reason: _reason, ...input } = await this.input(ctx)
    const plan = await aiProService.preview(input)
    return { ...plan, cards: plan.cards.slice(0, 60), cardCount: plan.cards.length }
  }

  async grant(ctx: HttpContext) {
    const { reason, ...input } = await this.input(ctx)
    if (!reason) throw new ApiException(422, 'Give a reason (it is stored in the audit log)')
    return aiProService.grant(ctx.actor, input, reason)
  }

  async extend({ request, actor, params }: HttpContext) {
    const { days, reason } = await request.validateUsing(extendValidator)
    return aiProService.extend(actor, Number(params.grantId), days, reason)
  }

  async end({ request, actor, params }: HttpContext) {
    const { remove_unused_minutes: remove, reason } = await request.validateUsing(endGrantValidator)
    return aiProService.end(actor, Number(params.grantId), reason, remove ?? false)
  }
}
