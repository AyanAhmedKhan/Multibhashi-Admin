import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One-time sign-in codes sent by email (the default second step). Each code is bound to
 * one session and purpose, stored only as an HMAC (APP_KEY), valid 10 minutes, five
 * tries, single use. Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_email_codes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.integer('user_id').unsigned().notNullable()
      table.integer('session_id').unsigned().notNullable()
      // login | step_up
      table.string('purpose', 16).notNullable()
      table.string('code_hash', 64).notNullable()
      table.integer('attempts').unsigned().notNullable().defaultTo(0)
      table.timestamp('expires_at').notNullable()
      table.timestamp('used_at').nullable()
      table.timestamp('created_at').notNullable()
      table.index(['session_id', 'purpose'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
