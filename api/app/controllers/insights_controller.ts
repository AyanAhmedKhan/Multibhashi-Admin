import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import analyticsService from '#services/analytics/analytics_service'
import costService from '#services/analytics/cost_service'
import { DEFAULT_COST_MODEL, costModelStore, perMinuteInr, validateCostModel } from '#services/analytics/cost_model'
import auditService from '#services/audit_service'
import providerSync from '#services/analytics/provider_sync'
import quizAnalytics from '#services/analytics/quiz_analytics'
import quizCost from '#services/analytics/quiz_cost'
import fullBill from '#services/analytics/full_bill'
import { costModelValidator, invoiceValidator, listValidator, providerRefreshValidator } from '#validators/console'

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

  /** Quizzes: Speaking/Writing volume, marking behaviour and learner experience. */
  async quizzes({ request }: HttpContext) {
    return quizAnalytics.insights(await this.days(request))
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
    fullBill.clearCache()
    return costService.reconciliation(6)
  }

  /** Quiz AI cost: actual provider spend per day, allocated per answer; estimates labelled. */
  async quizCost({ request }: HttpContext) {
    return quizCost.cost(await this.days(request))
  }

  /** The whole provider bill: every GCP project and OpenAI project/key/model, attributed. */
  async fullBill({ request }: HttpContext) {
    return fullBill.bill(await this.days(request))
  }

  /** Provider connection and freshness for the Quizzes cost section. */
  async quizProviders() {
    return providerSync.status()
  }

  /**
   * Refresh: pull the quiz providers' usage and billing now (the daily cron does the same).
   * Not connected providers are skipped, never an error. Audited with what each returned.
   */
  async refreshQuizProviders({ request, actor }: HttpContext) {
    const { days } = await request.validateUsing(providerRefreshValidator)
    const result = await providerSync.run(days ?? 7)
    const summary = (r: (typeof result)['openai'] | (typeof result)['google']) =>
      'connected' in r ? { connected: false } : { connected: true, ok: r.ok, rows: r.rows, error: r.error ? r.error.slice(0, 200) : null }
    const failed = [result.openai, result.google].some((r) => !('connected' in r) && !r.ok)
    await auditService.record({
      actor,
      action: 'analytics.provider_usage.refreshed',
      targetType: 'provider_usage',
      outcome: failed ? 'failure' : 'success',
      metadata: { days: result.days, openai: summary(result.openai), google: summary(result.google) },
    })
    quizCost.clearCache()
    fullBill.clearCache()
    return { result, status: await providerSync.status() }
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
    quizCost.clearCache()
    fullBill.clearCache()
    return { model: next, perMinute: perMinuteInr(next) }
  }
}
