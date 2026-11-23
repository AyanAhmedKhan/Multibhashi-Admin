import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Frozen daily quiz metrics (docs/QUIZ_OBSERVABILITY.md §7), written by `quiz:daily-metrics`.
 * One row per (IST day, metric, segment, definition version). A window's figure is
 * SUM(num) / SUM(den) over its days, or the merged histogram's quantile, so any before/after
 * window can be compared without re-reading the live answer tables.
 *
 * `final` rows are never rewritten by a normal run: the "before" a fix is judged against
 * stays exactly what it was, even if the definitions change later — a changed definition is
 * a new definition_version, written beside the old rows. Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_quiz_daily_metrics'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.bigIncrements('id')
      table.date('day').notNullable()
      table.string('metric', 64).notNullable()
      // all | context:course | device:web | os:ios | app:1.0.0+web.146e1a2b | error:NotAllowedError …
      table.string('segment', 64).notNullable().defaultTo('all')
      table.smallint('definition_version').unsigned().notNullable()
      // rate/ratio/cost: num / den; count: num; distribution: sum / count of the values
      table.decimal('num', 20, 6).notNullable().defaultTo(0)
      table.decimal('den', 20, 6).notNullable().defaultTo(0)
      // distribution: answers per bucket, edges fixed by the definition version
      table.json('hist').nullable()
      // cost rows: actual | usage | estimated (provider data or the rate card); null otherwise
      table.string('basis', 16).nullable()
      table.boolean('final').notNullable().defaultTo(false)
      table.timestamp('computed_at').notNullable()
      table.unique(['day', 'metric', 'segment', 'definition_version'], { indexName: 'uq_quiz_daily_metrics' })
      table.index(['metric', 'segment', 'day'], 'idx_quiz_daily_metrics_series')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
