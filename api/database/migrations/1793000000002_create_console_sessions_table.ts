import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Server-side staff sessions: the cookie holds a random token, the table only its
 * SHA-256. Kept in the database (not a signed cookie) so a session can be listed and
 * revoked at once: sign out everywhere, disable a leaver, reset an account.
 * Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_sessions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.integer('user_id').unsigned().notNullable()
      table.string('token_hash', 64).notNullable().unique()
      table.string('csrf_token', 64).notNullable()
      // mfa_pending (password ok, waiting for the code) | active
      table.string('state', 16).notNullable()
      table.string('ip', 45).nullable()
      table.string('user_agent', 255).nullable()
      // Last MFA check: critical actions need one within the step-up window.
      table.timestamp('mfa_at').nullable()
      table.timestamp('created_at').nullable()
      table.timestamp('last_seen_at').nullable()
      table.timestamp('expires_at').notNullable()
      table.timestamp('revoked_at').nullable()
      table.string('revoked_reason', 64).nullable()
      table.index(['user_id', 'revoked_at'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
