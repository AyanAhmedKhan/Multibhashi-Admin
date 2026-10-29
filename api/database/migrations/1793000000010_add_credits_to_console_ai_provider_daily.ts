import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The full provider bill (every GCP project/service/SKU, every OpenAI project/key/model)
 * keeps credits and discounts apart from the gross cost: cost_usd is gross, credits_usd the
 * (negative) credits, and net = cost_usd + credits_usd. Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_ai_provider_daily'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.decimal('credits_usd', 16, 6).notNullable().defaultTo(0).after('cost_usd')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('credits_usd')
    })
  }
}
