import type { HttpContext } from '@adonisjs/core/http'
import productInsights from '#services/product_analytics/insights'
import { productInsightsValidator } from '#validators/console'

/**
 * Insights → product analytics (MUL-152): the modelled BigQuery tables behind the Overview,
 * Screens, Features, Funnels, Retention and Health tabs. Behind analytics.read like the other
 * Insights pages. Aggregates only; the drop-off learner list (teachers-dashboard ids, linking
 * to the learner page, never contact details) is included only for staff who may also see
 * learners (learners.read).
 */
export default class ProductInsightsController {
  private async input(request: HttpContext['request']) {
    const input = await productInsightsValidator.validate(request.qs())
    return { ...input, range: productInsights.range(input.days ?? 30) }
  }

  async status() {
    return productInsights.status()
  }

  async overview({ request }: HttpContext) {
    return productInsights.overview((await this.input(request)).range)
  }

  async screens({ request }: HttpContext) {
    return productInsights.screens((await this.input(request)).range)
  }

  async features({ request }: HttpContext) {
    return productInsights.features((await this.input(request)).range)
  }

  async funnels({ request }: HttpContext) {
    const input = await this.input(request)
    return productInsights.funnels(input.range, input.breakdown ?? null, input.funnel ?? null)
  }

  async dropoffs({ request, actor }: HttpContext) {
    const input = await this.input(request)
    return productInsights.dropoffs(input.range, input.funnel ?? 'signup', input.step ?? 1, actor.permissions.has('learners.read'))
  }

  async retention({ request }: HttpContext) {
    const input = await this.input(request)
    return productInsights.retention(input.range, { basis: input.basis, channel: input.channel, feature: input.feature })
  }

  async health({ request }: HttpContext) {
    return productInsights.health((await this.input(request)).range)
  }
}
