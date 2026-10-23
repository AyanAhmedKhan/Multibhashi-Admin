import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { readFile } from 'node:fs/promises'
import { assertLocalDevDatabase } from '#helpers/dev_guard'

/** Creates local copies of the monolith tables the console reads (local Docker DB only). */
export default class ConsoleDevSchema extends BaseCommand {
  static commandName = 'console:dev-schema'
  static description = 'LOCAL ONLY: create minimal monolith tables (activity, courses, AI Pro) in the dev DB'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { default: env } = await import('#start/env')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    assertLocalDevDatabase(env)
    const sql = await readFile(new URL('../database/dev/monolith_tables.sql', import.meta.url), 'utf8')
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean)
    for (const statement of statements) await db.rawQuery(statement)
    // Older local copies named the course column `name`; the monolith calls it `title`.
    const [columns] = await db.rawQuery(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'courses'"
    )
    const names = (columns as { c: string }[]).map((r) => r.c)
    if (names.includes('name') && !names.includes('title')) {
      await db.rawQuery('ALTER TABLE courses CHANGE name title VARCHAR(255) NULL')
    }
    this.logger.success(`Applied ${statements.length} CREATE TABLE IF NOT EXISTS statements`)
  }
}
