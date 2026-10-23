import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Append-only audit trail of every staff write, every sensitive read and every denied
 * attempt. Each row carries the SHA-256 of the previous one (a hash chain), so an
 * edited or deleted row is detectable (`GET /console/audit/verify`). In production the
 * console's MySQL user gets only INSERT and SELECT on these two tables.
 * `console_audit_head` is a one-row lock that serialises appends.
 * Additive only.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('console_audit_logs', (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.bigIncrements('id')
      table.timestamp('created_at').notNullable()
      table.integer('actor_id').unsigned().nullable()
      table.string('actor_email', 254).nullable()
      table.string('action', 64).notNullable()
      table.string('target_type', 32).nullable()
      table.string('target_id', 64).nullable()
      // success | denied | failure
      table.string('outcome', 16).notNullable()
      table.string('reason', 500).nullable()
      table.json('metadata').nullable()
      table.string('ip', 45).nullable()
      table.string('user_agent', 255).nullable()
      table.string('request_id', 64).nullable()
      table.string('prev_hash', 64).notNullable()
      table.string('hash', 64).notNullable()
      table.index(['created_at'])
      table.index(['actor_id', 'created_at'])
      table.index(['target_type', 'target_id'])
      table.index(['action', 'created_at'])
    })

    this.schema.createTable('console_audit_head', (table) => {
      table.tinyint('id').unsigned().primary()
      table.bigInteger('last_id').unsigned().notNullable()
      table.string('last_hash', 64).notNullable()
    })

    this.defer(async (db) => {
      await db.table('console_audit_head').insert({ id: 1, last_id: 0, last_hash: '0'.repeat(64) })
    })
  }

  async down() {
    this.schema.dropTable('console_audit_head')
    this.schema.dropTable('console_audit_logs')
  }
}
