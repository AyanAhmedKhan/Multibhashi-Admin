import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Staff accounts of the admin console. Deliberately separate from the monolith's
 * `admins` table: every console account has MFA, a lockout counter and an invite
 * lifecycle, and the old accounts are migrated person by person (docs/PLAN.md).
 * Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_users'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.string('email', 254).notNullable().unique()
      table.string('name', 120).notNullable()
      table.string('password_hash', 255).nullable()
      // invited | active | disabled
      table.string('status', 16).notNullable().defaultTo('invited')
      // TOTP secrets, encrypted with APP_KEY. `pending` = shown on the setup page, not
      // yet confirmed with a code.
      table.text('mfa_secret').nullable()
      table.text('mfa_pending_secret').nullable()
      table.timestamp('mfa_enabled_at').nullable()
      // Last accepted TOTP time step: a code can't be replayed inside its window.
      table.bigInteger('mfa_last_step').nullable()
      // SHA-256 hashes of the unused single-use recovery codes.
      table.json('recovery_codes').nullable()
      // Invite / access-reset link (only its SHA-256 is stored).
      table.string('setup_token_hash', 64).nullable().index()
      table.timestamp('setup_expires_at').nullable()
      table.integer('failed_logins').unsigned().notNullable().defaultTo(0)
      table.timestamp('locked_until').nullable()
      table.timestamp('last_login_at').nullable()
      table.string('last_login_ip', 45).nullable()
      table.timestamp('password_changed_at').nullable()
      table.timestamp('disabled_at').nullable()
      table.string('disabled_reason', 255).nullable()
      table.integer('created_by').unsigned().nullable()
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
