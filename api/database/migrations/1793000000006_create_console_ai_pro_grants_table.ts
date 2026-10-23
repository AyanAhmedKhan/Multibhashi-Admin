import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Complimentary AI Pro access given from the console (no payment). One row per grant:
 * what it covered, what it created in the monolith's tables (the package booking that
 * turns on `has_ai_tutor`, the lesson subscriptions, the per-card minutes) and its
 * lifecycle, so it can be listed, extended and ended cleanly — and told apart from paid
 * access, which the console never shortens (that is a refund, owned by Finance).
 * Additive only.
 */
export default class extends BaseSchema {
  protected tableName = 'console_ai_pro_grants'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.integer('user_id').unsigned().notNullable()
      table.integer('course_id').unsigned().notNullable()
      table.string('level_name', 64).notNullable()
      table.integer('from_lesson').unsigned().notNullable()
      table.integer('to_lesson').unsigned().notNullable()
      table.string('lesson_field', 16).notNullable().defaultTo('lesson_number')
      table.integer('minutes_per_card').unsigned().notNullable()
      table.integer('validity_days').unsigned().notNullable()
      table.boolean('with_plan').notNullable()
      table.boolean('with_access').notNullable()
      table.integer('package_booking_id').unsigned().nullable()
      table.integer('cards_granted').unsigned().notNullable().defaultTo(0)
      table.integer('minutes_total').unsigned().notNullable().defaultTo(0)
      table.integer('subscriptions_created').unsigned().notNullable().defaultTo(0)
      // What the grant created, so extending or ending it touches exactly those rows:
      // course_lesson_subscriptions ids, and [{quiz_question_id, chat_id, minutes}] per card.
      table.json('subscription_ids').nullable()
      table.json('cards').nullable()
      // Epoch ms, like the monolith's expire_on / expired_on columns
      table.bigInteger('expires_at').unsigned().notNullable()
      // active | ended (an admin ended it early) — "expired" is derived from expires_at
      table.string('status', 16).notNullable().defaultTo('active')
      table.integer('granted_by').unsigned().notNullable()
      table.integer('approval_id').unsigned().nullable()
      table.string('reason', 500).notNullable()
      table.integer('ended_by').unsigned().nullable()
      table.timestamp('ended_at').nullable()
      table.string('end_reason', 500).nullable()
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
      table.index(['user_id', 'status'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
