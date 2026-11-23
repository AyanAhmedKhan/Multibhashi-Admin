import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The quiz release log (docs/QUIZ_OBSERVABILITY.md §7): every change that can move a quiz
 * metric — a brief phase, an app fix, a backend change, a confounder such as a navigation
 * change — with when it reached learners. Before/after comparisons are cut at `deployed_at`,
 * and the daily charts carry these as markers. Written only through the console (audited).
 * Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_quiz_releases'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.string('title', 160).notNullable()
      // Brief phase '0'–'6'; null for anything else (an app fix, a confounder)
      table.string('phase', 8).nullable()
      // fix | telemetry | confounder
      table.string('kind', 16).notNullable().defaultTo('fix')
      // app_web | app_android | app_ios | backend | admin
      table.string('surface', 16).notNullable()
      // Jira key (MUL-102), PR ("RN #42"), commit
      table.string('ticket', 32).nullable()
      table.string('pr', 64).nullable()
      table.string('commit_sha', 40).nullable()
      // The app version that first carries it (student_sessions.app_version), for a same-days split
      table.string('app_version', 32).nullable()
      // When learners first got it. deployed_estimated = the date is a merge/commit date, not a deploy
      table.timestamp('deployed_at').nullable()
      table.boolean('deployed_estimated').notNullable().defaultTo(false)
      // Metric keys (quiz_metrics.ts) this change is expected to move: [{ metric, direction }]
      table.json('expects').nullable()
      table.text('notes').nullable()
      table.integer('created_by').unsigned().nullable()
      table.integer('updated_by').unsigned().nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
      table.index(['deployed_at'], 'idx_quiz_releases_deployed')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
