import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * What the AI providers themselves report per day for the quizzes (docs/QUIZ_OBSERVABILITY.md
 * §3): OpenAI's Usage and Costs APIs (marking) and the GCP Cloud Billing export
 * (speech-to-text). Written only by the console's sync (`quiz:sync-provider-usage` and the
 * Cost page's Refresh), read by the Quizzes cost section. The quiz backend is not changed.
 *
 * One row per (IST day, provider, account scope, line item, unit). The unique key makes a
 * re-sync of the same window an idempotent upsert. Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_ai_provider_daily'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.bigIncrements('id')
      // IST date the usage belongs to
      table.date('day').notNullable()
      // openai | google
      table.string('provider', 16).notNullable()
      // OpenAI project id / API key id, or the GCP project id
      table.string('scope', 160).notNullable()
      // OpenAI model or cost line item; GCP "service / SKU" description
      table.string('item', 255).notNullable()
      // input_tokens, cached_input_tokens, output_tokens, requests; the GCP usage unit; usd for a cost-only line
      table.string('unit', 48).notNullable()
      table.decimal('quantity', 20, 4).notNullable().defaultTo(0)
      // The provider's own gross cost in USD (OpenAI Costs API; BigQuery cost ÷ conversion rate);
      // credits are kept apart in credits_usd (migration 1793000000010)
      table.decimal('cost_usd', 16, 6).notNullable().defaultTo(0)
      // openai_usage_api | openai_costs_api | gcp_billing_export
      table.string('source', 32).notNullable()
      table.timestamp('synced_at').notNullable()
      table.unique(['day', 'provider', 'scope', 'item', 'unit'], { indexName: 'uq_ai_provider_daily' })
      table.index(['provider', 'source', 'day'], 'idx_ai_provider_daily_source')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
