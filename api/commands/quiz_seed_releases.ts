import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Adds the quiz changes that went live before the release log existed (SEED_RELEASES in
 * quiz_releases.ts) to console_quiz_releases. Safe to run again: a title already in the log is
 * skipped. Run once after the migration:
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace quiz:seed-releases
 */
export default class QuizSeedReleases extends BaseCommand {
  static commandName = 'quiz:seed-releases'
  static description = 'Add the quiz changes made before the release log existed (idempotent)'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { default: releases, SEED_RELEASES } = await import('#services/analytics/quiz_releases')
    const added = await releases.seed()
    this.logger.success(`release log: ${added} added, ${SEED_RELEASES.length - added} already there`)
  }
}
