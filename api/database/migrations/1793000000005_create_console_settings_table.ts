import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Security policy and limits a super admin can change (config/console.ts `defaults`
 * apply until a key is saved). Every change is audited with its old and new value.
 * Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_settings'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('key', 64).primary()
      table.json('value').notNullable()
      table.integer('updated_by').unsigned().nullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
