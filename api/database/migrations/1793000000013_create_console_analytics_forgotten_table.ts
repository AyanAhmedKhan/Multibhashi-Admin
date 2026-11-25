import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Product analytics deletion requests (MUL-153, docs/PRODUCT_ANALYTICS.md §6), written by
 * `analytics:forget-user`: one row per run, append only. It is the suppression list:
 * - the nightly facts export skips these learners, so a MySQL row that still exists doesn't
 *   bring them back into BigQuery;
 * - `analytics:forget-user --scheduled` re-runs recent requests, because BigQuery can't delete
 *   rows still in the streaming buffer (the last day or two of events).
 * Ids only (the teachers-dashboard users.id and the appspot _id), never contact details, plus
 * the row counts deleted per table. Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_analytics_forgotten'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.bigIncrements('id')
      table.integer('td_user_id').unsigned().nullable()
      table.string('appspot_id', 64).nullable()
      // command (a staff member ran it) | deleted_account (learner_accounts.status = deleted) | rerun
      table.string('source', 24).notNullable()
      // Per-table rows deleted in BigQuery by this run.
      table.json('deleted').nullable()
      table.timestamp('created_at').notNullable()
      table.index(['td_user_id'], 'idx_analytics_forgotten_td')
      table.index(['appspot_id'], 'idx_analytics_forgotten_appspot')
      table.index(['created_at'], 'idx_analytics_forgotten_created')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
