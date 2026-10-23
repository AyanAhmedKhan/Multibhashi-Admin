import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * What each AI provider actually billed per month, entered by Finance from the invoices
 * (Sarvam has no usage API, only an organisation-wide credit balance). The Cost page
 * compares it with what the console computed from recorded usage. Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_cost_invoices'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      // YYYY-MM (IST month)
      table.string('month', 7).notNullable()
      // sarvam | google | livekit | other
      table.string('provider', 32).notNullable()
      table.decimal('amount_inr', 14, 2).notNullable()
      table.string('note', 255).nullable()
      table.integer('entered_by').unsigned().notNullable()
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
      table.unique(['month', 'provider'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
