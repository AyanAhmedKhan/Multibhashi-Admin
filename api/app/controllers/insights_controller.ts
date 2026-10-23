import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import analyticsService from '#services/analytics/analytics_service'
import costService from '#services/analytics/cost_service'
import { DEFAULT_COST_MODEL, costModelStore, perMinuteInr, validateCostModel } from '#services/analytics/cost_model'
import auditService from '#services/audit_service'
import { costModelValidator, invoiceValidator, listValidator } from '#validators/console'

/** Insights: users, engagement, AI tutor usage, cost. Aggregates only. */
export default class InsightsController {
  private async days(request: HttpContext['request']) {
    const { days } = await listValidator.validate(request.qs())
    return days ?? 30
  }

  async users({ request }: HttpContext) {
    return analyticsService.users(await this.days(request))
  }

  async engagement({ request }: HttpContext) {
    return analyticsService.engagement(await this.days(request))
  }

  async tutor({ request }: HttpContext) {
    return analyticsService.tutor(await this.days(request))
  }

  async highlights() {
    return analyticsService.highlights()
  }

  async staff({ request }: HttpContext) {
    return analyticsService.staff(await this.days(request))
  }

  async cost({ request }: HttpContext) {
    return costService.cost(await this.days(request))
  }

  async classCost({ params }: HttpContext) {
    return costService.classCost(Number(params.id))
  }

  async reconciliation() {
    return costService.reconciliation(6)
  }

  async saveInvoice({ request, actor }: HttpContext) {
    const input = await request.validateUsing(invoiceValidator)
    await costService.saveInvoice(actor, { month: input.month, provider: input.provider, amountInr: input.amount_inr, note: input.note }, input.reason)
    return costService.reconciliation(6)
  }

  async costModel() {
    const model = await costModelStore.get()
    return { model, perMinute: perMinuteInr(model), defaults: DEFAULT_COST_MODEL }
  }

  async updateCostModel({ request, actor }: HttpContext) {
    const { model, reason } = await request.validateUsing(costModelValidator)
    const next = validateCostModel(model)
    const before = await costModelStore.get()
    await db.transaction(async (trx) => {
      await costModelStore.save(next, actor.user.id, trx)
      await auditService.record(
        {
          actor,
          action: 'analytics.cost_model.updated',
          reason,
          metadata: { before_per_minute: perMinuteInr(before), after_per_minute: perMinuteInr(next) },
        },
        trx
      )
    })
    costService.clearCache()
    return { model: next, perMinute: perMinuteInr(next) }
  }
}
