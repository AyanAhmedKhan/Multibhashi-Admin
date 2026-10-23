import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Roles are bundles of permission strings from app/rbac/permissions.ts. System roles
 * (is_system) are written by `console:sync-roles`; custom roles are made in the UI.
 * Additive only.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('console_roles', (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.string('slug', 48).notNullable().unique()
      table.string('name', 80).notNullable()
      table.string('description', 255).nullable()
      table.boolean('is_system').notNullable().defaultTo(false)
      table.integer('created_by').unsigned().nullable()
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
    })

    this.schema.createTable('console_role_permissions', (table) => {
      table.integer('role_id').unsigned().notNullable()
      table.string('permission', 64).notNullable()
      table.primary(['role_id', 'permission'])
    })

    this.schema.createTable('console_user_roles', (table) => {
      table.integer('user_id').unsigned().notNullable()
      table.integer('role_id').unsigned().notNullable()
      table.integer('granted_by').unsigned().nullable()
      table.timestamp('created_at').nullable()
      table.primary(['user_id', 'role_id'])
      table.index(['role_id'])
    })
  }

  async down() {
    this.schema.dropTable('console_user_roles')
    this.schema.dropTable('console_role_permissions')
    this.schema.dropTable('console_roles')
  }
}
