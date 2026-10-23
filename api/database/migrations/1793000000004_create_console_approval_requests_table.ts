import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Four-eyes approvals: an action above its threshold (a big minutes grant, making
 * someone a super admin, …) is stored here and only runs when a second staff member
 * with the same power approves it. Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_approval_requests'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.string('action', 64).notNullable()
      table.json('payload').notNullable()
      table.string('summary', 255).notNullable()
      // pending | approved (and executed) | rejected | cancelled | expired | failed
      table.string('status', 16).notNullable().defaultTo('pending')
      table.integer('requested_by').unsigned().notNullable()
      table.string('request_reason', 500).notNullable()
      table.integer('decided_by').unsigned().nullable()
      table.timestamp('decided_at').nullable()
      table.string('decision_note', 500).nullable()
      table.timestamp('executed_at').nullable()
      table.json('result').nullable()
      table.string('error', 500).nullable()
      table.timestamp('expires_at').notNullable()
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
      table.index(['status', 'created_at'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
